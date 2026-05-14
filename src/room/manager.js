// ============================================================
// src/room/manager.js
// 部屋（ルーム）の作成・参加・退室・自動削除を管理する。
// 状態はすべてメモリ上で保持（プロセス再起動で消えるが、フェーズ3 では十分）。
// ============================================================
// 仕様（設計書「6. 部屋管理フロー」より）:
//   - 合言葉（パスワード）で部屋を識別
//   - 3人揃ったら自動で 'starting' 状態に遷移
//   - 30分間誰も参加しなければ自動削除
//   - 各プレイヤーには再接続用 token を発行
// ============================================================

const crypto = require('node:crypto');

// 30分間誰も参加しなければ削除
const ROOM_EXPIRE_MS = 30 * 60 * 1000;
// 3人麻雀
const MAX_PLAYERS = 3;
// 待機中のプレイヤーID（先着順に割り当て）
const PLAYER_IDS = ['P0', 'P1', 'P2'];

// uuid 形式のランダム ID を生成（部屋ID・トークン用）
function generateId() {
  return crypto.randomUUID();
}

class RoomManager {
  constructor(options = {}) {
    // 部屋ID → 部屋データ
    this.rooms = new Map();
    // ソケットID → { roomId, playerId, token }（接続中ソケットの逆引き）
    this.socketToRoom = new Map();
    // トークン → { roomId, playerId }（再接続用の逆引き）
    this.tokenToPlayer = new Map();

    // テストで時間・ID を固定できるように注入可能にしておく
    this.now = options.now || (() => Date.now());
    this.idGen = options.idGen || generateId;
  }

  // 部屋を新規作成。同じ合言葉の待機中部屋があればエラー。
  createRoom({ password, name, socketId }) {
    if (!password) throw new Error('合言葉を入力してください。');
    if (!name) throw new Error('名前を入力してください。');

    // 同じ合言葉の待機中部屋を確認（衝突時はエラー）
    for (const room of this.rooms.values()) {
      if (room.password === password && room.state === 'waiting') {
        throw new Error('その合言葉の部屋は既に存在します。「部屋に入る」から参加してください。');
      }
    }

    const roomId = this.idGen();
    const token = this.idGen();
    const playerId = PLAYER_IDS[0];

    const player = {
      id: playerId,
      socketId,
      name,
      token,
      connected: true,
    };

    const room = {
      id: roomId,
      password,
      createdAt: this.now(),
      // 'waiting' | 'starting' | 'in-game' | 'ended'
      state: 'waiting',
      players: [player],
    };

    this.rooms.set(roomId, room);
    this.socketToRoom.set(socketId, { roomId, playerId, token });
    this.tokenToPlayer.set(token, { roomId, playerId });

    return { room, player, token, playerId };
  }

  // 既存の部屋に参加。合言葉一致する待機部屋がなければエラー。
  // 3人揃ったら state を 'starting' に遷移。
  joinRoom({ password, name, socketId }) {
    if (!password) throw new Error('合言葉を入力してください。');
    if (!name) throw new Error('名前を入力してください。');

    let targetRoom = null;
    for (const room of this.rooms.values()) {
      if (room.password === password && room.state === 'waiting') {
        targetRoom = room;
        break;
      }
    }
    if (!targetRoom) {
      throw new Error('その合言葉の部屋は見つかりませんでした。');
    }
    if (targetRoom.players.length >= MAX_PLAYERS) {
      throw new Error('その部屋はすでに満員です。');
    }

    // 未使用のプレイヤーID を割り当て（P0 → P1 → P2 の順）
    const used = new Set(targetRoom.players.map((p) => p.id));
    const playerId = PLAYER_IDS.find((id) => !used.has(id));

    const token = this.idGen();
    const player = {
      id: playerId,
      socketId,
      name,
      token,
      connected: true,
    };
    targetRoom.players.push(player);

    this.socketToRoom.set(socketId, { roomId: targetRoom.id, playerId, token });
    this.tokenToPlayer.set(token, { roomId: targetRoom.id, playerId });

    // 3人揃ったらゲーム開始準備状態へ
    const isFull = targetRoom.players.length >= MAX_PLAYERS;
    if (isFull) {
      targetRoom.state = 'starting';
    }

    return { room: targetRoom, player, token, playerId, isFull };
  }

  // 退室処理。
  //   - 待機中（waiting）: プレイヤーを取り除く。空になったら部屋ごと削除。
  //   - 開始済み（starting / in-game）: プレイヤーは残し、connected を false に
  //     （再接続用。フェーズ6 で活用予定）
  leaveRoom(socketId) {
    const link = this.socketToRoom.get(socketId);
    if (!link) return null;

    const room = this.rooms.get(link.roomId);
    this.socketToRoom.delete(socketId);
    if (!room) return null;

    const idx = room.players.findIndex((p) => p.socketId === socketId);
    if (idx < 0) return null;
    const removedPlayer = room.players[idx];

    if (room.state === 'waiting') {
      // 待機中なら配列から取り除く
      this.tokenToPlayer.delete(removedPlayer.token);
      room.players.splice(idx, 1);

      if (room.players.length === 0) {
        this.rooms.delete(room.id);
        return { room: null, removedPlayer, roomDeleted: true };
      }
      return { room, removedPlayer, roomDeleted: false };
    }

    // 対局中は接続フラグだけ落とす（再接続を待つ）
    removedPlayer.connected = false;
    removedPlayer.socketId = null;
    return { room, removedPlayer, roomDeleted: false };
  }

  // ソケットID から所属部屋を取得（無ければ null）
  getRoomBySocketId(socketId) {
    const link = this.socketToRoom.get(socketId);
    if (!link) return null;
    return this.rooms.get(link.roomId) || null;
  }

  // 公開してよい情報だけを抜き出す（他人のトークン・ソケットID は隠す）
  publicView(room) {
    return {
      id: room.id,
      state: room.state,
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
      })),
    };
  }

  // 期限切れ部屋を削除（state === 'waiting' のみ対象）
  // 戻り値: 削除した部屋IDの配列
  cleanupExpiredRooms() {
    const now = this.now();
    const expired = [];
    for (const [id, room] of this.rooms) {
      if (room.state === 'waiting' && now - room.createdAt > ROOM_EXPIRE_MS) {
        expired.push(id);
      }
    }
    for (const id of expired) {
      const room = this.rooms.get(id);
      for (const p of room.players) {
        this.tokenToPlayer.delete(p.token);
        if (p.socketId) this.socketToRoom.delete(p.socketId);
      }
      this.rooms.delete(id);
    }
    return expired;
  }

  // テスト・ステータス確認用
  roomCount() {
    return this.rooms.size;
  }
}

module.exports = {
  RoomManager,
  ROOM_EXPIRE_MS,
  MAX_PLAYERS,
  PLAYER_IDS,
};
