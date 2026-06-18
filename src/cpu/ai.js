// ============================================================
// src/cpu/ai.js
// CPU 代打 AI（ソロ練習モード + 切断時の CPU 代打 で共通利用）
// すべて純粋関数。GameEngine の state や socket には依存しない。
// ============================================================
// 元は engine.js の cpuChooseDiscard / cpuCheckReach に書かれていたが、
// フェーズ6 で「CPU の意思決定」だけをここに集約し、Socket.IO 連携や
// タイマー制御は handlers.js 側に残す構成にした。
// ============================================================

const {
  tileBase,
  isJihai,
  isShuupai,
  tileNumber,
  tileSuit,
  countTiles,
} = require('../game/tile-utils');
const { isTenpai, getWaitingTiles } = require('../game/yaku');

// ------------------------------------------------------------
// (1) 打牌選択: 不要牌から優先して捨てる簡易ヒューリスティック
//   - 字牌で 1 枚だけのものを最優先で捨てる
//   - 端牌（1, 9）で孤立しているものを次に捨てる
//   - 隣接牌（±1, ±2）が多い牌は残す（残す価値が高い）
//   - 七筒・七萬は FEVER 用に残す方向
//   - 北は河に出せないので候補から除外
//   ★ 安全牌考慮（opts.opponents 渡し時）:
//      他家にリーチ者がいる場合は「現物（その人の河にある牌）」を優先的に切り、
//      逆に「他家リーチ後の捨て牌」周辺は避ける（簡易的な危険度評価）。
// リーチ中はツモ切り（最後の牌を返す）。
// 戻り値: tile コード（'m5' など）
// ------------------------------------------------------------
function chooseDiscard(player, opts = {}) {
  const hand = player.hand;
  if (player.isReached) {
    // リーチ中はツモ切り（北以外）
    const lastTile = hand[hand.length - 1];
    if (lastTile === 'z4') {
      for (const t of hand) {
        if (t !== 'z4') return t;
      }
    }
    return lastTile;
  }

  // 他家リーチ者の情報を整理（安全牌判定用）
  // opts.opponents は [{ id, isReached, discards: [{tile, ...}] }, ...] を期待
  const reachedOpponents = Array.isArray(opts.opponents)
    ? opts.opponents.filter((o) => o.isReached && o.id !== player.id)
    : [];
  // 各リーチ者の現物（discards すべて）の基本牌集合
  const genbutsuSet = new Set();
  for (const o of reachedOpponents) {
    if (!Array.isArray(o.discards)) continue;
    for (const d of o.discards) {
      genbutsuSet.add(tileBase(d.tile));
    }
  }

  // 北は河に捨てない（北抜きが優先される）
  // countTiles はループ外で 1 回だけ（パフォーマンス改善・元実装は O(n²) だった）
  const counts = countTiles(hand);
  const candidates = hand
    .filter((t) => t !== 'z4')
    .map((t) => {
      const base = tileBase(t);
      let score = 0;

      // 字牌の孤立牌: 最優先で捨てる
      if (isJihai(base) && counts[base] === 1) score += 100;
      if (isShuupai(base)) {
        const n = tileNumber(base);
        const suit = tileSuit(base);
        // 端牌の孤立: 高優先で捨てる
        if ((n === 1 || n === 9) && counts[base] === 1) score += 80;
        // 隣接牌が多いほど残す価値あり（捨て優先度を下げる）
        const adj = [`${suit}${n - 1}`, `${suit}${n + 1}`, `${suit}${n - 2}`, `${suit}${n + 2}`];
        const adjCount = adj.filter((x) => counts[x]).length;
        score -= adjCount * 10;
      }
      // 対子・刻子なら残す
      if (counts[base] >= 2) score -= 50;
      // 七筒・七萬は FEVER 用に残す
      if (base === 'p7' || base === 'm7') score -= 30;

      // ★ 安全牌ボーナス: リーチ者の現物は安全度大幅プラス
      if (reachedOpponents.length > 0 && genbutsuSet.has(base)) {
        score += 200;
      }

      return { tile: t, score };
    });

  if (candidates.length === 0) {
    return hand[0];
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].tile;
}

// ------------------------------------------------------------
// (2) リーチ判定: テンパイになる打牌候補を返す（フリテンも検出）
//   wallLength は呼び出し側から渡してもらう（純関数のため state に触らない）
// 戻り値: false | { discardIdx, discardTile, isFuriten }
// ------------------------------------------------------------
function checkReach(player, wallLength) {
  if (player.isReached) return false;
  if (player.score < 1000) return false;
  if (wallLength < 4) return false;
  if (player.melds.some((m) => m.type !== 'ankan')) return false;

  let bestNonFuriten = null;
  let bestFuriten = null;

  for (let i = 0; i < player.hand.length; i++) {
    if (player.hand[i] === 'z4') continue; // 北は河に出せない
    const test = [...player.hand];
    test.splice(i, 1);
    if (isTenpai(test, player.melds)) {
      const waits = getWaitingTiles(test, player.melds);
      const ownDiscards = player.discards.map((d) => tileBase(d.tile));
      const isFuriten = waits.some((w) => ownDiscards.includes(tileBase(w)));

      if (!isFuriten && !bestNonFuriten) {
        bestNonFuriten = { discardIdx: i, discardTile: player.hand[i], isFuriten: false };
      }
      if (isFuriten && !bestFuriten) {
        bestFuriten = { discardIdx: i, discardTile: player.hand[i], isFuriten: true };
      }
    }
  }
  return bestNonFuriten || bestFuriten || false;
}

// ------------------------------------------------------------
// (3) リーチ宣言の確率
//   - 通常テンパイ:   70%（ストリーク補正で 1 ターン経過ごとに +10%、最大 95%）
//   - フリテンテンパイ: 20%（ロンできないので戦術的に弱い）
//   tenpaiStreak は player.tenpaiStreak に保存される（連続テンパイターン数）
// ------------------------------------------------------------
function shouldDeclareReach(opts = {}) {
  const isFuriten = !!opts.isFuriten;
  const streak = typeof opts.tenpaiStreak === 'number' ? opts.tenpaiStreak : 0;
  if (isFuriten) {
    // フリテンは戦術的不利なのでリーチ確率を大きく下げる
    return Math.random() < 0.2;
  }
  // 連続テンパイで「黙テンのまま動かない」のを防ぐため確率上昇
  const base = 0.7 + Math.min(streak * 0.1, 0.25);
  return Math.random() < base;
}

// ------------------------------------------------------------
// (4) 鳴き応答の判断: 仕様書「14. CPU AI」のレートに準拠
//   ロン     : 100%（成立すれば必ず）
//   明カン   : 40%
//   ポン     : 25%
//   北カン   : 40%（kita-claim 時の canKan に対応）
//   北ポン   : 25%（kita-claim 時の canPon に対応）
//   それ以外 : skip
// 戻り値: 'ron' | 'kan' | 'pon' | 'skip'
// ------------------------------------------------------------
function decideClaim(eligibility) {
  if (!eligibility) return 'skip';
  if (eligibility.canRon) return 'ron';
  if (eligibility.canMinkan && Math.random() < 0.4) return 'kan';
  if (eligibility.canPon && Math.random() < 0.25) return 'pon';
  // 北抜き応答（kita-claim）の場合 canKan / canPon が立つ
  if (eligibility.canKan && Math.random() < 0.4) return 'kan';
  if (eligibility.canPon && Math.random() < 0.25) return 'pon';
  return 'skip';
}

module.exports = {
  chooseDiscard,
  checkReach,
  shouldDeclareReach,
  decideClaim,
};
