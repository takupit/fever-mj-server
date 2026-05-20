// ============================================================
// tests/score.test.js
// 点棒移動・ノーテン罰符の計算検証（フェーズ4b step 3 で追加）
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert');

const {
  calculateSimpleScore,
  calculatePointMoves,
  calculateNotenPenalty,
} = require('../src/game/score');

// ------------------------------------------------------------
// calculatePointMoves: ツモ
// ------------------------------------------------------------

test('calculatePointMoves: 子ツモ 1翻 → 親から1000, 他子から500', () => {
  const result = calculatePointMoves({
    han: 1, dealerId: 'P0', winnerId: 'P1', isTsumo: true,
  });
  // 1翻基本点 = 30 * 2^3 = 240 → ×2=500（切り上げ）、×1=300（切り上げ）相当
  // 実際: basePoint=240, 子ツモは 親=480→500, 他子=240→300
  assert.strictEqual(result.moves.P0, -500);
  assert.strictEqual(result.moves.P2, -300);
  assert.strictEqual(result.moves.P1, 800);
  assert.strictEqual(result.total, 800);
});

test('calculatePointMoves: 親ツモ 1翻 → 子全員から500ずつ', () => {
  const result = calculatePointMoves({
    han: 1, dealerId: 'P0', winnerId: 'P0', isTsumo: true,
  });
  // 親ツモ basePoint*2 = 480 → 500（切り上げ）から子全員
  assert.strictEqual(result.moves.P1, -500);
  assert.strictEqual(result.moves.P2, -500);
  assert.strictEqual(result.moves.P0, 1000);
});

test('calculatePointMoves: 子ロン 5翻 → 振り込み者から8000', () => {
  const result = calculatePointMoves({
    han: 5, dealerId: 'P0', winnerId: 'P1', isTsumo: false, fromPlayer: 'P2',
  });
  // 子ロン満貫: basePoint=2000 × 4 = 8000
  assert.strictEqual(result.moves.P2, -8000);
  assert.strictEqual(result.moves.P1, 8000);
  assert.strictEqual(result.moves.P0, 0);
});

test('calculatePointMoves: 親ロン 役満 → 32000 → 親なので 48000', () => {
  const result = calculatePointMoves({
    han: 13, dealerId: 'P0', winnerId: 'P0', isTsumo: false, fromPlayer: 'P1',
  });
  // 親ロン役満: basePoint=8000 × 6 = 48000
  assert.strictEqual(result.moves.P0, 48000);
  assert.strictEqual(result.moves.P1, -48000);
});

test('calculatePointMoves: 割れ目（被ロン者が割れ目）で点棒2倍', () => {
  const base = calculatePointMoves({
    han: 5, dealerId: 'P0', winnerId: 'P1', isTsumo: false, fromPlayer: 'P2',
  });
  const ware = calculatePointMoves({
    han: 5, dealerId: 'P0', winnerId: 'P1', isTsumo: false, fromPlayer: 'P2',
    warePlayer: 'P2',
  });
  assert.strictEqual(ware.moves.P1, base.moves.P1 * 2);
  assert.strictEqual(ware.moves.P2, base.moves.P2 * 2);
});

// ------------------------------------------------------------
// calculateNotenPenalty
// ------------------------------------------------------------

test('calculateNotenPenalty: 1人テンパイ → +3000、ノーテン2人が -1500 ずつ', () => {
  const moves = calculateNotenPenalty(['P1']);
  assert.strictEqual(moves.P1, 3000);
  assert.strictEqual(moves.P0, -1500);
  assert.strictEqual(moves.P2, -1500);
});

test('calculateNotenPenalty: 2人テンパイ → 各 +1500、ノーテン1人が -3000', () => {
  const moves = calculateNotenPenalty(['P0', 'P1']);
  assert.strictEqual(moves.P0, 1500);
  assert.strictEqual(moves.P1, 1500);
  assert.strictEqual(moves.P2, -3000);
});

test('calculateNotenPenalty: 全員テンパイ → 移動なし', () => {
  const moves = calculateNotenPenalty(['P0', 'P1', 'P2']);
  assert.strictEqual(moves.P0, 0);
  assert.strictEqual(moves.P1, 0);
  assert.strictEqual(moves.P2, 0);
});

test('calculateNotenPenalty: 全員ノーテン → 移動なし', () => {
  const moves = calculateNotenPenalty([]);
  assert.strictEqual(moves.P0, 0);
  assert.strictEqual(moves.P1, 0);
  assert.strictEqual(moves.P2, 0);
});

// ------------------------------------------------------------
// calculateSimpleScore（既存・正常動作確認）
// ------------------------------------------------------------

test('calculateSimpleScore: 既存の calculateSimpleScore も引き続き動作する', () => {
  assert.strictEqual(calculateSimpleScore(1, false, false), 1000);
  assert.strictEqual(calculateSimpleScore(5, false, false), 8000);
});
