-- ============================================================
-- src/db/schema.sql
-- SQLite データベースのテーブル定義。
-- フェーズ7（戦績記録）で使用。
-- ============================================================

-- プレイヤー本体（ブラウザ発行 UUID で識別）
CREATE TABLE IF NOT EXISTS players (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 対局1試合分の記録
CREATE TABLE IF NOT EXISTS games (
  id            TEXT PRIMARY KEY,
  room_id       TEXT NOT NULL,
  ended_at      INTEGER NOT NULL,
  player1_id    TEXT, player1_score INTEGER, player1_chips INTEGER, player1_rank INTEGER,
  player2_id    TEXT, player2_score INTEGER, player2_chips INTEGER, player2_rank INTEGER,
  player3_id    TEXT, player3_score INTEGER, player3_chips INTEGER, player3_rank INTEGER
);

-- プレイヤーの通算戦績
CREATE TABLE IF NOT EXISTS stats (
  player_id        TEXT PRIMARY KEY,
  total_games      INTEGER DEFAULT 0,
  wins             INTEGER DEFAULT 0,   -- 1位回数
  seconds          INTEGER DEFAULT 0,
  thirds           INTEGER DEFAULT 0,
  tobi_count       INTEGER DEFAULT 0,
  yakuman_count    INTEGER DEFAULT 0,
  fever_count      INTEGER DEFAULT 0,
  total_score_diff INTEGER DEFAULT 0,
  FOREIGN KEY (player_id) REFERENCES players(id)
);
