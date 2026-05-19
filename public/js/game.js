// ============================================================
// public/js/game.js
// 対局画面の描画担当（フェーズ4a）。
// サーバーから受け取った game:state-update と game:your-hand を
// DOM に反映する。打牌・ツモなどの操作はフェーズ4b 以降で追加。
// ============================================================

(function () {
  const fm = window.feverMj;
  const $ = (sel) => document.querySelector(sel);

  // クライアント側で保持する状態（再描画用）
  const view = {
    publicState: null,   // game:state-update の最新内容
    myHand: null,        // game:your-hand の最新内容
  };

  // ------------------------------------------------------------
  // 牌コード → 表示文字（仕様書 15. 牌記法 参照）
  //   m1〜m9 → 一萬〜九萬
  //   p1〜p9 → ①〜⑨（p5 のみ赤）
  //   s1, s9 → ①索, ⑨索
  //   z1〜z7 → 東 南 西 北 白 發 中
  // ------------------------------------------------------------
  const MANZU_LABELS = ['', '一萬', '二萬', '三萬', '四萬', '五萬', '六萬', '七萬', '八萬', '九萬'];
  const PINZU_LABELS = ['', '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];
  const JIHAI_LABELS = { z1: '東', z2: '南', z3: '西', z4: '北', z5: '白', z6: '發', z7: '中' };
  const WIND_NAMES = { E: '東家', S: '南家', W: '西家', N: '北家' };

  function tileToLabel(tile) {
    if (!tile) return '';
    const base = tile.replace('r', '');
    if (JIHAI_LABELS[base]) return JIHAI_LABELS[base];
    const suit = base[0];
    const num = parseInt(base[1], 10);
    if (suit === 'm') return MANZU_LABELS[num] || tile;
    if (suit === 'p') return PINZU_LABELS[num] || tile;
    if (suit === 's') return num === 1 ? '①索' : '⑨索';
    return tile;
  }

  // 牌1枚を表す DOM 要素を作る
  // options: { back: true で裏向き、small: true で小さめ }
  function makeTileEl(tile, options = {}) {
    const div = document.createElement('div');
    div.className = 'tile';
    if (options.back) {
      div.classList.add('back');
      return div;
    }
    if (!tile) {
      div.textContent = '';
      return div;
    }
    div.textContent = tileToLabel(tile);
    div.dataset.tile = tile;
    if (tile.endsWith('r')) div.classList.add('red');
    // 七筒・七萬は FEVER 牌として強調
    const base = tile.replace('r', '');
    if (base === 'p7' || base === 'm7') div.classList.add('fever');
    return div;
  }

  // 同じ牌の集まりを並べる（裏向きにも対応）
  function fillTileRow(rowEl, tiles, options = {}) {
    rowEl.innerHTML = '';
    for (const t of tiles) {
      rowEl.appendChild(makeTileEl(t, options));
    }
  }

  // 枚数だけ分の裏向き牌を並べる（他家の手牌用）
  function fillTileBacks(rowEl, count) {
    rowEl.innerHTML = '';
    for (let i = 0; i < count; i++) {
      rowEl.appendChild(makeTileEl(null, { back: true }));
    }
  }

  // ------------------------------------------------------------
  // 自分が誰か判定し、自分・対戦相手2人の配置を決める
  //   - 自分（me）
  //   - 左（leftOpp） = currentTurn の進行順で次の人
  //   - 右（rightOpp）= さらに次の人
  // ------------------------------------------------------------
  function seatLayout(publicState, myPlayerId) {
    const players = publicState.players;
    const myIdx = players.findIndex((p) => p.id === myPlayerId);
    if (myIdx === -1) {
      // 自分が見つからない（観戦モード相当・暫定）→ 仮に P0 視点
      return { me: players[0], leftOpp: players[1], rightOpp: players[2] };
    }
    const me = players[myIdx];
    const leftOpp = players[(myIdx + 1) % 3];
    const rightOpp = players[(myIdx + 2) % 3];
    return { me, leftOpp, rightOpp };
  }

  // ------------------------------------------------------------
  // 描画関数群（state を受けて DOM に反映）
  // ------------------------------------------------------------
  function renderHeader(publicState) {
    const roundName = publicState.round.wind === 'E' ? '東' : '南';
    $('#game-round').textContent = `${roundName}${publicState.round.hand}局`;
    $('#game-honba').textContent = `${publicState.round.honba}本場`;
    $('#game-wall').textContent = String(publicState.wallCount);
  }

  function renderDora(publicState) {
    fillTileRow($('#game-dora'), publicState.doraIndicators);
  }

  function renderOpponent(rootEl, opponent, isCurrentTurn) {
    rootEl.classList.toggle('current-turn', isCurrentTurn);
    rootEl.querySelector('.opp-name').textContent = opponent.name;
    rootEl.querySelector('.opp-wind').textContent = WIND_NAMES[opponent.wind] || opponent.wind;
    rootEl.querySelector('.opp-score').textContent = `${opponent.score}点`;
    // 手牌は枚数だけ裏向きで（仕様書セキュリティ 1: 他家手牌の中身は公開しない）
    fillTileBacks(rootEl.querySelector('[data-role="hand"]'), opponent.handCount);
    // 河
    const discardEl = rootEl.querySelector('[data-role="discards"]');
    fillTileRow(discardEl, opponent.discards.map((d) => d.tile));
  }

  function renderMe(me, isCurrentTurn) {
    $('#me-name').textContent = me.name + '（あなた）';
    $('#me-wind').textContent = WIND_NAMES[me.wind] || me.wind;
    $('#me-score').textContent = `${me.score}点`;
    $('.me-area').classList.toggle('current-turn', isCurrentTurn);
    // 自分の河
    fillTileRow($('#me-discards'), me.discards.map((d) => d.tile));
  }

  function renderMyHand(hand, drawnTile) {
    const handEl = $('#me-hand');
    handEl.innerHTML = '';
    if (!hand) return;
    // ツモ牌があれば手牌13枚 + ツモ牌1枚を分けて表示
    if (drawnTile) {
      const baseTiles = hand.slice(0, -1);
      for (const t of baseTiles) handEl.appendChild(makeTileEl(t));
      // 区切り
      const gap = document.createElement('span');
      gap.style.cssText = 'width:6px; display:inline-block;';
      handEl.appendChild(gap);
      handEl.appendChild(makeTileEl(drawnTile));
    } else {
      for (const t of hand) handEl.appendChild(makeTileEl(t));
    }
  }

  function renderTurn(publicState, myPlayerId) {
    const currentName = publicState.players.find((p) => p.id === publicState.currentTurn)?.name || '?';
    const isMyTurn = publicState.currentTurn === myPlayerId;
    $('#turn-text').textContent = isMyTurn
      ? '★ あなたのターンです'
      : `${currentName} さんのターン待ち`;
    $('#turn-bar').classList.toggle('my-turn', isMyTurn);
  }

  // 全体再描画
  function rerender() {
    if (!view.publicState) return;
    const myPlayerId = fm.state.playerId;
    const layout = seatLayout(view.publicState, myPlayerId);

    renderHeader(view.publicState);
    renderDora(view.publicState);
    renderOpponent(
      $('#opp-left'),
      layout.leftOpp,
      view.publicState.currentTurn === layout.leftOpp.id
    );
    renderOpponent(
      $('#opp-right'),
      layout.rightOpp,
      view.publicState.currentTurn === layout.rightOpp.id
    );
    renderMe(layout.me, view.publicState.currentTurn === layout.me.id);
    renderTurn(view.publicState, myPlayerId);

    // 自分の手牌（プライベート情報）
    if (view.myHand) {
      renderMyHand(view.myHand.hand, view.myHand.drawnTile);
    }
  }

  // ------------------------------------------------------------
  // サーバーイベント購読
  // ------------------------------------------------------------
  function bindEvents() {
    // 公開状態の更新（部屋全員に届く）
    fm.on('game:state-update', (publicState) => {
      view.publicState = publicState;
      rerender();
    });

    // 自分の手牌（本人だけに届く）
    fm.on('game:your-hand', (privateHand) => {
      view.myHand = privateHand;
      rerender();
    });

    // 接続切れたら表示をクリア（再接続時に古い手牌が見えないように）
    fm.on('disconnected', () => {
      view.myHand = null;
    });
  }

  // ------------------------------------------------------------
  // 初期化
  // ------------------------------------------------------------
  function init() {
    bindEvents();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
