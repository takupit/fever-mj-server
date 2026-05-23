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
const { StatsStore } = require('./src/db/stats');

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
//       public/stats.html → http://localhost:3000/stats.html
// ------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------
// 戦績ストアの初期化（フェーズ7）
// 失敗してもサーバー全体は起動する（戦績は副機能）
// ------------------------------------------------------------
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'fever-mj.json');
const statsStore = new StatsStore(DB_PATH);
if (statsStore.init()) {
  console.log(`[戦績] 戦績ストア初期化: ${DB_PATH}`);
} else {
  console.warn('[戦績] 戦績ストア無効化（ファイル I/O 失敗）');
}

// ------------------------------------------------------------
// ヘルスチェック用エンドポイント（Render など本番のスリープ防止）
// ------------------------------------------------------------
app.get('/healthz', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    rooms: roomManager.roomCount(),
    statsEnabled: statsStore.enabled,
  });
});

// ------------------------------------------------------------
// 戦績 API（フェーズ7）
// ------------------------------------------------------------
// プレイヤーの通算戦績
app.get('/api/stats/:playerId', (req, res) => {
  const playerId = String(req.params.playerId || '');
  if (!statsStore.enabled) {
    return res.status(503).json({ error: '戦績ストアが無効化されています' });
  }
  const stats = statsStore.getPlayerStats(playerId);
  if (!stats) {
    return res.status(404).json({ error: 'まだ対局記録がありません' });
  }
  res.json(stats);
});

// プレイヤーが参加した直近の対局一覧
app.get('/api/games/:playerId', (req, res) => {
  const playerId = String(req.params.playerId || '');
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  if (!statsStore.enabled) {
    return res.status(503).json({ error: '戦績ストアが無効化されています' });
  }
  const games = statsStore.getRecentGames(playerId, limit);
  res.json(games);
});

// 通算ランキング上位（全プレイヤー横断）
app.get('/api/ranking', (req, res) => {
  if (!statsStore.enabled) {
    return res.status(503).json({ error: '戦績ストアが無効化されています' });
  }
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
  res.json(statsStore.getRanking(limit));
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
  registerHandlers(io, socket, roomManager, statsStore);
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
