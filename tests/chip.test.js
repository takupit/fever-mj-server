// ============================================================
// tests/chip.test.js
// チップ計算の検証（フェーズ4b step 4 で追加）
// 仕様書「11. チップ」のルール ①②③ を網羅
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert');

const { GameEngine } = require('../src/game/engine');
const { calculateChipMoves, calculateChunHatsuBonus } = require('../src/game/chip');

function makeAgariResult({ totalHan, isYakuman = false, yakumanCount = 0, yakuList = [] }) {
  return {
    pattern: { sets: [], pairs: [], setTypes: [] },
    yakuResult: { yakuList, totalHan, isYakuman, yakumanCount },
    waitType: 'tanki',
  };
}

// ============================================================
// ルール ①: 一索/一萬/九萬 チップ
// ============================================================

test('チップ ①: 面前+七筒1枚以上 → 一索/一萬/九萬の枚数×2', () => {
  const engine = new GameEngine();
  engine.init();
  const p0 = engine.state.players[0];
  // 七筒 1枚 + 一萬2枚 + 一索1枚 + 九萬3枚 = 6枚（合計14枚）
  p0.hand = ['m1','m1','s1','p7','p2','p3','p4','m2','m3','m4','m9','m9','m9','m5'];
  engine.state.drawnTile = 'm5';
  engine.state.lastDiscard = null;
  const result = calculateChipMoves({
    state: engine.state,
    agariResult: makeAgariResult({ totalHan: 1 }),
    winnerId: 'P0',
    isTsumo: true,
    isReached: false,
    ipatsuActive: false,
  });
  // 6枚 × 2 = 12 チップ/payer、ツモなので他2人から12ずつ取得 → 計24
  assert.strictEqual(result.moves.P1, -12);
  assert.strictEqual(result.moves.P2, -12);
  assert.strictEqual(result.moves.P0, 24);
  assert.strictEqual(result.breakdown.rule1, 24);
});

test('チップ ①: 七筒がなければチップなし', () => {
  const engine = new GameEngine();
  engine.init();
  const p0 = engine.state.players[0];
  p0.hand = ['m1','m1','s1','m2','m3','m4','m5','m6','m7','m9','m9','m9','m9','m8'];
  engine.state.drawnTile = 'm8';
  const result = calculateChipMoves({
    state: engine.state,
    agariResult: makeAgariResult({ totalHan: 1 }),
    winnerId: 'P0', isTsumo: true,
    isReached: false, ipatsuActive: false,
  });
  assert.strictEqual(result.breakdown.rule1, 0);
});

test('チップ ①: 鳴いていたら（非面前）チップなし', () => {
  const engine = new GameEngine();
  engine.init();
  const p0 = engine.state.players[0];
  p0.hand = ['m1','m1','s1','p7','m2','m3','m4','m5','m6','m7','m8'];
  p0.melds.push({ type: 'pon', tiles: ['m9','m9','m9'], fromPlayer: 'P1' });
  engine.state.drawnTile = 'm8';
  const result = calculateChipMoves({
    state: engine.state,
    agariResult: makeAgariResult({ totalHan: 1 }),
    winnerId: 'P0', isTsumo: true,
    isReached: false, ipatsuActive: false,
  });
  assert.strictEqual(result.breakdown.rule1, 0);
});

test('チップ ①: 一発の場合 ×2 倍', () => {
  const engine = new GameEngine();
  engine.init();
  // ルール② の影響を排除するため裏ドラ表示牌をクリア
  engine.state.uraDoraIndicators = [];
  const p0 = engine.state.players[0];
  // 6枚（m1×2 + s1×1 + m9×3）
  p0.hand = ['m1','m1','s1','p7','p2','p3','p4','m2','m3','m4','m9','m9','m9','m5'];
  engine.state.drawnTile = 'm5';
  const result = calculateChipMoves({
    state: engine.state,
    agariResult: makeAgariResult({ totalHan: 1 }),
    winnerId: 'P0', isTsumo: true,
    isReached: true, ipatsuActive: true,
  });
  // 6枚 × 2 × 2 = 24 チップ/payer × 2 payers = 48 total（ルール①のみ）
  assert.strictEqual(result.breakdown.rule1, 48);
});

test('チップ ①: ロンの場合は振り込み者のみから', () => {
  const engine = new GameEngine();
  engine.init();
  const p0 = engine.state.players[0];
  // 13枚＋振り込まれた m5 で 14枚相当（m5 は対象外）
  p0.hand = ['m1','m1','s1','p7','p2','p3','p4','m2','m3','m4','m9','m9','m9'];
  engine.state.lastDiscard = { player: 'P2', tile: 'm5' };
  engine.state.drawnTile = null;
  const result = calculateChipMoves({
    state: engine.state,
    agariResult: makeAgariResult({ totalHan: 1 }),
    winnerId: 'P0', isTsumo: false, fromPlayer: 'P2',
    isReached: false, ipatsuActive: false,
  });
  // 6枚 × 2 = 12 チップ、P2 だけが支払う
  assert.strictEqual(result.moves.P0, 12);
  assert.strictEqual(result.moves.P2, -12);
  assert.strictEqual(result.moves.P1, 0);
});

// ============================================================
// ルール ②: 裏ドラ表示牌チップ
// ============================================================

test('チップ ②: リーチ和了+裏ドラ表示牌の枚数×1', () => {
  const engine = new GameEngine();
  engine.init();
  // 裏ドラ表示牌を強制的に設定
  engine.state.uraDoraIndicators = ['m5', 'p7'];
  const p0 = engine.state.players[0];
  // 手牌に m5 が 2枚、p7 が 1枚 ある
  p0.hand = ['m5','m5','p7','m2','m3','m4','p2','p3','p4','m9','m9','m9','m9','m6'];
  engine.state.drawnTile = 'm6';
  const result = calculateChipMoves({
    state: engine.state,
    agariResult: makeAgariResult({ totalHan: 1 }),
    winnerId: 'P0', isTsumo: true,
    isReached: true, ipatsuActive: false,
  });
  // m5 が2枚 + p7 が1枚 = 3チップ/payer（ツモなので他2人から）
  assert.strictEqual(result.breakdown.rule2, 6);
});

test('チップ ②: 非リーチならチップなし', () => {
  const engine = new GameEngine();
  engine.init();
  engine.state.uraDoraIndicators = ['m5', 'p7'];
  const p0 = engine.state.players[0];
  p0.hand = ['m5','m5','p7','m2','m3','m4','p2','p3','p4','m9','m9','m9','m9','m6'];
  engine.state.drawnTile = 'm6';
  const result = calculateChipMoves({
    state: engine.state,
    agariResult: makeAgariResult({ totalHan: 1 }),
    winnerId: 'P0', isTsumo: true,
    isReached: false, ipatsuActive: false,
  });
  assert.strictEqual(result.breakdown.rule2, 0);
});

// ============================================================
// ルール ③: 役満ご祝儀
// ============================================================

test('チップ ③: 役満は +10、全員から', () => {
  const engine = new GameEngine();
  engine.init();
  const p0 = engine.state.players[0];
  p0.hand = ['m1','m1','m1','m1','m2','m2','m2','m2','m3','m3','m3','m3','m9','m9'];
  engine.state.drawnTile = 'm9';
  const result = calculateChipMoves({
    state: engine.state,
    agariResult: makeAgariResult({ totalHan: 13, isYakuman: true, yakumanCount: 1 }),
    winnerId: 'P0', isTsumo: true,
    isReached: false, ipatsuActive: false,
  });
  // 10チップ/payer × 2 payers
  assert.strictEqual(result.breakdown.rule3, 20);
  assert.strictEqual(result.moves.P1, -10);
  assert.strictEqual(result.moves.P2, -10);
});

test('チップ ③: 数え役満（13翻以上）は +5', () => {
  const engine = new GameEngine();
  engine.init();
  const p0 = engine.state.players[0];
  p0.hand = ['m1','m1','m1','m2','m3','m4','m5','m6','m7','m9','m9','m9','m9','m8'];
  engine.state.drawnTile = 'm8';
  const result = calculateChipMoves({
    state: engine.state,
    agariResult: makeAgariResult({ totalHan: 13, isYakuman: false }),
    winnerId: 'P0', isTsumo: true,
    isReached: false, ipatsuActive: false,
  });
  // 5チップ/payer × 2 payers
  assert.strictEqual(result.breakdown.rule3, 10);
});

// ============================================================
// 中・發ボーナス（仕様書 ④）
// ============================================================

test('中・發ボーナス: 中ツモなら他家から各1枚', () => {
  const result = calculateChunHatsuBonus({ drawnTile: 'z7', winnerId: 'P0' });
  assert.ok(result);
  assert.strictEqual(result.moves.P0, 2);
  assert.strictEqual(result.moves.P1, -1);
  assert.strictEqual(result.moves.P2, -1);
});

test('中・發ボーナス: 對象外牌（m5 など）なら null', () => {
  const result = calculateChunHatsuBonus({ drawnTile: 'm5', winnerId: 'P0' });
  assert.strictEqual(result, null);
});
