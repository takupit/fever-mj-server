// ============================================================
// src/game/score.js
// 点数計算（FEVER MJ は 30 符固定方式）。
// 仕様書「10. 点数計算」の表に対応。
// ============================================================
// 割れ目（被ロン者または和了者が割れ目）と FEVER の倍率は、
// 呼び出し側で計算結果に追加で × 2 を掛ける運用にする（仕様書「10. 割れ目時／FEVER時」）。
// チップは割れ目で 2 倍にならない（仕様書「11. 割れ目とチップ」）。
// ============================================================

// 翻数（han）・親かどうか・ツモかどうか から、和了者の総取得点を計算。
// 100 点単位で切り上げる。
function calculateSimpleScore(han, isParent, isTsumo) {
  // 基本点（30 符固定）
  let basePoint;
  if (han >= 13) basePoint = 8000;       // 役満
  else if (han >= 11) basePoint = 6000;  // 三倍満
  else if (han >= 8)  basePoint = 4000;  // 倍満
  else if (han >= 6)  basePoint = 3000;  // 跳満
  else if (han >= 5)  basePoint = 2000;  // 満貫
  else basePoint = Math.min(30 * Math.pow(2, han + 2), 2000); // 1〜4 翻

  let total;
  if (isParent) {
    // 親：ツモなら 2 倍 × 2 倍（3 人分相当の係数）、ロンなら 6 倍
    total = isTsumo ? basePoint * 2 * 2 : basePoint * 6;
  } else {
    // 子：ツモなら（親から 2 倍 + 子から 1 倍）、ロンなら 4 倍
    total = isTsumo ? basePoint * 2 + basePoint * 1 : basePoint * 4;
  }
  // 100 点単位で切り上げ
  return Math.ceil(total / 100) * 100;
}

module.exports = {
  calculateSimpleScore,
};
