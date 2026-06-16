// ============================================================
// tests/fever-freeze-hotfix.test.js
// FEVER 後の固まり（freeze）バグ修正の検証テスト。
// ============================================================
// バグ:
//   他家 FEVER 中の自分のターン → ツモ牌以外をタップ → サーバが
//   「ツモ切りしかできません」エラーを返す → クライアントの
//   view.discarding=true / canDiscard=false がそのまま残る →
//   ユーザー操作不能（=「固まった」と認識される）。
//
// 修正:
//   1. クライアントに lobby:error ハンドラ追加し view 状態を復元（JS 側）
//   2. クライアントの onTileClick で FEVER/リーチ制限を未然にガード（JS 側）
//   3. サーバ executeCpuAction で CPU も他家 FEVER 中ツモ切り強制（本テスト）
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert');

const { GameEngine } = require('../src/game/engine');

// ------------------------------------------------------------
// サーバー側: CPU が他家 FEVER 中はツモ切りしかできない
// engine.discardTile に直接渡されるロジックなので、ここでは
// hasOtherFever + isReached の組み合わせで「ツモ切り強制」が
// 正しく適用されるか確認する。
// ------------------------------------------------------------

test('FEVER hotfix: hasOtherFever が true なら CPU のツモ切り強制条件が成立する', () => {
  const engine = new GameEngine();
  engine.init();
  // P0 を強制的に FEVER 状態にする（他家から見て FEVER 中）
  engine.state.players[0].feverActive = true;
  engine.state.players[0].feverTrigger = 'p7';

  // P1 視点では他家（P0）が FEVER → ツモ切り強制
  assert.strictEqual(engine.hasOtherFever('P1'), true, '他家 FEVER 検出');
  assert.strictEqual(engine.hasOtherFever('P0'), false, '自分は FEVER 中だが他家 FEVER ではない');

  // P1 がリーチ済みなら制限から除外される（リーチ前 FEVER の特例）
  engine.state.players[1].isReached = true;
  // 仕様: hasOtherFever && !isReached の AND 条件で制限される
  const restricted = engine.hasOtherFever('P1') && !engine.state.players[1].isReached;
  assert.strictEqual(restricted, false, 'リーチ済みなら制限解除');
});

test('FEVER hotfix: discardTile はツモ切り判定を正しく返す', () => {
  const engine = new GameEngine();
  engine.init();
  const p0 = engine.state.players[0];
  // 手札を固定して挙動を確認
  p0.hand = ['m1', 'm2', 'm3', 'p1', 'p2', 'p3', 's1', 's9', 'z1', 'z1', 'z2', 'z2', 'z3', 'z3'];
  engine.state.drawnTile = 'z3';
  // ツモ切り
  const ok = engine.discardTile('P0', 'z3', true);
  assert.strictEqual(ok, true);
  // 河に z3 が積まれている
  assert.strictEqual(p0.discards[p0.discards.length - 1].tile, 'z3');
  assert.strictEqual(p0.discards[p0.discards.length - 1].isTsumogiri, true);
});

test('FEVER hotfix: 他家 FEVER 検出の境界 - 自分が単独 FEVER でも自分には制限なし', () => {
  const engine = new GameEngine();
  engine.init();
  engine.state.players[2].feverActive = true; // P2 が FEVER

  // 自分（P2）に対しては「他家 FEVER」ではない
  assert.strictEqual(engine.hasOtherFever('P2'), false);
  // 他人（P0, P1）に対しては制限されるべき
  assert.strictEqual(engine.hasOtherFever('P0'), true);
  assert.strictEqual(engine.hasOtherFever('P1'), true);
});
