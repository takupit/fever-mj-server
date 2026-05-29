// ============================================================
// src/game/yaku.js
// 役判定・面子（メンツ）分解・テンパイ判定・待ち牌算出・FEVER 判定。
// すべて純粋関数（引数だけで動作）。
// play.html 行 2512〜2978 から移植（ロジックは変更なし）。
// ============================================================

const {
  tileSuit,
  tileNumber,
  isRed,
  tileBase,
  isShuupai,
  isJihai,
  isYaochuhai,
  sortTiles,
  countTiles,
  windToTile,
  nextTile,
} = require('./tile-utils');
const { ALL_TILES_FOR_WAITS } = require('./constants');

// ============ パターン抽出（4面子1雀頭 への分解） ============

// 残りの牌から needSets 個の面子（刻子または順子）を取り出せる全パターンを返す。
// counts: {基本牌コード: 残り枚数}。再帰で全列挙。
function findSets(counts, needSets) {
  if (needSets === 0) {
    // 全部使い切れたパターンのみ有効
    for (const k in counts) if (counts[k] > 0) return [];
    return [[]];
  }
  const tiles = Object.keys(counts).filter((k) => counts[k] > 0).sort();
  if (tiles.length === 0) return [];
  const first = tiles[0];
  const results = [];

  // 刻子（同じ牌3枚）を取り出す
  if (counts[first] >= 3) {
    const next = { ...counts };
    next[first] -= 3;
    const sub = findSets(next, needSets - 1);
    for (const s of sub) {
      results.push([{ type: 'koutsu', tiles: [first, first, first] }, ...s]);
    }
  }

  // 順子（数牌で連続3枚）を取り出す
  if (isShuupai(first)) {
    const suit = tileSuit(first);
    const num = tileNumber(first);
    if (num <= 7) {
      const t2 = `${suit}${num + 1}`;
      const t3 = `${suit}${num + 2}`;
      if ((counts[t2] || 0) >= 1 && (counts[t3] || 0) >= 1) {
        const next = { ...counts };
        next[first] -= 1; next[t2] -= 1; next[t3] -= 1;
        const sub = findSets(next, needSets - 1);
        for (const s of sub) {
          results.push([{ type: 'shuntsu', tiles: [first, t2, t3] }, ...s]);
        }
      }
    }
  }
  return results;
}

// 手牌＋副露 から「雀頭1組＋必要数の面子」の全パターンを返す。
// 副露は先頭側に並べ、すべての面子に「順子/刻子/槓子」「暗刻フラグ」を付ける。
function extractStandardPatterns(handTiles, melds = []) {
  const sorted = sortTiles(handTiles);
  const counts = countTiles(sorted);
  const patterns = [];
  const tileKeys = Object.keys(counts);

  for (const pairTile of tileKeys) {
    if (counts[pairTile] >= 2) {
      const remaining = { ...counts };
      remaining[pairTile] -= 2;
      const meldsCount = melds.length;
      const needSets = 4 - meldsCount;
      const setsList = findSets(remaining, needSets);

      for (const sets of setsList) {
        const allSets = [];
        const allTypes = [];
        const allAnkou = [];
        // 副露を先頭に追加
        for (const meld of melds) {
          allSets.push(meld.tiles.map((t) => tileBase(t)));
          if (meld.type === 'pon') { allTypes.push('koutsu'); allAnkou.push(false); }
          else if (meld.type === 'minkan' || meld.type === 'kakan') { allTypes.push('kantsu'); allAnkou.push(false); }
          else if (meld.type === 'ankan') { allTypes.push('kantsu'); allAnkou.push(true); }
          else if (meld.type === 'chi') { allTypes.push('shuntsu'); allAnkou.push(false); }
        }
        // 手牌から取り出した面子を追加
        for (const set of sets) {
          allSets.push(set.tiles);
          allTypes.push(set.type);
          allAnkou.push(set.type !== 'shuntsu');
        }
        patterns.push({
          pairs: [[pairTile, pairTile]],
          sets: allSets,
          setTypes: allTypes,
          isAnkou: allAnkou,
        });
      }
    }
  }
  return patterns;
}

// 七対子（14枚すべて異なる2枚組）パターンを判定。条件不一致なら null。
function isChiitoitsuPattern(handTiles, melds = []) {
  if (melds.length > 0) return null; // 七対子は面前のみ
  if (handTiles.length !== 14) return null;
  const counts = countTiles(handTiles);
  const pairs = [];
  for (const k in counts) {
    if (counts[k] !== 2) return null;
    pairs.push([k, k]);
  }
  if (pairs.length !== 7) return null;
  return { type: 'chiitoitsu', pairs, sets: [], setTypes: [], isAnkou: [] };
}

// 国士無双の幺九牌（么九＝端牌＋字牌）13種
const KOKUSHI_TILES = ['m1','m9','p1','p9','s1','s9','z1','z2','z3','z4','z5','z6','z7'];

// 国士無双（13種すべて1枚以上＋うち1種が雀頭）パターンを判定。
// 面前のみ。条件不一致なら null。
function isKokushiPattern(handTiles, melds = []) {
  if (melds.length > 0) return null; // 国士無双は面前のみ（暗カンも不可）
  if (handTiles.length !== 14) return null;
  const counts = countTiles(handTiles);
  // 幺九牌以外が混ざっていたら NG
  for (const k of Object.keys(counts)) {
    if (!KOKUSHI_TILES.includes(k)) return null;
  }
  // 13種すべて1枚以上、かつちょうど1種が2枚（雀頭）
  let pairTile = null;
  for (const t of KOKUSHI_TILES) {
    const c = counts[t] || 0;
    if (c === 0) return null;
    if (c === 2) {
      if (pairTile) return null; // 2枚組が2種類以上 → NG
      pairTile = t;
    }
    if (c > 2) return null;
  }
  if (!pairTile) return null;
  return { type: 'kokushi', pairs: [[pairTile, pairTile]], sets: [], setTypes: [], isAnkou: [] };
}

// 通常パターン＋七対子パターン＋国士無双パターンをまとめて返す
function extractAllPatterns(handTiles, melds = []) {
  const all = [];
  all.push(...extractStandardPatterns(handTiles, melds));
  const chiito = isChiitoitsuPattern(handTiles, melds);
  if (chiito) all.push(chiito);
  const kokushi = isKokushiPattern(handTiles, melds);
  if (kokushi) all.push(kokushi);
  return all;
}

// ============ FEVER 判定（仕様書「7. FEVER ルール」） ============

// 指定パターンにおいて、targetTile（'p7' or 'm7'）の暗刻が
// 「和了牌に依存しない独立した暗刻」かを判定。
// 和了牌が暗刻の一部だと「明刻扱い」になるため独立とは見なさない。
function isIndependentInPattern(pattern, winningTile, targetTile) {
  if (pattern.type === 'chiitoitsu' || pattern.type === 'kokushi') return false;
  let targetAnkouIndex = -1;
  for (let i = 0; i < pattern.sets.length; i++) {
    if (pattern.setTypes[i] === 'koutsu' && pattern.isAnkou[i] && tileBase(pattern.sets[i][0]) === targetTile) {
      targetAnkouIndex = i; break;
    }
  }
  if (targetAnkouIndex === -1) return false;
  const winBase = tileBase(winningTile);
  const pairTile = pattern.pairs[0] ? pattern.pairs[0][0] : null;
  // 和了牌が雀頭なら、targetTile の暗刻は独立
  if (pairTile && tileBase(pairTile) === winBase) return true;
  // 和了牌がどこかの面子に含まれるか確認
  for (let i = 0; i < pattern.sets.length; i++) {
    const set = pattern.sets[i];
    if (set.some((t) => tileBase(t) === winBase)) {
      // 和了牌が target 暗刻 *以外* の面子に組み込まれているなら独立
      return i !== targetAnkouIndex;
    }
  }
  return false;
}

// アガリ確定時に FEVER のトリガー種別を判定。
//   'p7'    : 七筒の暗刻が独立して存在
//   'm7'    : 七萬の暗刻が独立して存在
//   'double': 両方独立して存在
//   null    : FEVER 発動なし
function detectFeverType(finalHand, melds, winningTile) {
  const isMenzenHand = !melds || melds.every((m) => m.type === 'ankan');
  if (!isMenzenHand) return null;
  const patterns = extractStandardPatterns(finalHand, melds);
  const p7 = patterns.some((p) => isIndependentInPattern(p, winningTile, 'p7'));
  const m7 = patterns.some((p) => isIndependentInPattern(p, winningTile, 'm7'));
  if (p7 && m7) return 'double';
  if (p7) return 'p7';
  if (m7) return 'm7';
  return null;
}

// ============ 役判定 ============

// 副露があっても暗カンだけなら面前扱い
function isMenzen(melds) {
  if (!melds || melds.length === 0) return true;
  return melds.every((m) => m.type === 'ankan');
}

// 役満判定（パターン依存）。検出したら { name, han, yakumanCount } を返す。
// 国士無双は extractAllPatterns で kokushi 型として渡ってくる。
// 字一色は通常パターンと七対子パターンの両方で成立する。
function detectYakumanInPattern(pattern, melds) {
  // 国士無双（面前のみ・extractAllPatterns で生成）
  if (pattern.type === 'kokushi') {
    return { name: '国士無双', han: 13, yakumanCount: 1 };
  }

  // 七対子型で字一色
  if (pattern.type === 'chiitoitsu') {
    const allJihai = pattern.pairs.every((p) => isJihai(p[0]));
    if (allJihai) return { name: '字一色', han: 13, yakumanCount: 1 };
    return null; // 七対子からは他の役満は出ない
  }

  // 以降は通常パターン（4面子1雀頭）
  // 副露は extractStandardPatterns で pattern.sets の先頭側に統合されているので、
  // pattern.sets と pattern.pairs を見れば手牌＋副露の全体牌が分かる。
  const allTiles = [];
  pattern.pairs.forEach((p) => allTiles.push(...p));
  pattern.sets.forEach((s) => allTiles.push(...s));

  // 字一色: 全部字牌
  if (allTiles.length > 0 && allTiles.every((t) => isJihai(t))) {
    return { name: '字一色', han: 13, yakumanCount: 1 };
  }

  // 清老頭: 全部 1 か 9 の数牌（字牌混入なし）
  if (allTiles.length > 0 && allTiles.every((t) => {
    const base = tileBase(t);
    if (isJihai(base)) return false;
    const n = tileNumber(base);
    return n === 1 || n === 9;
  })) {
    return { name: '清老頭', han: 13, yakumanCount: 1 };
  }

  // 刻子・槓子の代表牌一覧
  const koutsuOrKantsuTiles = [];
  pattern.sets.forEach((set, i) => {
    if (pattern.setTypes[i] === 'koutsu' || pattern.setTypes[i] === 'kantsu') {
      koutsuOrKantsuTiles.push(tileBase(set[0]));
    }
  });

  // 大三元: 白發中すべて刻子（または槓子）
  if (koutsuOrKantsuTiles.includes('z5') &&
      koutsuOrKantsuTiles.includes('z6') &&
      koutsuOrKantsuTiles.includes('z7')) {
    return { name: '大三元', han: 13, yakumanCount: 1 };
  }

  // 大四喜: 東南西北 4 つすべて刻子
  const fourWinds = ['z1', 'z2', 'z3', 'z4'];
  if (fourWinds.every((w) => koutsuOrKantsuTiles.includes(w))) {
    return { name: '大四喜', han: 26, yakumanCount: 2 };
  }

  // 小四喜: 風牌3刻子 + 残り1風牌の雀頭
  const pairBase = pattern.pairs[0] ? tileBase(pattern.pairs[0][0]) : null;
  const windsInKoutsu = fourWinds.filter((w) => koutsuOrKantsuTiles.includes(w));
  if (windsInKoutsu.length === 3 && pairBase && fourWinds.includes(pairBase) &&
      !windsInKoutsu.includes(pairBase)) {
    return { name: '小四喜', han: 13, yakumanCount: 1 };
  }

  // 四槓子: 槓子（暗カン・明カン・加カン問わず）が 4 つ
  const kantsuCount = pattern.setTypes.filter((t) => t === 'kantsu').length;
  if (kantsuCount === 4) {
    return { name: '四槓子', han: 13, yakumanCount: 1 };
  }

  // 九蓮宝燈: 面前・純粋萬子 or 筒子・形が 1112345678999 + 1 牌
  // FEVER MJ では索子は s1/s9 しか存在しないので九蓮は萬子か筒子のみ可能
  if (isMenzen(melds) && melds.length === 0) {
    const suits = new Set();
    for (const t of allTiles) {
      const s = tileSuit(tileBase(t));
      if (s === 'z') { suits.clear(); suits.add('z'); break; }
      suits.add(s);
    }
    if (suits.size === 1) {
      const suit = [...suits][0];
      if (suit === 'm' || suit === 'p') {
        const counts = countTiles(allTiles);
        // 必要形: n=1 が 3 枚、n=2〜8 が各 1 枚、n=9 が 3 枚 → 計 13
        // 和了形は 14 枚なので、上の必要形を満たし「いずれか 1 種だけ +1」になっていれば OK
        const expected = { 1: 3, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 3 };
        let extra = 0;
        let valid = true;
        for (let n = 1; n <= 9; n++) {
          const key = `${suit}${n}`;
          const have = counts[key] || 0;
          const need = expected[n];
          if (have < need || have > need + 1) { valid = false; break; }
          extra += have - need;
        }
        if (valid && extra === 1) {
          return { name: '九蓮宝燈', han: 13, yakumanCount: 1 };
        }
      }
    }
  }

  return null;
}

// 1つのパターン（4面子1雀頭 or 七対子 or 国士無双）について、すべての役を集計する。
// ctx の中身:
//   isReached, reachType, ipatsuActive, feverActive, isTsumo, winningTile,
//   roundWind ('E'/'S'/'W'), seatWind ('E'/'S'/'W'/'N'), waitType,
//   doraIndicators, uraDoraIndicators
function evaluateAllYaku(pattern, melds, kitaPulls, ctx) {
  // ★ まず役満を先にチェック（成立したらドラなど他の役は加算しない・固定 13 翻）
  const yakumanResult = detectYakumanInPattern(pattern, melds);
  if (yakumanResult) {
    return {
      yakuList: [{ name: yakumanResult.name, han: yakumanResult.han }],
      totalHan: yakumanResult.han,
      isYakuman: true,
      yakumanCount: yakumanResult.yakumanCount,
    };
  }

  const yakuList = [];

  // 立直系
  if (ctx.isReached) {
    if (ctx.reachType === 'double') yakuList.push({ name: 'ダブル立直', han: 2 });
    else if (ctx.reachType === 'open' || ctx.feverActive) yakuList.push({ name: ctx.feverActive ? '立直 (FEVER)' : 'オープン立直', han: 2 });
    else yakuList.push({ name: '立直', han: 1 });

    if (ctx.ipatsuActive) yakuList.push({ name: '一発', han: 1 });
  }

  // 門前清自摸和（メンゼンツモ）
  if (isMenzen(melds) && ctx.isTsumo) {
    yakuList.push({ name: '門前清自摸和', han: 1 });
  }

  // 槍槓（チャンカン）：他家の加カンに対するロン和了で 1 翻
  // 加カンの瞬間に他家がロンするケース。ctx.isChankan が立っているときのみ加算。
  if (ctx.isChankan) {
    yakuList.push({ name: '槍槓', han: 1 });
  }

  // 平和（ピンフ）：面前・全順子・両面待ち・役牌でない雀頭
  if (isMenzen(melds) && pattern.type !== 'chiitoitsu') {
    const allShuntsu = pattern.setTypes.every((t) => t === 'shuntsu');
    const pairTile = pattern.pairs[0][0];
    const pairBase = tileBase(pairTile);
    // 役牌雀頭は平和不成立。
    // 三元牌（白發中=z5/z6/z7）と場風・自風の雀頭が対象。
    // z4（北）は雀頭そのものでは役牌にならないため除外（北抜き3枚 or 暗刻時のみ役牌）
    const isYakuhaiPair = ['z5','z6','z7'].includes(pairBase) ||
      pairBase === windToTile(ctx.roundWind) ||
      pairBase === windToTile(ctx.seatWind);
    if (allShuntsu && !isYakuhaiPair && ctx.waitType === 'ryanmen') {
      yakuList.push({ name: '平和', han: 1 });
    }
  }

  // 役牌：刻子/槓子で持っている字牌
  const allKoutsuTiles = [];
  pattern.sets.forEach((set, i) => {
    if (pattern.setTypes[i] === 'koutsu' || pattern.setTypes[i] === 'kantsu') {
      allKoutsuTiles.push(tileBase(set[0]));
    }
  });

  if (allKoutsuTiles.includes('z5')) yakuList.push({ name: '白', han: 1 });
  if (allKoutsuTiles.includes('z6')) yakuList.push({ name: '發', han: 1 });
  if (allKoutsuTiles.includes('z7')) yakuList.push({ name: '中', han: 1 });
  // 注: z4（北）は下の「北」判定セクションで一元的に評価する。
  // ここで z4 を加算すると北抜き3枚＋北暗刻のケースで重複加算が発生する。

  const roundWindTile = windToTile(ctx.roundWind);
  const seatWindTile = windToTile(ctx.seatWind);
  if (allKoutsuTiles.includes(roundWindTile) && roundWindTile !== 'z4') {
    const wn = { z1: '東', z2: '南', z3: '西' }[roundWindTile];
    yakuList.push({ name: `場風 ${wn}`, han: 1 });
  }
  // 自風：場風と同じ時もダブ東/ダブ南として計上
  if (seatWindTile !== 'z4' && allKoutsuTiles.includes(seatWindTile)) {
    const wn = { z1: '東', z2: '南', z3: '西' }[seatWindTile];
    yakuList.push({ name: `自風 ${wn}`, han: 1 });
  }

  // 北：役牌として1翻（北抜き3枚以上、または面前で北の暗刻）
  // どちらか一方の条件を満たせば 1 翻。両方満たしても 1 翻のみ（重複加算しない）
  const isKitaPullThree = kitaPulls.length >= 3;
  const isMenzenKitaAnkou = isMenzen(melds) && pattern.sets.some((set, i) =>
    pattern.setTypes[i] === 'koutsu' && pattern.isAnkou[i] && set[0] === 'z4');
  if (isKitaPullThree || isMenzenKitaAnkou) {
    yakuList.push({ name: '北', han: 1 });
  }

  // タンヤオ（面前のみ＝食いタンなし）
  if (isMenzen(melds)) {
    const allTiles = [];
    pattern.pairs.forEach((p) => allTiles.push(...p));
    pattern.sets.forEach((s) => allTiles.push(...s));
    if (allTiles.every((t) => !isYaochuhai(t))) {
      yakuList.push({ name: '断ヤオ', han: 1 });
    }
  }

  // 七対子（2翻・面前のみ）
  if (pattern.type === 'chiitoitsu') {
    yakuList.push({ name: '七対子', han: 2 });
  }

  // 対々和（全刻子）
  if (pattern.type !== 'chiitoitsu') {
    const allKoutsu = pattern.setTypes.every((t) => t === 'koutsu' || t === 'kantsu');
    if (allKoutsu) yakuList.push({ name: '対々和', han: 2 });
  }

  // 清一色・混一色判定用に「副露含む全ての牌」を集める
  const allTilesAll = [];
  pattern.pairs.forEach((p) => allTilesAll.push(...p));
  pattern.sets.forEach((s) => allTilesAll.push(...s));
  melds.forEach((m) => allTilesAll.push(...m.tiles));

  if (pattern.type !== 'kokushi') {
    const suitsUsed = new Set();
    let hasJihai = false;
    allTilesAll.forEach((t) => {
      const s = tileSuit(tileBase(t));
      if (s === 'z') hasJihai = true;
      else suitsUsed.add(s);
    });

    if (suitsUsed.size === 1 && !hasJihai) {
      // 清一色：面前 6 翻、副露 5 翻
      yakuList.push({ name: '清一色', han: isMenzen(melds) ? 6 : 5 });
    } else if (suitsUsed.size === 1 && hasJihai) {
      // 混一色：面前 3 翻、副露 2 翻
      yakuList.push({ name: '混一色', han: isMenzen(melds) ? 3 : 2 });
    }
  }

  // 一気通貫（イッキツウカン）：同色で 123, 456, 789 が揃う
  if (pattern.type !== 'chiitoitsu' && pattern.type !== 'kokushi') {
    for (const suit of ['m', 'p', 's']) {
      const lowSet = pattern.sets.findIndex((set, i) =>
        pattern.setTypes[i] === 'shuntsu' &&
        tileBase(set[0]) === `${suit}1` && tileBase(set[1]) === `${suit}2` && tileBase(set[2]) === `${suit}3`);
      const midSet = pattern.sets.findIndex((set, i) =>
        pattern.setTypes[i] === 'shuntsu' &&
        tileBase(set[0]) === `${suit}4` && tileBase(set[1]) === `${suit}5` && tileBase(set[2]) === `${suit}6`);
      const highSet = pattern.sets.findIndex((set, i) =>
        pattern.setTypes[i] === 'shuntsu' &&
        tileBase(set[0]) === `${suit}7` && tileBase(set[1]) === `${suit}8` && tileBase(set[2]) === `${suit}9`);

      // 副露の順子もチェック
      const meldShuntsuLow = melds.some((m) => m.type === 'chi' &&
        tileBase(m.tiles[0]) === `${suit}1` && tileBase(m.tiles[1]) === `${suit}2` && tileBase(m.tiles[2]) === `${suit}3`);
      const meldShuntsuMid = melds.some((m) => m.type === 'chi' &&
        tileBase(m.tiles[0]) === `${suit}4` && tileBase(m.tiles[1]) === `${suit}5` && tileBase(m.tiles[2]) === `${suit}6`);
      const meldShuntsuHigh = melds.some((m) => m.type === 'chi' &&
        tileBase(m.tiles[0]) === `${suit}7` && tileBase(m.tiles[1]) === `${suit}8` && tileBase(m.tiles[2]) === `${suit}9`);

      const hasLow = lowSet >= 0 || meldShuntsuLow;
      const hasMid = midSet >= 0 || meldShuntsuMid;
      const hasHigh = highSet >= 0 || meldShuntsuHigh;

      if (hasLow && hasMid && hasHigh) {
        yakuList.push({ name: '一気通貫', han: isMenzen(melds) ? 2 : 1 });
        break;
      }
    }
  }

  // 純チャン・チャンタ（端牌絡み）
  if (pattern.type !== 'chiitoitsu' && pattern.type !== 'kokushi') {
    // 雀頭と各面子のすべてが端牌（mustTerminalOnly=true なら字牌は除外＝純チャン）
    const checkChanta = (mustTerminalOnly) => {
      const pairTile = pattern.pairs[0] && pattern.pairs[0][0];
      if (!pairTile) return false;
      const pairBase = tileBase(pairTile);
      const pairIsTerminal = isYaochuhai(pairBase);
      const pairIsJihai = isJihai(pairBase);
      if (!pairIsTerminal) return false;
      if (mustTerminalOnly && pairIsJihai) return false;

      for (let i = 0; i < pattern.sets.length; i++) {
        const set = pattern.sets[i];
        const type = pattern.setTypes[i];
        if (type === 'shuntsu') {
          const nums = set.map((t) => tileNumber(tileBase(t)));
          const sortedNums = [...nums].sort((a, b) => a - b);
          if (sortedNums[0] !== 1 && sortedNums[2] !== 9) return false;
        } else {
          if (!isYaochuhai(set[0])) return false;
          if (mustTerminalOnly && isJihai(set[0])) return false;
        }
      }
      // 副露もチェック
      for (const m of melds) {
        if (m.type === 'chi') {
          const nums = m.tiles.map((t) => tileNumber(tileBase(t))).sort((a, b) => a - b);
          if (nums[0] !== 1 && nums[2] !== 9) return false;
        } else {
          if (!isYaochuhai(m.tiles[0])) return false;
          if (mustTerminalOnly && isJihai(m.tiles[0])) return false;
        }
      }
      return true;
    };

    if (checkChanta(true)) {
      // 純全帯ヤオ九（純チャン）：面前3翻、副露2翻
      yakuList.push({ name: '純全帯ヤオ九', han: isMenzen(melds) ? 3 : 2 });
    } else if (checkChanta(false)) {
      // 混全帯ヤオ九（チャンタ）：面前2翻、副露1翻
      // 雀頭か面子のどこかに字牌が含まれる必要あり
      const hasJihai = allTilesAll.some((t) => isJihai(t));
      if (hasJihai) {
        yakuList.push({ name: '混全帯ヤオ九', han: isMenzen(melds) ? 2 : 1 });
      }
    }
  }

  // 三暗刻・四暗刻（ロン和了で和了牌を含む刻子は明刻扱い）
  let ankouCount = 0;
  pattern.sets.forEach((set, i) => {
    if (pattern.setTypes[i] === 'koutsu' && pattern.isAnkou[i]) {
      if (!ctx.isTsumo && set.some((t) => tileBase(t) === tileBase(ctx.winningTile))) return;
      ankouCount++;
    }
  });
  // 暗カンも暗刻に含める
  melds.forEach((m) => { if (m.type === 'ankan') ankouCount++; });

  if (ankouCount === 3) yakuList.push({ name: '三暗刻', han: 2 });
  if (ankouCount === 4 && isMenzen(melds)) {
    return { yakuList: [{ name: '四暗刻', han: 13 }], totalHan: 13, isYakuman: true, yakumanCount: 1 };
  }

  // ドラ
  const allTilesForDora = [];
  pattern.pairs.forEach((p) => allTilesForDora.push(...p));
  pattern.sets.forEach((s) => allTilesForDora.push(...s));
  melds.forEach((m) => allTilesForDora.push(...m.tiles));

  let doraCount = 0;
  if (ctx.doraIndicators) {
    for (const ind of ctx.doraIndicators) {
      const doraTile = nextTile(ind);
      doraCount += allTilesForDora.filter((t) => tileBase(t) === doraTile).length;
    }
  }
  // 北抜きはドラとして加算
  doraCount += kitaPulls.length;
  if (doraCount > 0) yakuList.push({ name: `ドラ${doraCount}`, han: doraCount });

  // 赤ドラ
  const akaCount = allTilesForDora.filter((t) => isRed(t)).length;
  if (akaCount > 0) yakuList.push({ name: `赤ドラ${akaCount}`, han: akaCount });

  // 裏ドラ（リーチ和了時のみ計上）
  // リーチしていなければ uraDoraIndicators の有無に関わらず加算しない（仕様）
  if (ctx.isReached && ctx.uraDoraIndicators && ctx.uraDoraIndicators.length > 0) {
    let uraCount = 0;
    for (const ind of ctx.uraDoraIndicators) {
      const uraTile = nextTile(ind);
      uraCount += allTilesForDora.filter((t) => tileBase(t) === uraTile).length;
    }
    if (uraCount > 0) yakuList.push({ name: `裏ドラ${uraCount}`, han: uraCount });
  }

  const totalHan = yakuList.reduce((sum, y) => sum + y.han, 0);
  return { yakuList, totalHan, isYakuman: false, yakumanCount: 0 };
}

// 待ちの種類を判定（単騎 tanki / シャボ shabo / カンチャン kanchan
//   / ペンチャン penchan / リャンメン ryanmen）
function detectWaitType(pattern, winningTile) {
  const winBase = tileBase(winningTile);
  if (pattern.pairs[0] && tileBase(pattern.pairs[0][0]) === winBase) return 'tanki';
  for (let i = 0; i < pattern.sets.length; i++) {
    const set = pattern.sets[i];
    if (!set.some((t) => tileBase(t) === winBase)) continue;
    if (pattern.setTypes[i] === 'koutsu') return 'shabo';
    if (pattern.setTypes[i] === 'shuntsu') {
      const positions = set.map((t) => tileBase(t));
      const winPos = positions.indexOf(winBase);
      if (winPos === 1) return 'kanchan';
      const nums = positions.map((p) => parseInt(p[1], 10));
      if ((winPos === 0 && nums[0] === 1) || (winPos === 2 && nums[2] === 9)) return 'penchan';
      return 'ryanmen';
    }
  }
  return 'ryanmen';
}

// テンパイかどうか（任意の1枚を足してアガリ形になるかを総当たり）
function isTenpai(hand, melds = []) {
  for (const t of ALL_TILES_FOR_WAITS) {
    const test = [...hand, t];
    const patterns = extractAllPatterns(test, melds);
    if (patterns.length > 0) return true;
  }
  return false;
}

// 待ち牌のリストを返す（重複なし）
function getWaitingTiles(hand, melds = []) {
  const waits = [];
  for (const t of ALL_TILES_FOR_WAITS) {
    const test = [...hand, t];
    const patterns = extractAllPatterns(test, melds);
    if (patterns.length > 0) waits.push(t);
  }
  return waits;
}

module.exports = {
  findSets,
  extractStandardPatterns,
  isChiitoitsuPattern,
  isKokushiPattern,
  extractAllPatterns,
  isIndependentInPattern,
  detectFeverType,
  isMenzen,
  detectYakumanInPattern,
  evaluateAllYaku,
  detectWaitType,
  isTenpai,
  getWaitingTiles,
  KOKUSHI_TILES,
};
