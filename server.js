// ============================================================
// FEVER MJ オンライン対戦サーバー
// フェーズ1: 最小起動コード（Express + Socket.IO の骨格のみ）
// ============================================================
// このファイルがサーバーの入口です。
//   ・Express: ブラウザに HTML/JS/CSS を配信する Web サーバー
//   ・Socket.IO: ブラウザとサーバーがリアルタイムで通信する仕組み
// ============================================================

// .env ファイルから環境変数を読み込む
require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

// Express アプリと、その上に被せる HTTP サーバーを作成
const app = express();
const server = http.createServer(app);

// Socket.IO を HTTP サーバーに接続
// cors: ブラウザのセキュリティ制限の設定（開発中は全許可で OK）
const io = new Server(server, {
  cors: { origin: '*' },
});

// ------------------------------------------------------------
// 静的ファイル配信
// public フォルダの中身をブラウザから直接見えるようにする
//   例: public/index.html → http://localhost:3000/
//       public/play.html  → http://localhost:3000/play.html
// ------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------
// ヘルスチェック用エンドポイント
// 本番（Render など）でスリープ防止のために定期的に叩かれる
// ------------------------------------------------------------
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ------------------------------------------------------------
// WebSocket 接続イベント
// フェーズ1では「接続したよ」「切断したよ」をログに出すだけ
// フェーズ2以降で部屋作成・打牌などのイベントを追加していく
// ------------------------------------------------------------
io.on('connection', (socket) => {
  console.log(`[接続] ${socket.id}`);

  socket.on('disconnect', (reason) => {
    console.log(`[切断] ${socket.id} (理由: ${reason})`);
  });
});

// ------------------------------------------------------------
// サーバー起動
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('==============================================');
  console.log('  FEVER MJ サーバーが起動しました');
  console.log(`  ロビー: http://localhost:${PORT}/`);
  console.log(`  対局:   http://localhost:${PORT}/play.html`);
  console.log('  停止: Ctrl + C');
  console.log('==============================================');
});
