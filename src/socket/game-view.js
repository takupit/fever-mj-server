// ============================================================
// src/socket/game-view.js
// GameEngine.state からネットワーク送信用のビュー（払い出し可能な形）を
// 切り出すための純粋関数群。
// ============================================================
// 重要原則:
//   - publicGameView(state): 部屋全員に送ってよい情報のみ（他家の手牌は枚数のみ）
//   - privateHandView(state, playerId): 指定プレイヤー本人にだけ送る手牌・ツモ牌
// ============================================================
// 仕様書「セキュリティ・公平性 1. 手牌情報の隔離」に準拠:
//   自分以外の手牌はサーバーから絶対に送らない（不正対策）。
// ============================================================

// 副露1組を公開ビューに変換（フィールドを必要なものだけに絞る）
function meldView(meld) {
  return {
    type: meld.type,         // 'pon' | 'minkan' | 'kakan' | 'ankan' | 'chi'
    tiles: [...meld.tiles],
    fromPlayer: meld.fromPlayer || null,
  };
}

// 河の1枚を公開ビューに変換
function discardView(d) {
  return {
    tile: d.tile,
    isTsumogiri: !!d.isTsumogiri,
    isCalled: !!d.isCalled,
    isReachDeclaration: !!d.isReachDeclaration,
  };
}

// 1プレイヤーの「公開してよい情報」を返す（手牌の中身は含まない）
function playerPublicView(p) {
  return {
    id: p.id,
    name: p.name,
    wind: p.wind,
    score: p.score,
    chips: p.chips,
    handCount: p.hand.length,           // 中身は隠す、枚数だけ公開
    discards: p.discards.map(discardView),
    melds: p.melds.map(meldView),
    kitaPullsCount: p.kitaPulls.length, // 北抜き枚数（中身は全部 z4 なので隠す意味なし）
    isReached: !!p.isReached,
    reachType: p.reachType || null,
    feverActive: !!p.feverActive,
    feverTrigger: p.feverTrigger || null,
    connected: p.connected !== false,    // RoomManager 側で false にされる場合あり
  };
}

// 全員に送ってよい公開状態（公開ビュー）
function publicGameView(state) {
  return {
    round: {
      wind: state.roundWind,   // 'E' | 'S'
      hand: state.hand,        // 1〜3（局番号）
      honba: state.honba,
    },
    dealerId: state.dealerId,
    currentTurn: state.currentTurn,
    warePlayer: state.warePlayer,
    wallCount: state.wall.length,
    deadWallCount: state.deadTiles.length,
    doraIndicators: [...state.doraIndicators],
    reachSticks: state.reachSticks,
    phase: state.phase,
    lastDiscard: state.lastDiscard ? { ...state.lastDiscard } : null,
    players: state.players.map(playerPublicView),
  };
}

// 指定プレイヤー本人に送る、自分専用の手牌情報
function privateHandView(state, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return null;
  return {
    playerId,
    hand: [...player.hand],                 // 全枚開示
    drawnTile: state.drawnTile,             // ツモった牌（未ツモなら null）
    reachWaits: player.reachWaits ? [...player.reachWaits] : [],
  };
}

module.exports = {
  publicGameView,
  privateHandView,
};
