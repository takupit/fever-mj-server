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
const {
  calculateChipMoves,
  calculateChunHatsuBonus,
} = require('../game/chip');
const cpuAi = require('../cpu/ai');

// 鳴き応答の制限時間（仕様書「13. ポン・ロン応答」より 8 秒）
const CLAIM_TIMEOUT_MS = 8000;
// CPU の思考時間（人間に動きが見える程度の遅延）
const CPU_THINK_MS_MIN = 800;
const CPU_THINK_MS_MAX = 1400;
// 切断後の再接続猶予時間（仕様書「7. 切断検知」より 30 秒）
const RECONNECT_GRACE_MS = 30000;

// クライアントから受け取った値を安全に正規化（trim・長さ制限）
function sanitize(payload) {
  const p = payload || {};
  const name = String(p.name == null ? '' : p.name).trim().slice(0, 20);
  const password = String(p.password == null ? '' : p.password).trim().slice(0, 50);
  if (!name) throw new Error('名前を入力してください。');
  if (!password) throw new Error('合言葉を入力してください。');
  return { name, password };
}

// 永続プレイヤーID（クライアントが localStorage から送ってくる UUID）の正規化
// 不正な値が来ても落ちないように、文字列以外や長さ外れは null にする。
function sanitizePlayerId(id) {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (trimmed.length < 8 || trimmed.length > 64) return null;
  return trimmed;
}

// 部屋ID から Socket.IO のルーム名（チャネル名）を作る
function roomChannel(roomId) {
  return `room:${roomId}`;
}

function registerHandlers(io, socket, roomManager, statsStore = null) {
  // -----------------------------------------------------------------
  // 部屋作成: lobby:create-room
  // -----------------------------------------------------------------
  socket.on(C2S.LOBBY_CREATE_ROOM, (payload, ack) => {
    try {
      const { name, password } = sanitize(payload);
      const persistentPlayerId = sanitizePlayerId(payload && payload.persistentPlayerId);
      const { room, token, playerId } = roomManager.createRoom({
        password,
        name,
        socketId: socket.id,
        persistentPlayerId,
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
      const persistentPlayerId = sanitizePlayerId(payload && payload.persistentPlayerId);
      const { room, player, token, playerId, isFull } = roomManager.joinRoom({
        password,
        name,
        socketId: socket.id,
        persistentPlayerId,
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
        // 戦績ストアを部屋に紐付け（finalizeGameEnd から参照できるように）
        room.statsStore = statsStore;
        startGameInRoom(io, room);
      }

      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      socket.emit(S2C.LOBBY_ERROR, { message: err.message });
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------
  // ソロ練習: lobby:create-solo-room
  // 人間 1 人＋CPU 2 体ですぐに対局を始める。テスト用。
  // -----------------------------------------------------------------
  socket.on(C2S.LOBBY_CREATE_SOLO_ROOM, (payload, ack) => {
    try {
      const name = String((payload && payload.name) || '').trim().slice(0, 20);
      if (!name) throw new Error('名前を入力してください。');
      const persistentPlayerId = sanitizePlayerId(payload && payload.persistentPlayerId);

      const { room, token, playerId } = roomManager.createSoloRoom({
        name,
        socketId: socket.id,
        persistentPlayerId,
      });

      socket.join(roomChannel(room.id));
      socket.emit(S2C.LOBBY_ROOM_CREATED, {
        roomId: room.id,
        playerId,
        token,
        room: roomManager.publicView(room),
        isSolo: true,
      });
      console.log(`[ソロ練習開始] roomId=${room.id} human=${name}`);

      // 戦績ストアを部屋に紐付け（finalizeGameEnd から参照できるように）
      room.statsStore = statsStore;
      // 即対局開始
      startGameInRoom(io, room);
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
      // 検証4: 北は河に捨てられない（必ず北抜きするべき・仕様書 5）
      if (tile === 'z4') {
        throw new Error('北は河に捨てられません。「🟢 北抜き」ボタンで抜いてください。');
      }
      // 検証5: リーチ後はツモ切りのみ
      if (player.isReached && tile !== engine.state.drawnTile) {
        throw new Error('リーチ後はツモ切りしかできません。');
      }
      // 検証5: 他家 FEVER 中は未リーチ者もツモ切りのみ
      if (engine.hasOtherFever(myPlayerId) && !player.isReached
          && tile !== engine.state.drawnTile) {
        throw new Error('他家 FEVER 中はツモ切りしかできません。');
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

      // 打牌者本人に最新の手牌を再送（捨てた牌を表示から消すため）
      socket.emit(S2C.GAME_YOUR_HAND, privateHandView(engine.state, myPlayerId));

      // 公開状態を更新（河に1枚追加）
      io.to(roomChannel(room.id)).emit(
        S2C.GAME_STATE_UPDATE,
        publicGameView(engine.state, room)
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
      if (room.state === 'hand-end' || room.state === 'ended') {
        throw new Error('既に和了/流局済みです。');
      }
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
      if (room.state === 'hand-end' || room.state === 'ended') {
        throw new Error('既に和了/流局済みです。');
      }
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
        const me = engine.state.players.find((p) => p.id === myPlayerId);
        // 他家 FEVER 中はカン不可（自分が FEVER 前にリーチ済みなら可）
        if (engine.hasOtherFever(myPlayerId) && !me.isReached) {
          throw new Error('他家 FEVER 中はカンできません。');
        }
        const tile = payload.tile;
        if (!tile) throw new Error('カン対象の牌を指定してください。');

        if (type === 'kakan') {
          // 加カン: 他家にチャンカン（槍槓ロン）の応答チャンスを与える
          // 事前に候補チェック
          const candidates = engine.getKakanCandidates(myPlayerId);
          if (!candidates.includes(tile)) throw new Error('その牌で加カンできません。');

          // チャンカン可能な他家がいれば応答待ちに入る
          const chankanStarted = startChankanClaim(io, room, myPlayerId, tile);
          if (chankanStarted) {
            // 応答待ちに入った → 後の処理は resolveChankanClaim に委ねる
            if (typeof ack === 'function') ack({ ok: true });
            return;
          }
          // 誰もチャンカンできない → 通常通り加カン実行へフォールスルー
        }

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
          publicGameView(engine.state, room)
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
      if (room.state === 'hand-end' || room.state === 'ended') {
        throw new Error('既に和了/流局済みです。');
      }
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
      // 他家 FEVER 中はリーチ不可（仕様書 6. リーチ条件）
      if (engine.hasOtherFever(myPlayerId)) {
        throw new Error('他家 FEVER 中はリーチできません。');
      }

      // リーチ宣言 + 打牌
      const reachResult = engine.declareReach(myPlayerId, 'normal', tile);
      // フェーズ7: FEVER 発動なら戦績集計用にカウント
      if (reachResult && reachResult.trigger && room.gameStats && room.gameStats[myPlayerId]) {
        room.gameStats[myPlayerId].feverCount += 1;
      }
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

      // 打牌者本人に最新の手牌を再送（リーチ宣言で 1 枚減った状態を反映）
      socket.emit(S2C.GAME_YOUR_HAND, privateHandView(engine.state, myPlayerId));

      io.to(roomChannel(room.id)).emit(
        S2C.GAME_STATE_UPDATE,
        publicGameView(engine.state, room)
      );

      // リーチ宣言後の打牌でも鳴きはあり得る
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
  // 他家 FEVER 中は不可（自分が FEVER 前にリーチ済みの場合は可）。
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

      // 他家 FEVER 中: 未リーチならツモアガリ不可（仕様書 7. FEVER ルール）
      const me = engine.state.players.find((p) => p.id === myPlayerId);
      if (engine.hasOtherFever(myPlayerId) && !me.isReached) {
        throw new Error('他家 FEVER 中はツモアガリできません。');
      }

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
      if (room.state === 'hand-end' || room.state === 'ended') {
        throw new Error('既に和了/流局済みです。');
      }
      const playerInfo = roomManager.getPlayerInfoBySocketId(socket.id);
      if (!playerInfo) throw new Error('プレイヤー情報が見つかりません。');
      const claim = room.pendingClaim;
      const eligibility = claim.eligible.get(playerInfo.playerId);
      if (!eligibility || !eligibility.canRon) throw new Error('この打牌でロンできません。');
      claim.responses.set(playerInfo.playerId, { action: 'ron' });
      // 応答種別に応じて解決ルートを分岐（通常ロン / 槍槓ロン）
      if (claim.type === 'chankan') {
        tryResolveChankanClaim(io, room);
      } else {
        tryResolveClaim(io, room);
      }
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      socket.emit(S2C.LOBBY_ERROR, { message: err.message });
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------
  // 北抜き: game:kita
  // 自分のターン中、手牌に北（z4）があれば実行可能。
  // 北抜き → 嶺上ツモ → 他家の北ポン/カン応答チェック → 鳴きあれば実行、
  // なければ本人のターン継続（次の打牌待ち）。
  // -----------------------------------------------------------------
  socket.on(C2S.GAME_KITA, (_, ack) => {
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
      if (!engine.hasKita(myPlayerId)) throw new Error('北が手牌にありません。');
      doKitaInRoom(io, room, myPlayerId, /*isAuto=*/false);
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      socket.emit(S2C.LOBBY_ERROR, { message: err.message });
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  // 北抜きへのポン応答: game:kita-pon
  socket.on(C2S.GAME_KITA_PON, (_, ack) => {
    try {
      const room = roomManager.getRoomBySocketId(socket.id);
      if (!room || !room.pendingClaim || room.pendingClaim.type !== 'kita') {
        throw new Error('北抜き応答中ではありません。');
      }
      if (room.state === 'hand-end' || room.state === 'ended') {
        throw new Error('既に和了/流局済みです。');
      }
      const playerInfo = roomManager.getPlayerInfoBySocketId(socket.id);
      if (!playerInfo) throw new Error('プレイヤー情報が見つかりません。');
      const eligibility = room.pendingClaim.eligible.get(playerInfo.playerId);
      if (!eligibility || !eligibility.canPon) throw new Error('北抜きにポンできません。');
      room.pendingClaim.responses.set(playerInfo.playerId, { action: 'pon' });
      tryResolveKitaClaim(io, room);
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      socket.emit(S2C.LOBBY_ERROR, { message: err.message });
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  // 北抜きへのカン応答: game:kita-kan
  socket.on(C2S.GAME_KITA_KAN, (_, ack) => {
    try {
      const room = roomManager.getRoomBySocketId(socket.id);
      if (!room || !room.pendingClaim || room.pendingClaim.type !== 'kita') {
        throw new Error('北抜き応答中ではありません。');
      }
      if (room.state === 'hand-end' || room.state === 'ended') {
        throw new Error('既に和了/流局済みです。');
      }
      const playerInfo = roomManager.getPlayerInfoBySocketId(socket.id);
      if (!playerInfo) throw new Error('プレイヤー情報が見つかりません。');
      const eligibility = room.pendingClaim.eligible.get(playerInfo.playerId);
      if (!eligibility || !eligibility.canKan) throw new Error('北抜きにカンできません。');
      room.pendingClaim.responses.set(playerInfo.playerId, { action: 'kan' });
      tryResolveKitaClaim(io, room);
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
  // スキップ: game:skip（鳴き応答を見送る・北抜き応答にも対応）
  // -----------------------------------------------------------------
  socket.on(C2S.GAME_SKIP, (_, ack) => {
    try {
      const room = roomManager.getRoomBySocketId(socket.id);
      if (!room || !room.pendingClaim) throw new Error('鳴き応答中ではありません。');
      if (room.state === 'hand-end' || room.state === 'ended') {
        throw new Error('既に和了/流局済みです。');
      }
      const playerInfo = roomManager.getPlayerInfoBySocketId(socket.id);
      if (!playerInfo) throw new Error('プレイヤー情報が見つかりません。');
      const claim = room.pendingClaim;
      if (!claim.eligible.has(playerInfo.playerId)) return;
      claim.responses.set(playerInfo.playerId, { action: 'skip' });
      // 応答種別ごとの解決ルートを分岐
      if (claim.type === 'kita') {
        tryResolveKitaClaim(io, room);
      } else if (claim.type === 'chankan') {
        tryResolveChankanClaim(io, room);
      } else {
        tryResolveClaim(io, room);
      }
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

  // -----------------------------------------------------------------
  // 再接続: game:reconnect
  // クライアントが localStorage に保存していたトークンで席を取り戻す。
  // 30 秒の猶予内ならゲーム続行・タイマーをキャンセル。
  // 既に CPU 代打が始まっていれば人間に戻す。
  // -----------------------------------------------------------------
  socket.on(C2S.GAME_RECONNECT, (payload, ack) => {
    try {
      const token = payload && payload.token;
      if (!token) throw new Error('再接続トークンがありません');
      const found = roomManager.reattachSocketByToken(token, socket.id);
      if (!found) throw new Error('そのトークンの席は無効化されています');
      const { room, player } = found;

      socket.join(roomChannel(room.id));

      // CPU 代打タイマーが回っていればキャンセル
      if (room.cpuTakeoverTimers && room.cpuTakeoverTimers[player.id]) {
        clearTimeout(room.cpuTakeoverTimers[player.id]);
        delete room.cpuTakeoverTimers[player.id];
      }

      // 既に CPU 代打が始まっていたら人間に戻す
      if (room.gameEngine) {
        const enginePlayer = room.gameEngine.state.players.find((p) => p.id === player.id);
        if (enginePlayer && enginePlayer.isCpu && !player.isCpu) {
          enginePlayer.isCpu = false;
        }
      }
      player.cpuTakeover = false;

      // 再接続成功通知（lobby:room-joined と同形式で本人に返す）
      socket.emit(S2C.LOBBY_ROOM_JOINED, {
        roomId: room.id,
        playerId: player.id,
        token,
        room: roomManager.publicView(room),
        reconnected: true,
      });

      // 対局中ならゲーム状態も再送
      if (room.gameEngine) {
        socket.emit(S2C.GAME_START, {
          roomId: room.id,
          players: room.gameEngine.state.players.map((p) => ({ id: p.id, name: p.name, wind: p.wind })),
          dealerId: room.gameEngine.state.dealerId,
          warePlayer: room.gameEngine.state.warePlayer,
        });
        socket.emit(S2C.GAME_YOUR_HAND, privateHandView(room.gameEngine.state, player.id));
        // room を渡すことで、他プレイヤーの接続状態（切断バッジ・CPU 代打フラグ）を正しく含める
        socket.emit(S2C.GAME_STATE_UPDATE, publicGameView(room.gameEngine.state, room));

        // 自分のターン中なら your-turn も再送
        if (room.gameEngine.state.currentTurn === player.id && !room.pendingClaim) {
          socket.emit(S2C.GAME_YOUR_TURN, buildYourTurnPayload(room.gameEngine, player.id));
        }
        // 鳴き応答待ち中で自分が対象なら waiting-claim も再送
        if (room.pendingClaim && room.pendingClaim.eligible && room.pendingClaim.eligible.has(player.id)) {
          const opt = room.pendingClaim.eligible.get(player.id);
          const claimOptions = [];
          if (opt.canRon) claimOptions.push('ron');
          if (opt.canPon) claimOptions.push('pon');
          if (opt.canMinkan) claimOptions.push('kan');
          if (opt.canKan) claimOptions.push('kita-kan');
          claimOptions.push('skip');
          socket.emit(S2C.GAME_WAITING_CLAIM, {
            type: room.pendingClaim.type || null,
            discardingPlayer: room.pendingClaim.discarderId || null,
            fromPlayer: room.pendingClaim.fromPlayerId || null,
            tile: room.pendingClaim.tile || 'z4',
            options: claimOptions,
            timeoutMs: CLAIM_TIMEOUT_MS, // 概算（残時間は厳密でないが許容）
          });
        }
      }

      // 他メンバーに「復帰したよ」通知
      socket.to(roomChannel(room.id)).emit(S2C.GAME_PLAYER_RECONNECTED, {
        playerId: player.id,
        name: player.name,
      });
      console.log(`[再接続成功] roomId=${room.id} player=${player.id} (${player.name})`);

      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      socket.emit(S2C.LOBBY_ERROR, { message: err.message });
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
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
  const playerIsCpu = room.players.map((p) => !!p.isCpu);
  engine.init(null, {
    playerNames,
    playerIsCpu, // 通常対戦は全 false、ソロ練習は [false, true, true]
  });

  // 部屋に GameEngine を紐付け（フェーズ4b 以降の打牌処理で参照する）
  room.gameEngine = engine;
  room.state = 'in-game';
  room.lastResult = null;

  // フェーズ7: 対局単位の役満・FEVER カウントを初期化（戦績記録用）
  // 各プレイヤーごとに対局中の累積を持つ。finalizeGameEnd で DB に書く
  room.gameStats = {};
  for (const p of room.players) {
    room.gameStats[p.id] = { yakumanCount: 0, feverCount: 0 };
  }

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

  // FEVER 強制北抜き: 他家 FEVER 中 + 自分が未リーチ + 手牌に北があれば自動実行
  const playerNow = engine.state.players.find((p) => p.id === playerId);
  if (engine.hasOtherFever(playerId) && !playerNow.isReached && engine.hasKita(playerId)) {
    // 公開状態を一度更新してから自動北抜き
    io.to(roomChannel(room.id)).emit(
      S2C.GAME_STATE_UPDATE,
      publicGameView(engine.state, room)
    );
    doKitaInRoom(io, room, playerId, /*isAuto=*/true);
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
    publicGameView(engine.state, room)
  );

  // CPU プレイヤーなら自動行動をスケジュール（ソロ練習用）
  if (playerNow.isCpu) {
    scheduleCpuTurn(io, room, playerId);
  }
}

// 自分のターンで使える選択肢をまとめたペイロードを作る
function buildYourTurnPayload(engine, playerId) {
  const player = engine.state.players.find((p) => p.id === playerId);
  const otherFever = engine.hasOtherFever(playerId);
  // 他家 FEVER 中・自分未リーチなら選択肢が大きく制限される
  const restrictedByFever = otherFever && !player.isReached;

  const options = ['discard'];
  const ankanCandidates = engine.getAnkanCandidates(playerId);
  const kakanCandidates = engine.getKakanCandidates(playerId);
  const canReach = engine.canReach(playerId);
  const reachOptions = canReach ? engine.getReachOptions(playerId) : [];
  const canTsumo = engine.canTsumo(playerId);
  const canKita = engine.hasKita(playerId);

  if (!restrictedByFever) {
    if (ankanCandidates.length > 0) options.push('ankan');
    if (kakanCandidates.length > 0) options.push('kakan');
    if (canReach) options.push('reach');
    if (canTsumo) options.push('tsumo');
  }
  // 北抜きは FEVER 制限中でも可（むしろ強制的に startTurnFor で実行される）
  if (canKita) options.push('kita');

  return {
    drawnTile: engine.state.drawnTile,
    options,
    ankanCandidates: restrictedByFever ? [] : ankanCandidates,
    kakanCandidates: restrictedByFever ? [] : kakanCandidates,
    reachOptions: restrictedByFever ? [] : reachOptions,
    canTsumo: restrictedByFever ? false : canTsumo,
    canKita,
    restrictedByFever,
  };
}

// 次のプレイヤーへターンを進める（打牌後または鳴き応答終了後に呼ぶ）
// hand-end / ended（局終了済み）のときは何もしない（二重進行防止）
function progressToNextTurn(io, room) {
  if (!room || !room.gameEngine) return;
  // 局終了済み or 対局終了済みなら進めない
  if (room.state !== 'in-game') return;
  const engine = room.gameEngine;
  engine.nextTurn();
  startTurnFor(io, room, engine.state.currentTurn);
}

// =====================================================================
// CPU 自動行動（ソロ練習モード用）
// =====================================================================

// CPU のターンを思考時間後に実行
function scheduleCpuTurn(io, room, playerId) {
  const delay = CPU_THINK_MS_MIN + Math.random() * (CPU_THINK_MS_MAX - CPU_THINK_MS_MIN);
  setTimeout(() => executeCpuAction(io, room, playerId), delay);
}

// CPU のターン中の意思決定（優先度: 北抜き → ツモ → リーチ → 打牌）
function executeCpuAction(io, room, playerId) {
  const engine = room && room.gameEngine;
  if (!engine || room.state !== 'in-game') return;
  if (room.pendingClaim) return;
  if (engine.state.currentTurn !== playerId) return;

  const player = engine.state.players.find((p) => p.id === playerId);
  if (!player || !player.isCpu) return;

  // (1) 北抜き：手牌に北があれば必ず（北は河に出せないので）
  if (engine.hasKita(playerId)) {
    doKitaInRoom(io, room, playerId, /*isAuto=*/false);
    return;
  }

  // (2) ツモアガリ：成立すれば必ず
  if (engine.canTsumo(playerId) && !engine.hasOtherFever(playerId)) {
    const result = engine.checkAgariTsumo(playerId, engine.state.drawnTile);
    if (result) {
      finalizeAgari(io, room, {
        agariResult: result,
        winnerId: playerId,
        isTsumo: true,
        fromPlayer: null,
      });
      return;
    }
  }

  // (3) リーチ：テンパイで条件満たすなら 70% で宣言（cpuAi.shouldDeclareReach 経由）
  if (!player.isReached && !engine.hasOtherFever(playerId) && cpuAi.shouldDeclareReach()) {
    const reachOpt = engine.cpuCheckReach(player);
    if (reachOpt) {
      const tile = reachOpt.discardTile;
      const handIdx = reachOpt.discardIdx;
      const reachType = reachOpt.isFuriten ? 'furiten' : 'normal';
      const reachResult = engine.declareReach(playerId, reachType, tile);
      // フェーズ7: CPU でも FEVER 発動を戦績にカウント
      if (reachResult && reachResult.trigger && room.gameStats && room.gameStats[playerId]) {
        room.gameStats[playerId].feverCount += 1;
      }
      const isTsumogiri = tile === engine.state.drawnTile;
      engine.discardTile(playerId, tile, isTsumogiri, handIdx);

      io.to(roomChannel(room.id)).emit(S2C.GAME_ACTION_RESULT, {
        action: 'reach', playerId, tile, isTsumogiri,
      });
      io.to(roomChannel(room.id)).emit(S2C.GAME_STATE_UPDATE, publicGameView(engine.state, room));

      const claimStarted = startClaimPhase(io, room);
      if (!claimStarted) progressToNextTurn(io, room);
      return;
    }
  }

  // (4) 通常打牌
  //   仕様: 他家 FEVER 中・未リーチの場合はツモ切り強制（仕様書「7. FEVER ルール」）
  //   旧実装はこの制約を無視して cpuChooseDiscard の最良牌を捨てていたため、
  //   ルール違反の打牌が成立していた（freeze の原因ではないが正確性問題）。
  let tile;
  if (engine.hasOtherFever(playerId) && !player.isReached) {
    tile = engine.state.drawnTile; // ツモ切り強制
  } else {
    tile = engine.cpuChooseDiscard(player);
  }
  const isTsumogiri = tile === engine.state.drawnTile;
  engine.discardTile(playerId, tile, isTsumogiri);

  io.to(roomChannel(room.id)).emit(S2C.GAME_ACTION_RESULT, {
    action: 'discard', playerId, tile, isTsumogiri,
  });
  io.to(roomChannel(room.id)).emit(S2C.GAME_STATE_UPDATE, publicGameView(engine.state, room));

  const claimStarted = startClaimPhase(io, room);
  if (!claimStarted) progressToNextTurn(io, room);
}

// 鳴き応答中の CPU 判断（即時に decision を入れる）
// 判断ロジック本体は src/cpu/ai.js の decideClaim に分離。
function decideCpuClaim(io, room, cpuPlayerId) {
  const claim = room.pendingClaim;
  if (!claim) return;
  if (claim.responses.has(cpuPlayerId)) return;
  const eligibility = claim.eligible.get(cpuPlayerId);
  if (!eligibility) return;

  const action = cpuAi.decideClaim(eligibility);
  claim.responses.set(cpuPlayerId, { action });
  if (claim.type === 'kita') tryResolveKitaClaim(io, room);
  else tryResolveClaim(io, room);
}

// CPU 全員に鳴き応答を予約（startClaimPhase / doKitaInRoom から呼ぶ）
function scheduleCpuClaims(io, room) {
  const claim = room.pendingClaim;
  if (!claim) return;
  const engine = room.gameEngine;
  for (const pid of claim.eligible.keys()) {
    const p = engine.state.players.find((pp) => pp.id === pid);
    if (p && p.isCpu) {
      const delay = CPU_THINK_MS_MIN + Math.random() * 400;
      setTimeout(() => decideCpuClaim(io, room, pid), delay);
    }
  }
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

  // CPU 対象者には自動応答を予約（ソロ練習用）
  scheduleCpuClaims(io, room);

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
      publicGameView(engine.state, room)
    );
    if (claimerRoomPlayer && claimerRoomPlayer.socketId) {
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
      publicGameView(engine.state, room)
    );
  }

  // 鳴いた本人が CPU なら自動的に打牌をスケジュール
  const claimerEnginePlayer = engine.state.players.find((p) => p.id === winner.playerId);
  if (claimerEnginePlayer && claimerEnginePlayer.isCpu) {
    scheduleCpuTurn(io, room, winner.playerId);
  }

  console.log(`[鳴き成立] roomId=${room.id} ${winner.action}=${winner.playerId} 牌=${claim.tile}`);
}

// -----------------------------------------------------------------
// チャンカン（加カンへのロン）応答フロー
//   - 加カン宣言時に、他家が「待ち牌に加カン対象牌が含まれる」場合に
//     ロンで割り込めるようにする（槍槓 1 翻）
//   - 通常の鳴き応答とは流れが違うので別経路で処理する。
// -----------------------------------------------------------------

// 加カン宣言時にチャンカン可能な他家がいるか確認し、いれば応答待ち開始。
// 戻り値: 応答待ちが始まったら true、誰もチャンカンできなければ false
function startChankanClaim(io, room, kakaningPlayerId, tile) {
  const engine = room.gameEngine;
  const eligible = new Map();
  for (const p of engine.state.players) {
    if (p.id === kakaningPlayerId) continue;
    const result = engine.checkChankan(p.id, kakaningPlayerId, tile);
    if (result && result.canRon) {
      // canPon/canMinkan は チャンカンでは使わないが、UI で再接続時に
      // GAME_WAITING_CLAIM の options を組み立てる用に空フィールドを持たせる
      eligible.set(p.id, { canRon: true, canPon: false, canMinkan: false, canKan: false, ronResult: result });
    }
  }
  if (eligible.size === 0) return false;

  room.pendingClaim = {
    type: 'chankan',
    kakaningPlayerId,
    discarderId: kakaningPlayerId, // UI 上の「振り込み者」は加カン者
    fromPlayerId: kakaningPlayerId,
    tile,
    eligible,
    responses: new Map(),
    timeoutId: null,
  };

  // 該当プレイヤーだけに通知
  for (const [pid] of eligible) {
    const rp = room.players.find((p) => p.id === pid);
    if (rp && rp.socketId) {
      io.to(rp.socketId).emit(S2C.GAME_WAITING_CLAIM, {
        type: 'chankan',
        discardingPlayer: kakaningPlayerId,
        fromPlayer: kakaningPlayerId,
        tile,
        options: ['ron', 'skip'],
        timeoutMs: CLAIM_TIMEOUT_MS,
      });
    }
  }

  // タイムアウト後に強制解決
  room.pendingClaim.timeoutId = setTimeout(() => {
    resolveChankanClaim(io, room);
  }, CLAIM_TIMEOUT_MS);

  // CPU 対象者は短い思考時間でロン判断（基本ロン可能なら必ずロンする）
  for (const [pid] of eligible) {
    const enginePlayer = engine.state.players.find((p) => p.id === pid);
    if (enginePlayer && enginePlayer.isCpu) {
      setTimeout(() => {
        if (!room.pendingClaim || room.pendingClaim.type !== 'chankan') return;
        if (room.pendingClaim.responses.has(pid)) return;
        room.pendingClaim.responses.set(pid, { action: 'ron' });
        tryResolveChankanClaim(io, room);
      }, CPU_THINK_MS_MIN + Math.random() * 400);
    }
  }

  console.log(`[槍槓応答待ち] roomId=${room.id} 加カン者=${kakaningPlayerId} 牌=${tile} 対象=${[...eligible.keys()].join(',')}`);
  return true;
}

// 全員から応答が揃ったら即時解決する（タイムアウト前でも）
function tryResolveChankanClaim(io, room) {
  const claim = room.pendingClaim;
  if (!claim || claim.type !== 'chankan') return;
  const allResponded = [...claim.eligible.keys()].every((pid) => claim.responses.has(pid));
  if (allResponded) {
    if (claim.timeoutId) clearTimeout(claim.timeoutId);
    resolveChankanClaim(io, room);
  }
}

// チャンカン応答を確定し、ロン成立 or 加カン続行に分岐
function resolveChankanClaim(io, room) {
  const claim = room.pendingClaim;
  if (!claim || claim.type !== 'chankan') return;
  if (claim.timeoutId) clearTimeout(claim.timeoutId);

  const engine = room.gameEngine;
  const kakaningPlayerId = claim.kakaningPlayerId;
  const tile = claim.tile;

  // ロン優先で勝者を確定（加カン者の上家を優先する標準ルール）
  const order = ['P0', 'P1', 'P2'];
  const discIdx = order.indexOf(kakaningPlayerId);
  const sortedPids = [order[(discIdx + 1) % 3], order[(discIdx + 2) % 3]]
    .filter((pid) => claim.eligible.has(pid));
  let ronWinnerId = null;
  for (const pid of sortedPids) {
    const resp = claim.responses.get(pid);
    if (resp && resp.action === 'ron') { ronWinnerId = pid; break; }
  }

  room.pendingClaim = null;

  if (ronWinnerId) {
    // 槍槓ロン成立
    const eligibility = claim.eligible.get(ronWinnerId);
    finalizeAgari(io, room, {
      agariResult: eligibility.ronResult,
      winnerId: ronWinnerId,
      isTsumo: false,
      fromPlayer: kakaningPlayerId,
    });
    return;
  }

  // 誰もロンしなかった → 加カン処理を実行して通常進行
  const ok = engine.doKakan(kakaningPlayerId, tile);
  if (!ok) {
    console.warn(`[槍槓応答後] doKakan 失敗: roomId=${room.id} player=${kakaningPlayerId} tile=${tile}`);
    progressToNextTurn(io, room);
    return;
  }

  io.to(roomChannel(room.id)).emit(S2C.GAME_ACTION_RESULT, {
    action: 'kakan',
    playerId: kakaningPlayerId,
    tile,
  });

  // 嶺上ツモ → 加カン者にあなたのターン通知
  engine.drawRinshan(kakaningPlayerId);
  const roomPlayer = room.players.find((p) => p.id === kakaningPlayerId);
  if (roomPlayer && roomPlayer.socketId) {
    io.to(roomPlayer.socketId).emit(
      S2C.GAME_YOUR_HAND,
      privateHandView(engine.state, kakaningPlayerId)
    );
    io.to(roomPlayer.socketId).emit(
      S2C.GAME_YOUR_TURN,
      buildYourTurnPayloadAfterCall(engine, kakaningPlayerId)
    );
  }
  io.to(roomChannel(room.id)).emit(
    S2C.GAME_STATE_UPDATE,
    publicGameView(engine.state, room)
  );

  // 加カン後のターンが CPU なら自動打牌をスケジュール
  const enginePlayer = engine.state.players.find((p) => p.id === kakaningPlayerId);
  if (enginePlayer && enginePlayer.isCpu) {
    scheduleCpuTurn(io, room, kakaningPlayerId);
  }
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
//   2. 点棒移動を計算して各プレイヤーに反映（FEVER の場合は ×2 倍）
//   3. チップ移動を計算して各プレイヤーに反映
//   4. game:agari を全員に送信
//   5. room.state = 'hand-end' にして、room.lastResult を保存
// -----------------------------------------------------------------
function finalizeAgari(io, room, { agariResult, winnerId, isTsumo, fromPlayer }) {
  const engine = room.gameEngine;
  if (room.pendingClaim && room.pendingClaim.timeoutId) {
    clearTimeout(room.pendingClaim.timeoutId);
  }
  room.pendingClaim = null;

  // 和了者の状態を取得（点棒/チップ計算でも使う）
  const winner = engine.state.players.find((p) => p.id === winnerId);
  const isFever = !!(winner && winner.feverActive);
  const wasReached = !!(winner && winner.isReached);
  const wasIpatsu = !!(winner && winner.ipatsuActive);

  // フェーズ7: 役満アガリを戦績にカウント
  if (agariResult.yakuResult && agariResult.yakuResult.isYakuman && room.gameStats && room.gameStats[winnerId]) {
    const yakumanCount = agariResult.yakuResult.yakumanCount || 1;
    room.gameStats[winnerId].yakumanCount += yakumanCount;
  }

  // 点棒移動を計算（FEVER で ×2 倍）
  const han = agariResult.yakuResult.totalHan;
  const pointResult = calculatePointMoves({
    han,
    dealerId: engine.state.dealerId,
    winnerId,
    isTsumo,
    fromPlayer,
    warePlayer: engine.state.warePlayer,
    isFever,
  });

  // 点数を実際に動かす
  for (const p of engine.state.players) {
    p.score += pointResult.moves[p.id] || 0;
  }
  // リーチ棒を和了者が回収
  const reachBonus = engine.state.reachSticks * 1000;
  if (winner) winner.score += reachBonus;
  // リーチ棒は使い切ったので 0 にリセット
  const consumedReachSticks = engine.state.reachSticks;
  engine.state.reachSticks = 0;

  // チップ移動を計算して反映（① 一索/一萬/九萬、② 裏ドラ、③ 役満）
  const chipResult = calculateChipMoves({
    state: engine.state,
    agariResult,
    winnerId,
    isTsumo,
    fromPlayer,
    isReached: wasReached,
    ipatsuActive: wasIpatsu,
  });
  for (const p of engine.state.players) {
    p.chips += chipResult.moves[p.id] || 0;
  }

  // アガリ画面用のビューを構築して全員にブロードキャスト
  const view = agariView(
    engine.state,
    agariResult,
    winnerId,
    isTsumo,
    fromPlayer,
    pointResult,
    reachBonus,
    chipResult,
    isFever
  );
  io.to(roomChannel(room.id)).emit(S2C.GAME_AGARI, view);

  // 公開状態も最終的に更新
  io.to(roomChannel(room.id)).emit(
    S2C.GAME_STATE_UPDATE,
    publicGameView(engine.state, room)
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

  console.log(`[アガリ] roomId=${room.id} winner=${winnerId} ${isTsumo ? 'ツモ' : `ロン from ${fromPlayer}`} han=${han} basePoint=${pointResult.basePoint} FEVER=${isFever}`);
}

// -----------------------------------------------------------------
// 北抜きを実行 → 嶺上ツモ → 鳴き応答チェック（kita-claim）
//   1. engine.doKitaPull で北を抜く（嶺上ツモも実行）
//   2. 中・發ボーナス判定（リーチ後一発時のみ）
//   3. game:action-result で全員に通知
//   4. 他家の北抜き応答（pon/kan）をチェック → あれば kita-claim 開始
//   5. 鳴きがなければ本人のターン継続
// isAuto=true なら FEVER 強制北抜き経由（鳴き応答後も北が残ってればまた抜く）
// -----------------------------------------------------------------
function doKitaInRoom(io, room, playerId, isAuto) {
  const engine = room.gameEngine;
  const rinshanTile = engine.doKitaPull(playerId);
  if (rinshanTile === null) return false;

  // 中・發ボーナス判定（リーチ後一発ツモのみ）→ ただし北抜き時の rinshan ツモには
  // 適用しない（仕様書 8. は「リーチ後の一発ツモ」を指す）。北抜きは独立処理。
  // → ここでは何もしない。

  io.to(roomChannel(room.id)).emit(S2C.GAME_ACTION_RESULT, {
    action: 'kita',
    playerId,
    tile: 'z4',
    isAuto,
  });
  io.to(roomChannel(room.id)).emit(
    S2C.GAME_STATE_UPDATE,
    publicGameView(engine.state, room)
  );

  // 他家の北抜き応答チェック
  const kitaEligible = new Map();
  for (const p of engine.state.players) {
    if (p.id === playerId) continue;
    const canPon = engine.canPonOnKita(p.id);
    const canKan = engine.canKanOnKita(p.id);
    if (canPon || canKan) kitaEligible.set(p.id, { canPon, canKan });
  }

  if (kitaEligible.size === 0) {
    // 鳴きなし → 本人ターン継続
    continueAfterKita(io, room, playerId, isAuto);
    return true;
  }

  room.pendingClaim = {
    type: 'kita',
    fromPlayerId: playerId,
    isAuto,
    eligible: kitaEligible,
    responses: new Map(),
    timeoutId: null,
  };

  for (const [pid, opt] of kitaEligible) {
    const claimOptions = [];
    if (opt.canPon) claimOptions.push('kita-pon');
    if (opt.canKan) claimOptions.push('kita-kan');
    claimOptions.push('skip');
    const rp = room.players.find((p) => p.id === pid);
    if (rp && rp.socketId) {
      io.to(rp.socketId).emit(S2C.GAME_WAITING_CLAIM, {
        type: 'kita',
        fromPlayer: playerId,
        tile: 'z4',
        options: claimOptions,
        timeoutMs: CLAIM_TIMEOUT_MS,
      });
    }
  }

  room.pendingClaim.timeoutId = setTimeout(() => {
    resolveKitaClaim(io, room);
  }, CLAIM_TIMEOUT_MS);

  // CPU 対象者の自動応答（ソロ練習用）
  scheduleCpuClaims(io, room);

  console.log(`[北抜き応答待ち] roomId=${room.id} 抜いた人=${playerId} 対象=${[...kitaEligible.keys()].join(',')}`);
  return true;
}

function tryResolveKitaClaim(io, room) {
  const claim = room.pendingClaim;
  if (!claim || claim.type !== 'kita') return;
  const allResponded = [...claim.eligible.keys()].every((pid) => claim.responses.has(pid));
  if (allResponded) {
    if (claim.timeoutId) clearTimeout(claim.timeoutId);
    resolveKitaClaim(io, room);
  }
}

function resolveKitaClaim(io, room) {
  const claim = room.pendingClaim;
  if (!claim || claim.type !== 'kita') return;
  if (claim.timeoutId) clearTimeout(claim.timeoutId);
  room.pendingClaim = null;
  const engine = room.gameEngine;

  // 優先順位: kan > pon
  const order = ['P0', 'P1', 'P2'];
  const fromIdx = order.indexOf(claim.fromPlayerId);
  const sortedPids = [order[(fromIdx + 1) % 3], order[(fromIdx + 2) % 3]]
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
    // 誰も鳴かなかった → 抜いた本人のターン継続
    continueAfterKita(io, room, claim.fromPlayerId, claim.isAuto);
    return;
  }

  // 北ポン or 北カンを実行
  if (winner.action === 'pon') {
    engine.doPonOnKita(winner.playerId, claim.fromPlayerId);
  } else {
    engine.doKanOnKita(winner.playerId, claim.fromPlayerId);
  }
  io.to(roomChannel(room.id)).emit(S2C.GAME_ACTION_RESULT, {
    action: winner.action === 'pon' ? 'kita-pon' : 'kita-kan',
    playerId: winner.playerId,
    fromPlayer: claim.fromPlayerId,
    tile: 'z4',
  });
  // 鳴いた本人に手牌＋打牌可能通知
  const claimerRoomPlayer = room.players.find((p) => p.id === winner.playerId);
  if (claimerRoomPlayer && claimerRoomPlayer.socketId) {
    io.to(claimerRoomPlayer.socketId).emit(
      S2C.GAME_YOUR_HAND,
      privateHandView(engine.state, winner.playerId)
    );
    if (winner.action === 'kan') {
      // 北カンは嶺上ツモが必要
      const rinshanTile = engine.drawRinshan(winner.playerId);
      io.to(claimerRoomPlayer.socketId).emit(
        S2C.GAME_YOUR_HAND,
        privateHandView(engine.state, winner.playerId)
      );
    }
    io.to(claimerRoomPlayer.socketId).emit(
      S2C.GAME_YOUR_TURN,
      buildYourTurnPayloadAfterCall(engine, winner.playerId)
    );
  }
  io.to(roomChannel(room.id)).emit(
    S2C.GAME_STATE_UPDATE,
    publicGameView(engine.state, room)
  );
  // 北抜きを鳴いた本人が CPU なら自動行動
  const winnerEnginePlayer = engine.state.players.find((p) => p.id === winner.playerId);
  if (winnerEnginePlayer && winnerEnginePlayer.isCpu) {
    scheduleCpuTurn(io, room, winner.playerId);
  }
  console.log(`[北抜き応答成立] roomId=${room.id} ${winner.action}=${winner.playerId} from=${claim.fromPlayerId}`);
}

// 北抜き後、鳴きが入らなかった場合に本人のターンを継続
function continueAfterKita(io, room, playerId, isAuto) {
  const engine = room.gameEngine;
  const player = engine.state.players.find((p) => p.id === playerId);
  // FEVER 強制経由 or CPU で、まだ手牌に北が残っていれば再度北抜き
  const needsForcedKita = isAuto && engine.hasOtherFever(playerId) && !player.isReached && engine.hasKita(playerId);
  const cpuStillHasKita = player.isCpu && !player.isReached && engine.hasKita(playerId);
  if (needsForcedKita || cpuStillHasKita) {
    doKitaInRoom(io, room, playerId, /*isAuto=*/needsForcedKita);
    return;
  }
  // 通常: 本人にツモ済の手牌+ターン通知
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
  io.to(roomChannel(room.id)).emit(
    S2C.GAME_STATE_UPDATE,
    publicGameView(engine.state, room)
  );
  // CPU の場合は次の行動をスケジュール
  if (player.isCpu) {
    scheduleCpuTurn(io, room, playerId);
  }
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
    publicGameView(engine.state, room)
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
  // 次局も CPU フラグを引き継ぐ（ソロ練習の CPU、および前局終了時に代打中だった人）
  // 引き継がないと、ソロモードで2局目が止まる／代打中プレイヤーのターンが永久待機になる
  const playerIsCpu = room.players.map((p) => !!p.isCpu || !!p.cpuTakeover);
  const newEngine = new GameEngine();
  newEngine.init(
    {
      scores, chips,
      roundWind: nextRound, hand: nextHand, honba: nextHonba,
      reachSticks: nextReachSticks, dealerId: nextDealerId,
    },
    { playerNames, playerIsCpu }
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
  // 各プレイヤーに順位（1〜3）を付与
  const rankMap = {};
  ranking.forEach((r, idx) => { rankMap[r.id] = idx + 1; });

  io.to(roomChannel(room.id)).emit(S2C.GAME_GAME_END, {
    reason, // 'all-hands-done' | 'tobi'
    tobiPlayer: tobiPlayer || null,
    finalScores,
    ranking,
  });
  room.state = 'ended';

  // フェーズ7: 戦績を DB に書き込む
  // room.statsStore は startGameInRoom 直前に registerHandlers のクロージャから注入される
  const statsStore = room.statsStore || null;
  if (statsStore) {
    try {
      const players = engine.state.players.map((p, i) => {
        const roomPlayer = room.players[i];
        const stats = (room.gameStats && room.gameStats[p.id]) || { yakumanCount: 0, feverCount: 0 };
        return {
          id: roomPlayer ? roomPlayer.persistentPlayerId : null,
          name: p.name,
          score: p.score,
          chips: p.chips,
          rank: rankMap[p.id] || 3,
          // CPU 代打中の対局は本人の戦績として残らないように isCpu 扱いする
          isCpu: !!roomPlayer && (!!roomPlayer.isCpu || !!roomPlayer.cpuTakeover),
          yakumanCount: stats.yakumanCount,
          feverCount: stats.feverCount,
        };
      });
      const gameId = statsStore.recordGame({
        roomId: room.id,
        endReason: reason,
        endedAt: Date.now(),
        players,
      });
      if (gameId) {
        console.log(`[戦績記録] gameId=${gameId} 終了理由=${reason}`);
      }
    } catch (err) {
      console.warn(`[戦績記録] 失敗: ${err.message}`);
    }
  }
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
    publicGameView(engine.state, room)
  );
}

// 退室共通処理: 残メンバーに通知 or 部屋削除 or CPU 代打タイマー起動
function handleLeave(io, socket, roomManager, reason) {
  const result = roomManager.leaveRoom(socket.id);
  if (!result) return;
  const { room, removedPlayer, roomDeleted } = result;

  if (roomDeleted) {
    console.log(`[部屋削除] 全員退室により削除 (player=${removedPlayer.name})`);
    return;
  }
  if (!room) return;

  // 対局中（in-game / hand-end）の切断: CPU 代打タイマーを起動
  if (room.state === 'in-game' || room.state === 'hand-end') {
    io.to(roomChannel(room.id)).emit(S2C.GAME_PLAYER_DISCONNECTED, {
      playerId: removedPlayer.id,
      name: removedPlayer.name,
      willCpuTakeoverInMs: RECONNECT_GRACE_MS,
    });
    scheduleCpuTakeover(io, room, removedPlayer.id, roomManager);
    console.log(`[切断] roomId=${room.id} player=${removedPlayer.name} 30秒以内に再接続無ければ CPU 代打 / 理由=${reason}`);
    return;
  }

  // 待機中の退室: ロビー通知
  io.to(roomChannel(room.id)).emit(S2C.LOBBY_PLAYER_LEFT, {
    playerId: removedPlayer.id,
    room: roomManager.publicView(room),
  });
  console.log(`[退室] roomId=${room.id} player=${removedPlayer.name} (${removedPlayer.id}) 理由=${reason}`);
}

// 30 秒後に CPU 代打を確定するタイマー
function scheduleCpuTakeover(io, room, playerId, roomManager) {
  if (!room.cpuTakeoverTimers) room.cpuTakeoverTimers = {};
  // 既存のタイマーがあればキャンセル（再度切断された場合のため）
  if (room.cpuTakeoverTimers[playerId]) clearTimeout(room.cpuTakeoverTimers[playerId]);
  room.cpuTakeoverTimers[playerId] = setTimeout(() => {
    delete room.cpuTakeoverTimers[playerId];
    applyCpuTakeover(io, room, playerId, roomManager);
  }, RECONNECT_GRACE_MS);
}

// CPU 代打を実際に開始する（30 秒経過 or 即時で）
function applyCpuTakeover(io, room, playerId, roomManager) {
  const engine = room.gameEngine;
  if (!engine) return;
  const enginePlayer = engine.state.players.find((p) => p.id === playerId);
  if (!enginePlayer) return;
  // 既に CPU 代打中なら何もしない
  if (enginePlayer.isCpu) return;

  enginePlayer.isCpu = true;
  const roomPlayer = room.players.find((p) => p.id === playerId);
  if (roomPlayer) {
    roomPlayer.cpuTakeover = true;
    // トークンを無効化（30秒過ぎたらもう復帰不可・別席が空くまで）
    if (roomPlayer.token) roomManager.invalidateToken(roomPlayer.token);
  }

  io.to(roomChannel(room.id)).emit(S2C.GAME_CPU_TAKEOVER, {
    playerId,
    name: enginePlayer.name,
  });
  console.log(`[CPU 代打開始] roomId=${room.id} player=${playerId} (${enginePlayer.name})`);

  // 自分のターンで止まっていたら即 CPU 行動
  if (engine.state.currentTurn === playerId && !room.pendingClaim && room.state === 'in-game') {
    scheduleCpuTurn(io, room, playerId);
  }
  // 鳴き応答中で対象なら CPU 判断
  if (room.pendingClaim && room.pendingClaim.eligible && room.pendingClaim.eligible.has(playerId)) {
    setTimeout(() => decideCpuClaim(io, room, playerId), 200);
  }
}

module.exports = { registerHandlers };
