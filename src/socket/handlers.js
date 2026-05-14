// ============================================================
// src/socket/handlers.js
// Socket.IO イベントハンドラの集約。
// connection ごとに登録する各種ハンドラ（部屋作成・打牌など）をここに書く。
// フェーズ3 以降で実装を埋めていく。
// ============================================================

// const { C2S, S2C } = require('./events');

function registerHandlers(io, socket) {
  // 各イベントの受信ハンドラはフェーズ3以降で追加
}

module.exports = { registerHandlers };
