// ============================================================
// src/game/tile-utils.js
// 牌に関する純粋関数（副作用なし）を集約。
// すべての関数は引数だけで動き、グローバル状態に触れない。
// ============================================================
// 牌の記法（仕様書「15. 設計上の重要メモ」より）:
//   萬子: m1〜m9
//   筒子: p1〜p9（p5 のみ赤ドラとして 'p5r' 表記、4枚すべて赤）
//   索子: s1, s9（FEVER MJ では 2〜8 索は使わない）
//   字牌: z1=東, z2=南, z3=西, z4=北, z5=白, z6=發, z7=中
// ============================================================

const { SUIT_ORDER, WIND_TO_TILE } = require('./constants');

// 牌コードの先頭文字 = スート（m/p/s/z）
function tileSuit(tile) { return tile[0]; }

// 牌コードの2文字目 = 数字（字牌の場合も 1〜7 を返す）
function tileNumber(tile) { return parseInt(tile[1], 10); }

// 末尾に 'r' があれば赤ドラ
function isRed(tile) { return tile.endsWith('r'); }

// 赤ドラ表記を取り除いた基本牌コード（'p5r' → 'p5'）
function tileBase(tile) { return tile.replace('r', ''); }

// 数牌（萬子・筒子・索子）か
function isShuupai(tile) { return tile[0] !== 'z'; }

// 字牌か
function isJihai(tile) { return tile[0] === 'z'; }

// 端牌（1 or 9 の数牌）か
function isTerminal(tile) {
  if (!isShuupai(tile)) return false;
  const n = tileNumber(tile);
  return n === 1 || n === 9;
}

// 么九牌（ヤオチュウハイ：端牌または字牌）か
function isYaochuhai(tile) { return isTerminal(tile) || isJihai(tile); }

// 牌の並びを「スート → 数字 → 赤の有無」で安定ソート
function sortTiles(tiles) {
  return [...tiles].sort((a, b) => {
    const sa = SUIT_ORDER[tileSuit(a)];
    const sb = SUIT_ORDER[tileSuit(b)];
    if (sa !== sb) return sa - sb;
    const na = tileNumber(a);
    const nb = tileNumber(b);
    if (na !== nb) return na - nb;
    if (isRed(a) && !isRed(b)) return 1;
    if (!isRed(a) && isRed(b)) return -1;
    return 0;
  });
}

// 牌の枚数を {基本牌コード: 枚数} の辞書で返す（赤ドラも基本牌として集計）
function countTiles(tiles) {
  const counts = {};
  for (const t of tiles) {
    const base = tileBase(t);
    counts[base] = (counts[base] || 0) + 1;
  }
  return counts;
}

// 自風記号（'E'/'S'/'W'/'N'）→ 字牌コード（'z1'〜'z4'）
function windToTile(wind) {
  return WIND_TO_TILE[wind];
}

// ドラ表示牌から「実際のドラ」を求める（表示牌の次の牌）
//   萬子・筒子: 9 → 1 にループ
//   索子: FEVER MJ では s1, s9 しか存在しないため s1 ↔ s9 で交互ループ
//   風牌(z1〜z4): 北 → 東 にループ
//   三元牌(z5〜z7): 中 → 白 にループ
function nextTile(indicator) {
  const base = tileBase(indicator);
  const suit = tileSuit(base);
  if (isShuupai(base)) {
    // 索子は s1 と s9 しか牌山に存在しないので、特例で s1↔s9 を循環させる
    // 通常通り「次の数」を返すと存在しない s2 等を指してしまい、ドラが死ぬ
    if (suit === 's') {
      const num = tileNumber(base);
      return num === 1 ? 's9' : 's1';
    }
    const num = tileNumber(base);
    const next = num === 9 ? 1 : num + 1;
    return `${suit}${next}`;
  }
  if (suit === 'z') {
    const num = tileNumber(base);
    if (num >= 1 && num <= 4) return `z${num === 4 ? 1 : num + 1}`;
    if (num >= 5 && num <= 7) return `z${num === 7 ? 5 : num + 1}`;
  }
  return base;
}

module.exports = {
  tileSuit,
  tileNumber,
  isRed,
  tileBase,
  isShuupai,
  isJihai,
  isTerminal,
  isYaochuhai,
  sortTiles,
  countTiles,
  windToTile,
  nextTile,
};
