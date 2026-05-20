// ============================================================
// src/game/chip.js
// チップ計算（FEVER MJ オリジナル要素）。
// すべて純粋関数。フェーズ4b step 4 で実装。
// ============================================================
// 仕様書「11. チップ」のルール:
//   ① 一索/一萬/九萬チップ（面前 + 七筒1枚以上）
//     - 効果: 該当牌の枚数 × 2 枚（一発なら ×2 倍）
//     - 支払い: ツモなら全員から、ロンなら振り込み者のみから
//   ② 裏ドラ表示牌チップ（リーチ和了時）
//     - 効果: 手牌の裏ドラ表示牌そのものの枚数 × 1 枚
//     - 一発の倍率対象外
//   ③ 役満ご祝儀チップ
//     - 役満 +10、W役満 +20、数え役満（13翻以上）+5
//     - 支払い: 全員から（ツモ/ロン問わず）
//
// 割れ目はチップ移動には影響しない（仕様書「11. 割れ目とチップ」）。
// ============================================================

const { tileBase } = require('./tile-utils');

// 手牌に七筒があるか（赤含む）
function handHasP7(hand) {
  return hand.some((t) => tileBase(t) === 'p7');
}

// アガリ時のチップ移動を計算
// 引数:
//   state         : GameEngine.state
//   agariResult   : checkAgariTsumo/Ron の戻り値（{ pattern, yakuResult, ... }）
//   winnerId      : 和了者
//   isTsumo       : ツモなら true
//   fromPlayer    : ロン時の振り込み者
//   isReached     : 和了者がリーチしていたか
//   ipatsuActive  : 和了者が一発状態だったか
// 戻り値: { moves: {P0,P1,P2}, breakdown: { rule1, rule2, rule3 } }
function calculateChipMoves({ state, agariResult, winnerId, isTsumo, fromPlayer = null, isReached = false, ipatsuActive = false }) {
  const allPlayers = ['P0', 'P1', 'P2'];
  const moves = { P0: 0, P1: 0, P2: 0 };
  const breakdown = { rule1: 0, rule2: 0, rule3: 0 };

  const winner = state.players.find((p) => p.id === winnerId);
  if (!winner) return { moves, breakdown };

  const winningTile = isTsumo ? state.drawnTile : (state.lastDiscard ? state.lastDiscard.tile : null);

  // アガリ時の完全な手牌（副露含む全 14 枚相当）
  const fullHand = [...winner.hand];
  if (!isTsumo && winningTile) fullHand.push(winningTile);
  for (const m of winner.melds) fullHand.push(...m.tiles);

  // 面前判定（暗カンのみは面前扱い）
  const isMenzen = !winner.melds || winner.melds.every((m) => m.type === 'ankan');

  // ----- ルール ①: 一索/一萬/九萬 -----
  if (isMenzen && handHasP7(fullHand)) {
    const TARGETS = ['s1', 'm1', 'm9'];
    const count = fullHand.filter((t) => TARGETS.includes(tileBase(t))).length;
    if (count > 0) {
      // 一発の場合 ×2 倍
      const perPayer = count * 2 * (ipatsuActive ? 2 : 1);
      if (isTsumo) {
        for (const pid of allPlayers) {
          if (pid === winnerId) continue;
          moves[pid] -= perPayer;
          moves[winnerId] += perPayer;
          breakdown.rule1 += perPayer;
        }
      } else if (fromPlayer) {
        moves[fromPlayer] -= perPayer;
        moves[winnerId] += perPayer;
        breakdown.rule1 += perPayer;
      }
    }
  }

  // ----- ルール ②: 裏ドラ表示牌 -----
  // 仕様書: "リーチ和了時、手牌の裏ドラ表示牌そのものの枚数 × 1 枚"
  // ※「裏ドラ表示牌そのもの」= 裏ドラインジケータと同じ基本牌が和了者の手牌に何枚あるか
  if (isReached && Array.isArray(state.uraDoraIndicators)) {
    let chipCount = 0;
    for (const ind of state.uraDoraIndicators) {
      chipCount += fullHand.filter((t) => tileBase(t) === ind).length;
    }
    if (chipCount > 0) {
      if (isTsumo) {
        for (const pid of allPlayers) {
          if (pid === winnerId) continue;
          moves[pid] -= chipCount;
          moves[winnerId] += chipCount;
          breakdown.rule2 += chipCount;
        }
      } else if (fromPlayer) {
        moves[fromPlayer] -= chipCount;
        moves[winnerId] += chipCount;
        breakdown.rule2 += chipCount;
      }
    }
  }

  // ----- ルール ③: 役満ご祝儀チップ（全員から） -----
  if (agariResult && agariResult.yakuResult) {
    const yr = agariResult.yakuResult;
    let bonus = 0;
    if (yr.isYakuman) {
      // W役満は yakumanCount === 2、トリプル役満は 3
      const yakumanCount = yr.yakumanCount || 1;
      bonus = 10 * yakumanCount;
    } else if (yr.totalHan >= 13) {
      // 数え役満
      bonus = 5;
    }
    if (bonus > 0) {
      for (const pid of allPlayers) {
        if (pid === winnerId) continue;
        moves[pid] -= bonus;
        moves[winnerId] += bonus;
        breakdown.rule3 += bonus;
      }
    }
  }

  return { moves, breakdown };
}

// 中・發ボーナス（仕様書 ④）
// リーチ後の一発ツモで中（z7）または發（z6）を引いた場合、他家から各1枚ずつ。
// アガリにはならない（局は続行）。
// 引数: drawnTile, all other players' ids
// 戻り値: { moves: {P0,P1,P2} } or null（対象牌でなければ null）
function calculateChunHatsuBonus({ drawnTile, winnerId }) {
  const base = tileBase(drawnTile || '');
  if (base !== 'z7' && base !== 'z6') return null;
  const moves = { P0: 0, P1: 0, P2: 0 };
  for (const pid of ['P0', 'P1', 'P2']) {
    if (pid === winnerId) continue;
    moves[pid] -= 1;
    moves[winnerId] += 1;
  }
  return { moves, tile: base };
}

module.exports = {
  calculateChipMoves,
  calculateChunHatsuBonus,
};
