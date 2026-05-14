// ============================================================
// public/js/socket-client.js
// サーバーとの WebSocket 接続を担当（クライアント側）
// フェーズ1: 接続確認だけ。フェーズ3 以降で部屋作成・参加などのイベント追加。
// ============================================================

(function () {
  const statusEl = document.getElementById('connStatus');
  if (typeof io === 'undefined') {
    if (statusEl) {
      statusEl.textContent = 'Socket.IO 読み込み失敗';
      statusEl.classList.add('error');
    }
    return;
  }

  const socket = io();

  socket.on('connect', () => {
    if (statusEl) {
      statusEl.textContent = `✅ 接続OK  (ID: ${socket.id.slice(0, 6)}...)`;
      statusEl.classList.remove('error');
    }
    console.log('[socket] connected', socket.id);
  });

  socket.on('disconnect', (reason) => {
    if (statusEl) {
      statusEl.textContent = `⚠ 切断 (${reason})`;
      statusEl.classList.add('error');
    }
    console.log('[socket] disconnected', reason);
  });

  socket.on('connect_error', (err) => {
    if (statusEl) {
      statusEl.textContent = `❌ 接続エラー: ${err.message}`;
      statusEl.classList.add('error');
    }
    console.error('[socket] connect_error', err);
  });

  // フェーズ3以降で公開する送信用 API（暫定）
  window.feverMjSocket = socket;
})();
