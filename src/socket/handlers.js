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
const {
  publicGameView,
  privateHandView,
  agariView,
  ryukyokuView,
} = require('./game-view');
const {
  calculatePointMoves,
  calculateNotenPenalty,
} = require('../game/score');

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
  // ツモアガリ: game:tsumo
  // 自分のターン中・ツモ牌がある状態で、checkAgariTsumo が成立する場合に成功。
  // -----------------------------------------------------------------
  socket.on(C2S.GAME_TSUMO, (_, ack) => {
    try {
      const room = roomManager.getRoomBySocketId(socket.id);
      if (!room || !room.gameEngine) throw new Error('対局が開始されていません。');
      if (room.pendingClaim) throw new Error('鳴き応答待ち中です。');
      if (room.state === 'hand-end') throw new Error('既に和了/流局済みです。');
      const playerInfo = roomManager.getPlayerInfoBySocketId(socket.id);
      if (!playerInfo) throw new Error('プレイヤー情報が見つかりません。');
      const engine = room.gameEngine;
      const myPlayerId = playerInfo.playerId;
      if (engine.state.currentTurn !== myPlayerId) throw new Error('あなたのターンではありません。');
      const drawnTile = engine.state.drawnTile;
      if (!drawnTile) throw new Error('ツモ牌がありません。');

      const result = engine.checkAgariTsumo(myPlayerId, drawnTile);
      if (!result) throw new Error('役なしのためツモアガリできません（完全先付け）。');

      finalizeAgari(io, room, {
        agariResult: result,
        winnerId: myPlayerId,
        isTsumo: true,
        fromPlayer: null,
      });
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      socket.emit(S2C.LOBBY_ERROR, { message: err.message });
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------
  // ロン: game:ron
  // 鳴き応答中（pendingClaim あり）で eligible.canRon = true のときのみ受付。
  // tryResolveClaim でロンが最優先で勝者になる。
  // -----------------------------------------------------------------
  socket.on(C2S.GAME_RON, (_, ack) => {
    try {
      const room = roomManager.getRoomBySocketId(socket.id);
      if (!room || !room.pendingClaim) throw new Error('鳴き応答中ではありません。');
      const playerInfo = roomManager.getPlayerInfoBySocketId(socket.id);
      if (!playerInfo) throw new Error('プレイヤー情報が見つかりません。');
      const claim = room.pendingClaim;
      const eligibility = claim.eligible.get(playerInfo.playerId);
      if (!eligibility || !eligibility.canRon) throw new Error('この打牌でロンできません。');
      claim.responses.set(playerInfo.playerId, { action: 'ron' });
      tryResolveClaim(io, room);
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      socket.emit(S2C.LOBBY_ERROR, { message: err.message });
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------
  // 次局へ: game:next-hand
  // アガリ/流局後のアガリ画面で誰かが「次へ」を押した時に呼ばれる。
  // 連荘判定 → 親流れ判定 → 次局開始 or 終局通知。
  // 複数人が同時に押しても idempotent になるよう room.state でガード。
  // -----------------------------------------------------------------
  socket.on(C2S.GAME_NEXT_HAND, (_, ack) => {
    try {
      const room = roomManager.getRoomBySocketId(socket.id);
      if (!room) throw new Error('部屋が見つかりません。');
      if (room.state !== 'hand-end') {
        // 既に次局へ進んだ後の押下は無視
        if (typeof ack === 'function') ack({ ok: true });
        return;
      }
      proceedToNextHand(io, room);
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
  room.lastResult = null;

  // 開始ブロードキャスト（次局以降と共通）
  broadcastHandStart(io, room);
  console.log(`[対局開始] roomId=${room.id} dealer=${engine.state.dealerId} ware=${engine.state.warePlayer}`);

  // 親（dealer）が最初の14枚目をツモる → 親に your-turn 通知
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
    // 山切れ流局：テンパイ判定 → 罰符 → 詳細ブロードキャスト
    finalizeRyukyoku(io, room);
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
// step 4 で kita を追加予定
function buildYourTurnPayload(engine, playerId) {
  const options = ['discard'];
  const ankanCandidates = engine.getAnkanCandidates(playerId);
  const kakanCandidates = engine.getKakanCandidates(playerId);
  const canReach = engine.canReach(playerId);
  const reachOptions = canReach ? engine.getReachOptions(playerId) : [];
  const canTsumo = engine.canTsumo(playerId);

  if (ankanCandidates.length > 0) options.push('ankan');
  if (kakanCandidates.length > 0) options.push('kakan');
  if (canReach) options.push('reach');
  if (canTsumo) options.push('tsumo');

  return {
    drawnTile: engine.state.drawnTile,
    options,
    ankanCandidates,
    kakanCandidates,
    reachOptions, // [{ discardIdx, discardTile, isFuriten }, ...]
    canTsumo,
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
    // ロン応答チェック（フリテンも考慮される）
    const ronResult = engine.checkAgariRon(p.id, tile, discarderId);
    const canRon = !!(ronResult && ronResult.canRon);
    if (canPon || canMinkan || canRon) {
      eligible.set(p.id, { canPon, canMinkan, canRon, ronResult: canRon ? ronResult : null });
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

  // 該当プレイヤーだけに通知（ロン優先で目立つ順序）
  for (const [pid, opt] of eligible) {
    const claimOptions = [];
    if (opt.canRon) claimOptions.push('ron');
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

  // 優先順位: ron > minkan > pon > skip
  // 同優先度なら turn 順で discarder の次のプレイヤーを優先（標準麻雀ルール）
  const engine = room.gameEngine;
  const order = ['P0', 'P1', 'P2'];
  const discIdx = order.indexOf(claim.discarderId);
  const sortedPids = [order[(discIdx + 1) % 3], order[(discIdx + 2) % 3]]
    .filter((pid) => claim.eligible.has(pid));

  let winner = null;
  for (const pid of sortedPids) {
    const resp = claim.responses.get(pid);
    if (resp && resp.action === 'ron') { winner = { playerId: pid, action: 'ron' }; break; }
  }
  if (!winner) {
    for (const pid of sortedPids) {
      const resp = claim.responses.get(pid);
      if (resp && resp.action === 'kan') { winner = { playerId: pid, action: 'kan' }; break; }
    }
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

  // ロン: 鳴きとは別フローでアガリ確定処理へ
  if (winner.action === 'ron') {
    const eligibility = claim.eligible.get(winner.playerId);
    finalizeAgari(io, room, {
      agariResult: eligibility.ronResult,  // { canRon, pattern, yakuResult, waitType }
      winnerId: winner.playerId,
      isTsumo: false,
      fromPlayer: claim.discarderId,
    });
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
    canTsumo: false,
  };
}

// -----------------------------------------------------------------
// アガリ確定処理（ツモ・ロン共通）
//   1. リーチ棒を回収して和了者の点数に加算
//   2. 点棒移動を計算して各プレイヤーに反映
//   3. game:agari を全員に送信
//   4. room.state = 'hand-end' にして、room.lastResult を保存
// -----------------------------------------------------------------
function finalizeAgari(io, room, { agariResult, winnerId, isTsumo, fromPlayer }) {
  const engine = room.gameEngine;
  if (room.pendingClaim && room.pendingClaim.timeoutId) {
    clearTimeout(room.pendingClaim.timeoutId);
  }
  room.pendingClaim = null;

  // 点棒移動を計算
  const han = agariResult.yakuResult.totalHan;
  const pointResult = calculatePointMoves({
    han,
    dealerId: engine.state.dealerId,
    winnerId,
    isTsumo,
    fromPlayer,
    warePlayer: engine.state.warePlayer,
  });

  // 点数を実際に動かす
  for (const p of engine.state.players) {
    p.score += pointResult.moves[p.id] || 0;
  }
  // リーチ棒を和了者が回収
  const reachBonus = engine.state.reachSticks * 1000;
  const winner = engine.state.players.find((p) => p.id === winnerId);
  if (winner) winner.score += reachBonus;
  // リーチ棒は使い切ったので 0 にリセット
  const consumedReachSticks = engine.state.reachSticks;
  engine.state.reachSticks = 0;

  // アガリ画面用のビューを構築して全員にブロードキャスト
  const view = agariView(
    engine.state,
    agariResult,
    winnerId,
    isTsumo,
    fromPlayer,
    pointResult,
    reachBonus
  );
  io.to(roomChannel(room.id)).emit(S2C.GAME_AGARI, view);

  // 公開状態も最終的に更新
  io.to(roomChannel(room.id)).emit(
    S2C.GAME_STATE_UPDATE,
    publicGameView(engine.state)
  );

  // 状態を hand-end にしてアクション受付を停止
  engine.state.phase = 'hand-end';
  room.state = 'hand-end';
  room.lastResult = {
    type: 'agari',
    winnerId,
    isDealer: winnerId === engine.state.dealerId,
    isTsumo,
    fromPlayer,
    consumedReachSticks,
  };

  console.log(`[アガリ] roomId=${room.id} winner=${winnerId} ${isTsumo ? 'ツモ' : `ロン from ${fromPlayer}`} han=${han} basePoint=${pointResult.basePoint}`);
}

// -----------------------------------------------------------------
// 流局確定処理（山切れ時）
//   1. テンパイ判定（全プレイヤー分）
//   2. ノーテン罰符 3000 点を分配
//   3. game:ryukyoku を全員に送信
//   4. room.state = 'hand-end'、lastResult.dealerTenpai を保存
// -----------------------------------------------------------------
function finalizeRyukyoku(io, room) {
  const engine = room.gameEngine;
  const tenpaiStatus = engine.getRyukyokuTenpaiStatus();
  // テンパイ者の playerId 一覧
  const tenpaiIds = tenpaiStatus
    .filter((s) => s.isTenpai || s.isReached)
    .map((s) => s.id);

  // 罰符を計算して反映
  const penaltyMoves = calculateNotenPenalty(tenpaiIds);
  for (const p of engine.state.players) {
    p.score += penaltyMoves[p.id] || 0;
  }

  const view = ryukyokuView(engine.state, tenpaiStatus, penaltyMoves);
  io.to(roomChannel(room.id)).emit(S2C.GAME_RYUKYOKU, view);

  // 公開状態も最終的に更新
  io.to(roomChannel(room.id)).emit(
    S2C.GAME_STATE_UPDATE,
    publicGameView(engine.state)
  );

  engine.state.phase = 'hand-end';
  room.state = 'hand-end';
  room.lastResult = {
    type: 'ryukyoku',
    dealerTenpai: tenpaiIds.includes(engine.state.dealerId),
  };

  console.log(`[流局] roomId=${room.id} テンパイ者=${tenpaiIds.join(',') || 'なし'}`);
}

// -----------------------------------------------------------------
// 次局への遷移（クライアントから game:next-hand 受信時）
//   1. 連荘 / 親流れ / 終局判定
//   2. 終局なら game:game-end を送って終わり
//   3. 続行なら新しい GameEngine で init し、新局開始
// -----------------------------------------------------------------
function proceedToNextHand(io, room) {
  const engine = room.gameEngine;
  const last = room.lastResult;
  if (!last) return;

  // トビ判定（誰かマイナス）
  const tobiPlayer = engine.state.players.find((p) => p.score < 0);
  if (tobiPlayer) {
    finalizeGameEnd(io, room, { reason: 'tobi', tobiPlayer: tobiPlayer.id });
    return;
  }

  // 親が続行するか判定
  let dealerContinues;
  if (last.type === 'agari') {
    dealerContinues = last.isDealer; // 親アガリなら連荘
  } else {
    // 流局: 東場は親テンパイで連荘、南場は親ノーテンで連荘
    if (engine.state.roundWind === 'E') dealerContinues = !!last.dealerTenpai;
    else dealerContinues = !last.dealerTenpai;
  }

  // 終局判定（南3局終了 + 親流れなら終局）
  const isLastHand = engine.state.roundWind === 'S' && engine.state.hand === 3;
  if (isLastHand && !dealerContinues) {
    finalizeGameEnd(io, room, { reason: 'all-hands-done' });
    return;
  }

  // 次局のパラメータを計算
  const order = ['P0', 'P1', 'P2'];
  const dealerIdx = order.indexOf(engine.state.dealerId);
  let nextDealerId, nextHand, nextRound;
  let nextHonba;
  if (dealerContinues) {
    nextDealerId = engine.state.dealerId;
    nextHand = engine.state.hand;
    nextRound = engine.state.roundWind;
    nextHonba = engine.state.honba + 1;
  } else {
    nextDealerId = order[(dealerIdx + 1) % 3];
    if (engine.state.hand === 3) {
      nextRound = engine.state.roundWind === 'E' ? 'S' : 'S';
      nextHand = 1;
    } else {
      nextRound = engine.state.roundWind;
      nextHand = engine.state.hand + 1;
    }
    // 流局なら本場積み、和了なら 0 にリセット
    nextHonba = last.type === 'ryukyoku' ? engine.state.honba + 1 : 0;
  }

  // リーチ棒: 流局時は積み残し、和了時は和了者が回収済みなので 0
  const nextReachSticks = last.type === 'ryukyoku' ? engine.state.reachSticks : 0;

  // 新エンジンで init
  const playerNames = engine.state.players.map((p) => p.name);
  const scores = engine.state.players.map((p) => p.score);
  const chips = engine.state.players.map((p) => p.chips);
  const newEngine = new GameEngine();
  newEngine.init(
    {
      scores, chips,
      roundWind: nextRound, hand: nextHand, honba: nextHonba,
      reachSticks: nextReachSticks, dealerId: nextDealerId,
    },
    { playerNames, playerIsCpu: [false, false, false] }
  );
  room.gameEngine = newEngine;
  room.state = 'in-game';
  room.lastResult = null;

  io.to(roomChannel(room.id)).emit(S2C.GAME_HAND_END, {
    nextDealer: nextDealerId,
    nextRound,
    nextHand,
    nextHonba,
    scores,
  });

  // 新局を開始（startGameInRoom と同じブロードキャスト）
  broadcastHandStart(io, room);
  startTurnFor(io, room, newEngine.state.dealerId);

  console.log(`[次局開始] roomId=${room.id} ${nextRound}${nextHand}局 ${nextHonba}本場 dealer=${nextDealerId}`);
}

// 対局終了
function finalizeGameEnd(io, room, { reason, tobiPlayer }) {
  const engine = room.gameEngine;
  const finalScores = engine.state.players.map((p) => ({
    id: p.id, name: p.name, score: p.score, chips: p.chips,
  }));
  // 順位は点数降順
  const ranking = [...finalScores].sort((a, b) => b.score - a.score);
  io.to(roomChannel(room.id)).emit(S2C.GAME_GAME_END, {
    reason, // 'all-hands-done' | 'tobi'
    tobiPlayer: tobiPlayer || null,
    finalScores,
    ranking,
  });
  room.state = 'ended';
  console.log(`[対局終了] roomId=${room.id} 理由=${reason}`);
}

// 新局開始時の初期ブロードキャスト（game:start + 各人手牌 + state-update）
function broadcastHandStart(io, room) {
  const engine = room.gameEngine;
  io.to(roomChannel(room.id)).emit(S2C.GAME_START, {
    roomId: room.id,
    players: engine.state.players.map((p) => ({ id: p.id, name: p.name, wind: p.wind })),
    dealerId: engine.state.dealerId,
    warePlayer: engine.state.warePlayer,
  });
  for (let i = 0; i < room.players.length; i++) {
    const roomPlayer = room.players[i];
    const enginePlayerId = engine.state.players[i].id;
    if (roomPlayer.socketId) {
      io.to(roomPlayer.socketId).emit(
        S2C.GAME_YOUR_HAND,
        privateHandView(engine.state, enginePlayerId)
      );
    }
  }
  io.to(roomChannel(room.id)).emit(
    S2C.GAME_STATE_UPDATE,
    publicGameView(engine.state)
  );
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
