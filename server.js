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

// 本番（Render など）はリバースプロキシ経由なので X-Forwarded-* ヘッダを信頼する
// これでクライアント IP の取得や HTTPS リダイレクト判定が正しく動く
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// Socket.IO を HTTP サーバーに接続
// cors: 同一オリジンからの接続が主なので origin:'*' で問題ない（公開アプリ前提）
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
//   /health と /healthz の両方で同じ内容を返す（汎用名 + Kubernetes 流）
// ------------------------------------------------------------
function healthPayload() {
  return {
    status: 'ok',
    uptime: process.uptime(),
    rooms: roomManager.roomCount(),
    statsEnabled: statsStore.enabled,
    nodeEnv: process.env.NODE_ENV || 'development',
  };
}
app.get('/health',  (req, res) => res.json(healthPayload()));
app.get('/healthz', (req, res) => res.json(healthPayload()));

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
// 本番では Render が PORT を環境変数で渡してくる。0.0.0.0 にバインドしないと
// 外部から見えないので明示的に指定する（ローカル開発でも問題なし）。
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log('==============================================');
  console.log('  FEVER MJ サーバーが起動しました');
  console.log(`  リッスン: ${HOST}:${PORT}`);
  if (process.env.NODE_ENV === 'production') {
    console.log(`  本番モードで稼働中`);
  } else {
    console.log(`  ロビー: http://localhost:${PORT}/`);
    console.log(`  戦績:   http://localhost:${PORT}/stats.html`);
  }
  console.log('  停止: Ctrl + C');
  console.log('==============================================');
});
