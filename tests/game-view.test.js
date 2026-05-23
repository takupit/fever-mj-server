// ============================================================
// tests/game-view.test.js
// publicGameView / privateHandView の検証。
// 特に重要なのは「他家の手牌が公開ビューに含まれないこと」
// （仕様書 セキュリティ・公平性 1. 手牌情報の隔離）。
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert');

const { GameEngine } = require('../src/game/engine');
const { publicGameView, privateHandView } = require('../src/socket/game-view');

function setupEngine() {
  const engine = new GameEngine();
  engine.init(null, {
    playerNames: ['たくみ', 'あゆみ', 'けんじ'],
    playerIsCpu: [false, false, false],
  });
  return engine;
}

// ============================================================
// 1. publicGameView: 他家の手牌は絶対に漏らさない
// ============================================================

test('publicGameView: 各プレイヤーの手牌は含まれず、handCount だけが出る', () => {
  const engine = setupEngine();
  const pub = publicGameView(engine.state);

  for (const p of pub.players) {
    assert.strictEqual(typeof p.handCount, 'number', 'handCount がある');
    assert.strictEqual(p.handCount, 13, '配牌直後は 13 枚');
    assert.strictEqual('hand' in p, false, '生の手牌キーは含まれない');
  }
});

test('publicGameView: 各プレイヤーに公開してよい情報だけが出る', () => {
  const engine = setupEngine();
  const pub = publicGameView(engine.state);

  for (const p of pub.players) {
    const expectedKeys = [
      'id', 'name', 'wind', 'score', 'chips', 'handCount',
      'discards', 'melds', 'kitaPullsCount',
      'isReached', 'reachType', 'feverActive', 'feverTrigger', 'connected',
      // フェーズ6 で追加: CPU 代打バッジ表示用フラグ
      'isCpu', 'cpuTakeover',
    ].sort();
    const actualKeys = Object.keys(p).sort();
    assert.deepStrictEqual(actualKeys, expectedKeys);
  }
});

test('publicGameView: 山札の枚数とドラ表示牌を含む', () => {
  const engine = setupEngine();
  const pub = publicGameView(engine.state);

  assert.strictEqual(pub.wallCount, 55, '配牌後の山残は 55 枚');
  assert.strictEqual(pub.doraIndicators.length, 2, 'ドラ表示は 2 枚');
  assert.strictEqual(pub.deadWallCount, 14, '王牌は 14 枚');
});

test('publicGameView: 局情報と現在のターンを含む', () => {
  const engine = setupEngine();
  const pub = publicGameView(engine.state);

  assert.deepStrictEqual(pub.round, { wind: 'E', hand: 1, honba: 0 });
  assert.strictEqual(pub.dealerId, 'P0');
  assert.strictEqual(pub.currentTurn, 'P0');
  assert.ok(['P0', 'P1', 'P2'].includes(pub.warePlayer));
});

test('publicGameView: 河（discards）には公開してよい情報のみが入る', () => {
  const engine = setupEngine();
  // 手牌から1枚捨ててみる
  engine.drawTile('P0');
  const tile = engine.state.players[0].hand[0];
  engine.discardTile('P0', tile, false);

  const pub = publicGameView(engine.state);
  const p0 = pub.players.find((p) => p.id === 'P0');
  assert.strictEqual(p0.discards.length, 1);
  const d = p0.discards[0];
  assert.deepStrictEqual(
    Object.keys(d).sort(),
    ['isCalled', 'isReachDeclaration', 'isTsumogiri', 'tile']
  );
});

// ============================================================
// 2. privateHandView: 本人にだけ手牌を渡す
// ============================================================

test('privateHandView: 指定プレイヤーの手牌を全枚返す', () => {
  const engine = setupEngine();
  const priv = privateHandView(engine.state, 'P1');

  assert.strictEqual(priv.playerId, 'P1');
  assert.strictEqual(priv.hand.length, 13);
  // 元の手牌と一致する（コピーされている）
  assert.deepStrictEqual(priv.hand, engine.state.players[1].hand);
  // ただし参照は別（破壊的変更が伝播しない）
  assert.notStrictEqual(priv.hand, engine.state.players[1].hand);
});

test('privateHandView: 存在しない playerId なら null', () => {
  const engine = setupEngine();
  assert.strictEqual(privateHandView(engine.state, 'P9'), null);
});

test('privateHandView: 配牌直後は drawnTile が null', () => {
  const engine = setupEngine();
  const priv = privateHandView(engine.state, 'P0');
  assert.strictEqual(priv.drawnTile, null);
});

// ============================================================
// 3. 不変性: publicGameView で得たオブジェクトを書き換えても
//    engine.state に影響しない
// ============================================================

test('publicGameView: 戻り値の doraIndicators を書き換えても元の state は変わらない', () => {
  const engine = setupEngine();
  const pub = publicGameView(engine.state);

  const originalDora = [...engine.state.doraIndicators];
  pub.doraIndicators.push('m1');

  assert.deepStrictEqual(engine.state.doraIndicators, originalDora);
});
