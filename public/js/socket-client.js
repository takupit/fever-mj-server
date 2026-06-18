// ============================================================
// public/js/socket-client.js
// サーバーとの WebSocket 接続を管理するクライアント側の入口。
// 接続状態を window.feverMj に集約し、他の JS（lobby.js など）が利用する。
// ============================================================

(function () {
  // ローカルストレージのキー
  const STORAGE_KEY = 'feverMj.player';
  const PID_KEY = 'feverMj.persistentPlayerId'; // フェーズ7: 戦績集計用の永続ID
  const SIG_KEY = 'feverMj.playerSig';          // ステージC: 永続IDの署名（なりすまし対策）

  // 永続ID の署名（HMAC）を保存・取得。
  // サーバーが lobby:room-created / lobby:room-joined のレスポンスで発行する。
  function loadPlayerSig() {
    try { return localStorage.getItem(SIG_KEY) || null; } catch (e) { return null; }
  }
  function savePlayerSig(sig) {
    try {
      if (sig) localStorage.setItem(SIG_KEY, sig);
    } catch (e) { /* ignore */ }
  }

  // 永続プレイヤーID（このブラウザ固有のUUID）を取得 or 新規発行
  // 戦績記録のキーとして使う。クリアされなければずっと同じ。
  function getOrCreatePersistentPlayerId() {
    try {
      let id = localStorage.getItem(PID_KEY);
      if (!id || id.length < 8) {
        // crypto.randomUUID() は HTTPS / localhost で利用可能。それ以外は手書きで作る
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
          id = crypto.randomUUID();
        } else {
          // フォールバック: ランダムな英数字 16 桁
          id = Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
        }
        localStorage.setItem(PID_KEY, id);
      }
      return id;
    } catch (e) {
      console.warn('[stats] persistent ID の永続化失敗（localStorage 不可？）:', e);
      return null;
    }
  }

  // 接続状態の保存
  const state = {
    socket: null,
    connected: false,
    // 部屋参加後にサーバーから受け取る情報
    roomId: null,
    playerId: null,        // 対局中の席ID (P0/P1/P2)
    token: null,           // 再接続用トークン（部屋ごとに一回）
    playerName: null,
    persistentPlayerId: getOrCreatePersistentPlayerId(), // 戦績用の永続UUID
    playerSig: loadPlayerSig(),                          // 永続UUID の HMAC 署名
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
      // フェーズ6: 自動再接続を試みる（localStorage にトークンが残っていれば）
      const session = loadSession();
      if (session && session.token && session.roomId) {
        socket.emit('game:reconnect', { token: session.token });
      }
    });
    socket.on('disconnect', (reason) => {
      state.connected = false;
      emitLocal('disconnected', { reason });
    });
    socket.on('connect_error', (err) => {
      state.connected = false;
      emitLocal('connect_error', { message: err.message });
    });

    // サーバーからのイベントを listeners に転送
    [
      // ロビー系
      'lobby:room-created',
      'lobby:room-joined',
      'lobby:player-joined',
      'lobby:player-left',
      'lobby:error',
      // 対局系
      'game:start',
      'game:your-hand',
      'game:state-update',
      'game:your-turn',
      'game:waiting-claim',
      'game:action-result',
      'game:agari',
      'game:ryukyoku',
      'game:hand-end',
      'game:game-end',
      'game:tobi',
      // フェーズ6: 切断・再接続・CPU 代打通知
      'game:player-disconnected',
      'game:player-reconnected',
      'game:cpu-takeover',
    ].forEach((evt) => {
      socket.on(evt, (payload) => {
        // 部屋情報を受け取ったらクライアント側状態を更新
        if (evt === 'lobby:room-created' || evt === 'lobby:room-joined') {
          state.roomId = payload.roomId;
          state.playerId = payload.playerId;
          state.token = payload.token;
          // サーバーが発行した新しい署名を localStorage に保存（初回 or 再発行）
          if (payload.playerSig) {
            state.playerSig = payload.playerSig;
            savePlayerSig(payload.playerSig);
          }
          saveSession();
        }
        emitLocal(evt, payload);
      });
    });
  }

  // サーバーへ送信するためのヘルパー（接続前でも安全に呼べるよう socket.connected を確認）
  // すべての送信に persistentPlayerId を含めて、戦績集計のキーにする
  function sendCreateRoom({ name, password }) {
    state.playerName = name;
    state.socket.emit('lobby:create-room', {
      name, password,
      persistentPlayerId: state.persistentPlayerId,
      playerSig: state.playerSig,
    });
  }
  function sendJoinRoom({ name, password }) {
    state.playerName = name;
    state.socket.emit('lobby:join-room', {
      name, password,
      persistentPlayerId: state.persistentPlayerId,
      playerSig: state.playerSig,
    });
  }
  function sendCreateSoloRoom({ name }) {
    state.playerName = name;
    state.socket.emit('lobby:create-solo-room', {
      name,
      persistentPlayerId: state.persistentPlayerId,
      playerSig: state.playerSig,
    });
  }
  function sendLeaveRoom() {
    if (state.socket) state.socket.emit('lobby:leave-room', {});
  }
  // 対局中のアクション群
  function sendDiscard({ tile, handIdx }) {
    if (!state.socket) return;
    state.socket.emit('game:discard', { tile, handIdx });
  }
  function sendPon() {
    if (!state.socket) return;
    state.socket.emit('game:pon', {});
  }
  // type: 'ankan' | 'kakan' | 'minkan'
  function sendKan({ type, tile }) {
    if (!state.socket) return;
    state.socket.emit('game:kan', { type, tile });
  }
  function sendReach({ tile, handIdx }) {
    if (!state.socket) return;
    state.socket.emit('game:reach', { tile, handIdx });
  }
  function sendSkip() {
    if (!state.socket) return;
    state.socket.emit('game:skip', {});
  }
  function sendTsumo() {
    if (!state.socket) return;
    state.socket.emit('game:tsumo', {});
  }
  function sendRon() {
    if (!state.socket) return;
    state.socket.emit('game:ron', {});
  }
  function sendNextHand() {
    if (!state.socket) return;
    state.socket.emit('game:next-hand', {});
  }
  // フェーズ6: 明示的に再接続を要求（自動再接続と同じ動作）
  function sendReconnect(token) {
    if (!state.socket) return;
    state.socket.emit('game:reconnect', { token });
  }
  function sendKita() {
    if (!state.socket) return;
    state.socket.emit('game:kita', {});
  }
  function sendKitaPon() {
    if (!state.socket) return;
    state.socket.emit('game:kita-pon', {});
  }
  function sendKitaKan() {
    if (!state.socket) return;
    state.socket.emit('game:kita-kan', {});
  }

  // 他のスクリプトから使える API を window に公開
  window.feverMj = {
    state,
    on,
    connect,
    sendCreateRoom,
    sendJoinRoom,
    sendCreateSoloRoom,
    sendLeaveRoom,
    sendDiscard,
    sendPon,
    sendKan,
    sendReach,
    sendSkip,
    sendTsumo,
    sendRon,
    sendNextHand,
    sendKita,
    sendKitaPon,
    sendKitaKan,
    sendReconnect,
    clearSession,
    loadSession,
  };

  // ページ読み込み時に自動接続
  connect();
})();
