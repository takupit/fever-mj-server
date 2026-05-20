// ============================================================
// src/game/engine.js
// ゲーム進行エンジン（GameEngine クラス）。
// play.html の const game = {...} を、複数部屋対応のため class 化。
// メソッド本体のロジックはオリジナルと同一。
// ============================================================
// play.html 行 2984〜3802 から移植。
//
// 主な変更点（ロジックは変更なし）:
//   1. const game シングルトン → class GameEngine（部屋ごとにインスタンス化可能に）
//   2. 牌操作・役判定ユーティリティを別ファイルから require
//   3. 山生成・シャッフルを wall.js の buildTileSet / shuffleTiles に置換
//   4. ハードコードされた定数を constants.js から取り込み
// ============================================================

const {
  sortTiles,
  countTiles,
  tileBase,
  isJihai,
  isShuupai,
  isRed,
  tileNumber,
  tileSuit,
  nextTile,
} = require('./tile-utils');
const {
  extractAllPatterns,
  evaluateAllYaku,
  getWaitingTiles,
  isTenpai,
  detectWaitType,
} = require('./yaku');
const { buildTileSet, shuffleTiles } = require('./wall');
const {
  PLAYER_ORDER,
  WINDS_ORDER,
  INITIAL_SCORE,
  INITIAL_CHIPS,
} = require('./constants');

class GameEngine {
  constructor() {
    this.state = null;
  }

  // 1局を初期化（前局の点数・チップ・親などを引き継ぎ可能）
  // options:
  //   playerNames: [string, string, string]  - 各プレイヤーの表示名（オンライン対戦用）
  //   playerIsCpu: [bool, bool, bool]         - CPU 扱いするか（オンラインなら全 false）
  // 既定値は単独プレイモード（P0 が人間、P1/P2 が CPU）。
  init(carryOver = null, options = {}) {
    // 牌山を生成してシャッフル
    const tiles = shuffleTiles(buildTileSet());

    // 前回の点数・チップ・本場・親・局を引き継ぎ
    const carryScores = carryOver ? carryOver.scores : [INITIAL_SCORE, INITIAL_SCORE, INITIAL_SCORE];
    const carryChips = carryOver ? carryOver.chips : [INITIAL_CHIPS, INITIAL_CHIPS, INITIAL_CHIPS];
    const carryRound = carryOver ? carryOver.roundWind : 'E';
    const carryHand = carryOver ? carryOver.hand : 1;
    const carryHonba = carryOver ? carryOver.honba : 0;
    const carryReachSticks = carryOver ? carryOver.reachSticks : 0;
    const carryDealerId = carryOver ? carryOver.dealerId : 'P0';

    // プレイヤー名・CPU フラグ（既定は単独プレイモード）
    const playerNames = options.playerNames || ['あなた', 'CPU 1', 'CPU 2'];
    const playerIsCpu = options.playerIsCpu || [false, true, true];

    // 自風は親に応じて決まる（3人麻雀：東家・南家・西家）
    const dealerIdx = parseInt(carryDealerId.slice(1), 10);
    const getWind = (playerIdx) => WINDS_ORDER[(playerIdx - dealerIdx + 3) % 3];

    const makePlayer = (idx) => ({
      id: `P${idx}`,
      name: playerNames[idx],
      wind: getWind(idx),
      score: carryScores[idx],
      chips: carryChips[idx],
      hand: [],
      discards: [],
      melds: [],
      kitaPulls: [],
      isReached: false,
      ipatsuActive: false,
      feverActive: false,
      feverTrigger: null,
      missedRonTiles: [],
      kitaRinshanActive: false,
      isCpu: playerIsCpu[idx],
    });
    const players = [makePlayer(0), makePlayer(1), makePlayer(2)];

    // 13枚ずつ配牌
    let cursor = 0;
    for (let i = 0; i < 13; i++) {
      players.forEach((p) => p.hand.push(tiles[cursor++]));
    }

    const wallEnd = tiles.length - 14;
    const liveTiles = tiles.slice(cursor, wallEnd);
    const deadTiles = tiles.slice(wallEnd);

    this.state = {
      players,
      wall: liveTiles,
      deadTiles,
      doraIndicators: [deadTiles[0], deadTiles[2]],
      uraDoraIndicators: [deadTiles[1], deadTiles[3]],
      rinshanIndex: 4,
      currentTurn: carryDealerId,
      dealerId: carryDealerId,
      roundWind: carryRound,
      hand: carryHand,
      reachSticks: carryReachSticks,
      honba: carryHonba,
      warePlayer: 'P' + Math.floor(Math.random() * 3),
      drawnTile: null,
      lastDiscard: null,
      phase: 'init',
    };

    // 人間プレイヤーの手牌はソート（CPU はソート不要）
    players.forEach((p) => {
      if (!p.isCpu) p.hand = sortTiles(p.hand);
    });
    return this.state;
  }

  drawTile(playerId) {
    if (this.state.wall.length === 0) {
      // 山が空 → 流局。state.drawnTile も null にしておく。
      this.state.drawnTile = null;
      return { drawn: null, ryukyoku: true };
    }
    const player = this.state.players.find((p) => p.id === playerId);

    // 多牌防止：すでに14枚以上ある場合はツモせず警告
    const expectedHandSize = 13 - player.melds.length * 3;
    if (player.hand.length > expectedHandSize) {
      console.warn(`多牌防止: ${playerId}の手牌は既に${player.hand.length}枚（期待値${expectedHandSize}枚）`);
      return { drawn: player.hand[player.hand.length - 1], ryukyoku: false };
    }

    const tile = this.state.wall.shift();
    player.hand.push(tile);
    if (!player.isCpu) {
      const sortedExceptLast = sortTiles(player.hand.slice(0, -1));
      player.hand = [...sortedExceptLast, tile];
    }
    // 今ツモった牌を state に記録（ツモ切り判定や UI 表示用）
    this.state.drawnTile = tile;
    return { drawn: tile, ryukyoku: false };
  }

  drawRinshan(playerId) {
    if (this.state.rinshanIndex >= this.state.deadTiles.length) return null;
    const player = this.state.players.find((p) => p.id === playerId);

    // 多牌防止：嶺上ツモ前に14枚以上あれば異常
    const expectedHandSize = 13 - player.melds.length * 3;
    if (player.hand.length > expectedHandSize) {
      console.warn(`嶺上ツモ多牌防止: ${playerId}の手牌は既に${player.hand.length}枚（期待値${expectedHandSize}枚）`);
      return player.hand[player.hand.length - 1];
    }

    // 山から1枚減らす（牌補充の代わり）
    if (this.state.wall.length > 0) {
      this.state.wall.pop();
    }
    const tile = this.state.deadTiles[this.state.rinshanIndex++];
    player.hand.push(tile);
    if (!player.isCpu) {
      const sortedExceptLast = sortTiles(player.hand.slice(0, -1));
      player.hand = [...sortedExceptLast, tile];
    }
    return tile;
  }

  discardTile(playerId, tile, isTsumogiri, handIdx = null) {
    const player = this.state.players.find((p) => p.id === playerId);
    let idx;
    // handIdx が指定されてればそれを使う（同じ牌が複数ある場合の正確性のため）
    if (handIdx !== null && handIdx >= 0 && handIdx < player.hand.length && player.hand[handIdx] === tile) {
      idx = handIdx;
    } else {
      idx = player.hand.findIndex((t) => t === tile);
    }
    if (idx === -1) return false;
    player.hand.splice(idx, 1);
    if (!player.isCpu) {
      player.hand = sortTiles(player.hand);
    }
    player.discards.push({
      tile,
      isTsumogiri,
      isCalled: false,
      isReachDeclaration: player.justDeclaredReach || false,
    });

    if (player.justDeclaredReach) {
      player.justDeclaredReach = false;
      // リーチ打牌後：13枚になった手牌で待ち牌を確定
      player.reachWaits = getWaitingTiles(player.hand, player.melds);
      // リーチ宣言と同時の打牌では一発はまだ消えない（次のツモまで有効）
    } else if (player.isReached && player.ipatsuActive) {
      // リーチ後の通常打牌（嶺上ツモ後の打牌含む）で一発消滅
      player.ipatsuActive = false;
    }

    this.state.lastDiscard = { player: playerId, tile };
    // 打牌した時点でツモ済牌はリセット（次のプレイヤーがツモる前の状態）
    this.state.drawnTile = null;
    return true;
  }

  declareReach(playerId, reachType = 'normal', discardTile = null) {
    const player = this.state.players.find((p) => p.id === playerId);
    player.isReached = true;
    player.reachType = reachType;
    player.score -= 1000;
    this.state.reachSticks++;
    player.ipatsuActive = true;
    player.justDeclaredReach = true;
    player.reachWaits = [];  // 打牌後に discardTile で確定する

    // FEVER 判定は「リーチ宣言の打牌後の13枚」=面前で判定する
    // discardTile が指定されていればその牌を1枚除外、なければ現状の手牌で判定
    let handForCheck = [...player.hand];
    if (discardTile !== null) {
      const idx = handForCheck.findIndex((t) => t === discardTile);
      if (idx >= 0) handForCheck.splice(idx, 1);
    }
    const p7Count = handForCheck.filter((t) => tileBase(t) === 'p7').length;
    const m7Count = handForCheck.filter((t) => tileBase(t) === 'm7').length;
    let trigger = null;
    if (p7Count >= 3 && m7Count >= 3) trigger = 'double';
    else if (p7Count >= 3) trigger = 'p7';
    else if (m7Count >= 3) trigger = 'm7';
    if (trigger) {
      player.feverActive = true;
      player.feverTrigger = trigger;
    }
    return { trigger };
  }

  // 一発消滅（指定プレイヤー以外のリーチ者の一発を消す）
  consumeIpatsu(triggerPlayerId) {
    this.state.players.forEach((p) => {
      if (p.id !== triggerPlayerId && p.ipatsuActive) {
        p.ipatsuActive = false;
      }
    });
  }

  checkAgariTsumo(playerId, drawnTile) {
    const player = this.state.players.find((p) => p.id === playerId);

    // 白ジョーカー：リーチ一発中に白をツモった場合は強制アガリ
    if (tileBase(drawnTile) === 'z5' && player.isReached && player.ipatsuActive) {
      return this.createHakuJokerResult(player, drawnTile);
    }

    const finalHand = player.hand;
    const patterns = extractAllPatterns(finalHand, player.melds);
    if (patterns.length === 0) return null;

    let bestResult = null;
    for (const pattern of patterns) {
      const waitType = detectWaitType(pattern, drawnTile);
      const yakuResult = evaluateAllYaku(pattern, player.melds, player.kitaPulls, {
        isReached: player.isReached,
        reachType: player.reachType,
        ipatsuActive: player.ipatsuActive,
        feverActive: player.feverActive,
        isTsumo: true,
        winningTile: drawnTile,
        roundWind: this.state.roundWind,
        seatWind: player.wind,
        waitType,
        doraIndicators: this.state.doraIndicators,
      });
      if (yakuResult.totalHan === 0 && !yakuResult.isYakuman) continue;
      // 完全先付け：ドラのみのアガリは不可
      const nonDoraYaku = yakuResult.yakuList.filter((y) =>
        !y.name.startsWith('ドラ') &&
        !y.name.startsWith('赤ドラ') &&
        !y.name.startsWith('裏ドラ') &&
        !y.name.startsWith('抜きドラ') &&
        !y.name.startsWith('北抜きドラ')
      );
      if (nonDoraYaku.length === 0 && !yakuResult.isYakuman) continue;
      if (!bestResult || yakuResult.totalHan > bestResult.yakuResult.totalHan) {
        bestResult = { pattern, yakuResult, waitType };
      }
    }
    return bestResult;
  }

  // 白ジョーカー：リーチ一発ツモで白を引いた場合の強制アガリ
  createHakuJokerResult(player, drawnTile) {
    // 基本役：立直 + 一発 + 門前清自摸和 + 白（ジョーカー）
    const yakuList = [
      { name: '立直', han: player.reachType === 'open' ? 2 : 1 },
      { name: '一発', han: 1 },
      { name: '門前清自摸和', han: 1 },
      { name: '白 (ジョーカー)', han: 1 },
    ];

    // 手牌の役を追加判定（白を雀頭または刻子の一部として扱う）
    const handWithoutHaku = [...player.hand];
    // 簡易実装：手牌12枚 + 白2枚（仮想）で14枚として通常評価
    const virtualHand = [...handWithoutHaku, 'z5', 'z5'];
    const patterns = extractAllPatterns(virtualHand, player.melds);

    let bestExtra = { yakuList: [], totalHan: 0 };
    for (const pattern of patterns) {
      const waitType = detectWaitType(pattern, 'z5');
      const yakuResult = evaluateAllYaku(pattern, player.melds, player.kitaPulls, {
        isReached: false,   // 立直・一発・ツモ・白は既に上で追加済みなので
        reachType: null,
        ipatsuActive: false,
        feverActive: false,
        isTsumo: false,     // 自摸も上で追加済み
        winningTile: 'z5',
        roundWind: this.state.roundWind,
        seatWind: player.wind,
        waitType,
        doraIndicators: this.state.doraIndicators,
      });
      // 白の役牌は yakuList で出てくるはずだが、既に「白(ジョーカー)」で計上済みなので除外
      const filtered = yakuResult.yakuList.filter((y) => y.name !== '白' && y.name !== 'ドラ' && !y.name.startsWith('ドラ'));
      const filteredHan = filtered.reduce((sum, y) => sum + y.han, 0);
      if (filteredHan > bestExtra.totalHan) {
        bestExtra = { yakuList: filtered, totalHan: filteredHan, pattern };
      }
    }

    // 追加役を統合
    bestExtra.yakuList.forEach((y) => yakuList.push(y));

    // ドラ計算（通常の手牌のドラ + 北抜き）
    let doraCount = 0;
    if (this.state.doraIndicators) {
      const allTiles = [...player.hand];
      for (const ind of this.state.doraIndicators) {
        const doraTile = nextTile(ind);
        doraCount += allTiles.filter((t) => tileBase(t) === doraTile).length;
      }
    }
    // 赤ドラ
    doraCount += player.hand.filter((t) => isRed(t)).length;
    // 北抜き
    doraCount += (player.kitaPulls || []).length;
    if (doraCount > 0) yakuList.push({ name: `ドラ${doraCount}`, han: doraCount });

    const totalHan = yakuList.reduce((sum, y) => sum + y.han, 0);

    return {
      pattern: bestExtra.pattern || { type: 'haku_joker', sets: [], pairs: [], setTypes: [] },
      yakuResult: { yakuList, totalHan, isYakuman: false },
      waitType: 'tanki',
      isHakuJoker: true,
    };
  }

  checkAgariRon(playerId, winningTile, fromPlayer) {
    const player = this.state.players.find((p) => p.id === playerId);
    const finalHand = [...player.hand, winningTile];
    const patterns = extractAllPatterns(finalHand, player.melds);
    if (patterns.length === 0) return null;

    // フリテンチェック
    const waitTiles = getWaitingTiles(player.hand, player.melds);
    const ownDiscards = player.discards.map((d) => tileBase(d.tile));
    const isFuriten = waitTiles.some((w) => ownDiscards.includes(tileBase(w)));
    const hasMissedRon = (player.missedRonTiles || []).map((t) => tileBase(t)).includes(tileBase(winningTile));

    if (isFuriten || hasMissedRon) return { canRon: false, reason: 'furiten' };
    if (player.reachType === 'furiten') return { canRon: false, reason: 'furiten_reach' };

    let bestResult = null;
    for (const pattern of patterns) {
      const waitType = detectWaitType(pattern, winningTile);
      const yakuResult = evaluateAllYaku(pattern, player.melds, player.kitaPulls, {
        isReached: player.isReached,
        reachType: player.reachType,
        ipatsuActive: player.ipatsuActive,
        feverActive: player.feverActive,
        isTsumo: false,
        winningTile,
        roundWind: this.state.roundWind,
        seatWind: player.wind,
        waitType,
        doraIndicators: this.state.doraIndicators,
      });
      if (yakuResult.totalHan === 0 && !yakuResult.isYakuman) continue;
      // 完全先付け：ドラのみのアガリは不可
      const nonDoraYaku = yakuResult.yakuList.filter((y) =>
        !y.name.startsWith('ドラ') &&
        !y.name.startsWith('赤ドラ') &&
        !y.name.startsWith('裏ドラ') &&
        !y.name.startsWith('抜きドラ') &&
        !y.name.startsWith('北抜きドラ')
      );
      if (nonDoraYaku.length === 0 && !yakuResult.isYakuman) continue;
      if (!bestResult || yakuResult.totalHan > bestResult.yakuResult.totalHan) {
        bestResult = { pattern, yakuResult, waitType };
      }
    }
    if (!bestResult) return null;
    return { canRon: true, ...bestResult };
  }

  // ポン可能か
  canPon(playerId, tile) {
    const player = this.state.players.find((p) => p.id === playerId);
    if (player.isReached) return false;
    // 他家が FEVER 中の場合、自分が FEVER 前にリーチ済みでなければ鳴き不可
    const anyOtherFever = this.state.players.some((p) => p.id !== playerId && p.feverActive);
    if (anyOtherFever && !player.isReached) return false;
    const base = tileBase(tile);
    const sameInHand = player.hand.filter((t) => tileBase(t) === base).length;
    return sameInHand >= 2;
  }

  // ポン実行
  doPon(playerId, tile, fromPlayer) {
    const player = this.state.players.find((p) => p.id === playerId);
    const base = tileBase(tile);
    const sameTiles = player.hand.filter((t) => tileBase(t) === base);

    // 2枚を手牌から取り除く
    const usedFromHand = sameTiles.slice(0, 2);
    let removed = 0;
    player.hand = player.hand.filter((t) => {
      if (tileBase(t) === base && removed < 2) {
        removed++;
        return false;
      }
      return true;
    });

    // 副露に追加
    player.melds.push({
      type: 'pon',
      tiles: [...usedFromHand, tile],
      fromPlayer,
    });

    // 鳴かれた牌は鳴き対象として河からは除外しない（フラグだけ立てる）
    const fromPlayerObj = this.state.players.find((p) => p.id === fromPlayer);
    const lastDisc = fromPlayerObj.discards[fromPlayerObj.discards.length - 1];
    if (lastDisc) lastDisc.isCalled = true;

    // 鳴いたら次のターンはこのプレイヤー
    this.state.currentTurn = playerId;

    // 一発消滅（リーチ者全員）
    this.consumeIpatsu(playerId);

    if (!player.isCpu) {
      player.hand = sortTiles(player.hand);
    }
  }

  // 暗カン可能か（手牌に4枚あるか）
  getAnkanCandidates(playerId) {
    const player = this.state.players.find((p) => p.id === playerId);
    const counts = countTiles(player.hand);
    const candidates = [];
    for (const k in counts) {
      if (counts[k] >= 4) {
        // リーチ後は待ちが変わらない暗カンのみ OK
        if (player.isReached) {
          const currentWaits = (player.reachWaits || []).map((t) => tileBase(t)).sort().join(',');
          // 待ち牌そのものを暗カンするのは NG
          if ((player.reachWaits || []).some((w) => tileBase(w) === k)) continue;
          // 暗カン4枚を抜いた手牌で、副露として暗カン追加した待ちを判定
          const handMinusKan = player.hand.filter((t) => tileBase(t) !== k);
          const testMelds = [...player.melds, { type: 'ankan', tiles: [k, k, k, k] }];
          const newWaits = getWaitingTiles(handMinusKan, testMelds).map((t) => tileBase(t)).sort().join(',');
          if (newWaits !== currentWaits) continue;  // 待ちが変わる
        }
        candidates.push(k);
      }
    }
    return candidates;
  }

  // 加カン可能か（既にポンしている牌と同じものが手牌にある）
  getKakanCandidates(playerId) {
    const player = this.state.players.find((p) => p.id === playerId);
    const candidates = [];
    for (const meld of player.melds) {
      if (meld.type === 'pon') {
        const base = tileBase(meld.tiles[0]);
        if (player.hand.some((t) => tileBase(t) === base)) {
          // リーチ後は待ちが変わらない加カンのみ OK
          if (player.isReached) {
            const currentWaits = (player.reachWaits || []).map((t) => tileBase(t)).sort().join(',');
            if ((player.reachWaits || []).some((w) => tileBase(w) === base)) continue;
            const handMinusBase = player.hand.filter((t) => tileBase(t) !== base);
            const testMelds = player.melds.map((m) =>
              (m === meld) ? { type: 'ankan', tiles: [base, base, base, base] } : m
            );
            const newWaits = getWaitingTiles(handMinusBase, testMelds).map((t) => tileBase(t)).sort().join(',');
            if (newWaits !== currentWaits) continue;
          }
          candidates.push(base);
        }
      }
    }
    return candidates;
  }

  // 明カン可能か（他家の打牌に対して）
  canMinkan(playerId, tile) {
    const player = this.state.players.find((p) => p.id === playerId);
    if (player.isReached) return false;
    const anyOtherFever = this.state.players.some((p) => p.id !== playerId && p.feverActive);
    if (anyOtherFever && !player.isReached) return false;
    const base = tileBase(tile);
    const sameInHand = player.hand.filter((t) => tileBase(t) === base).length;
    return sameInHand >= 3;
  }

  doAnkan(playerId, baseTile) {
    const player = this.state.players.find((p) => p.id === playerId);
    const tilesInHand = player.hand.filter((t) => tileBase(t) === baseTile);
    if (tilesInHand.length < 4) return false;

    let removed = 0;
    player.hand = player.hand.filter((t) => {
      if (tileBase(t) === baseTile && removed < 4) {
        removed++;
        return false;
      }
      return true;
    });

    player.melds.push({
      type: 'ankan',
      tiles: tilesInHand.slice(0, 4),
      fromPlayer: null,
    });

    // 暗カンでカンドラ即めくり
    if (this.state.rinshanIndex < this.state.deadTiles.length - 4) {
      this.state.doraIndicators.push(this.state.deadTiles[this.state.doraIndicators.length * 2 + 4]);
    }

    if (!player.isCpu) {
      player.hand = sortTiles(player.hand);
    }
    return true;
  }

  doKakan(playerId, baseTile) {
    const player = this.state.players.find((p) => p.id === playerId);
    const ponMeld = player.melds.find((m) => m.type === 'pon' && tileBase(m.tiles[0]) === baseTile);
    if (!ponMeld) return false;

    const tileIdx = player.hand.findIndex((t) => tileBase(t) === baseTile);
    if (tileIdx === -1) return false;

    const addedTile = player.hand[tileIdx];
    player.hand.splice(tileIdx, 1);

    // ポンを加カンに変換
    ponMeld.type = 'kakan';
    ponMeld.tiles.push(addedTile);

    // 一発消滅
    this.consumeIpatsu(playerId);

    if (!player.isCpu) {
      player.hand = sortTiles(player.hand);
    }
    return true;
  }

  doMinkan(playerId, tile, fromPlayer) {
    const player = this.state.players.find((p) => p.id === playerId);
    const base = tileBase(tile);
    const sameInHand = player.hand.filter((t) => tileBase(t) === base);
    if (sameInHand.length < 3) return false;

    let removed = 0;
    player.hand = player.hand.filter((t) => {
      if (tileBase(t) === base && removed < 3) {
        removed++;
        return false;
      }
      return true;
    });

    player.melds.push({
      type: 'minkan',
      tiles: [...sameInHand.slice(0, 3), tile],
      fromPlayer,
    });

    const fromPlayerObj = this.state.players.find((p) => p.id === fromPlayer);
    const lastDisc = fromPlayerObj.discards[fromPlayerObj.discards.length - 1];
    if (lastDisc) lastDisc.isCalled = true;

    this.state.currentTurn = playerId;
    this.consumeIpatsu(playerId);

    if (!player.isCpu) {
      player.hand = sortTiles(player.hand);
    }
    return true;
  }

  // 北抜き
  doKitaPull(playerId) {
    const player = this.state.players.find((p) => p.id === playerId);
    const idx = player.hand.findIndex((t) => t === 'z4');
    if (idx === -1) return null;

    player.hand.splice(idx, 1);
    player.kitaPulls.push({ tile: 'z4' });

    // 自分の一発消滅（他家の一発には影響しない）
    if (player.ipatsuActive) {
      player.ipatsuActive = false;
    }

    // 嶺上ツモ後のツモ切りは他家の一発を消さないようフラグ
    player.kitaRinshanActive = true;

    // 嶺上ツモ
    const rinshan = this.drawRinshan(playerId);

    if (!player.isCpu) {
      player.hand = sortTiles(player.hand);
    }

    return rinshan;
  }

  // 他家の北抜きに対するポン応答可
  canPonOnKita(playerId) {
    const player = this.state.players.find((p) => p.id === playerId);
    if (player.isReached) return false;
    const anyOtherFever = this.state.players.some((p) => p.id !== playerId && p.feverActive);
    if (anyOtherFever && !player.isReached) return false;
    const count = player.hand.filter((t) => t === 'z4').length;
    return count >= 2;
  }

  // 他家の北抜きに対するカン応答可
  canKanOnKita(playerId) {
    const player = this.state.players.find((p) => p.id === playerId);
    if (player.isReached) return false;
    const anyOtherFever = this.state.players.some((p) => p.id !== playerId && p.feverActive);
    if (anyOtherFever && !player.isReached) return false;
    const count = player.hand.filter((t) => t === 'z4').length;
    return count >= 3;
  }

  doPonOnKita(playerId, fromPlayerId) {
    const player = this.state.players.find((p) => p.id === playerId);
    const fromPlayer = this.state.players.find((p) => p.id === fromPlayerId);

    let removed = 0;
    player.hand = player.hand.filter((t) => {
      if (t === 'z4' && removed < 2) { removed++; return false; }
      return true;
    });

    // 北抜きエリアから北を1枚取り出す（最後の1枚）
    fromPlayer.kitaPulls.pop();

    player.melds.push({
      type: 'pon',
      tiles: ['z4', 'z4', 'z4'],
      fromPlayer: fromPlayerId,
    });

    this.state.currentTurn = playerId;
    this.consumeIpatsu(playerId);

    if (!player.isCpu) {
      player.hand = sortTiles(player.hand);
    }
    return true;
  }

  doKanOnKita(playerId, fromPlayerId) {
    const player = this.state.players.find((p) => p.id === playerId);
    const fromPlayer = this.state.players.find((p) => p.id === fromPlayerId);

    let removed = 0;
    player.hand = player.hand.filter((t) => {
      if (t === 'z4' && removed < 3) { removed++; return false; }
      return true;
    });

    fromPlayer.kitaPulls.pop();

    player.melds.push({
      type: 'minkan',
      tiles: ['z4', 'z4', 'z4', 'z4'],
      fromPlayer: fromPlayerId,
    });

    this.state.currentTurn = playerId;
    this.consumeIpatsu(playerId);

    if (!player.isCpu) {
      player.hand = sortTiles(player.hand);
    }
    return true;
  }

  // CPU 打牌 AI（フェーズ6 で src/cpu/ai.js の代打 AI から呼び出す予定）
  cpuChooseDiscard(player) {
    const hand = player.hand;
    if (player.isReached) {
      // リーチ中はツモ切り
      const lastTile = hand[hand.length - 1];
      if (lastTile === 'z4') {
        // 北は河に出せないので、北以外を選ぶ
        for (const t of hand) {
          if (t !== 'z4') return t;
        }
      }
      return lastTile;
    }

    // 北は河に捨てない（北抜きが優先されるが念のため除外）
    const candidates = hand
      .filter((t) => t !== 'z4')
      .map((t) => {
        const base = tileBase(t);
        const counts = countTiles(hand);
        let score = 0;

        if (isJihai(base) && counts[base] === 1) score += 100;
        if (isShuupai(base)) {
          const n = tileNumber(base);
          if ((n === 1 || n === 9) && counts[base] === 1) score += 80;
          const suit = tileSuit(base);
          const adj = [`${suit}${n - 1}`, `${suit}${n + 1}`, `${suit}${n - 2}`, `${suit}${n + 2}`];
          const adjCount = adj.filter((x) => counts[x]).length;
          score -= adjCount * 10;
        }
        if (counts[base] >= 2) score -= 50;
        if (base === 'p7' || base === 'm7') score -= 30;

        return { tile: t, score };
      });

    if (candidates.length === 0) {
      return hand[0];
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].tile;
  }

  // 他のプレイヤーが FEVER 中か（boolean）
  // フェーズ4b step 4 で他家 FEVER 時の制限判定に使う
  hasOtherFever(playerId) {
    return this.state.players.some((p) => p.id !== playerId && p.feverActive);
  }

  // ツモアガリ可能か（boolean）。自分のターン中で drawnTile があるときに使う。
  // フェーズ4b step 3 で your-turn ペイロードに含めるために追加。
  canTsumo(playerId) {
    if (!this.state.drawnTile) return false;
    const result = this.checkAgariTsumo(playerId, this.state.drawnTile);
    return !!result;
  }

  // 流局時のテンパイ判定情報を全プレイヤー分返す
  // 戻り値: [{ id, isTenpai, waits, hand, melds, kitaPullsCount }]
  getRyukyokuTenpaiStatus() {
    return this.state.players.map((p) => {
      const isTenpaiNow = isTenpai(p.hand, p.melds);
      return {
        id: p.id,
        name: p.name,
        isTenpai: isTenpaiNow,
        // リーチ者は確定テンパイ
        isReached: !!p.isReached,
        waits: isTenpaiNow ? getWaitingTiles(p.hand, p.melds) : [],
        hand: isTenpaiNow ? [...p.hand] : [],
        melds: p.melds.map((m) => ({ type: m.type, tiles: [...m.tiles], fromPlayer: m.fromPlayer || null })),
        kitaPullsCount: p.kitaPulls.length,
      };
    });
  }

  // リーチ可能か（boolean）。cpuCheckReach の薄いラッパー。
  // フェーズ4b step 2 で your-turn ペイロードに含めるために追加。
  canReach(playerId) {
    const player = this.state.players.find((p) => p.id === playerId);
    if (!player) return false;
    return this.cpuCheckReach(player) !== false;
  }

  // リーチで打牌可能な牌のインデックス一覧を返す
  //   戻り値: [{ discardIdx, discardTile, isFuriten }] （cpuCheckReach の全候補版）
  getReachOptions(playerId) {
    const player = this.state.players.find((p) => p.id === playerId);
    if (!player) return [];
    if (player.isReached) return [];
    if (player.score < 1000) return [];
    if (this.state.wall.length < 4) return [];
    if (player.melds.some((m) => m.type !== 'ankan')) return [];

    const options = [];
    for (let i = 0; i < player.hand.length; i++) {
      if (player.hand[i] === 'z4') continue; // 北は河に出せない
      const test = [...player.hand];
      test.splice(i, 1);
      if (isTenpai(test, player.melds)) {
        const waits = getWaitingTiles(test, player.melds);
        const ownDiscards = player.discards.map((d) => tileBase(d.tile));
        const isFuriten = waits.some((w) => ownDiscards.includes(tileBase(w)));
        options.push({ discardIdx: i, discardTile: player.hand[i], isFuriten });
      }
    }
    return options;
  }

  // リーチ判定（14枚状態で）- フリテンも検出
  // 戻り値: false | { discardIdx, discardTile, isFuriten }
  cpuCheckReach(player) {
    if (player.isReached) return false;
    if (player.score < 1000) return false;
    if (this.state.wall.length < 4) return false;
    if (player.melds.some((m) => m.type !== 'ankan')) return false;

    let bestNonFuriten = null;
    let bestFuriten = null;

    for (let i = 0; i < player.hand.length; i++) {
      // 北は河に捨てられないので、北を切るリーチも除外
      if (player.hand[i] === 'z4') continue;

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

    // 通常リーチ可能ならそれを優先、ダメならフリテンリーチも返す
    return bestNonFuriten || bestFuriten || false;
  }

  // FEVER 可能判定（リーチ可能でかつ七筒 or 七萬の暗刻あり）
  // 戻り値: null | { trigger: 'p7'|'m7'|'double', discardOptions: [{discardIdx, discardTile}, ...] }
  checkFeverOption(playerId) {
    const player = this.state.players.find((p) => p.id === playerId);
    if (player.isReached) return null;
    if (player.score < 1000) return null;
    if (this.state.wall.length < 4) return null;
    if (player.melds.some((m) => m.type !== 'ankan')) return null;

    // 七筒/七萬の暗刻が手牌にあるか（副露は除外）
    const p7Count = player.hand.filter((t) => tileBase(t) === 'p7').length;
    const m7Count = player.hand.filter((t) => tileBase(t) === 'm7').length;

    let trigger = null;
    if (p7Count >= 3 && m7Count >= 3) trigger = 'double';
    else if (p7Count >= 3) trigger = 'p7';
    else if (m7Count >= 3) trigger = 'm7';
    if (!trigger) return null;

    // テンパイになる打牌候補を全部探す
    const discardOptions = [];
    for (let i = 0; i < player.hand.length; i++) {
      const tile = player.hand[i];
      // 七筒/七萬の暗刻を崩す打牌は除外
      if (trigger === 'p7' && tileBase(tile) === 'p7' && p7Count <= 3) continue;
      if (trigger === 'm7' && tileBase(tile) === 'm7' && m7Count <= 3) continue;
      if (trigger === 'double') {
        if (tileBase(tile) === 'p7' && p7Count <= 3) continue;
        if (tileBase(tile) === 'm7' && m7Count <= 3) continue;
      }

      const test = [...player.hand];
      test.splice(i, 1);
      if (isTenpai(test, player.melds)) {
        const waits = getWaitingTiles(test, player.melds);
        const ownDiscards = player.discards.map((d) => tileBase(d.tile));
        const isFuriten = waits.some((w) => ownDiscards.includes(tileBase(w)));
        if (isFuriten) continue;

        discardOptions.push({ discardIdx: i, discardTile: tile });
      }
    }

    if (discardOptions.length === 0) return null;
    return { trigger, discardOptions };
  }

  // 北抜き候補（手牌に北があるか）
  hasKita(playerId) {
    const player = this.state.players.find((p) => p.id === playerId);
    return player.hand.includes('z4');
  }

  // 次のプレイヤーへターンを進める
  nextTurn() {
    const idx = PLAYER_ORDER.indexOf(this.state.currentTurn);
    this.state.currentTurn = PLAYER_ORDER[(idx + 1) % 3];
  }
}

module.exports = { GameEngine };
