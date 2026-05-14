// ============================================================
// src/game/wall.js
// 山牌（やまはい）の生成・シャッフル。
// 乱数源を差し替えられるようにしておく（テストで再現性のある配牌を作るため）。
// ============================================================
// FEVER MJ の使用牌（全108枚・仕様書「1.使用牌」参照）:
//   萬子 1〜9 各4枚 = 36枚
//   筒子 1〜9 各4枚（5筒は赤5として p5r で4枚すべて赤） = 36枚
//   索子 1 と 9 のみ 各4枚 = 8枚
//   字牌 z1〜z7 各4枚 = 28枚
// ============================================================

// 全108枚の牌セットを生成（順序は固定。シャッフル前の状態）。
function buildTileSet() {
  const tiles = [];

  // 萬子 m1〜m9 各4枚
  for (let n = 1; n <= 9; n++) {
    for (let i = 0; i < 4; i++) tiles.push(`m${n}`);
  }

  // 筒子 p1〜p9 各4枚。p5 は4枚すべて赤ドラ 'p5r'
  for (let n = 1; n <= 9; n++) {
    for (let i = 0; i < 4; i++) {
      tiles.push(n === 5 ? 'p5r' : `p${n}`);
    }
  }

  // 索子は 1 と 9 のみ 各4枚（2〜8 索は使わない）
  for (const n of [1, 9]) {
    for (let i = 0; i < 4; i++) tiles.push(`s${n}`);
  }

  // 字牌 z1〜z7 各4枚
  for (let n = 1; n <= 7; n++) {
    for (let i = 0; i < 4; i++) tiles.push(`z${n}`);
  }

  return tiles;
}

// Fisher-Yates 法でシャッフル。
// 元配列を破壊せずに新しい配列を返す。乱数源 rng は差し替え可能（テスト用）。
function shuffleTiles(tiles, rng = Math.random) {
  const arr = [...tiles];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = {
  buildTileSet,
  shuffleTiles,
};
