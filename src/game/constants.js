// ============================================================
// src/game/constants.js
// 牌定義・定数（FEVER MJ 仕様書 v2.1 準拠）。
//
// 本ファイルは「データだけ」を集約する場所。
// 計算ロジックは tile-utils.js や yaku.js など別ファイルに置く。
// ============================================================

// テンパイ判定・待ち牌探索に使う「ありうる牌」の一覧。
// 索子（s）は 1 と 9 のみ、字牌（z）は z1〜z7。赤五筒は通常牌として p5 で扱う。
const ALL_TILES_FOR_WAITS = [
  'm1','m2','m3','m4','m5','m6','m7','m8','m9',
  'p1','p2','p3','p4','p5','p6','p7','p8','p9',
  's1','s9',
  'z1','z2','z3','z4','z5','z6','z7',
];

// 自風記号 → 字牌コード（東=z1, 南=z2, 西=z3, 北=z4）
const WIND_TO_TILE = { E: 'z1', S: 'z2', W: 'z3', N: 'z4' };

// 牌のスート（m=萬子, p=筒子, s=索子, z=字牌）のソート順
const SUIT_ORDER = { m: 0, p: 1, s: 2, z: 3 };

// 字牌の表示文字（クライアント側にも使われる）
const JIHAI_DISPLAY = {
  z1: '東', z2: '南', z3: '西', z4: '北',
  z5: '白', z6: '發', z7: '中',
};

// プレイヤーID 一覧（3人麻雀）
const PLAYER_ORDER = ['P0', 'P1', 'P2'];

// 自風の出現順（東家→南家→西家のローテーション）
const WINDS_ORDER = ['E', 'S', 'W'];

// 初期点数・初期チップ（仕様書「1. ゲーム基本構成」参照）
const INITIAL_SCORE = 25000;
const INITIAL_CHIPS = 100;

module.exports = {
  ALL_TILES_FOR_WAITS,
  WIND_TO_TILE,
  SUIT_ORDER,
  JIHAI_DISPLAY,
  PLAYER_ORDER,
  WINDS_ORDER,
  INITIAL_SCORE,
  INITIAL_CHIPS,
};
