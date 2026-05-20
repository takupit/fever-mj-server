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

// ============================================================
// アガリ時の点棒移動を計算（フェーズ4b step 3 で追加）
//   入力:
//     han        : 翻数
//     dealerId   : 親（東家）の playerId
//     winnerId   : 和了者の playerId
//     isTsumo    : ツモなら true、ロンなら false
//     fromPlayer : ロン時の振り込み者（ロンのみ必須）
//     warePlayer : 割れ目プレイヤー (P0|P1|P2)。和了者または被ロン者が
//                  割れ目なら点棒移動 ×2（仕様書「4. 割れ目効果」）
//   戻り値:
//     { moves: {P0, P1, P2 のいずれもプラマイ点数}, basePoint, total }
// ============================================================
function calculatePointMoves({ han, dealerId, winnerId, isTsumo, fromPlayer = null, warePlayer = null, isFever = false }) {
  const isWinnerParent = (winnerId === dealerId);
  const allPlayers = ['P0', 'P1', 'P2'];
  const moves = { P0: 0, P1: 0, P2: 0 };

  // 基本点（30 符固定・calculateSimpleScore と同じロジック）
  let basePoint;
  if (han >= 13) basePoint = 8000;
  else if (han >= 11) basePoint = 6000;
  else if (han >= 8)  basePoint = 4000;
  else if (han >= 6)  basePoint = 3000;
  else if (han >= 5)  basePoint = 2000;
  else basePoint = Math.min(30 * Math.pow(2, han + 2), 2000);

  const round100 = (n) => Math.ceil(n / 100) * 100;

  // 倍率を計算するヘルパー
  // 割れ目（和了者 or 支払者が割れ目）→ ×2、FEVER →×2、両方なら ×4
  const applyMultipliers = (basePay, payerId) => {
    let pay = basePay;
    if (warePlayer === winnerId || warePlayer === payerId) pay *= 2;
    if (isFever) pay *= 2;
    return pay;
  };

  if (isTsumo) {
    if (isWinnerParent) {
      // 親ツモ: 子全員から basePoint × 2 ずつ
      for (const pid of allPlayers) {
        if (pid === winnerId) continue;
        const pay = applyMultipliers(round100(basePoint * 2), pid);
        moves[pid] -= pay;
        moves[winnerId] += pay;
      }
    } else {
      // 子ツモ: 親から basePoint*2、他子から basePoint*1
      for (const pid of allPlayers) {
        if (pid === winnerId) continue;
        const isParent = (pid === dealerId);
        const pay = applyMultipliers(round100(basePoint * (isParent ? 2 : 1)), pid);
        moves[pid] -= pay;
        moves[winnerId] += pay;
      }
    }
  } else {
    // ロン: discarder が全額支払い
    if (!fromPlayer) throw new Error('ロンには fromPlayer が必須');
    const pay = applyMultipliers(round100(basePoint * (isWinnerParent ? 6 : 4)), fromPlayer);
    moves[fromPlayer] -= pay;
    moves[winnerId] += pay;
  }

  return { moves, basePoint, total: moves[winnerId] };
}

// ============================================================
// 流局時のノーテン罰符を計算（仕様書「12. ノーテン罰符」より）
//   合計 3000 点をノーテン者から徴収しテンパイ者で山分け
//   全員テンパイ or 全員ノーテン → 移動なし
//   1人テンパイ → +3000（1500×2 受け取り）
//   2人テンパイ → 各 +1500
// ============================================================
function calculateNotenPenalty(tenpaiPlayerIds) {
  const allPlayers = ['P0', 'P1', 'P2'];
  const moves = { P0: 0, P1: 0, P2: 0 };
  const tenpaiCount = tenpaiPlayerIds.length;
  const notenPlayers = allPlayers.filter((p) => !tenpaiPlayerIds.includes(p));
  const notenCount = notenPlayers.length;

  if (tenpaiCount === 0 || notenCount === 0) return moves;

  const TOTAL = 3000;
  const perTenpai = Math.floor(TOTAL / tenpaiCount);
  const perNoten = Math.floor(TOTAL / notenCount);

  for (const p of tenpaiPlayerIds) moves[p] = perTenpai;
  for (const p of notenPlayers) moves[p] = -perNoten;

  return moves;
}

module.exports = {
  calculateSimpleScore,
  calculatePointMoves,
  calculateNotenPenalty,
};
