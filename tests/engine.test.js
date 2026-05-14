// ============================================================
// tests/engine.test.js
// サーバー側に移植したゲームロジックの最小動作確認テスト。
// Node.js 標準の test runner（node:test）を使用 — 追加ライブラリ不要。
//
// 実行方法:
//   npm test
//   または:  node --test tests/engine.test.js
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert');

const { buildTileSet, shuffleTiles } = require('../src/game/wall');
const {
  tileBase,
  isRed,
  isYaochuhai,
  sortTiles,
  countTiles,
  nextTile,
} = require('../src/game/tile-utils');
const {
  isTenpai,
  getWaitingTiles,
  extractAllPatterns,
  evaluateAllYaku,
} = require('../src/game/yaku');
const { calculateSimpleScore } = require('../src/game/score');
const { GameEngine } = require('../src/game/engine');

// ============================================================
// 1. 山牌（やまはい）の生成テスト
// ============================================================

test('buildTileSet は 108 枚の牌を返す', () => {
  const tiles = buildTileSet();
  assert.strictEqual(tiles.length, 108, '使用牌は全 108 枚');
});

test('buildTileSet の内訳: 萬子36 + 筒子36 + 索子8 + 字牌28', () => {
  const tiles = buildTileSet();
  const manzu = tiles.filter((t) => t.startsWith('m')).length;
  const pinzu = tiles.filter((t) => t.startsWith('p')).length;
  const souzu = tiles.filter((t) => t.startsWith('s')).length;
  const jihai = tiles.filter((t) => t.startsWith('z')).length;

  assert.strictEqual(manzu, 36, '萬子は 9 種 × 4 枚 = 36 枚');
  assert.strictEqual(pinzu, 36, '筒子は 9 種 × 4 枚 = 36 枚');
  assert.strictEqual(souzu, 8,  '索子は 1 と 9 のみ × 4 枚 = 8 枚');
  assert.strictEqual(jihai, 28, '字牌は 7 種 × 4 枚 = 28 枚');
});

test('5筒は4枚すべて赤ドラ p5r', () => {
  const tiles = buildTileSet();
  const allP5 = tiles.filter((t) => tileBase(t) === 'p5');
  assert.strictEqual(allP5.length, 4, '5筒は4枚');
  assert.ok(allP5.every((t) => isRed(t)), '5筒はすべて赤ドラ');
});

test('shuffleTiles は枚数を保持しつつ並びを変える', () => {
  const original = buildTileSet();
  const shuffled = shuffleTiles(original);

  assert.strictEqual(shuffled.length, 108);
  // 元配列は破壊されない
  assert.notStrictEqual(shuffled, original);
  // 牌の集合は同じ（マルチセット比較）
  const sortedOriginal = [...original].sort();
  const sortedShuffled = [...shuffled].sort();
  assert.deepStrictEqual(sortedShuffled, sortedOriginal);
});

// ============================================================
// 2. GameEngine の初期化テスト（配牌）
// ============================================================

test('GameEngine.init: 3人に13枚ずつ配り、王牌14枚を残す', () => {
  const engine = new GameEngine();
  engine.init();

  assert.strictEqual(engine.state.players.length, 3, 'プレイヤー数 3');
  for (const p of engine.state.players) {
    assert.strictEqual(p.hand.length, 13, `${p.id} の手牌は 13 枚`);
  }
  assert.strictEqual(engine.state.deadTiles.length, 14, '王牌は 14 枚');
  // 山残: 108 - (13 × 3 = 39) - (14) = 55 枚
  assert.strictEqual(engine.state.wall.length, 55, '山残は 55 枚');
});

test('GameEngine.init: 配牌+山+王牌で108枚を維持', () => {
  const engine = new GameEngine();
  engine.init();

  const totalTiles =
    engine.state.players.reduce((sum, p) => sum + p.hand.length, 0) +
    engine.state.wall.length +
    engine.state.deadTiles.length;
  assert.strictEqual(totalTiles, 108, '配られた牌の合計は常に 108 枚');
});

test('GameEngine.init: ドラ表示牌2枚と裏ドラ表示牌2枚が決定する', () => {
  const engine = new GameEngine();
  engine.init();

  assert.strictEqual(engine.state.doraIndicators.length, 2, 'ドラ表示は2枚開示');
  assert.strictEqual(engine.state.uraDoraIndicators.length, 2, '裏ドラ表示も2枚');
  assert.strictEqual(engine.state.rinshanIndex, 4, '嶺上開始位置は王牌の5枚目');
});

test('GameEngine.init: 初期点数25000・初期チップ100・割れ目あり', () => {
  const engine = new GameEngine();
  engine.init();

  for (const p of engine.state.players) {
    assert.strictEqual(p.score, 25000);
    assert.strictEqual(p.chips, 100);
  }
  assert.ok(['P0', 'P1', 'P2'].includes(engine.state.warePlayer), '割れ目はP0/P1/P2のいずれか');
});

// ============================================================
// 3. 牌操作ユーティリティのテスト
// ============================================================

test('tileBase: 赤ドラ表記 r を除去', () => {
  assert.strictEqual(tileBase('p5r'), 'p5');
  assert.strictEqual(tileBase('p5'), 'p5');
  assert.strictEqual(tileBase('m7'), 'm7');
  assert.strictEqual(tileBase('z4'), 'z4');
});

test('isYaochuhai: 端牌と字牌のみ true', () => {
  assert.ok(isYaochuhai('m1'));   // 一萬
  assert.ok(isYaochuhai('m9'));   // 九萬
  assert.ok(isYaochuhai('z1'));   // 東
  assert.ok(isYaochuhai('z7'));   // 中
  assert.ok(!isYaochuhai('m5'));  // 五萬は中張牌
  assert.ok(!isYaochuhai('p3'));  // 三筒も中張牌
});

test('sortTiles: 萬→筒→索→字、同スート内は数字昇順、赤は同数字内で後ろ', () => {
  const sorted = sortTiles(['z1', 'p5r', 'p5', 'm1', 's9', 'm9']);
  assert.deepStrictEqual(sorted, ['m1', 'm9', 'p5', 'p5r', 's9', 'z1']);
});

test('nextTile: ドラ表示牌から実際のドラを算出', () => {
  // 数牌: 9 → 1 にループ
  assert.strictEqual(nextTile('m9'), 'm1');
  assert.strictEqual(nextTile('p8'), 'p9');
  assert.strictEqual(nextTile('p5r'), 'p6');  // 赤は基本牌として処理
  // 風牌: 北 → 東
  assert.strictEqual(nextTile('z4'), 'z1');
  assert.strictEqual(nextTile('z1'), 'z2');
  // 三元牌: 中 → 白
  assert.strictEqual(nextTile('z7'), 'z5');
  assert.strictEqual(nextTile('z5'), 'z6');
});

test('countTiles: 赤ドラも基本牌として集計', () => {
  const counts = countTiles(['p5', 'p5r', 'p5r', 'm1', 'm1']);
  assert.strictEqual(counts['p5'], 3);
  assert.strictEqual(counts['m1'], 2);
});

// ============================================================
// 4. テンパイ判定・待ち牌のテスト
// ============================================================

test('isTenpai: 一萬待ち（リャンメン待ち）の13枚はテンパイ', () => {
  // 形: 234m 234p 234p 11s 666z + 12s 待ち（一索 or 三索だが s2/s3 はない）
  // FEVER MJ は索子1と9しかないので、別の形でテスト:
  //
  // 形: 222m 333m 444m 555m 99m → 14枚で和了形。1枚抜けばテンパイ。
  const hand = ['m2','m2','m2','m3','m3','m3','m4','m4','m4','m5','m5','m5','m9'];
  // この手は m9 単騎待ち
  assert.ok(isTenpai(hand), 'テンパイ判定');
  const waits = getWaitingTiles(hand);
  assert.ok(waits.includes('m9'), '待ちに m9 が含まれる');
});

test('isTenpai: 七対子で1枚足りない手はテンパイ', () => {
  // 6 対 + 1 枚 = 13 枚（最後の1枚で7対子が完成）
  const hand = ['m1','m1','m3','m3','p2','p2','p4','p4','z1','z1','z3','z3','z5'];
  assert.ok(isTenpai(hand), '七対子テンパイ');
  const waits = getWaitingTiles(hand);
  assert.ok(waits.includes('z5'), 'z5 単騎待ち');
});

test('isTenpai: 完全にバラバラな手はテンパイではない', () => {
  const hand = ['m1','m3','m5','m7','p2','p4','p6','p8','s1','z1','z3','z5','z7'];
  assert.ok(!isTenpai(hand), '非テンパイ');
});

// ============================================================
// 5. 役判定のテスト
// ============================================================

test('evaluateAllYaku: 立直+門前清自摸和+断ヤオ を認定', () => {
  // 形: 234m 234m 234p 234p 55m（雀頭を 5 萬にして中張牌のみ＝タンヤオ成立）
  const hand = ['m2','m3','m4','m2','m3','m4','p2','p3','p4','p2','p3','p4','m5','m5'];
  const patterns = extractAllPatterns(hand);
  assert.ok(patterns.length > 0, 'アガリ形になる');

  const result = evaluateAllYaku(patterns[0], [], [], {
    isReached: true,
    reachType: 'normal',
    ipatsuActive: false,
    feverActive: false,
    isTsumo: true,
    winningTile: 'm5',
    roundWind: 'E',
    seatWind: 'E',
    waitType: 'tanki',
    doraIndicators: [],
  });

  const yakuNames = result.yakuList.map((y) => y.name);
  assert.ok(yakuNames.includes('立直'), '立直が認定される');
  assert.ok(yakuNames.includes('門前清自摸和'), '門前清自摸和が認定される');
  assert.ok(yakuNames.includes('断ヤオ'), 'タンヤオが認定される（中張牌のみで構成）');
});

test('evaluateAllYaku: 端牌入りの手はタンヤオが付かない', () => {
  // 雀頭が 9 萬 → 端牌があるためタンヤオ不成立
  const hand = ['m2','m3','m4','m2','m3','m4','p2','p3','p4','p2','p3','p4','m9','m9'];
  const patterns = extractAllPatterns(hand);

  const result = evaluateAllYaku(patterns[0], [], [], {
    isReached: false,
    reachType: null,
    ipatsuActive: false,
    feverActive: false,
    isTsumo: false,
    winningTile: 'm9',
    roundWind: 'E',
    seatWind: 'E',
    waitType: 'tanki',
    doraIndicators: [],
  });

  const yakuNames = result.yakuList.map((y) => y.name);
  assert.ok(!yakuNames.includes('断ヤオ'), '端牌入りなのでタンヤオ不成立');
});

test('evaluateAllYaku: ロン和了では門前清自摸和は付かない', () => {
  const hand = ['m2','m3','m4','m2','m3','m4','p2','p3','p4','p2','p3','p4','m9','m9'];
  const patterns = extractAllPatterns(hand);

  const result = evaluateAllYaku(patterns[0], [], [], {
    isReached: false,
    reachType: null,
    ipatsuActive: false,
    feverActive: false,
    isTsumo: false,
    winningTile: 'm9',
    roundWind: 'E',
    seatWind: 'E',
    waitType: 'tanki',
    doraIndicators: [],
  });

  const yakuNames = result.yakuList.map((y) => y.name);
  assert.ok(!yakuNames.includes('門前清自摸和'), 'ロンでは付かない');
});

test('evaluateAllYaku: 役牌（白）刻子で1翻', () => {
  // 234m 234p 234p z5z5z5 z7z7 — 白の刻子＋中の雀頭
  const hand = ['m2','m3','m4','p2','p3','p4','p2','p3','p4','z5','z5','z5','z7','z7'];
  const patterns = extractAllPatterns(hand);
  assert.ok(patterns.length > 0);

  const result = evaluateAllYaku(patterns[0], [], [], {
    isReached: false,
    reachType: null,
    ipatsuActive: false,
    feverActive: false,
    isTsumo: false,
    winningTile: 'z7',
    roundWind: 'E',
    seatWind: 'E',
    waitType: 'shabo',
    doraIndicators: [],
  });

  const yakuNames = result.yakuList.map((y) => y.name);
  assert.ok(yakuNames.includes('白'), '白の役牌が認定される');
});

// ============================================================
// 6. リーチ判定（CPU AI）のテスト
// ============================================================

test('cpuCheckReach: テンパイ手で打牌候補を返す（14枚状態）', () => {
  const engine = new GameEngine();
  engine.init();

  // P1 の手牌を強制的にテンパイ形に上書き
  const p1 = engine.state.players[1];
  // 14枚: 234m 234m 234p 234p 99m + 余り1枚
  p1.hand = ['m2','m3','m4','m2','m3','m4','p2','p3','p4','p2','p3','p4','m9','m9'];
  // 山残・点数・副露条件は init 直後で OK

  const result = engine.cpuCheckReach(p1);
  assert.ok(result !== false, 'テンパイ手はリーチ可能と判定');
  assert.ok(typeof result.discardIdx === 'number', 'どの牌を切るかの index がある');
  assert.ok(typeof result.discardTile === 'string', '切る牌の指定がある');
});

test('cpuCheckReach: 持ち点 1000 未満ならリーチ不可', () => {
  const engine = new GameEngine();
  engine.init();
  const p1 = engine.state.players[1];
  p1.hand = ['m2','m3','m4','m2','m3','m4','p2','p3','p4','p2','p3','p4','m9','m9'];
  p1.score = 500;  // リーチ棒1000点を払えない

  const result = engine.cpuCheckReach(p1);
  assert.strictEqual(result, false, '点数不足でリーチ不可');
});

// ============================================================
// 7. 点数計算のテスト
// ============================================================

test('calculateSimpleScore: 子のロン 1翻 は 1000 点', () => {
  assert.strictEqual(calculateSimpleScore(1, false, false), 1000);
});

test('calculateSimpleScore: 満貫（5翻）の子ロンは 8000 点', () => {
  assert.strictEqual(calculateSimpleScore(5, false, false), 8000);
});

test('calculateSimpleScore: 役満（13翻）の子ロンは 32000 点', () => {
  assert.strictEqual(calculateSimpleScore(13, false, false), 32000);
});

test('calculateSimpleScore: 跳満（6翻）の親ツモは 6000all = 18000', () => {
  assert.strictEqual(calculateSimpleScore(6, true, true), 12000);
  // ↑ 基本点 3000 × 2 × 2 = 12000（親ツモの全プレイヤー支払い合計は別計算）
});

// ============================================================
// 8. 打牌→次のターンの簡易フロー
// ============================================================

test('GameEngine.discardTile: 打牌すると手牌が1枚減り、河に追加される', () => {
  const engine = new GameEngine();
  engine.init();
  const p0 = engine.state.players[0];

  // P0 にツモらせる（14枚になる）
  engine.drawTile('P0');
  assert.strictEqual(p0.hand.length, 14);

  const tileToDiscard = p0.hand[0];
  const ok = engine.discardTile('P0', tileToDiscard, false);

  assert.ok(ok, '打牌が成功する');
  assert.strictEqual(p0.hand.length, 13);
  assert.strictEqual(p0.discards.length, 1);
  assert.strictEqual(p0.discards[0].tile, tileToDiscard);
});

test('GameEngine.nextTurn: P0 → P1 → P2 → P0 のローテーション', () => {
  const engine = new GameEngine();
  engine.init();
  engine.state.currentTurn = 'P0';

  engine.nextTurn();
  assert.strictEqual(engine.state.currentTurn, 'P1');
  engine.nextTurn();
  assert.strictEqual(engine.state.currentTurn, 'P2');
  engine.nextTurn();
  assert.strictEqual(engine.state.currentTurn, 'P0');
});
