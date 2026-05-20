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
    // 自分のターンで使える選択肢（game:your-turn のペイロード）
    myTurnOptions: null, // { drawnTile, options, ankanCandidates, kakanCandidates, reachOptions }
    canDiscard: false,
    discarding: false,
    // リーチ宣言モード（リーチ可能な牌だけクリック可能）
    reachMode: false,
    // 鳴き応答中の状態（game:waiting-claim 受信時にセット）
    pendingClaim: null,  // { discardingPlayer, tile, options, timeoutMs, startedAt }
    claimCountdownTimer: null,
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
    rootEl.classList.toggle('reached', !!opponent.isReached);
    rootEl.classList.toggle('fever', !!opponent.feverActive);
    const nameEl = rootEl.querySelector('.opp-name');
    nameEl.textContent = opponent.name;
    if (opponent.isReached) nameEl.innerHTML += ' <span class="reach-banner">リーチ</span>';
    if (opponent.feverActive) nameEl.innerHTML += ' <span class="fever-tag">🎰FEVER</span>';
    rootEl.querySelector('.opp-wind').textContent = WIND_NAMES[opponent.wind] || opponent.wind;
    rootEl.querySelector('.opp-score').textContent = `${opponent.score}点 / ${opponent.chips || 0}💎`;
    // 手牌は枚数だけ裏向きで（仕様書セキュリティ 1: 他家手牌の中身は公開しない）
    fillTileBacks(rootEl.querySelector('[data-role="hand"]'), opponent.handCount);
    // 副露
    const handRow = rootEl.querySelector('[data-role="hand"]');
    for (const m of opponent.melds) {
      const sep = document.createElement('span');
      sep.style.cssText = 'width:4px; display:inline-block;';
      handRow.appendChild(sep);
      for (const t of m.tiles) handRow.appendChild(makeTileEl(t));
    }
    // 北抜き数
    if (opponent.kitaPullsCount > 0) {
      const kita = document.createElement('span');
      kita.className = 'kita-mark';
      kita.textContent = `北×${opponent.kitaPullsCount}`;
      handRow.appendChild(kita);
    }
    // 河
    const discardEl = rootEl.querySelector('[data-role="discards"]');
    fillTileRow(discardEl, opponent.discards.map((d) => d.tile));
  }

  function renderMe(me, isCurrentTurn) {
    let nameHtml = `${escapeHtml(me.name)}（あなた）`;
    if (me.isReached) nameHtml += ' <span class="reach-banner">リーチ</span>';
    if (me.feverActive) nameHtml += ' <span class="fever-tag">🎰FEVER</span>';
    $('#me-name').innerHTML = nameHtml;
    $('#me-wind').textContent = WIND_NAMES[me.wind] || me.wind;
    $('#me-score').textContent = `${me.score}点 / ${me.chips || 0}💎`;
    $('.me-area').classList.toggle('current-turn', isCurrentTurn);
    $('.me-area').classList.toggle('reached', !!me.isReached);
    $('.me-area').classList.toggle('fever', !!me.feverActive);
    // 自分の河
    fillTileRow($('#me-discards'), me.discards.map((d) => d.tile));
    // 自分の北抜き数
    if (me.kitaPullsCount > 0) {
      const span = document.createElement('span');
      span.className = 'kita-mark';
      span.textContent = `北×${me.kitaPullsCount}`;
      $('#me-discards').appendChild(span);
    }
  }

  function renderMyHand(hand, drawnTile) {
    const handEl = $('#me-hand');
    handEl.innerHTML = '';
    if (!hand) return;

    // リーチモード時にどのインデックスが選択可能か
    const reachOptions = view.myTurnOptions ? (view.myTurnOptions.reachOptions || []) : [];
    const reachIdxMap = new Map(reachOptions.map((o) => [o.discardIdx, o]));

    // 牌をクリック可能にする処理
    const attachClick = (tileEl, tile, handIdx) => {
      if (view.reachMode) {
        // リーチモード: リーチ候補にだけクリックを付ける
        const opt = reachIdxMap.get(handIdx);
        if (!opt) return;
        tileEl.classList.add('reach-candidate');
        if (opt.isFuriten) tileEl.classList.add('furiten');
        tileEl.addEventListener('click', () => onReachTileClick(tile, handIdx));
      } else if (view.canDiscard) {
        // 通常モード: 全部クリック可能
        tileEl.classList.add('clickable');
        tileEl.addEventListener('click', () => onTileClick(tile, handIdx));
      }
    };

    // ツモ牌があれば手牌13枚 + ツモ牌1枚を分けて表示
    if (drawnTile && hand.length > 0 && hand[hand.length - 1] === drawnTile) {
      const baseTiles = hand.slice(0, -1);
      baseTiles.forEach((t, i) => {
        const el = makeTileEl(t);
        attachClick(el, t, i);
        handEl.appendChild(el);
      });
      const gap = document.createElement('span');
      gap.style.cssText = 'width:6px; display:inline-block;';
      handEl.appendChild(gap);
      const drawnEl = makeTileEl(drawnTile);
      drawnEl.classList.add('drawn');
      attachClick(drawnEl, drawnTile, hand.length - 1);
      handEl.appendChild(drawnEl);
    } else {
      hand.forEach((t, i) => {
        const el = makeTileEl(t);
        attachClick(el, t, i);
        handEl.appendChild(el);
      });
    }
  }

  // 牌クリック（通常モード） → 打牌送信
  function onTileClick(tile, handIdx) {
    if (!view.canDiscard || view.discarding) return;
    view.discarding = true;
    view.canDiscard = false;
    rerender();
    fm.sendDiscard({ tile, handIdx });
  }

  // 牌クリック（リーチモード） → リーチ宣言送信
  function onReachTileClick(tile, handIdx) {
    if (!view.reachMode || view.discarding) return;
    view.discarding = true;
    view.reachMode = false;
    view.canDiscard = false;
    rerender();
    fm.sendReach({ tile, handIdx });
  }

  function renderTurn(publicState, myPlayerId) {
    const currentName = publicState.players.find((p) => p.id === publicState.currentTurn)?.name || '?';
    const isMyTurn = publicState.currentTurn === myPlayerId;
    if (isMyTurn) {
      $('#turn-text').textContent = view.canDiscard
        ? '★ あなたのターン: 捨てる牌をクリック'
        : '★ あなたのターン';
    } else {
      $('#turn-text').textContent = `${currentName} さんのターン待ち`;
    }
    $('#turn-bar').classList.toggle('my-turn', isMyTurn);
  }

  // FEVER バナーの表示制御（仕様書 7. FEVER 視覚演出）
  function renderFeverBanner(publicState) {
    const feverPlayer = publicState.players.find((p) => p.feverActive);
    let banner = document.getElementById('fever-banner');
    if (!feverPlayer) {
      if (banner) banner.classList.remove('show');
      return;
    }
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'fever-banner';
      banner.className = 'fever-banner';
      document.body.appendChild(banner);
    }
    const triggerLabel = feverPlayer.feverTrigger === 'double' ? 'W-FEVER!!'
      : feverPlayer.feverTrigger === 'p7' ? 'FEVER (七筒)'
      : feverPlayer.feverTrigger === 'm7' ? 'FEVER (七萬)'
      : 'FEVER';
    banner.innerHTML = `
      🎰 <strong>${escapeHtml(feverPlayer.name)}</strong> ${triggerLabel} 🎰
    `;
    banner.classList.add('show');
  }

  // 全体再描画
  function rerender() {
    if (!view.publicState) return;
    const myPlayerId = fm.state.playerId;
    const layout = seatLayout(view.publicState, myPlayerId);

    renderHeader(view.publicState);
    renderDora(view.publicState);
    renderFeverBanner(view.publicState);
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

    // リーチモードのクラスを me-area に反映
    $('.me-area').classList.toggle('reach-mode', view.reachMode);

    // 自分の手牌（プライベート情報）
    if (view.myHand) {
      renderMyHand(view.myHand.hand, view.myHand.drawnTile);
    }

    // アクションボタンを描画
    renderActionArea();
  }

  // -----------------------------------------------------------------
  // アクションボタン描画
  //   1. 鳴き応答待ち (pendingClaim) があれば: ポン/カン/スキップ + カウントダウン
  //   2. 自分のターン (myTurnOptions) なら: 暗カン/加カン/リーチ ボタン
  //   3. リーチモード中なら: キャンセルボタン
  //   どれでもないなら: 何も表示しない
  // -----------------------------------------------------------------
  function renderActionArea() {
    const area = $('#action-area');
    area.innerHTML = '';

    // (1) 鳴き応答中
    if (view.pendingClaim) {
      area.appendChild(makeClaimBar(view.pendingClaim));
      return;
    }

    // (2) リーチモード中: キャンセルボタンのみ
    if (view.reachMode) {
      const row = document.createElement('div');
      row.className = 'action-row';
      const hint = document.createElement('span');
      hint.style.cssText = 'color: #ffd700; font-size: 13px; margin-right: 8px;';
      hint.textContent = 'リーチで切る牌を選択';
      row.appendChild(hint);

      const cancel = document.createElement('button');
      cancel.className = 'action-btn cancel';
      cancel.textContent = 'キャンセル';
      cancel.addEventListener('click', () => {
        view.reachMode = false;
        view.canDiscard = !!view.myTurnOptions; // 通常打牌に戻す
        rerender();
      });
      row.appendChild(cancel);
      area.appendChild(row);
      return;
    }

    // (3) 自分のターン中の選択肢
    const opts = view.myTurnOptions;
    if (!opts) return;
    const isMyTurn = view.publicState && view.publicState.currentTurn === fm.state.playerId;
    if (!isMyTurn) return;

    const row = document.createElement('div');
    row.className = 'action-row';

    // 他家 FEVER 中のヒント
    if (opts.restrictedByFever) {
      const hint = document.createElement('span');
      hint.style.cssText = 'color: #ff00aa; font-size: 12px; margin-right: 6px;';
      hint.textContent = '⚠ FEVER 中：ツモ切り限定';
      row.appendChild(hint);
    }

    // ツモアガリボタン（最も目立たせる）
    if (opts.options && opts.options.includes('tsumo')) {
      const btn = document.createElement('button');
      btn.className = 'action-btn tsumo';
      btn.textContent = '🔵 ツモ！';
      btn.addEventListener('click', () => {
        if (confirm('ツモアガリしますか？')) {
          view.discarding = true;
          fm.sendTsumo();
        }
      });
      row.appendChild(btn);
    }

    // 北抜きボタン
    if (opts.options && opts.options.includes('kita')) {
      const btn = document.createElement('button');
      btn.className = 'action-btn kita';
      btn.textContent = '🟢 北抜き';
      btn.addEventListener('click', () => {
        view.discarding = true;
        fm.sendKita();
      });
      row.appendChild(btn);
    }

    // リーチボタン
    if (opts.options && opts.options.includes('reach')) {
      const btn = document.createElement('button');
      btn.className = 'action-btn reach';
      btn.textContent = '🎯 リーチ';
      btn.addEventListener('click', () => {
        view.reachMode = true;
        view.canDiscard = false;
        rerender();
      });
      row.appendChild(btn);
    }

    // 暗カンボタン
    if (opts.options && opts.options.includes('ankan')) {
      for (const tile of opts.ankanCandidates) {
        const btn = document.createElement('button');
        btn.className = 'action-btn kan';
        btn.textContent = `暗カン (${tileToLabel(tile)})`;
        btn.addEventListener('click', () => {
          if (confirm(`${tileToLabel(tile)} で暗カンしますか？`)) {
            view.discarding = true;
            fm.sendKan({ type: 'ankan', tile });
          }
        });
        row.appendChild(btn);
      }
    }

    // 加カンボタン
    if (opts.options && opts.options.includes('kakan')) {
      for (const tile of opts.kakanCandidates) {
        const btn = document.createElement('button');
        btn.className = 'action-btn kan';
        btn.textContent = `加カン (${tileToLabel(tile)})`;
        btn.addEventListener('click', () => {
          if (confirm(`${tileToLabel(tile)} で加カンしますか？`)) {
            view.discarding = true;
            fm.sendKan({ type: 'kakan', tile });
          }
        });
        row.appendChild(btn);
      }
    }

    if (row.children.length > 0) area.appendChild(row);
  }

  // 鳴き応答バー（カウントダウン + ボタン）を生成
  function makeClaimBar(claim) {
    const bar = document.createElement('div');
    bar.className = 'claim-bar';

    const sourcePlayerId = claim.fromPlayer || claim.discardingPlayer;
    const fromName = view.publicState
      ? (view.publicState.players.find((p) => p.id === sourcePlayerId)?.name || '?')
      : '?';
    const title = document.createElement('div');
    title.className = 'claim-title';
    const verb = claim.type === 'kita' ? 'が抜いた' : 'の捨て牌';
    title.innerHTML = `${escapeHtml(fromName)} ${verb} <span class="claim-target-tile"></span> ${claim.type === 'kita' ? '応答しますか？' : '鳴きますか？'}`;
    const tileSlot = title.querySelector('.claim-target-tile');
    tileSlot.appendChild(makeTileEl(claim.tile));
    bar.appendChild(title);

    const countdown = document.createElement('div');
    countdown.className = 'claim-countdown';
    countdown.id = 'claim-countdown';
    bar.appendChild(countdown);

    const row = document.createElement('div');
    row.className = 'action-row';
    row.style.cssText = 'justify-content: center; margin-top: 8px;';

    // 北抜き応答ボタン（kita-claim 専用）
    if (claim.options.includes('kita-pon')) {
      const btn = document.createElement('button');
      btn.className = 'action-btn pon';
      btn.textContent = '🟠 北ポン';
      btn.addEventListener('click', () => {
        view.pendingClaim = null;
        stopClaimCountdown();
        rerender();
        fm.sendKitaPon();
      });
      row.appendChild(btn);
    }
    if (claim.options.includes('kita-kan')) {
      const btn = document.createElement('button');
      btn.className = 'action-btn kan';
      btn.textContent = '🟣 北カン';
      btn.addEventListener('click', () => {
        view.pendingClaim = null;
        stopClaimCountdown();
        rerender();
        fm.sendKitaKan();
      });
      row.appendChild(btn);
    }
    // ロンボタン（最優先で先頭に）
    if (claim.options.includes('ron')) {
      const btn = document.createElement('button');
      btn.className = 'action-btn ron';
      btn.textContent = '🔴 ロン！';
      btn.addEventListener('click', () => {
        view.pendingClaim = null;
        stopClaimCountdown();
        rerender();
        fm.sendRon();
      });
      row.appendChild(btn);
    }
    if (claim.options.includes('pon')) {
      const btn = document.createElement('button');
      btn.className = 'action-btn pon';
      btn.textContent = '🟠 ポン';
      btn.addEventListener('click', () => {
        view.pendingClaim = null;
        stopClaimCountdown();
        rerender();
        fm.sendPon();
      });
      row.appendChild(btn);
    }
    if (claim.options.includes('kan')) {
      const btn = document.createElement('button');
      btn.className = 'action-btn kan';
      btn.textContent = '🟣 明カン';
      btn.addEventListener('click', () => {
        view.pendingClaim = null;
        stopClaimCountdown();
        rerender();
        fm.sendKan({ type: 'minkan' });
      });
      row.appendChild(btn);
    }
    const skip = document.createElement('button');
    skip.className = 'action-btn skip';
    skip.textContent = 'スキップ';
    skip.addEventListener('click', () => {
      view.pendingClaim = null;
      stopClaimCountdown();
      rerender();
      fm.sendSkip();
    });
    row.appendChild(skip);

    bar.appendChild(row);
    return bar;
  }

  function startClaimCountdown(claim) {
    stopClaimCountdown();
    const update = () => {
      const remain = Math.max(0, claim.timeoutMs - (Date.now() - claim.startedAt));
      const sec = Math.ceil(remain / 1000);
      const el = document.getElementById('claim-countdown');
      if (el) el.textContent = `残り ${sec} 秒`;
      if (remain <= 0) stopClaimCountdown();
    };
    update();
    view.claimCountdownTimer = setInterval(update, 200);
  }
  function stopClaimCountdown() {
    if (view.claimCountdownTimer) {
      clearInterval(view.claimCountdownTimer);
      view.claimCountdownTimer = null;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  }

  // ------------------------------------------------------------
  // サーバーイベント購読
  // ------------------------------------------------------------
  function bindEvents() {
    // 公開状態の更新（部屋全員に届く）
    fm.on('game:state-update', (publicState) => {
      view.publicState = publicState;
      // 自分以外のターンになったら打牌不可 + your-turn の選択肢もクリア
      if (publicState.currentTurn !== fm.state.playerId) {
        view.canDiscard = false;
        view.reachMode = false;
        view.myTurnOptions = null;
      }
      rerender();
    });

    // 自分の手牌（本人だけに届く）
    fm.on('game:your-hand', (privateHand) => {
      view.myHand = privateHand;
      view.discarding = false;  // 送信ロックを解除
      rerender();
    });

    // 自分のターンが来た → 打牌可能に + アクションボタン表示
    fm.on('game:your-turn', (payload) => {
      view.myTurnOptions = payload;
      view.canDiscard = Array.isArray(payload.options) && payload.options.includes('discard');
      view.discarding = false;
      view.reachMode = false;
      rerender();
    });

    // 鳴き応答（ポン・明カンができる打牌があった）
    fm.on('game:waiting-claim', (payload) => {
      view.pendingClaim = { ...payload, startedAt: Date.now() };
      // 通常打牌・リーチモードを一時停止
      view.canDiscard = false;
      view.reachMode = false;
      rerender();
      startClaimCountdown(view.pendingClaim);
    });

    // 誰かが何かしたという通知（ログ的に使う・トーストは過剰なので控えめに）
    fm.on('game:action-result', ({ action, playerId, tile, isTsumogiri, isAuto }) => {
      if (!view.publicState) return;
      const name = view.publicState.players.find((p) => p.id === playerId)?.name || playerId;
      if (playerId === fm.state.playerId) return; // 自分の行動はトーストしない
      const label = tile ? tileToLabel(tile) : '';
      if (action === 'discard') {
        showToast(`${name} が ${label} を${isTsumogiri ? 'ツモ切り' : '打牌'}`, 'info', 1200);
      } else if (action === 'pon') {
        showToast(`🟠 ${name} が ${label} をポン！`, 'info', 1800);
      } else if (action === 'minkan' || action === 'kan') {
        showToast(`🟣 ${name} が ${label} で明カン！`, 'info', 1800);
      } else if (action === 'ankan') {
        showToast(`🟣 ${name} が暗カン (${label})`, 'info', 1800);
      } else if (action === 'kakan') {
        showToast(`🟣 ${name} が加カン (${label})`, 'info', 1800);
      } else if (action === 'reach') {
        showToast(`🎯 ${name} がリーチ！`, 'ok', 2000);
      } else if (action === 'kita') {
        showToast(`🟢 ${name} が北抜き${isAuto ? '（FEVER 強制）' : ''}`, 'info', 1500);
      } else if (action === 'kita-pon') {
        showToast(`🟠 ${name} が北ポン！`, 'info', 1800);
      } else if (action === 'kita-kan') {
        showToast(`🟣 ${name} が北カン！`, 'info', 1800);
      }
    });

    // 流局通知（step 3: 詳細版）
    fm.on('game:ryukyoku', (payload) => {
      view.canDiscard = false;
      view.discarding = false;
      view.myTurnOptions = null;
      view.reachMode = false;
      view.pendingClaim = null;
      stopClaimCountdown();
      showRyukyokuOverlay(payload);
      rerender();
    });

    // アガリ通知（step 3）
    fm.on('game:agari', (payload) => {
      view.canDiscard = false;
      view.discarding = false;
      view.myTurnOptions = null;
      view.reachMode = false;
      view.pendingClaim = null;
      stopClaimCountdown();
      showAgariOverlay(payload);
      rerender();
    });

    // 局終了 → 次局開始の通知（情報のみ・オーバーレイは hide される）
    fm.on('game:hand-end', () => {
      hideAgariOverlay();
      hideRyukyokuOverlay();
    });

    // 対局終了
    fm.on('game:game-end', (payload) => {
      view.canDiscard = false;
      view.discarding = false;
      view.myTurnOptions = null;
      view.pendingClaim = null;
      stopClaimCountdown();
      hideAgariOverlay();
      hideRyukyokuOverlay();
      showGameEndOverlay(payload);
    });

    // 接続切れたら表示をクリア（再接続時に古い手牌が見えないように）
    fm.on('disconnected', () => {
      view.myHand = null;
      view.canDiscard = false;
      view.myTurnOptions = null;
      view.pendingClaim = null;
      view.reachMode = false;
      stopClaimCountdown();
    });
  }

  // 簡易トースト（lobby.js のトーストを再利用するため #toast を使う）
  function showToast(message, type = 'info', duration = 1500) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.className = 'toast show ' + type;
    setTimeout(() => { el.className = 'toast'; }, duration);
  }

  // 流局オーバーレイ（step 3: 詳細版）
  // payload: { reason, message, tenpaiStatus, penalty, scoresAfter, round, reachSticks }
  function showRyukyokuOverlay(payload) {
    let el = document.getElementById('ryukyoku-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ryukyoku-overlay';
      el.className = 'result-overlay';
      document.body.appendChild(el);
    }
    el.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'result-card ryukyoku-card';

    const h2 = document.createElement('h2');
    h2.innerHTML = '🏁 流局';
    card.appendChild(h2);
    if (payload && payload.message) {
      const msg = document.createElement('p');
      msg.className = 'result-sub';
      msg.textContent = payload.message;
      card.appendChild(msg);
    }

    // テンパイ状況
    if (payload && Array.isArray(payload.tenpaiStatus)) {
      const list = document.createElement('div');
      list.className = 'tenpai-list';
      for (const s of payload.tenpaiStatus) {
        const row = document.createElement('div');
        row.className = 'tenpai-row';
        const status = s.isTenpai || s.isReached ? '✅ テンパイ' : '❌ ノーテン';
        const delta = (payload.penalty && payload.penalty[s.id]) || 0;
        row.innerHTML = `
          <span class="tenpai-name">${escapeHtml(s.name)}</span>
          <span class="tenpai-status">${status}</span>
          <span class="tenpai-delta ${delta >= 0 ? 'plus' : 'minus'}">${delta >= 0 ? '+' : ''}${delta}</span>
        `;
        // テンパイ者は待ち牌を表示
        if (s.isTenpai && s.waits && s.waits.length > 0) {
          const waits = document.createElement('div');
          waits.className = 'tenpai-waits';
          waits.appendChild(document.createTextNode('待ち: '));
          for (const t of s.waits) {
            waits.appendChild(makeTileEl(t, { small: true }));
          }
          row.appendChild(waits);
        }
        list.appendChild(row);
      }
      card.appendChild(list);
    }

    // 次局ボタン
    const next = document.createElement('button');
    next.className = 'action-btn primary-next';
    next.textContent = '次の局へ ➡';
    next.addEventListener('click', () => {
      next.disabled = true;
      fm.sendNextHand();
    });
    card.appendChild(next);

    el.appendChild(card);
    el.classList.add('show');
  }
  function hideRyukyokuOverlay() {
    const el = document.getElementById('ryukyoku-overlay');
    if (el) el.classList.remove('show');
  }

  // アガリオーバーレイ（step 3）
  // payload: { winner, isTsumo, fromPlayer, hand, melds, kitaPullsCount, winningTile,
  //            yakuList, totalHan, isYakuman, doraIndicators, uraDoraIndicators,
  //            basePoint, pointMoves, scoresAfter, reachBonusGain, round }
  function showAgariOverlay(payload) {
    let el = document.getElementById('agari-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'agari-overlay';
      el.className = 'result-overlay';
      document.body.appendChild(el);
    }
    el.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'result-card agari-card';

    // バナー
    const banner = document.createElement('h2');
    banner.className = 'agari-banner';
    banner.textContent = payload.isTsumo ? '🔵 ツモ！' : '🔴 ロン！';
    if (payload.isYakuman) banner.textContent += ' 役満！';
    card.appendChild(banner);

    // 和了者
    const winnerLine = document.createElement('div');
    winnerLine.className = 'agari-winner';
    const fromText = payload.isTsumo ? '' : `（${escapeHtml(payload.fromPlayer.name)} から）`;
    winnerLine.innerHTML = `<strong>${escapeHtml(payload.winner.name)}</strong> ${fromText}`;
    card.appendChild(winnerLine);

    // 手牌＋和了牌
    const handArea = document.createElement('div');
    handArea.className = 'agari-hand';
    // 副露
    if (payload.melds && payload.melds.length > 0) {
      const meldsBlock = document.createElement('div');
      meldsBlock.className = 'agari-melds';
      for (const m of payload.melds) {
        const meldSpan = document.createElement('span');
        meldSpan.className = 'agari-meld';
        for (const t of m.tiles) meldSpan.appendChild(makeTileEl(t));
        handArea.appendChild(meldSpan);
      }
    }
    // 手牌
    for (const t of payload.hand) {
      handArea.appendChild(makeTileEl(t));
    }
    // 和了牌（強調）
    if (payload.winningTile) {
      const sep = document.createElement('span');
      sep.style.cssText = 'width:8px; display:inline-block;';
      handArea.appendChild(sep);
      const winTile = makeTileEl(payload.winningTile);
      winTile.classList.add('agari-winning');
      handArea.appendChild(winTile);
    }
    card.appendChild(handArea);

    // 役一覧
    const yakuBlock = document.createElement('div');
    yakuBlock.className = 'agari-yaku';
    for (const y of payload.yakuList) {
      const row = document.createElement('div');
      row.className = 'yaku-row';
      row.innerHTML = `
        <span class="yaku-name">${escapeHtml(y.name)}</span>
        <span class="yaku-han">${y.han}翻</span>
      `;
      yakuBlock.appendChild(row);
    }
    const total = document.createElement('div');
    total.className = 'yaku-total';
    total.innerHTML = `合計 <strong>${payload.totalHan}</strong> 翻 / 基本点 <strong>${payload.basePoint}</strong>`;
    yakuBlock.appendChild(total);
    card.appendChild(yakuBlock);

    // FEVER 表示
    if (payload.feverActive) {
      const fev = document.createElement('div');
      fev.className = 'agari-fever-badge';
      const label = payload.feverTrigger === 'double' ? 'W-FEVER!! (点棒×2)' : '🎰 FEVER (点棒×2)';
      fev.textContent = label;
      card.appendChild(fev);
    }

    // 点棒移動
    if (payload.pointMoves) {
      const pointsBlock = document.createElement('div');
      pointsBlock.className = 'agari-points';
      pointsBlock.innerHTML = '<div class="points-title">点棒移動</div>';
      for (const pid of ['P0','P1','P2']) {
        const delta = payload.pointMoves[pid] || 0;
        if (delta === 0) continue;
        const name = (view.publicState && view.publicState.players.find((p) => p.id === pid)?.name) || pid;
        const row = document.createElement('div');
        row.className = 'point-row';
        row.innerHTML = `
          <span class="point-name">${escapeHtml(name)}</span>
          <span class="point-delta ${delta >= 0 ? 'plus' : 'minus'}">${delta >= 0 ? '+' : ''}${delta}</span>
        `;
        pointsBlock.appendChild(row);
      }
      if (payload.reachBonusGain > 0) {
        const row = document.createElement('div');
        row.className = 'point-row reach-bonus';
        row.innerHTML = `<span class="point-name">リーチ棒回収</span><span class="point-delta plus">+${payload.reachBonusGain}</span>`;
        pointsBlock.appendChild(row);
      }
      card.appendChild(pointsBlock);
    }

    // チップ移動（step 4 で追加）
    if (payload.chipMoves) {
      let hasAnyChip = false;
      for (const pid of ['P0','P1','P2']) {
        if ((payload.chipMoves[pid] || 0) !== 0) { hasAnyChip = true; break; }
      }
      if (hasAnyChip) {
        const chipBlock = document.createElement('div');
        chipBlock.className = 'agari-chips';
        chipBlock.innerHTML = '<div class="chips-title">💎 チップ移動</div>';
        for (const pid of ['P0','P1','P2']) {
          const delta = payload.chipMoves[pid] || 0;
          if (delta === 0) continue;
          const name = (view.publicState && view.publicState.players.find((p) => p.id === pid)?.name) || pid;
          const row = document.createElement('div');
          row.className = 'chip-row';
          row.innerHTML = `
            <span class="point-name">${escapeHtml(name)}</span>
            <span class="point-delta ${delta >= 0 ? 'plus' : 'minus'}">${delta >= 0 ? '+' : ''}${delta}💎</span>
          `;
          chipBlock.appendChild(row);
        }
        // 内訳（あれば）
        if (payload.chipBreakdown) {
          const bd = payload.chipBreakdown;
          const detail = [];
          if (bd.rule1) detail.push(`一索/一萬/九萬: +${bd.rule1}`);
          if (bd.rule2) detail.push(`裏ドラ表示: +${bd.rule2}`);
          if (bd.rule3) detail.push(`役満祝儀: +${bd.rule3}`);
          if (detail.length > 0) {
            const d = document.createElement('div');
            d.className = 'chip-breakdown';
            d.textContent = detail.join(' / ');
            chipBlock.appendChild(d);
          }
        }
        card.appendChild(chipBlock);
      }
    }

    // 裏ドラ表示牌（リーチ和了時のみ）
    if (payload.uraDoraIndicators && payload.uraDoraIndicators.length > 0) {
      const ura = document.createElement('div');
      ura.className = 'agari-ura';
      ura.innerHTML = '<div class="ura-title">裏ドラ表示</div>';
      const tiles = document.createElement('div');
      tiles.className = 'tile-row';
      for (const t of payload.uraDoraIndicators) tiles.appendChild(makeTileEl(t));
      ura.appendChild(tiles);
      card.appendChild(ura);
    }

    // 次局ボタン
    const next = document.createElement('button');
    next.className = 'action-btn primary-next';
    next.textContent = '次の局へ ➡';
    next.addEventListener('click', () => {
      next.disabled = true;
      fm.sendNextHand();
    });
    card.appendChild(next);

    el.appendChild(card);
    el.classList.add('show');
  }
  function hideAgariOverlay() {
    const el = document.getElementById('agari-overlay');
    if (el) el.classList.remove('show');
  }

  // 対局終了オーバーレイ
  function showGameEndOverlay(payload) {
    let el = document.getElementById('gameend-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'gameend-overlay';
      el.className = 'result-overlay';
      document.body.appendChild(el);
    }
    el.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'result-card gameend-card';

    const h2 = document.createElement('h2');
    h2.textContent = payload.reason === 'tobi' ? '🏁 トビ終了' : '🏁 対局終了';
    card.appendChild(h2);

    const sub = document.createElement('div');
    sub.className = 'result-sub';
    sub.textContent = payload.reason === 'tobi'
      ? 'マイナス点でトビになりました'
      : '全6局を終えました';
    card.appendChild(sub);

    // 順位表
    const rank = document.createElement('div');
    rank.className = 'ranking';
    payload.ranking.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'rank-row';
      row.innerHTML = `
        <span class="rank-num">${i + 1}位</span>
        <span class="rank-name">${escapeHtml(p.name)}</span>
        <span class="rank-score">${p.score} 点</span>
      `;
      rank.appendChild(row);
    });
    card.appendChild(rank);

    el.appendChild(card);
    el.classList.add('show');
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
