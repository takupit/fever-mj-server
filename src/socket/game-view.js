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
// roomPlayer (オプション) が渡されたら、ネットワーク状態を反映。なければデフォルト値。
// フィールド一覧は常に同じ（テストで明示的に検証されている）。
function playerPublicView(p, roomPlayer = null) {
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
    // engine.state.players[i].isCpu。ソロ練習の元 CPU と代打開始後の両方で true
    isCpu: !!p.isCpu,
    // フェーズ6: ネットワーク状態
    connected: roomPlayer ? roomPlayer.connected !== false : true,
    cpuTakeover: roomPlayer ? !!roomPlayer.cpuTakeover : false, // 切断由来の代打のみ true
  };
}

// 全員に送ってよい公開状態（公開ビュー）
// room (オプション) が渡されたら、各プレイヤーの connected/cpuTakeover も含める
function publicGameView(state, room = null) {
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
    players: state.players.map((p, i) => {
      const rp = room && room.players ? room.players[i] : null;
      return playerPublicView(p, rp);
    }),
    // FEVER 中の情報（仕様書 7. FEVER 視覚演出: 待ち牌・残り山牌数を全員に公開）
    feverInfo: computeFeverInfo(state),
  };
}

// FEVER 中のプレイヤー情報を計算（複数人 FEVER がいる場合は配列で返す）
//   各エントリ: { playerId, name, trigger, waits, waitsRemaining }
//     trigger: 'p7' | 'm7' | 'double'
//     waits: 待ち牌の基本牌コード配列
//     waitsRemaining: 山に残っている待ち牌の枚数（公開情報）
function computeFeverInfo(state) {
  const { tileBase } = require('../game/tile-utils');
  const feverPlayers = state.players.filter((p) => p.feverActive);
  if (feverPlayers.length === 0) return null;
  return feverPlayers.map((p) => {
    const waits = p.reachWaits || [];
    // 山牌の中に待ち牌が何枚残っているか
    const waitsRemaining = waits.reduce((sum, w) => {
      return sum + state.wall.filter((t) => tileBase(t) === w).length;
    }, 0);
    return {
      playerId: p.id,
      name: p.name,
      trigger: p.feverTrigger || null,
      waits: [...waits],
      waitsRemaining,
    };
  });
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

// ============================================================
// アガリ画面用のビューを生成（フェーズ4b step 3 で追加）
//   agariResult: engine.checkAgariTsumo / checkAgariRon の戻り値
//   winnerId: 和了者の playerId
//   isTsumo: ツモなら true
//   fromPlayer: ロン時の振り込み者
//   pointResult: calculatePointMoves の戻り値
//   reachBonusGain: リーチ棒を回収した分（和了者のみ +1000×棒数）
// ============================================================
function agariView(state, agariResult, winnerId, isTsumo, fromPlayer, pointResult, reachBonusGain, chipResult, feverActive) {
  const winner = state.players.find((p) => p.id === winnerId);
  const winningTile = isTsumo ? state.drawnTile : (state.lastDiscard ? state.lastDiscard.tile : null);
  // 面子分解情報（クライアント側でアガリ牌の塊ごとに表示するため）
  // 国士無双・七対子・白ジョーカー等の特殊形は pattern.type を見て判断する。
  // 通常パターンの場合: pattern.sets は副露を先頭に持つ「全面子」（手牌由来の面子は副露の後ろ）。
  // 副露数（melds.length）で「副露由来 / 手牌由来」を分離できる。
  const p = agariResult.pattern || {};
  const patternForView = {
    type: p.type || 'standard',
    pairs: Array.isArray(p.pairs) ? p.pairs.map((pair) => [...pair]) : [],
    sets: Array.isArray(p.sets) ? p.sets.map((s) => [...s]) : [],
    setTypes: Array.isArray(p.setTypes) ? [...p.setTypes] : [],
    isAnkou: Array.isArray(p.isAnkou) ? [...p.isAnkou] : [],
    // 副露数: pattern.sets の先頭から何個が副露由来か
    meldsCount: winner.melds.length,
  };
  return {
    winner: { id: winnerId, name: winner.name, wind: winner.wind },
    isTsumo,
    fromPlayer: fromPlayer
      ? { id: fromPlayer, name: state.players.find((p) => p.id === fromPlayer).name }
      : null,
    hand: [...winner.hand],
    melds: winner.melds.map((m) => ({ type: m.type, tiles: [...m.tiles], fromPlayer: m.fromPlayer || null })),
    kitaPullsCount: winner.kitaPulls.length,
    winningTile,
    // クライアント側で「雀頭 / 面子 / アガリ牌」を区切って表示するための情報
    pattern: patternForView,
    yakuList: agariResult.yakuResult.yakuList.map((y) => ({ name: y.name, han: y.han })),
    totalHan: agariResult.yakuResult.totalHan,
    isYakuman: !!agariResult.yakuResult.isYakuman,
    yakumanCount: agariResult.yakuResult.yakumanCount || 0,
    waitType: agariResult.waitType,
    isHakuJoker: !!agariResult.isHakuJoker,
    doraIndicators: [...state.doraIndicators],
    // リーチ和了時のみ裏ドラ公開
    uraDoraIndicators: winner.isReached ? [...state.uraDoraIndicators] : [],
    basePoint: pointResult.basePoint,
    pointMoves: pointResult.moves,
    reachBonusGain: reachBonusGain || 0,
    // チップ移動とその内訳（フェーズ4b step 4 で追加）
    chipMoves: chipResult ? chipResult.moves : null,
    chipBreakdown: chipResult ? chipResult.breakdown : null,
    chipsAfter: state.players.reduce((acc, p) => { acc[p.id] = p.chips; return acc; }, {}),
    // FEVER の有無を表示用に
    feverActive: !!feverActive,
    feverTrigger: winner.feverTrigger || null,
    scoresAfter: state.players.reduce((acc, p) => { acc[p.id] = p.score; return acc; }, {}),
    round: { wind: state.roundWind, hand: state.hand, honba: state.honba },
  };
}

// ============================================================
// 流局画面用のビューを生成（フェーズ4b step 3 で追加）
//   tenpaiStatus: engine.getRyukyokuTenpaiStatus() の戻り値
//   penaltyMoves: calculateNotenPenalty の戻り値
// ============================================================
function ryukyokuView(state, tenpaiStatus, penaltyMoves) {
  return {
    reason: 'wall-empty',
    message: '流局しました（山切れ）',
    tenpaiStatus,
    penalty: penaltyMoves,
    scoresAfter: state.players.reduce((acc, p) => { acc[p.id] = p.score; return acc; }, {}),
    round: { wind: state.roundWind, hand: state.hand, honba: state.honba },
    reachSticks: state.reachSticks,
  };
}

module.exports = {
  publicGameView,
  privateHandView,
  agariView,
  ryukyokuView,
};
