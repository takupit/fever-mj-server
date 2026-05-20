// ============================================================
// src/socket/handlers.js
// Socket.IO のイベントハンドラを登録する関数。
// connection ごとに呼び出され、その socket に対する各イベントを購読する。
// ============================================================
// 設計書「5. WebSocketイベント定義」「6. 部屋管理フロー」に対応。
// フェーズ3 ではロビー関連（lobby:*）と切断検知のみ実装。
// 打牌・鳴きなど game:* のハンドラはフェーズ4 以降で追加。
// ============================================================

const { C2S, S2C } = require('./events');
const { GameEngine } = require('../game/engine');
const { publicGameView, privateHandView } = require('./game-view');

// 鳴き応答の制限時間（仕様書「13. ポン・ロン応答」より 8 秒）
const CLAIM_TIMEOUT_MS = 8000;

// クライアントから受け取った値を安全に正規化（trim・長さ制限）
function sanitize(payload) {
  const p = payload || {};
  const name = String(p.name == null ? '' : p.name).trim().slice(0, 20);
  const password = String(p.password == null ? '' : p.password).trim().slice(0, 50);
  if (!name) throw new Error('名前を入力してください。');
  if (!password) throw new Error('合言葉を入力してください。');
  return { name, password };
}

// 部屋ID から Socket.IO のルーム名（チャネル名）を作る
function roomChannel(roomId) {
  return `room:${roomId}`;
}

function registerHandlers(io, socket, roomManager) {
  // -----------------------------------------------------------------
  // 部屋作成: lobby:create-room
  // -----------------------------------------------------------------
  socket.on(C2S.LOBBY_CREATE_ROOM, (payload, ack) => {
    try {
      const { name, password } = sanitize(payload);
      const { room, token, playerId } = roomManager.createRoom({
        password,
        name,
        socketId: socket.id,
      });

      // この socket を「部屋専用チャネル」に参加させる
      socket.join(roomChannel(room.id));

      // 作成した本人に詳細を返す（token は本人だけが知る）
      socket.emit(S2C.LOBBY_ROOM_CREATED, {
        roomId: room.id,
        playerId,
        token,
        room: roomManager.publicView(room),
      });

      console.log(`[部屋作成] roomId=${room.id} host=${name} (${playerId})`);
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      socket.emit(S2C.LOBBY_ERROR, { message: err.message });
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------
  // 部屋参加: lobby:join-room
  // -----------------------------------------------------------------
  socket.on(C2S.LOBBY_JOIN_ROOM, (payload, ack) => {
    try {
      const { name, password } = sanitize(payload);
      const { room, player, token, playerId, isFull } = roomManager.joinRoom({
        password,
        name,
        socketId: socket.id,
      });

      socket.join(roomChannel(room.id));

      // 参加者本人へ部屋の現状を返す
      socket.emit(S2C.LOBBY_ROOM_JOINED, {
        roomId: room.id,
        playerId,
        token,
        room: roomManager.publicView(room),
      });

      // 既存メンバーへ「誰かが入ってきた」通知
      socket.to(roomChannel(room.id)).emit(S2C.LOBBY_PLAYER_JOINED, {
        player: { id: player.id, name: player.name, connected: true },
        room: roomManager.publicView(room),
      });

      console.log(`[部屋参加] roomId=${room.id} player=${name} (${playerId}) members=${room.players.length}/3`);

      // 3人揃ったら対局を開始
      if (isFull) {
        startGameInRoom(io, room);
      }

      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      socket.emit(S2C.LOBBY_ERROR, { message: err.message });
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------
  // 退室: lobby:leave-room（自発的）
  // -----------------------------------------------------------------
  socket.on(C2S.LOBBY_LEAVE_ROOM, (_, ack) => {
    handleLeave(io, socket, roomManager, '自発退室');
    if (typeof ack === 'function') ack({ ok: true });
  });

  // -----------------------------------------------------------------
  // 打牌: game:discard
  // クライアントから { tile, handIdx? } を受け取り、サーバー側で検証してから
  // 河に置く。打牌後、他家が鳴ける場合は startClaimPhase で 8 秒応答待ち、
  // なければ即座に次のターンへ進む。
  // -----------------------------------------------------------------
  socket.on(C2S.GAME_DISCARD, (payload, ack) => {
    try {
      const room = roomManager.getRoomBySocketId(socket.id);
      if (!room || !room.gameEngine) {
        throw new Error('対局がまだ開始されていません。');
      }
      if (room.pendingClaim) {
        throw new Error('現在は他家の鳴き応答待ち中です。');
      }
      const playerInfo = roomManager.getPlayerInfoBySocketId(socket.id);
      if (!playerInfo) throw new Error('プレイヤー情報が見つかりません。');

      const engine = room.gameEngine;
      const myPlayerId = playerInfo.playerId;

      // 検証1: 自分のターンか
      if (engine.state.currentTurn !== myPlayerId) {
        throw new Error('あなたのターンではありません。');
      }
      // 検証2: 牌指定があるか
      const tile = payload && payload.tile;
      if (typeof tile !== 'string' || !tile) {
        throw new Error('打牌情報が不正です。');
      }
      // 検証3: 手牌に存在するか
      const player = engine.state.players.find((p) => p.id === myPlayerId);
      if (!player || !player.hand.includes(tile)) {
        throw new Error('その牌は手牌にありません。');
      }
      // 検証4: リーチ後はツモ切りのみ
      if (player.isReached && tile !== engine.state.drawnTile) {
        throw new Error('リーチ後はツモ切りしかできません。');
      }

      // ツモ切り判定（ツモ牌をそのまま捨てたか）
      const isTsumogiri = tile === engine.state.drawnTile;
      const handIdx = typeof payload.handIdx === 'number' ? payload.handIdx : null;

      const ok = engine.discardTile(myPlayerId, tile, isTsumogiri, handIdx);
      if (!ok) throw new Error('打牌処理に失敗しました。');

      // アクション結果（誰が何を捨てたか）を全員にブロードキャスト
      io.to(roomChannel(room.id)).emit(S2C.GAME_ACTION_RESULT, {
        action: 'discard',
        playerId: myPlayerId,
        tile,
        isTsumogiri,
        isReachDeclaration: player.discards[player.discards.length - 1].isReachDeclaration,
      });

      // 公開状態を更新（河に1枚追加）
      io.to(roomChannel(room.id)).emit(
        S2C.GAME_STATE_UPDATE,
        publicGameView(engine.state)
      );

      // 鳴き応答チェック: 誰かポン/明カンできるなら 8 秒応答待ち、
      // 誰も鳴けないなら即座に次ターンへ
      const claimStarted = startClaimPhase(io, room);
      if (!claimStarted) {
        progressToNextTurn(io, room);
      }

      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      socket.emit(S2C.LOBBY_ERROR, { message: err.message });
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------
  // ポン応答: game:pon
  // 鳴き応答中（room.pendingClaim あり）に呼ばれる。
  // 当該プレイヤーの応答を記録し、全員揃ったら resolveClaim を呼ぶ。
  // -----------------------------------------------------------------
  socket.on(C2S.GAME_PON, (payload, ack) => {
    try {
      const room = roomManager.getRoomBySocketId(socket.id);
      if (!room || !room.pendingClaim) throw new Error('鳴き応答中ではありません。');
      const playerInfo = roomManager.getPlayerInfoBySocketId(socket.id);
      if (!playerInfo) throw new Error('プレイヤー情報が見つかりません。');
      const claim = room.pendingClaim;
      const eligibility = claim.eligible.get(playerInfo.playerId);
      if (!eligibility || !eligibility.canPon) {
        throw new Error('この打牌はポンできません。');
      }
      claim.responses.set(playerInfo.playerId, { action: 'pon' });
      tryResolveClaim(io, room);
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      socket.emit(S2C.LOBBY_ERROR, { message: err.message });
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------
  // カン: game:kan
  // ペイロード: { type: 'ankan' | 'kakan' | 'minkan', tile? }
  //   - minkan: 鳴き応答中（他家の捨て牌を 3 枚揃えてカン）
  //   - ankan / kakan: 自分のターン中（手牌4枚 or ポン済+ツモ牌）
  // -----------------------------------------------------------------
  socket.on(C2S.GAME_KAN, (payload, ack) => {
    try {
      const room = roomManager.getRoomBySocketId(socket.id);
      if (!room || !room.gameEngine) throw new Error('対局が開始されていません。');
      const playerInfo = roomManager.getPlayerInfoBySocketId(socket.id);
      if (!playerInfo) throw new Error('プレイヤー情報が見つかりません。');
      const engine = room.gameEngine;
      const myPlayerId = playerInfo.playerId;
      const type = payload && payload.type;

      if (type === 'minkan') {
        // 鳴き応答中の明カン
        if (!room.pendingClaim) throw new Error('鳴き応答中ではありません。');
        const eligibility = room.pendingClaim.eligible.get(myPlayerId);
        if (!eligibility || !eligibility.canMinkan) throw new Error('この打牌は明カンできません。');
        room.pendingClaim.responses.set(myPlayerId, { action: 'kan' });
        tryResolveClaim(io, room);
      } else if (type === 'ankan' || type === 'kakan') {
        // 自分のターンでの暗カン or 加カン
        if (room.pendingClaim) throw new Error('鳴き応答待ち中です。');
        if (engine.state.currentTurn !== myPlayerId) throw new Error('あなたのターンではありません。');
        const tile = payload.tile;
        if (!tile) throw new Error('カン対象の牌を指定してください。');
        const doneOk = type === 'ankan'
          ? engine.doAnkan(myPlayerId, tile)
          : engine.doKakan(myPlayerId, tile);
        if (!doneOk) throw new Error('カン処理に失敗しました。');

        io.to(roomChannel(room.id)).emit(S2C.GAME_ACTION_RESULT, {
          action: type, playerId: myPlayerId, tile,
        });

        // 嶺上ツモ → ツモ済の手牌を本人にだけ
        const rinshanTile = engine.drawRinshan(myPlayerId);
        const roomPlayer = room.players.find((p) => p.id === myPlayerId);
        if (roomPlayer && roomPlayer.socketId) {
          io.to(roomPlayer.socketId).emit(
            S2C.GAME_YOUR_HAND,
            privateHandView(engine.state, myPlayerId)
          );
          io.to(roomPlayer.socketId).emit(
            S2C.GAME_YOUR_TURN,
            buildYourTurnPayload(engine, myPlayerId)
          );
        }
        io.to(roomChannel(room.id)).emit(
          S2C.GAME_STATE_UPDATE,
          publicGameView(engine.state)
        );
      } else {
        throw new Error(`不明なカン種別: ${type}`);
      }
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      socket.emit(S2C.LOBBY_ERROR, { message: err.message });
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------
  // リーチ宣言: game:reach
  // ペイロード: { tile, handIdx? }
  // declareReach で旗を立て、続けて discardTile を実行する。
  // discardTile の中で justDeclaredReach フラグから「リーチ宣言牌」として記録される。
  // -----------------------------------------------------------------
  socket.on(C2S.GAME_REACH, (payload, ack) => {
    try {
      const room = roomManager.getRoomBySocketId(socket.id);
      if (!room || !room.gameEngine) throw new Error('対局が開始されていません。');
      if (room.pendingClaim) throw new Error('鳴き応答待ち中です。');
      const playerInfo = roomManager.getPlayerInfoBySocketId(socket.id);
      if (!playerInfo) throw new Error('プレイヤー情報が見つかりません。');
      const engine = room.gameEngine;
      const myPlayerId = playerInfo.playerId;
      if (engine.state.currentTurn !== myPlayerId) throw new Error('あなたのターンではありません。');

      const tile = payload && payload.tile;
      if (!tile) throw new Error('リーチで切る牌を指定してください。');

      // リーチ可能チェック（捨てる牌を除外した手牌でテンパイか）
      const player = engine.state.players.find((p) => p.id === myPlayerId);
      if (!player || !player.hand.includes(tile)) throw new Error('その牌は手牌にありません。');
      if (player.isReached) throw new Error('既にリーチ宣言済みです。');
      if (player.score < 1000) throw new Error('リーチには 1000 点以上必要です。');
      if (engine.state.wall.length < 4) throw new Error('山残り 4 枚未満ではリーチできません。');

      // リーチ宣言 + 打牌
      engine.declareReach(myPlayerId, 'normal', tile);
      const isTsumogiri = tile === engine.state.drawnTile;
      const handIdx = typeof payload.handIdx === 'number' ? payload.handIdx : null;
      const ok = engine.discardTile(myPlayerId, tile, isTsumogiri, handIdx);
      if (!ok) throw new Error('リーチ打牌に失敗しました。');

      io.to(roomChannel(room.id)).emit(S2C.GAME_ACTION_RESULT, {
        action: 'reach',
        playerId: myPlayerId,
        tile,
        isTsumogiri,
      });
      io.to(roomChannel(room.id)).emit(
        S2C.GAME_STATE_UPDATE,
        publicGameView(engine.state)
      );

      // リーチ宣言後の打牌でも鳴きはあり得る（ロンは step 3 で実装）
      const claimStarted = startClaimPhase(io, room);
      if (!claimStarted) {
        progressToNextTurn(io, room);
      }
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      socket.emit(S2C.LOBBY_ERROR, { message: err.message });
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------
  // スキップ: game:skip（鳴き応答を見送る）
  // -----------------------------------------------------------------
  socket.on(C2S.GAME_SKIP, (_, ack) => {
    try {
      const room = roomManager.getRoomBySocketId(socket.id);
      if (!room || !room.pendingClaim) throw new Error('鳴き応答中ではありません。');
      const playerInfo = roomManager.getPlayerInfoBySocketId(socket.id);
      if (!playerInfo) throw new Error('プレイヤー情報が見つかりません。');
      const claim = room.pendingClaim;
      if (!claim.eligible.has(playerInfo.playerId)) return;
      claim.responses.set(playerInfo.playerId, { action: 'skip' });
      tryResolveClaim(io, room);
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      socket.emit(S2C.LOBBY_ERROR, { message: err.message });
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------
  // 切断: タブを閉じた・ネットワーク切れ等
  // -----------------------------------------------------------------
  socket.on('disconnect', (reason) => {
    handleLeave(io, socket, roomManager, `切断: ${reason}`);
  });
}

// -----------------------------------------------------------------
// 対局開始処理（3人揃った時に呼ばれる）
//   1. GameEngine インスタンスを作って室内に保持
//   2. プレイヤー名を引き継いで init（配牌＋ドラ決定）
//   3. game:start を全員にブロードキャスト
//   4. game:your-hand を各プレイヤー本人にのみ送信
//   5. game:state-update を全員にブロードキャスト
// -----------------------------------------------------------------
function startGameInRoom(io, room) {
  const engine = new GameEngine();
  const playerNames = room.players.map((p) => p.name);
  engine.init(null, {
    playerNames,
    playerIsCpu: [false, false, false], // オンライン対戦は全員人間
  });

  // 部屋に GameEngine を紐付け（フェーズ4b 以降の打牌処理で参照する）
  room.gameEngine = engine;
  room.state = 'in-game';

  // 1. 対局開始通知（公開可能な情報のみ）
  io.to(roomChannel(room.id)).emit(S2C.GAME_START, {
    roomId: room.id,
    players: engine.state.players.map((p) => ({
      id: p.id,
      name: p.name,
      wind: p.wind,
    })),
    dealerId: engine.state.dealerId,
    warePlayer: engine.state.warePlayer,
  });

  // 2. 各プレイヤー本人にのみ「自分の手牌」を送る（仕様書 セキュリティ 1）
  for (let i = 0; i < room.players.length; i++) {
    const roomPlayer = room.players[i];
    const enginePlayerId = engine.state.players[i].id; // P0/P1/P2
    if (roomPlayer.socketId) {
      io.to(roomPlayer.socketId).emit(
        S2C.GAME_YOUR_HAND,
        privateHandView(engine.state, enginePlayerId)
      );
    }
  }

  // 3. 公開状態を全員にブロードキャスト
  io.to(roomChannel(room.id)).emit(
    S2C.GAME_STATE_UPDATE,
    publicGameView(engine.state)
  );

  console.log(`[対局開始] roomId=${room.id} dealer=${engine.state.dealerId} ware=${engine.state.warePlayer}`);

  // 4. 親（dealer）が最初の14枚目をツモる → 親に your-turn 通知
  startTurnFor(io, room, engine.state.dealerId);
}

// -----------------------------------------------------------------
// 指定プレイヤーのターンを開始する:
//   1. その人がツモる（嶺上開花のときは別経路、step 1 では通常ツモのみ）
//   2. その人にだけ「自分の手牌（ツモ済み）」と「あなたのターン」を送る
//   3. 全員に公開状態を再ブロードキャスト
//   4. 山が空なら流局を全員に通知
// -----------------------------------------------------------------
function startTurnFor(io, room, playerId) {
  const engine = room.gameEngine;
  const drawResult = engine.drawTile(playerId);

  if (drawResult.ryukyoku) {
    // 山が空 → 流局（step 1 は最小実装。テンパイ罰符は step 3 で）
    io.to(roomChannel(room.id)).emit(S2C.GAME_RYUKYOKU, {
      reason: 'wall-empty',
      message: '流局しました（山切れ）',
    });
    room.state = 'ended';
    console.log(`[流局] roomId=${room.id} 山切れ`);
    return;
  }

  // ツモ済の手牌を本人にだけ
  const roomPlayer = room.players.find((p) => p.id === playerId);
  if (roomPlayer && roomPlayer.socketId) {
    io.to(roomPlayer.socketId).emit(
      S2C.GAME_YOUR_HAND,
      privateHandView(engine.state, playerId)
    );
    io.to(roomPlayer.socketId).emit(
      S2C.GAME_YOUR_TURN,
      buildYourTurnPayload(engine, playerId)
    );
  }

  // 山が1枚減ったので公開状態を再ブロードキャスト
  io.to(roomChannel(room.id)).emit(
    S2C.GAME_STATE_UPDATE,
    publicGameView(engine.state)
  );
}

// 自分のターンで使える選択肢をまとめたペイロードを作る
// step 2 で ankan/kakan/reach、step 3 で tsumo、step 4 で kita を追加していく
function buildYourTurnPayload(engine, playerId) {
  const options = ['discard'];
  const ankanCandidates = engine.getAnkanCandidates(playerId);
  const kakanCandidates = engine.getKakanCandidates(playerId);
  const canReach = engine.canReach(playerId);
  const reachOptions = canReach ? engine.getReachOptions(playerId) : [];

  if (ankanCandidates.length > 0) options.push('ankan');
  if (kakanCandidates.length > 0) options.push('kakan');
  if (canReach) options.push('reach');

  return {
    drawnTile: engine.state.drawnTile,
    options,
    ankanCandidates,
    kakanCandidates,
    reachOptions, // [{ discardIdx, discardTile, isFuriten }, ...]
  };
}

// 次のプレイヤーへターンを進める（打牌後または鳴き応答終了後に呼ぶ）
function progressToNextTurn(io, room) {
  const engine = room.gameEngine;
  engine.nextTurn();
  startTurnFor(io, room, engine.state.currentTurn);
}

// -----------------------------------------------------------------
// 鳴き応答フェーズの開始
//   1. 直前の打牌に対してポン/明カンできるプレイヤーを抽出
//   2. 該当者がいれば pendingClaim をセットして game:waiting-claim 送信
//   3. 8 秒タイマーで強制解決
// 戻り値: true=応答待ちを開始した, false=誰も鳴けないので応答待ちなし
// -----------------------------------------------------------------
function startClaimPhase(io, room) {
  const engine = room.gameEngine;
  const lastDiscard = engine.state.lastDiscard;
  if (!lastDiscard) return false;
  const tile = lastDiscard.tile;
  const discarderId = lastDiscard.player;

  const eligible = new Map();
  for (const p of engine.state.players) {
    if (p.id === discarderId) continue;
    const canPon = engine.canPon(p.id, tile);
    const canMinkan = engine.canMinkan(p.id, tile);
    if (canPon || canMinkan) {
      eligible.set(p.id, { canPon, canMinkan });
    }
  }
  if (eligible.size === 0) return false;

  room.pendingClaim = {
    discarderId,
    tile,
    eligible,
    responses: new Map(),
    timeoutId: null,
  };

  // 該当プレイヤーだけに通知
  for (const [pid, opt] of eligible) {
    const claimOptions = [];
    if (opt.canPon) claimOptions.push('pon');
    if (opt.canMinkan) claimOptions.push('kan');
    claimOptions.push('skip');
    const rp = room.players.find((p) => p.id === pid);
    if (rp && rp.socketId) {
      io.to(rp.socketId).emit(S2C.GAME_WAITING_CLAIM, {
        discardingPlayer: discarderId,
        tile,
        options: claimOptions,
        timeoutMs: CLAIM_TIMEOUT_MS,
      });
    }
  }

  // タイムアウト後に強制解決
  room.pendingClaim.timeoutId = setTimeout(() => {
    resolveClaim(io, room);
  }, CLAIM_TIMEOUT_MS);

  console.log(`[鳴き応答待ち] roomId=${room.id} 対象=${[...eligible.keys()].join(',')} 牌=${tile}`);
  return true;
}

// 全員から応答が揃ったら即時解決する（タイムアウト前でも）
function tryResolveClaim(io, room) {
  const claim = room.pendingClaim;
  if (!claim) return;
  const allResponded = [...claim.eligible.keys()].every((pid) => claim.responses.has(pid));
  if (allResponded) {
    if (claim.timeoutId) clearTimeout(claim.timeoutId);
    resolveClaim(io, room);
  }
}

// 鳴き応答を確定し、ポン/カンを実行 or 次ターンへ進める
function resolveClaim(io, room) {
  const claim = room.pendingClaim;
  if (!claim) return;
  if (claim.timeoutId) clearTimeout(claim.timeoutId);
  room.pendingClaim = null;

  // 優先順位: minkan > pon > skip
  // 同優先度なら turn 順で discarder の次のプレイヤーを優先（標準麻雀ルール）
  const engine = room.gameEngine;
  const order = ['P0', 'P1', 'P2'];
  const discIdx = order.indexOf(claim.discarderId);
  const sortedPids = [order[(discIdx + 1) % 3], order[(discIdx + 2) % 3]]
    .filter((pid) => claim.eligible.has(pid));

  let winner = null;
  for (const pid of sortedPids) {
    const resp = claim.responses.get(pid);
    if (resp && resp.action === 'kan') { winner = { playerId: pid, action: 'kan' }; break; }
  }
  if (!winner) {
    for (const pid of sortedPids) {
      const resp = claim.responses.get(pid);
      if (resp && resp.action === 'pon') { winner = { playerId: pid, action: 'pon' }; break; }
    }
  }

  if (!winner) {
    // 全員スキップ or 無応答（タイムアウト） → 次ターン
    progressToNextTurn(io, room);
    return;
  }

  // 鳴きを実行
  if (winner.action === 'pon') {
    engine.doPon(winner.playerId, claim.tile, claim.discarderId);
  } else {
    engine.doMinkan(winner.playerId, claim.tile, claim.discarderId);
  }

  io.to(roomChannel(room.id)).emit(S2C.GAME_ACTION_RESULT, {
    action: winner.action,
    playerId: winner.playerId,
    tile: claim.tile,
    fromPlayer: claim.discarderId,
  });

  // 鳴いた本人に手牌＋打牌可能通知
  const claimerRoomPlayer = room.players.find((p) => p.id === winner.playerId);
  if (claimerRoomPlayer && claimerRoomPlayer.socketId) {
    io.to(claimerRoomPlayer.socketId).emit(
      S2C.GAME_YOUR_HAND,
      privateHandView(engine.state, winner.playerId)
    );
  }

  if (winner.action === 'pon') {
    // ポンは嶺上ツモなし → そのまま打牌へ
    io.to(roomChannel(room.id)).emit(
      S2C.GAME_STATE_UPDATE,
      publicGameView(engine.state)
    );
    if (claimerRoomPlayer && claimerRoomPlayer.socketId) {
      // ポン後の打牌では ankan/kakan/reach は基本的に使えないので discard と kakan のみ
      io.to(claimerRoomPlayer.socketId).emit(
        S2C.GAME_YOUR_TURN,
        buildYourTurnPayloadAfterCall(engine, winner.playerId)
      );
    }
  } else {
    // 明カン: 嶺上ツモ → 打牌可能通知
    const rinshanTile = engine.drawRinshan(winner.playerId);
    if (claimerRoomPlayer && claimerRoomPlayer.socketId) {
      io.to(claimerRoomPlayer.socketId).emit(
        S2C.GAME_YOUR_HAND,
        privateHandView(engine.state, winner.playerId)
      );
      io.to(claimerRoomPlayer.socketId).emit(
        S2C.GAME_YOUR_TURN,
        buildYourTurnPayloadAfterCall(engine, winner.playerId)
      );
    }
    io.to(roomChannel(room.id)).emit(
      S2C.GAME_STATE_UPDATE,
      publicGameView(engine.state)
    );
  }

  console.log(`[鳴き成立] roomId=${room.id} ${winner.action}=${winner.playerId} 牌=${claim.tile}`);
}

// 鳴き後の打牌で使える選択肢（リーチは原則不可なので除外）
// 加カンは可能、暗カンは手牌4枚揃っていれば可能
function buildYourTurnPayloadAfterCall(engine, playerId) {
  const options = ['discard'];
  const ankanCandidates = engine.getAnkanCandidates(playerId);
  const kakanCandidates = engine.getKakanCandidates(playerId);
  if (ankanCandidates.length > 0) options.push('ankan');
  if (kakanCandidates.length > 0) options.push('kakan');
  return {
    drawnTile: engine.state.drawnTile,
    options,
    ankanCandidates,
    kakanCandidates,
    reachOptions: [],
  };
}

// 退室共通処理: 残メンバーに通知 or 部屋削除
function handleLeave(io, socket, roomManager, reason) {
  const result = roomManager.leaveRoom(socket.id);
  if (!result) return;
  const { room, removedPlayer, roomDeleted } = result;

  if (roomDeleted) {
    console.log(`[部屋削除] 全員退室により削除 (player=${removedPlayer.name})`);
    return;
  }
  if (!room) return;

  io.to(roomChannel(room.id)).emit(S2C.LOBBY_PLAYER_LEFT, {
    playerId: removedPlayer.id,
    room: roomManager.publicView(room),
  });
  console.log(`[退室] roomId=${room.id} player=${removedPlayer.name} (${removedPlayer.id}) 理由=${reason}`);
}

module.exports = { registerHandlers };
