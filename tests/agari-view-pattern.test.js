// ============================================================
// tests/agari-view-pattern.test.js
// アガリ画面改修（A+B+C）でサーバ→クライアントに渡す
// pattern 情報のテスト。
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert');

const { GameEngine } = require('../src/game/engine');
const { agariView } = require('../src/socket/game-view');

test('agariView: pattern フィールドが含まれる（クライアント面子区切り用）', () => {
  const engine = new GameEngine();
  engine.init();
  const p0 = engine.state.players[0];
  // 適当な確定形：m1m2m3 p1p2p3 m4m5m6 s1s1s1 z1z1 + 和了 m7
  p0.hand = ['m1','m2','m3','p1','p2','p3','m4','m5','m6','s1','s1','s1','m7','m7'];
  engine.state.drawnTile = 'm7';
  engine.state.lastDiscard = null;

  const agariResult = engine.checkAgariTsumo('P0', 'm7');
  assert.ok(agariResult, '役判定が成立する');

  const view = agariView(
    engine.state,
    agariResult,
    'P0',
    /*isTsumo=*/true,
    /*fromPlayer=*/null,
    { basePoint: 1000, moves: { P0: 1000, P1: -500, P2: -500 } },
    0,
    null,
    false,
  );

  // pattern が含まれること
  assert.ok(view.pattern, 'pattern フィールドが存在');
  assert.strictEqual(typeof view.pattern.type, 'string');
  assert.ok(Array.isArray(view.pattern.pairs));
  assert.ok(Array.isArray(view.pattern.sets));
  assert.ok(Array.isArray(view.pattern.setTypes));
  assert.strictEqual(view.pattern.meldsCount, 0, '副露なしなので meldsCount=0');
});

test('agariView: 国士無双の pattern.type は kokushi', () => {
  const engine = new GameEngine();
  engine.init();
  const p0 = engine.state.players[0];
  // 国士無双: 1m,9m,1p,9p,1s,9s,z1〜z7（z1 雀頭）
  p0.hand = ['m1','m9','p1','p9','s1','s9','z1','z2','z3','z4','z5','z6','z7','z1'];
  engine.state.drawnTile = 'z1';

  const agariResult = engine.checkAgariTsumo('P0', 'z1');
  assert.ok(agariResult, '国士無双が成立する');

  const view = agariView(
    engine.state,
    agariResult,
    'P0',
    true,
    null,
    { basePoint: 32000, moves: { P0: 32000, P1: -16000, P2: -16000 } },
    0,
    null,
    false,
  );

  assert.strictEqual(view.pattern.type, 'kokushi', '国士パターンの type は kokushi');
  assert.strictEqual(view.isYakuman, true, '役満フラグ');
});

test('agariView: winningTile が含まれてクライアント側で隔離表示できる', () => {
  const engine = new GameEngine();
  engine.init();
  const p0 = engine.state.players[0];
  p0.hand = ['m1','m2','m3','p1','p2','p3','m4','m5','m6','s1','s1','s1','m7','m7'];
  engine.state.drawnTile = 'm7';
  const agariResult = engine.checkAgariTsumo('P0', 'm7');
  const view = agariView(
    engine.state, agariResult, 'P0', true, null,
    { basePoint: 1000, moves: { P0: 1000, P1: -500, P2: -500 } },
    0, null, false,
  );
  assert.strictEqual(view.winningTile, 'm7');
  assert.ok(view.hand.includes('m7'), 'hand にも含まれる（クライアントが除外して描画）');
});
