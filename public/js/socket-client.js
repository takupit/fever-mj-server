// ============================================================
// public/js/socket-client.js
// サーバーとの WebSocket 接続を管理するクライアント側の入口。
// 接続状態を window.feverMj に集約し、他の JS（lobby.js など）が利用する。
// ============================================================

(function () {
  // ローカルストレージのキー
  const STORAGE_KEY = 'feverMj.player';

  // 接続状態の保存
  const state = {
    socket: null,
    connected: false,
    // 部屋参加後にサーバーから受け取る情報
    roomId: null,
    playerId: null,
    token: null,
    playerName: null,
  };

  // 接続状態の変化や、サーバーからのイベントを画面に伝えるためのハブ
  const listeners = new Map(); // event名 → Set<callback>
  function on(event, cb) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(cb);
    return () => listeners.get(event).delete(cb);
  }
  function emitLocal(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      try { cb(payload); } catch (e) { console.error('[listener error]', event, e); }
    }
  }

  // localStorage に token などを保存/読み込み（再接続用・フェーズ6 で活用）
  function saveSession() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        roomId: state.roomId,
        playerId: state.playerId,
        token: state.token,
        playerName: state.playerName,
      }));
    } catch (e) {
      // localStorage が無効でも致命的ではない
      console.warn('[session] localStorage 保存失敗:', e);
    }
  }
  function loadSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function clearSession() {
    state.roomId = null;
    state.playerId = null;
    state.token = null;
    state.playerName = null;
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }

  // Socket.IO 接続を確立し、サーバーからのイベントを listeners 経由で配信
  function connect() {
    if (typeof io === 'undefined') {
      console.error('[socket] Socket.IO クライアントが読み込まれていません');
      emitLocal('connect_error', { message: 'Socket.IO 読み込み失敗' });
      return;
    }
    const socket = io();
    state.socket = socket;

    socket.on('connect', () => {
      state.connected = true;
      emitLocal('connected', { socketId: socket.id });
    });
    socket.on('disconnect', (reason) => {
      state.connected = false;
      emitLocal('disconnected', { reason });
    });
    socket.on('connect_error', (err) => {
      state.connected = false;
      emitLocal('connect_error', { message: err.message });
    });

    // ロビー系のイベントを listeners に転送
    [
      'lobby:room-created',
      'lobby:room-joined',
      'lobby:player-joined',
      'lobby:player-left',
      'lobby:error',
      'game:start',
    ].forEach((evt) => {
      socket.on(evt, (payload) => {
        // 部屋情報を受け取ったらクライアント側状態を更新
        if (evt === 'lobby:room-created' || evt === 'lobby:room-joined') {
          state.roomId = payload.roomId;
          state.playerId = payload.playerId;
          state.token = payload.token;
          saveSession();
        }
        emitLocal(evt, payload);
      });
    });
  }

  // サーバーへ送信するためのヘルパー（接続前でも安全に呼べるよう socket.connected を確認）
  function sendCreateRoom({ name, password }) {
    state.playerName = name;
    state.socket.emit('lobby:create-room', { name, password });
  }
  function sendJoinRoom({ name, password }) {
    state.playerName = name;
    state.socket.emit('lobby:join-room', { name, password });
  }
  function sendLeaveRoom() {
    if (state.socket) state.socket.emit('lobby:leave-room', {});
  }

  // 他のスクリプトから使える API を window に公開
  window.feverMj = {
    state,
    on,
    connect,
    sendCreateRoom,
    sendJoinRoom,
    sendLeaveRoom,
    clearSession,
    loadSession,
  };

  // ページ読み込み時に自動接続
  connect();
})();
