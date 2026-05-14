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

      // 3人揃ったらゲーム開始を全員に通知
      if (isFull) {
        io.to(roomChannel(room.id)).emit(S2C.GAME_START, {
          roomId: room.id,
          players: room.players.map((p) => ({ id: p.id, name: p.name })),
        });
        console.log(`[対局開始] roomId=${room.id}`);
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
  // 切断: タブを閉じた・ネットワーク切れ等
  // -----------------------------------------------------------------
  socket.on('disconnect', (reason) => {
    handleLeave(io, socket, roomManager, `切断: ${reason}`);
  });
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
