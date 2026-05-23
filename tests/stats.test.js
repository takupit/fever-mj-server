// ============================================================
// tests/stats.test.js
// 戦績記録ストア（src/db/stats.js）の単体テスト
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { StatsStore } = require('../src/db/stats');

// テンポラリファイルパスを返す（テスト毎に別ファイル）
function makeTempPath() {
  return path.join(os.tmpdir(), `fever-mj-stats-test-${Date.now()}-${Math.random()}.json`);
}

// テスト用にストアを作って初期化
function makeStore() {
  const fp = makeTempPath();
  const store = new StatsStore(fp);
  store.init();
  // テスト終了後にクリーンアップするための path も返す
  return { store, fp };
}

// テンプレ的なゲーム記録を作る
function makeGameRecord({ p1score = 35000, p2score = 25000, p3score = -10000, p1id = 'uuid-1' } = {}) {
  return {
    roomId: 'room-1',
    endReason: 'all-hands-done',
    endedAt: Date.now(),
    players: [
      { id: p1id, name: 'たくみ', score: p1score, chips: 110, rank: 1, isCpu: false, yakumanCount: 0, feverCount: 1 },
      { id: 'uuid-2', name: 'あゆみ', score: p2score, chips: 100, rank: 2, isCpu: false, yakumanCount: 0, feverCount: 0 },
      { id: 'uuid-3', name: 'けんじ', score: p3score, chips: 90, rank: 3, isCpu: false, yakumanCount: 0, feverCount: 0 },
    ],
  };
}

test('StatsStore: 初期化で空のデータが作られる', () => {
  const { store, fp } = makeStore();
  assert.strictEqual(store.enabled, true);
  assert.deepStrictEqual(store.data, { players: {}, stats: {}, games: [] });
  fs.unlinkSync(fp);
});

test('recordGame: ゲーム1件と統計が正しく記録される', () => {
  const { store, fp } = makeStore();
  const gameId = store.recordGame(makeGameRecord());
  assert.ok(gameId, 'gameId が返る');
  assert.strictEqual(store.data.games.length, 1);

  const s1 = store.getPlayerStats('uuid-1');
  assert.strictEqual(s1.totalGames, 1);
  assert.strictEqual(s1.wins, 1);
  assert.strictEqual(s1.totalScoreDiff, 10000); // 35000 - 25000
  assert.strictEqual(s1.feverCount, 1);

  const s3 = store.getPlayerStats('uuid-3');
  assert.strictEqual(s3.totalGames, 1);
  assert.strictEqual(s3.thirds, 1);
  assert.strictEqual(s3.tobiCount, 1); // -10000 はマイナスなので tobi
  assert.strictEqual(s3.totalScoreDiff, -35000);
  fs.unlinkSync(fp);
});

test('recordGame: 複数局で累積される', () => {
  const { store, fp } = makeStore();
  store.recordGame(makeGameRecord({ p1score: 35000 }));
  store.recordGame(makeGameRecord({ p1score: 40000 }));
  store.recordGame(makeGameRecord({ p1score: 28000 }));
  const s = store.getPlayerStats('uuid-1');
  assert.strictEqual(s.totalGames, 3);
  assert.strictEqual(s.wins, 3);
  assert.strictEqual(s.totalScoreDiff, (35000 - 25000) + (40000 - 25000) + (28000 - 25000)); // 28000
  fs.unlinkSync(fp);
});

test('recordGame: 役満カウントが集計される', () => {
  const { store, fp } = makeStore();
  const rec = makeGameRecord();
  rec.players[0].yakumanCount = 2; // W役満
  store.recordGame(rec);
  assert.strictEqual(store.getPlayerStats('uuid-1').yakumanCount, 2);
  fs.unlinkSync(fp);
});

test('recordGame: CPU プレイヤーは統計に含めない', () => {
  const { store, fp } = makeStore();
  const rec = {
    roomId: 'room-solo',
    endReason: 'all-hands-done',
    endedAt: Date.now(),
    players: [
      { id: 'uuid-1', name: '人', score: 35000, chips: 110, rank: 1, isCpu: false, yakumanCount: 0, feverCount: 0 },
      { id: null,     name: 'CPU 1', score: 25000, chips: 100, rank: 2, isCpu: true, yakumanCount: 0, feverCount: 0 },
      { id: null,     name: 'CPU 2', score: 0,     chips: 90,  rank: 3, isCpu: true, yakumanCount: 0, feverCount: 0 },
    ],
  };
  store.recordGame(rec);
  // 人間 1 人の統計だけが作られる
  assert.strictEqual(Object.keys(store.data.stats).length, 1);
  assert.ok(store.getPlayerStats('uuid-1'));
  // ゲーム自体は記録されている（CPU プレイヤーも players 配列に含まれる）
  assert.strictEqual(store.data.games.length, 1);
  fs.unlinkSync(fp);
});

test('recordGame: 人間が誰もいなければ記録しない', () => {
  const { store, fp } = makeStore();
  const allCpuRec = {
    roomId: 'room-test',
    endReason: 'all-hands-done',
    endedAt: Date.now(),
    players: [
      { id: null, name: 'CPU 1', score: 35000, chips: 100, rank: 1, isCpu: true, yakumanCount: 0, feverCount: 0 },
      { id: null, name: 'CPU 2', score: 25000, chips: 100, rank: 2, isCpu: true, yakumanCount: 0, feverCount: 0 },
      { id: null, name: 'CPU 3', score: 15000, chips: 100, rank: 3, isCpu: true, yakumanCount: 0, feverCount: 0 },
    ],
  };
  const gameId = store.recordGame(allCpuRec);
  assert.strictEqual(gameId, null, '人間ゼロなら null を返す');
  assert.strictEqual(store.data.games.length, 0);
  fs.unlinkSync(fp);
});

test('getPlayerStats: 未登録プレイヤーは null', () => {
  const { store, fp } = makeStore();
  assert.strictEqual(store.getPlayerStats('unknown-uuid'), null);
  fs.unlinkSync(fp);
});

test('getRecentGames: 指定プレイヤーが含まれる対局のみ返す', () => {
  const { store, fp } = makeStore();
  store.recordGame(makeGameRecord({ p1id: 'uuid-A' }));
  store.recordGame(makeGameRecord({ p1id: 'uuid-B' }));
  store.recordGame(makeGameRecord({ p1id: 'uuid-A' }));

  const aGames = store.getRecentGames('uuid-A');
  const bGames = store.getRecentGames('uuid-B');
  assert.strictEqual(aGames.length, 2);
  assert.strictEqual(bGames.length, 1);
  fs.unlinkSync(fp);
});

test('getRecentGames: 新しい順で返ってくる', () => {
  const { store, fp } = makeStore();
  // 3件記録（順番に endedAt をずらす）
  const r1 = makeGameRecord(); r1.endedAt = 1000;
  const r2 = makeGameRecord(); r2.endedAt = 2000;
  const r3 = makeGameRecord(); r3.endedAt = 3000;
  store.recordGame(r1);
  store.recordGame(r2);
  store.recordGame(r3);
  const games = store.getRecentGames('uuid-1');
  assert.strictEqual(games[0].endedAt, 3000);
  assert.strictEqual(games[2].endedAt, 1000);
  fs.unlinkSync(fp);
});

test('saveとロード: ストアがファイルから復元される', () => {
  const fp = makeTempPath();
  const s1 = new StatsStore(fp);
  s1.init();
  s1.recordGame(makeGameRecord());
  // 別インスタンスでロード
  const s2 = new StatsStore(fp);
  s2.init();
  assert.strictEqual(s2.getPlayerStats('uuid-1').totalGames, 1);
  assert.strictEqual(s2.getPlayerStats('uuid-1').wins, 1);
  fs.unlinkSync(fp);
});

test('getRanking: 1位回数の降順でソートされる', () => {
  const { store, fp } = makeStore();
  // たくみ: 1位 2 回 / 2位 1 回
  store.recordGame(makeGameRecord({ p1id: 'A' }));
  store.recordGame(makeGameRecord({ p1id: 'A' }));
  const r3 = makeGameRecord({ p1id: 'B' });
  // たくみが 2 位、新しい人 'B' が 1 位
  r3.players[0].id = 'B';
  r3.players[0].rank = 1;
  r3.players[1].id = 'A';
  r3.players[1].rank = 2;
  store.recordGame(r3);

  const ranking = store.getRanking();
  // A: 1位 2 回、 B: 1 位 1 回
  assert.strictEqual(ranking[0].playerId, 'A');
  assert.strictEqual(ranking[0].wins, 2);
  fs.unlinkSync(fp);
});
