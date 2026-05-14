// ============================================================
// FEVER MJ オンライン対戦サーバー
// フェーズ3: ロビー＋3人マッチング機能
// ============================================================
// このファイルがサーバーの入口です。
//   ・Express:   ブラウザに HTML/JS/CSS を配信する Web サーバー
//   ・Socket.IO: ブラウザとサーバーがリアルタイムで通信する仕組み
//   ・RoomManager: 合言葉部屋の作成・参加・退室管理（src/room/manager.js）
// ============================================================

// .env ファイルから環境変数を読み込む
require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const { RoomManager } = require('./src/room/manager');
const { registerHandlers } = require('./src/socket/handlers');

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
// ヘルスチェック用エンドポイント（Render など本番のスリープ防止）
// ------------------------------------------------------------
app.get('/healthz', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    rooms: roomManager.roomCount(),
  });
});

// ------------------------------------------------------------
// 部屋管理（RoomManager）を1つ作って、全 socket で共有する
// ------------------------------------------------------------
const roomManager = new RoomManager();

// 1分おきに期限切れ部屋（30分間誰も参加しない待機部屋）を削除
const CLEANUP_INTERVAL_MS = 60 * 1000;
setInterval(() => {
  const cleaned = roomManager.cleanupExpiredRooms();
  if (cleaned.length > 0) {
    console.log(`[クリーンアップ] 期限切れの部屋を ${cleaned.length} 件削除`);
  }
}, CLEANUP_INTERVAL_MS);

// ------------------------------------------------------------
// WebSocket 接続イベント
// 1つの socket（= 1つのブラウザタブ）が繋がるたびに、
// この中でロビーや対局のイベントハンドラを登録する。
// ------------------------------------------------------------
io.on('connection', (socket) => {
  console.log(`[接続] ${socket.id}`);
  registerHandlers(io, socket, roomManager);
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
