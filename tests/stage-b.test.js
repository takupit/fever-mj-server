// ============================================================
// tests/stage-b.test.js
// ステージ B の修正（役判定の精密化）に対するテスト。
//   #6 nextTile の索子分岐（s1 ↔ s9）
//   #5 平和判定で z4 雀頭の役牌扱い解消
//   #4 「北」役牌の重複加算解消
//   #7 裏ドラ加算
//   #8 役満実装（国士・大三元・字一色・清老頭・九蓮宝燈 など）
//   #10 チャンカン（槍槓）役の加算
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert');

const { nextTile } = require('../src/game/tile-utils');
const {
  evaluateAllYaku,
  extractAllPatterns,
  isKokushiPattern,
  detectYakumanInPattern,
} = require('../src/game/yaku');

// ============================================================
// #6 nextTile の索子分岐
// ============================================================

test('#6 nextTile: s1 のドラ表示牌は s9 を指す', () => {
  // 索子は s1, s9 しか存在しないので、s1 → s9 のループになる
  assert.strictEqual(nextTile('s1'), 's9');
});

test('#6 nextTile: s9 のドラ表示牌は s1 を指す', () => {
  assert.strictEqual(nextTile('s9'), 's1');
});

test('#6 nextTile: 萬子・筒子は通常通り 9 → 1 にループ', () => {
  assert.strictEqual(nextTile('m9'), 'm1');
  assert.strictEqual(nextTile('p9'), 'p1');
  assert.strictEqual(nextTile('m5'), 'm6');
  // 赤ドラ表示牌でも基本牌で次牌を計算
  assert.strictEqual(nextTile('p5r'), 'p6');
});

test('#6 nextTile: 字牌は風 z1〜z4 と三元牌 z5〜z7 の2系統でループ', () => {
  assert.strictEqual(nextTile('z4'), 'z1'); // 北 → 東
  assert.strictEqual(nextTile('z7'), 'z5'); // 中 → 白
});

// ============================================================
// #5 平和判定で z4 雀頭の役牌扱いを解消
// ============================================================
// シンプルな素和：手牌に z4 雀頭＋全順子・両面待ち・面前ツモ
// → 平和 + 門前清自摸和 が成立すべき

test('#5 平和: z4（北）雀頭で平和が成立する（北抜きなし）', () => {
  // 手牌: m1-2-3, p2-3-4, p5-6-7, m4-5-6 完成形 + z4 z4 雀頭
  // 待ち: 両面待ちを作るため、ツモ前は p5,p6 + p7待ち
  // 簡単のため完成形を直接渡して評価
  const hand = ['m1','m2','m3','p2','p3','p4','p5','p6','p7','m4','m5','m6','z4','z4'];
  const patterns = extractAllPatterns(hand, []);
  assert.ok(patterns.length > 0, 'パターンが分解できる');

  // 平和成立を見るには：
  // - waitType=ryanmen
  // - winningTile が両面のどちらか
  // ここでは p7 のツモアガリ・両面待ち想定
  const ctx = {
    isReached: false, ipatsuActive: false, feverActive: false,
    isTsumo: true, winningTile: 'p7',
    roundWind: 'E', seatWind: 'S',
    waitType: 'ryanmen',
    doraIndicators: [], uraDoraIndicators: [],
  };
  // パターン全部試して、平和が含まれるものがあるか
  const hasPinfu = patterns.some((p) => {
    const r = evaluateAllYaku(p, [], [], ctx);
    return r.yakuList.some((y) => y.name === '平和');
  });
  assert.ok(hasPinfu, 'z4 雀頭でも平和が成立する');
});

test('#5 平和: z5（白）雀頭では平和が不成立', () => {
  const hand = ['m1','m2','m3','p2','p3','p4','p5','p6','p7','m4','m5','m6','z5','z5'];
  const patterns = extractAllPatterns(hand, []);
  const ctx = {
    isReached: false, ipatsuActive: false, feverActive: false,
    isTsumo: true, winningTile: 'p7',
    roundWind: 'E', seatWind: 'S',
    waitType: 'ryanmen',
    doraIndicators: [], uraDoraIndicators: [],
  };
  const hasPinfu = patterns.some((p) => {
    const r = evaluateAllYaku(p, [], [], ctx);
    return r.yakuList.some((y) => y.name === '平和');
  });
  assert.ok(!hasPinfu, '役牌雀頭では平和は不成立');
});

// ============================================================
// #4 北の重複加算解消
// ============================================================

test('#4 北抜き3枚＋面前 z4 暗刻 でも「北」役牌は 1 翻のみ', () => {
  // 手牌: 4面子1雀頭の通常形に z4 暗刻を含む。北抜き3枚あり。
  const hand = ['m1','m2','m3','p1','p2','p3','m7','m8','m9','z4','z4','z4','p5','p5'];
  const patterns = extractAllPatterns(hand, []);
  assert.ok(patterns.length > 0);
  const ctx = {
    isReached: false, ipatsuActive: false, feverActive: false,
    isTsumo: true, winningTile: 'p5',
    roundWind: 'E', seatWind: 'S',
    waitType: 'shabo',
    doraIndicators: [], uraDoraIndicators: [],
  };
  const kitaPulls = [{ tile: 'z4' }, { tile: 'z4' }, { tile: 'z4' }];
  const r = evaluateAllYaku(patterns[0], [], kitaPulls, ctx);
  const kitaCount = r.yakuList.filter((y) => y.name === '北').length;
  assert.strictEqual(kitaCount, 1, '北は 1 翻のみ計上される（重複加算なし）');
});

// ============================================================
// #7 裏ドラ加算
// ============================================================

test('#7 裏ドラ: リーチ和了で裏ドラ表示牌の次牌が手にあれば裏ドラ加算', () => {
  // 手牌: 簡単な確定形
  const hand = ['m1','m2','m3','p1','p2','p3','s1','s1','s1','z1','z1','z1','m9','m9'];
  const patterns = extractAllPatterns(hand, []);
  // 裏ドラ表示牌が m8 → 裏ドラは m9。手牌の m9 が 2 枚あるので +2 翻
  const ctx = {
    isReached: true, reachType: 'normal',
    ipatsuActive: false, feverActive: false,
    isTsumo: true, winningTile: 'm9',
    roundWind: 'E', seatWind: 'S',
    waitType: 'tanki',
    doraIndicators: [],
    uraDoraIndicators: ['m8'],
  };
  const r = evaluateAllYaku(patterns[0], [], [], ctx);
  const uraDora = r.yakuList.find((y) => y.name.startsWith('裏ドラ'));
  assert.ok(uraDora, '裏ドラが計上される');
  assert.strictEqual(uraDora.han, 2, '裏ドラ 2 枚で +2 翻');
});

test('#7 裏ドラ: リーチしていなければ加算されない', () => {
  const hand = ['m1','m2','m3','p1','p2','p3','s1','s1','s1','z1','z1','z1','m9','m9'];
  const patterns = extractAllPatterns(hand, []);
  const ctx = {
    isReached: false, ipatsuActive: false, feverActive: false,
    isTsumo: true, winningTile: 'm9',
    roundWind: 'E', seatWind: 'S',
    waitType: 'tanki',
    doraIndicators: [],
    uraDoraIndicators: ['m8'],
  };
  const r = evaluateAllYaku(patterns[0], [], [], ctx);
  const uraDora = r.yakuList.find((y) => y.name.startsWith('裏ドラ'));
  assert.ok(!uraDora, 'リーチなしでは裏ドラは計上されない');
});

// ============================================================
// #8 役満
// ============================================================

test('#8 国士無双: 13幺九 + 1組の雀頭で成立', () => {
  // 手牌: m1,m9,p1,p9,s1,s9,z1-z7 + z1（雀頭は z1）
  const hand = ['m1','m9','p1','p9','s1','s9','z1','z2','z3','z4','z5','z6','z7','z1'];
  const kokushi = isKokushiPattern(hand, []);
  assert.ok(kokushi, '国士パターンが検出される');
  assert.strictEqual(kokushi.type, 'kokushi');

  const r = detectYakumanInPattern(kokushi, []);
  assert.ok(r);
  assert.strictEqual(r.name, '国士無双');
  assert.strictEqual(r.han, 13);
});

test('#8 国士無双: 12種類しかなければ不成立', () => {
  const hand = ['m1','m9','p1','p9','s1','s9','z1','z2','z3','z4','z5','z6','z6','z6']; // z7 がない
  const kokushi = isKokushiPattern(hand, []);
  assert.strictEqual(kokushi, null);
});

test('#8 大三元: 白發中すべて刻子で成立', () => {
  const hand = ['z5','z5','z5','z6','z6','z6','z7','z7','z7','m1','m2','m3','p5','p5'];
  const patterns = extractAllPatterns(hand, []);
  const ctx = {
    isReached: false, ipatsuActive: false, feverActive: false,
    isTsumo: true, winningTile: 'p5',
    roundWind: 'E', seatWind: 'S',
    waitType: 'shabo',
    doraIndicators: [], uraDoraIndicators: [],
  };
  let hasYakuman = false;
  let yakumanName = null;
  for (const p of patterns) {
    const r = evaluateAllYaku(p, [], [], ctx);
    if (r.isYakuman) { hasYakuman = true; yakumanName = r.yakuList[0].name; break; }
  }
  assert.ok(hasYakuman, '役満が検出される');
  assert.strictEqual(yakumanName, '大三元');
});

test('#8 字一色: 全部字牌で成立（七対子型）', () => {
  // 七対子の字一色
  const hand = ['z1','z1','z2','z2','z3','z3','z4','z4','z5','z5','z6','z6','z7','z7'];
  const patterns = extractAllPatterns(hand, []);
  const ctx = {
    isReached: false, ipatsuActive: false, feverActive: false,
    isTsumo: true, winningTile: 'z7',
    roundWind: 'E', seatWind: 'S',
    waitType: 'tanki',
    doraIndicators: [], uraDoraIndicators: [],
  };
  let hasTsuiisou = false;
  for (const p of patterns) {
    const r = evaluateAllYaku(p, [], [], ctx);
    if (r.isYakuman && r.yakuList[0].name === '字一色') { hasTsuiisou = true; break; }
  }
  assert.ok(hasTsuiisou, '字一色（七対子型）が役満として検出される');
});

test('#8 清老頭: 全部1か9の数牌で成立', () => {
  const hand = ['m1','m1','m1','m9','m9','m9','p1','p1','p1','p9','p9','p9','s1','s1'];
  const patterns = extractAllPatterns(hand, []);
  const ctx = {
    isReached: false, ipatsuActive: false, feverActive: false,
    isTsumo: true, winningTile: 's1',
    roundWind: 'E', seatWind: 'S',
    waitType: 'tanki',
    doraIndicators: [], uraDoraIndicators: [],
  };
  let hasChinrou = false;
  for (const p of patterns) {
    const r = evaluateAllYaku(p, [], [], ctx);
    if (r.isYakuman && r.yakuList[0].name === '清老頭') { hasChinrou = true; break; }
  }
  assert.ok(hasChinrou, '清老頭が役満として検出される');
});

test('#8 九蓮宝燈: 純粋萬子 1112345678999+1 で成立', () => {
  // 11123456789 9 9 + 1 任意 = 14枚
  const hand = ['m1','m1','m1','m2','m3','m4','m5','m6','m7','m8','m9','m9','m9','m5'];
  const patterns = extractAllPatterns(hand, []);
  const ctx = {
    isReached: false, ipatsuActive: false, feverActive: false,
    isTsumo: true, winningTile: 'm5',
    roundWind: 'E', seatWind: 'S',
    waitType: 'tanki',
    doraIndicators: [], uraDoraIndicators: [],
  };
  let hasChuren = false;
  for (const p of patterns) {
    const r = evaluateAllYaku(p, [], [], ctx);
    if (r.isYakuman && r.yakuList[0].name === '九蓮宝燈') { hasChuren = true; break; }
  }
  assert.ok(hasChuren, '九蓮宝燈が役満として検出される');
});

test('#8 大四喜: 東南西北すべて刻子（ダブル役満 26翻）', () => {
  const hand = ['z1','z1','z1','z2','z2','z2','z3','z3','z3','z4','z4','z4','m1','m1'];
  const patterns = extractAllPatterns(hand, []);
  const ctx = {
    isReached: false, ipatsuActive: false, feverActive: false,
    isTsumo: true, winningTile: 'm1',
    roundWind: 'E', seatWind: 'S',
    waitType: 'tanki',
    doraIndicators: [], uraDoraIndicators: [],
  };
  let hasDaisuushii = false;
  let yakumanCount = 0;
  for (const p of patterns) {
    const r = evaluateAllYaku(p, [], [], ctx);
    if (r.isYakuman && r.yakuList[0].name === '大四喜') {
      hasDaisuushii = true;
      yakumanCount = r.yakumanCount;
      break;
    }
  }
  assert.ok(hasDaisuushii, '大四喜が役満として検出される');
  assert.strictEqual(yakumanCount, 2, '大四喜はダブル役満（yakumanCount=2）');
});

// ============================================================
// 役満のチップ報酬（仕様: 純正役満=10枚ALL、W役満=20枚ALL、数え役満=5枚ALL）
// chip.js 既存ルール③が、ステージBで追加した役満でも正しく動くか保証する
// ============================================================

const { GameEngine } = require('../src/game/engine');
const { calculateChipMoves } = require('../src/game/chip');

function makeYakumanResult(name, han = 13, yakumanCount = 1) {
  return {
    pattern: { sets: [], pairs: [], setTypes: [] },
    yakuResult: {
      yakuList: [{ name, han }],
      totalHan: han,
      isYakuman: true,
      yakumanCount,
    },
    waitType: 'tanki',
  };
}

function makeKazoeYakumanResult(totalHan) {
  return {
    pattern: { sets: [], pairs: [], setTypes: [] },
    yakuResult: {
      yakuList: [{ name: '立直', han: 1 }, { name: `ドラ${totalHan - 1}`, han: totalHan - 1 }],
      totalHan,
      isYakuman: false,
      yakumanCount: 0,
    },
    waitType: 'tanki',
  };
}

test('チップ: 純正役満ツモは 10 枚 ALL（他家2人から各10枚）', () => {
  const engine = new GameEngine();
  engine.init();
  const p0 = engine.state.players[0];
  // 適当な手牌（チップ ①②に該当しないように：七筒なし・字牌中心）
  p0.hand = ['z1','z1','z1','z2','z2','z2','z3','z3','z3','z5','z5','z5','m1','m1'];
  engine.state.drawnTile = 'm1';
  engine.state.lastDiscard = null;
  const result = calculateChipMoves({
    state: engine.state,
    agariResult: makeYakumanResult('字一色', 13, 1),
    winnerId: 'P0',
    isTsumo: true,
  });
  // 純正役満 → 10枚 ALL
  assert.strictEqual(result.moves.P1, -10);
  assert.strictEqual(result.moves.P2, -10);
  assert.strictEqual(result.moves.P0, 20);
  assert.strictEqual(result.breakdown.rule3, 20);
});

test('チップ: 純正役満ロンも 10 枚 ALL（全員から徴収）', () => {
  const engine = new GameEngine();
  engine.init();
  const p0 = engine.state.players[0];
  p0.hand = ['m1','m9','p1','p9','s1','s9','z1','z2','z3','z4','z5','z6','z7']; // 13枚（国士想定）
  engine.state.drawnTile = null;
  engine.state.lastDiscard = { player: 'P1', tile: 'z1' };
  const result = calculateChipMoves({
    state: engine.state,
    agariResult: makeYakumanResult('国士無双', 13, 1),
    winnerId: 'P0',
    isTsumo: false,
    fromPlayer: 'P1',
  });
  // 役満ロンでも ALL なので「ロン振り込み者だけ」ではなく全員から
  assert.strictEqual(result.moves.P1, -10);
  assert.strictEqual(result.moves.P2, -10);
  assert.strictEqual(result.moves.P0, 20);
});

test('チップ: W役満（大四喜）は 20 枚 ALL（10×2）', () => {
  const engine = new GameEngine();
  engine.init();
  const p0 = engine.state.players[0];
  p0.hand = ['z1','z1','z1','z2','z2','z2','z3','z3','z3','z4','z4','z4','m1','m1'];
  engine.state.drawnTile = 'm1';
  const result = calculateChipMoves({
    state: engine.state,
    agariResult: makeYakumanResult('大四喜', 26, 2),
    winnerId: 'P0',
    isTsumo: true,
  });
  // W役満 → 20枚 ALL
  assert.strictEqual(result.moves.P1, -20);
  assert.strictEqual(result.moves.P2, -20);
  assert.strictEqual(result.moves.P0, 40);
});

test('チップ: 数え役満（13翻だが isYakuman=false）は 5 枚 ALL', () => {
  const engine = new GameEngine();
  engine.init();
  const p0 = engine.state.players[0];
  // 適当な手牌（鳴き役なし・字牌だけ）
  p0.hand = ['z1','z1','z1','z2','z2','z2','z3','z3','z3','z4','z4','z4','m5','m5'];
  engine.state.drawnTile = 'm5';
  const result = calculateChipMoves({
    state: engine.state,
    agariResult: makeKazoeYakumanResult(13),
    winnerId: 'P0',
    isTsumo: true,
  });
  // 数え役満 → 5 枚 ALL
  assert.strictEqual(result.moves.P1, -5);
  assert.strictEqual(result.moves.P2, -5);
  assert.strictEqual(result.moves.P0, 10);
});

test('チップ: 12翻以下では数え役満ボーナスなし', () => {
  const engine = new GameEngine();
  engine.init();
  const p0 = engine.state.players[0];
  p0.hand = ['z1','z1','z1','z2','z2','z2','z3','z3','z3','z4','z4','z4','m5','m5'];
  engine.state.drawnTile = 'm5';
  const result = calculateChipMoves({
    state: engine.state,
    agariResult: makeKazoeYakumanResult(12),
    winnerId: 'P0',
    isTsumo: true,
  });
  // ルール③のボーナスなし
  assert.strictEqual(result.breakdown.rule3, 0);
});

// ============================================================
// #10 槍槓
// ============================================================

test('#10 槍槓: ctx.isChankan が立てば 1 翻加算される', () => {
  // 単純な確定形（タンヤオ系）で槍槓 +1 翻を確認
  const hand = ['m2','m3','m4','p3','p4','p5','s1','s1','s1','m5','m5','m5','p7','p7'];
  const patterns = extractAllPatterns(hand, []);
  const ctx = {
    isReached: false, ipatsuActive: false, feverActive: false,
    isTsumo: false, isChankan: true,
    winningTile: 'p7',
    roundWind: 'E', seatWind: 'S',
    waitType: 'shabo',
    doraIndicators: [], uraDoraIndicators: [],
  };
  const r = evaluateAllYaku(patterns[0], [], [], ctx);
  const chankan = r.yakuList.find((y) => y.name === '槍槓');
  assert.ok(chankan, '槍槓が計上される');
  assert.strictEqual(chankan.han, 1, '槍槓は 1 翻');
});
