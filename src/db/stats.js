// ============================================================
// src/db/stats.js
// 戦績記録ストア（JSON ファイル版）
// ============================================================
// フェーズ7 の戦績記録機能。当初 SQLite (better-sqlite3) を予定していたが、
// Windows + Node 24 でネイティブビルドが通らない（Python 未インストール環境）
// ため、JSON ファイルベースの軽量ストアに切り替えた。
//
// 仕様:
//   - 1 ファイル ./data/fever-mj.json に全てのデータを保存
//   - 起動時にロード、変更ごとに atomic write
//   - シングルスレッドの Node.js 上で動くので競合は考慮不要
//   - データ規模: 数千対局程度まで現実的なパフォーマンス
//
// 構造:
//   {
//     players: { [id]: { name, createdAt } },
//     stats:   { [id]: { totalGames, wins, seconds, thirds, tobiCount,
//                        yakumanCount, feverCount, totalScoreDiff } },
//     games:   [ { id, roomId, endedAt, endReason, players: [...] }, ... ]
//   }
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INITIAL_SCORE = 25000; // 通算点数収支の基準

function emptyData() {
  return { players: {}, stats: {}, games: [] };
}

function emptyStatsRecord() {
  return {
    totalGames: 0,
    wins: 0,
    seconds: 0,
    thirds: 0,
    tobiCount: 0,
    yakumanCount: 0,
    feverCount: 0,
    totalScoreDiff: 0,
  };
}

class StatsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = emptyData();
    this.enabled = false;
  }

  // ファイルをロード（無ければ新規）。dir が無ければ作る。
  // 失敗してもサーバー全体を落とさないよう例外は握りつぶす（戦績は副機能）。
  //
  // 既存ファイルが JSON として壊れていた場合は、破損ファイルを
  // *.broken-{timestamp} に退避してから空データで起動を継続する。
  // これにより「一度壊れると永久にストアが無効化される」状態を防ぐ。
  init() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // ★ save() より先に enabled を立てる（save が enabled=false で早期 return しないように）
      this.enabled = true;
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        try {
          const parsed = JSON.parse(raw);
          this.data = {
            players: parsed.players || {},
            stats: parsed.stats || {},
            games: Array.isArray(parsed.games) ? parsed.games : [],
          };
        } catch (parseErr) {
          // JSON 破損時: バックアップして空データで起動継続
          const backupPath = `${this.filePath}.broken-${Date.now()}`;
          try {
            fs.renameSync(this.filePath, backupPath);
            console.warn(`[stats] JSON 破損を検出 → ${backupPath} へバックアップして空データで起動継続: ${parseErr.message}`);
          } catch (renameErr) {
            console.warn(`[stats] 破損ファイルのバックアップに失敗: ${renameErr.message}`);
          }
          this.data = emptyData();
          this.save();
        }
      } else {
        this.data = emptyData();
        this.save();
      }
      return true;
    } catch (err) {
      console.warn(`[stats] 初期化失敗（戦績記録は無効化）: ${err.message}`);
      this.enabled = false;
      return false;
    }
  }

  // 原子的に書き込む（一旦 .tmp に書いてから rename）。
  // クラッシュ・電源断耐性のため fsync で物理ディスクへの書き込み確定を待つ。
  // tmp パスにプロセス ID とランダム ID を含めて、複数プロセス間の衝突を防ぐ。
  save() {
    if (!this.enabled) return;
    try {
      // tmp パスを衝突しにくくする（pid + 短いランダム）
      const tmp = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      const json = JSON.stringify(this.data, null, 2);
      // open → write → fsync → close で物理ディスクへの書き込みを保証
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeSync(fd, json, 0, 'utf8');
        // fsync: ファイル本体をディスクに同期（OS のページキャッシュをフラッシュ）
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      // rename は同一ファイルシステム上で原子的
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.warn(`[stats] 保存失敗: ${err.message}`);
    }
  }

  // プレイヤー登録（既にあれば名前だけ更新）
  upsertPlayer(playerId, name) {
    if (!this.enabled || !playerId) return;
    const existing = this.data.players[playerId];
    if (existing) {
      existing.name = name; // 名前変更を反映
    } else {
      this.data.players[playerId] = { name, createdAt: Date.now() };
    }
    if (!this.data.stats[playerId]) {
      this.data.stats[playerId] = emptyStatsRecord();
    }
  }

  // 1 対局を記録 + 各プレイヤーの累積統計を更新
  //   record = {
  //     roomId, endReason, endedAt,
  //     players: [
  //       { id: 永続UUID|null, name, score, chips, rank, isCpu,
  //         yakumanCount, feverCount }
  //     ]
  //   }
  //   戻り値: gameId（人間が 1 人もいなければ null）
  recordGame(record) {
    if (!this.enabled) return null;
    const hasHuman = record.players.some((p) => p.id && !p.isCpu);
    if (!hasHuman) return null;

    const gameId = crypto.randomUUID();
    const gameRow = {
      id: gameId,
      roomId: record.roomId,
      endedAt: record.endedAt || Date.now(),
      endReason: record.endReason || 'unknown',
      players: record.players.map((p) => ({
        id: p.id || null,
        name: p.name,
        score: p.score,
        chips: p.chips,
        rank: p.rank,
        isCpu: !!p.isCpu,
        yakumanCount: p.yakumanCount || 0,
        feverCount: p.feverCount || 0,
      })),
    };
    this.data.games.unshift(gameRow); // 新しい順に先頭挿入
    if (this.data.games.length > 500) this.data.games.length = 500; // 直近 500 まで

    // 累積統計を更新
    for (const p of record.players) {
      if (!p.id || p.isCpu) continue;
      this.upsertPlayer(p.id, p.name);
      const stats = this.data.stats[p.id];
      stats.totalGames += 1;
      if (p.rank === 1) stats.wins += 1;
      else if (p.rank === 2) stats.seconds += 1;
      else if (p.rank === 3) stats.thirds += 1;
      if (p.score < 0) stats.tobiCount += 1;
      stats.yakumanCount += p.yakumanCount || 0;
      stats.feverCount += p.feverCount || 0;
      stats.totalScoreDiff += p.score - INITIAL_SCORE;
    }

    this.save();
    return gameId;
  }

  // プレイヤーの通算戦績を取得
  //   戻り値: null（プレイヤー未登録） or 統計オブジェクト
  getPlayerStats(playerId) {
    if (!this.enabled || !playerId) return null;
    const stats = this.data.stats[playerId];
    if (!stats) return null;
    const player = this.data.players[playerId] || {};
    return {
      playerId,
      name: player.name || '名無し',
      createdAt: player.createdAt || null,
      ...stats,
      winRate: stats.totalGames > 0 ? stats.wins / stats.totalGames : 0,
      avgScoreDiff: stats.totalGames > 0 ? stats.totalScoreDiff / stats.totalGames : 0,
    };
  }

  // 指定プレイヤーが参加した直近 N 対局
  getRecentGames(playerId, limit = 20) {
    if (!this.enabled || !playerId) return [];
    const matches = this.data.games.filter((g) =>
      g.players.some((p) => p.id === playerId)
    );
    return matches.slice(0, limit);
  }

  // 全プレイヤーのランキング（通算1位回数順）
  getRanking(limit = 10) {
    if (!this.enabled) return [];
    return Object.entries(this.data.stats)
      .map(([id, s]) => ({
        playerId: id,
        name: (this.data.players[id] && this.data.players[id].name) || '名無し',
        ...s,
      }))
      .sort((a, b) => b.wins - a.wins || b.totalScoreDiff - a.totalScoreDiff)
      .slice(0, limit);
  }
}

module.exports = { StatsStore };
