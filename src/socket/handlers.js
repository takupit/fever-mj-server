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
  // 河に置く。鳴き応答は step 2（4c）で実装するので、ここでは即座に次のターンへ進む。
  // -----------------------------------------------------------------
  socket.on(C2S.GAME_DISCARD, (payload, ack) => {
    try {
      const room = roomManager.getRoomBySocketId(socket.id);
      if (!room || !room.gameEngine) {
        throw new Error('対局がまだ開始されていません。');
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
      });

      // 公開状態を更新（河に1枚追加）
      io.to(roomChannel(room.id)).emit(
        S2C.GAME_STATE_UPDATE,
        publicGameView(engine.state)
      );

      // 次のターンへ進める（step 2 で鳴き応答待ちを挿入予定）
      progressToNextTurn(io, room);

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
    io.to(roomPlayer.socketId).emit(S2C.GAME_YOUR_TURN, {
      drawnTile: engine.state.drawnTile,
      // step 2 以降で 'pon', 'kan', 'reach', 'tsumo', 'kita' を増やす
      options: ['discard'],
    });
  }

  // 山が1枚減ったので公開状態を再ブロードキャスト
  io.to(roomChannel(room.id)).emit(
    S2C.GAME_STATE_UPDATE,
    publicGameView(engine.state)
  );
}

// 次のプレイヤーへターンを進める（打牌後に呼ぶ）
function progressToNextTurn(io, room) {
  const engine = room.gameEngine;
  engine.nextTurn();
  startTurnFor(io, room, engine.state.currentTurn);
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
