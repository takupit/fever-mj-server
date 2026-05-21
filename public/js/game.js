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
    // FEVER 発動検出用: 前回の状態で誰が FEVER だったかを記録
    prevFeverActivePlayers: new Set(),
  };

  // ------------------------------------------------------------
  // 牌コード → 表示用ラベル（簡易テキスト・トースト等で使用）
  // ------------------------------------------------------------
  const MANZU_LABELS = ['', '一萬', '二萬', '三萬', '四萬', '五萬', '六萬', '七萬', '八萬', '九萬'];
  const PINZU_LABELS = ['', '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];
  const JIHAI_LABELS = { z1: '東', z2: '南', z3: '西', z4: '北', z5: '白', z6: '發', z7: '中' };
  const WIND_NAMES = { E: '東家', S: '南家', W: '西家', N: '北家' };
  const MANZU_KANJI = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

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

  // ------------------------------------------------------------
  // SVG 牌ファクトリ（フェーズ5a で旧 play.html から移植）
  //   makePinzu / makePinzuDot / makePinzu1SVG / getPinzuColors:
  //     筒子の車輪型 SVG。1筒は特別デザイン、5筒は赤五筒対応
  //   makeSouzu: 索子（1索=孔雀風、9索=8字型）
  //   makeTileEl: 上記を組み合わせて DOM 要素を作る
  // ------------------------------------------------------------

  // 筒子の各円の色（実物の麻雀牌準拠）
  const PINZU_BLUE = '#1a3a78';
  const PINZU_RED = '#e60000';
  function getPinzuColors(n) {
    const B = PINZU_BLUE, R = PINZU_RED;
    const map = {
      1: [B], 2: [B, B], 3: [B, B, B], 4: [B, B, B, B],
      5: [B, B, R, B, B], 6: [R, R, B, B, B, B],
      7: [R, R, R, B, B, B, B], 8: [B, B, B, B, B, B, B, B],
      9: [B, R, B, B, R, B, B, R, B],
    };
    return map[n] || [];
  }

  // 筒子1個の SVG（車輪型）
  function makePinzuDot(color) {
    const dot = document.createElement('div');
    dot.className = 'pinzu-dot';
    dot.innerHTML = `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
      <circle cx="16" cy="16" r="14.5" fill="${color}"/>
      <circle cx="16" cy="16" r="11" fill="#fff8e1"/>
      <circle cx="16" cy="16" r="10.5" fill="none" stroke="${color}" stroke-width="0.8"/>
      <g fill="${color}">
        <circle cx="16" cy="9" r="2"/>
        <circle cx="22.06" cy="12.5" r="2"/>
        <circle cx="22.06" cy="19.5" r="2"/>
        <circle cx="16" cy="23" r="2"/>
        <circle cx="9.94" cy="19.5" r="2"/>
        <circle cx="9.94" cy="12.5" r="2"/>
      </g>
      <circle cx="16" cy="16" r="2" fill="#fff8e1" stroke="${color}" stroke-width="0.5"/>
    </svg>`;
    return dot;
  }

  // 1筒：豪華な特別デザイン
  function makePinzu1SVG() {
    let cogPath = '';
    const cogCount = 16;
    for (let i = 0; i < cogCount; i++) {
      const a1 = (i * 2 * Math.PI / cogCount) - Math.PI / 2;
      const a2 = ((i + 0.5) * 2 * Math.PI / cogCount) - Math.PI / 2;
      const a3 = ((i + 1) * 2 * Math.PI / cogCount) - Math.PI / 2;
      const r1 = 27, r2 = 29;
      const x1 = 30 + r1 * Math.cos(a1), y1 = 30 + r1 * Math.sin(a1);
      const x2 = 30 + r2 * Math.cos(a2), y2 = 30 + r2 * Math.sin(a2);
      const x3 = 30 + r1 * Math.cos(a3), y3 = 30 + r1 * Math.sin(a3);
      if (i === 0) cogPath += `M ${x1.toFixed(2)} ${y1.toFixed(2)} `;
      cogPath += `L ${x2.toFixed(2)} ${y2.toFixed(2)} L ${x3.toFixed(2)} ${y3.toFixed(2)} `;
    }
    cogPath += 'Z';
    return `<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
      <path d="${cogPath}" fill="#1a3a78"/>
      <circle cx="30" cy="30" r="22" fill="#fff8e1"/>
      <circle cx="30" cy="30" r="20" fill="#1a5d2c"/>
      <circle cx="30" cy="30" r="17" fill="#fff8e1"/>
      <g fill="#d4a017">
        <circle cx="30" cy="14.5" r="1.5"/><circle cx="41" cy="19" r="1.5"/>
        <circle cx="45.5" cy="30" r="1.5"/><circle cx="41" cy="41" r="1.5"/>
        <circle cx="30" cy="45.5" r="1.5"/><circle cx="19" cy="41" r="1.5"/>
        <circle cx="14.5" cy="30" r="1.5"/><circle cx="19" cy="19" r="1.5"/>
      </g>
      <g fill="#e60000">
        <circle cx="30" cy="22" r="3"/><circle cx="37" cy="26" r="3"/>
        <circle cx="37" cy="34" r="3"/><circle cx="30" cy="38" r="3"/>
        <circle cx="23" cy="34" r="3"/><circle cx="23" cy="26" r="3"/>
      </g>
      <circle cx="30" cy="30" r="3" fill="#fff8e1"/>
      <circle cx="30" cy="30" r="1.5" fill="#d4a017"/>
    </svg>`;
  }

  // 筒子全体（1〜9）
  function makePinzu(n, isRedFive) {
    const c = document.createElement('div');
    c.className = `pinzu pinzu-${n}`;
    if (n === 1) {
      const dot = document.createElement('div');
      dot.className = 'pinzu-dot';
      dot.innerHTML = makePinzu1SVG();
      c.appendChild(dot);
      return c;
    }
    const colors = getPinzuColors(n);
    for (let i = 0; i < n; i++) {
      c.appendChild(makePinzuDot(isRedFive && n === 5 ? '#e60000' : colors[i]));
    }
    return c;
  }

  // 索子（1索=孔雀風、9索=8字型を3x3）
  function makeSouzu(n) {
    const c = document.createElement('div');
    c.className = 'souzu';
    if (n === 1) {
      c.innerHTML = `<svg viewBox="0 0 60 80" xmlns="http://www.w3.org/2000/svg">
        <ellipse cx="30" cy="68" rx="20" ry="10" fill="#1a5d2c"/>
        <path d="M15 68 Q20 60 30 58 Q40 60 45 68 Z" fill="#2d7a3e"/>
        <ellipse cx="30" cy="50" rx="11" ry="14" fill="#2d7a3e"/>
        <ellipse cx="30" cy="48" rx="9" ry="11" fill="#3d9050"/>
        <ellipse cx="30" cy="52" rx="6" ry="7" fill="#ffc107"/>
        <ellipse cx="22" cy="50" rx="5" ry="9" fill="#1565c0" transform="rotate(-15 22 50)"/>
        <ellipse cx="38" cy="50" rx="5" ry="9" fill="#1565c0" transform="rotate(15 38 50)"/>
        <circle cx="30" cy="32" r="10" fill="#c62828"/>
        <circle cx="30" cy="30" r="8" fill="#e53935"/>
        <path d="M30 18 L26 24 L30 22 L34 24 Z" fill="#ffc107"/>
        <polygon points="30,30 27,38 33,38" fill="#ffc107"/>
        <polygon points="30,32 28,36 32,36" fill="#c4a000"/>
        <circle cx="27" cy="28" r="1.5" fill="#000"/>
        <circle cx="33" cy="28" r="1.5" fill="#000"/>
        <line x1="28" y1="62" x2="26" y2="72" stroke="#c4a000" stroke-width="1.5"/>
        <line x1="32" y1="62" x2="34" y2="72" stroke="#c4a000" stroke-width="1.5"/>
      </svg>`;
    } else {
      c.classList.add('souzu-9');
      const colors = ['#1a5d2c', '#1a5d2c', '#1a5d2c', '#c62828', '#c62828', '#c62828', '#1a5d2c', '#1a5d2c', '#1a5d2c'];
      for (let i = 0; i < 9; i++) {
        const bamboo = document.createElement('div');
        bamboo.className = 'bamboo';
        bamboo.innerHTML = `<svg viewBox="0 0 20 24" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
          <ellipse cx="10" cy="7" rx="4" ry="4" fill="none" stroke="${colors[i]}" stroke-width="2"/>
          <line x1="10" y1="11" x2="10" y2="13" stroke="${colors[i]}" stroke-width="2"/>
          <ellipse cx="10" cy="17" rx="4" ry="4" fill="none" stroke="${colors[i]}" stroke-width="2"/>
          <circle cx="10" cy="12" r="1" fill="${colors[i]}"/>
        </svg>`;
        c.appendChild(bamboo);
      }
    }
    return c;
  }

  // 牌1枚を表す DOM 要素を作る（SVG 描画版）
  // options: { back: true で裏向き }
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
    const isRedTile = tile.endsWith('r');
    const base = tile.replace('r', '');
    const suit = base[0];
    div.classList.add(`suit-${suit}`);
    if (isRedTile) div.classList.add('red');
    // 七筒・七萬は FEVER 牌として金枠
    if (base === 'm7' || base === 'p7') div.classList.add('fever-tile');
    div.dataset.tile = tile;

    // 字牌
    if (suit === 'z') {
      const inner = document.createElement('div');
      inner.className = 'tile-jihai';
      if (base === 'z6') inner.classList.add('hatsu');
      if (base === 'z7') inner.classList.add('chun');
      if (base === 'z5') {
        inner.classList.add('haku'); // 白は空の枠
      } else {
        inner.textContent = JIHAI_LABELS[base] || '';
      }
      div.appendChild(inner);
      return div;
    }

    const n = parseInt(base[1], 10);
    // 萬子
    if (suit === 'm') {
      const num = document.createElement('div');
      num.className = 'tile-mn-num';
      num.textContent = MANZU_KANJI[n] || '';
      const lbl = document.createElement('div');
      lbl.className = 'tile-mn-lbl';
      lbl.textContent = '萬';
      div.appendChild(num);
      div.appendChild(lbl);
      return div;
    }
    // 筒子
    if (suit === 'p') {
      div.appendChild(makePinzu(n, isRedTile));
      return div;
    }
    // 索子
    if (suit === 's') {
      div.appendChild(makeSouzu(n));
      return div;
    }

    div.textContent = tile;
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
  // ------------------------------------------------------------
  // カジノチップのスタック描画（旧 play.html から移植）
  //   黒チップ = 10枚分（積み重ね・最大8枚表示）
  //   色チップ = 1枚分（プレイヤー別: P0=青、P1=緑、P2=オレンジ）
  //   末尾に数値も併記
  // ------------------------------------------------------------
  function makeChipStackEl(chips, playerIdx) {
    const colorMap = ['blue', 'green', 'orange'];
    const color = colorMap[playerIdx] || 'blue';
    const stack = document.createElement('span');
    stack.className = 'chip-stack';
    chips = Math.max(0, Math.floor(chips || 0));

    const blackCount = Math.floor(chips / 10);
    const colorCount = chips % 10;

    if (blackCount > 0) {
      const pile = document.createElement('span');
      pile.className = 'chip-pile';
      const displayBlack = Math.min(blackCount, 8);
      for (let i = 0; i < displayBlack; i++) {
        const c = document.createElement('span');
        c.className = 'chip black';
        pile.appendChild(c);
      }
      stack.appendChild(pile);
      if (blackCount > 8) {
        const more = document.createElement('span');
        more.className = 'chip-more';
        more.textContent = `×${blackCount}`;
        stack.appendChild(more);
      }
    }
    if (colorCount > 0) {
      const pile = document.createElement('span');
      pile.className = 'chip-pile';
      for (let i = 0; i < colorCount; i++) {
        const c = document.createElement('span');
        c.className = `chip ${color}`;
        pile.appendChild(c);
      }
      stack.appendChild(pile);
    }
    const num = document.createElement('span');
    num.className = 'chip-count';
    num.textContent = `(${chips})`;
    stack.appendChild(num);
    return stack;
  }

  // playerId → 0/1/2 のインデックス
  function playerIdx(playerId) {
    return parseInt((playerId || 'P0').slice(1), 10);
  }

  // ------------------------------------------------------------
  // FEVER 持続バナー描画（仕様書 7. 待ち牌・残り山残量を画面上部に常時表示）
  // ------------------------------------------------------------
  function renderFeverStatusBar(publicState) {
    const el = document.getElementById('fever-status-bar');
    if (!el) return;
    const info = publicState && publicState.feverInfo;
    if (!info || info.length === 0) {
      el.classList.remove('show');
      el.innerHTML = '';
      return;
    }
    el.innerHTML = '';
    for (const f of info) {
      const triggerLabel = f.trigger === 'double' ? 'W-FEVER（七筒＆七萬）'
                          : f.trigger === 'p7' ? '七筒の暗刻'
                          : f.trigger === 'm7' ? '七萬の暗刻'
                          : 'FEVER';
      // 上段: 🎰 FEVER 🎰 + 名前 + 種別
      const row1 = document.createElement('div');
      row1.className = 'fsb-row';
      row1.innerHTML = `
        <span class="fsb-icon">🎰</span>
        <span class="fsb-title">FEVER</span>
        <span class="fsb-icon">🎰</span>
        <span class="fsb-name">${escapeHtml(f.name)}</span>
        <span class="fsb-trigger">${triggerLabel}</span>
      `;
      el.appendChild(row1);

      // 下段: 待ち牌 + 山残量
      const row2 = document.createElement('div');
      row2.className = 'fsb-waits-row';
      const label = document.createElement('span');
      label.className = 'fsb-waits-label';
      label.textContent = '待ち：';
      row2.appendChild(label);

      const waitsEl = document.createElement('span');
      waitsEl.className = 'fsb-waits';
      for (const w of f.waits) waitsEl.appendChild(makeTileEl(w));
      row2.appendChild(waitsEl);

      const remaining = document.createElement('span');
      remaining.className = 'fsb-remaining';
      remaining.textContent = `山に残り ${f.waitsRemaining} 枚`;
      row2.appendChild(remaining);

      el.appendChild(row2);
    }
    el.classList.add('show');
  }

  function renderHeader(publicState) {
    const roundName = publicState.round.wind === 'E' ? '東' : '南';
    $('#game-round').textContent = `${roundName}${publicState.round.hand}局`;
    $('#game-honba').textContent = `${publicState.round.honba}本場`;
    $('#game-wall').textContent = String(publicState.wallCount);
    // 残り山警告（仕様書 13. 残り山牌の警告表示）
    //   11 枚以上: 通常
    //   5〜10 枚: オレンジ脈動 + 「ラストN」
    //   0〜4 枚 : 赤激しい脈動 + 「リーチ不可」
    const wallLabel = document.querySelector('.wall-label');
    if (!wallLabel) return;
    wallLabel.classList.remove('warn', 'danger');
    // 既存の warn-note を消す
    const oldNote = wallLabel.querySelector('.warn-note');
    if (oldNote) oldNote.remove();
    if (publicState.wallCount <= 4) {
      wallLabel.classList.add('danger');
      const note = document.createElement('span');
      note.className = 'warn-note';
      note.textContent = 'リーチ不可';
      wallLabel.appendChild(note);
    } else if (publicState.wallCount <= 10) {
      wallLabel.classList.add('warn');
      const note = document.createElement('span');
      note.className = 'warn-note';
      note.style.background = '#ff8c00';
      note.style.animation = 'none';
      note.textContent = `ラスト${publicState.wallCount}`;
      wallLabel.appendChild(note);
    }
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
    if (opponent.isReached) nameEl.innerHTML += ' <span class="reach-banner">立直</span>';
    if (opponent.feverActive) nameEl.innerHTML += ' <span class="fever-tag">🎰</span>';
    rootEl.querySelector('.opp-wind').textContent = WIND_NAMES[opponent.wind] || opponent.wind;
    // 点数 + チップスタック視覚
    const scoreEl = rootEl.querySelector('.opp-score');
    scoreEl.innerHTML = '';
    scoreEl.appendChild(document.createTextNode(`${opponent.score}点 `));
    scoreEl.appendChild(makeChipStackEl(opponent.chips || 0, playerIdx(opponent.id)));

    // 副露ブロック（5c: 鳴き牌は横向き、各メルドを枠で分離）
    const meldsEl = rootEl.querySelector('[data-role="melds"]');
    if (meldsEl) {
      renderMelds(meldsEl, opponent.melds, opponent.kitaPullsCount);
    }

    // 手牌（仕様書セキュリティ 1: 他家手牌の中身は公開しない・枚数のみ裏向き表示）
    fillTileBacks(rootEl.querySelector('[data-role="hand"]'), opponent.handCount);

    // 河
    const discardEl = rootEl.querySelector('[data-role="discards"]');
    fillTileRow(discardEl, opponent.discards.map((d) => d.tile));
  }

  // 副露ブロック描画（5c で新規）
  //   各メルドを meld-block で枠囲み、鳴き牌（fromPlayer が示す）は 90° 回転
  //   ankan は2枚を裏向きで「これは暗カン」と分かるように
  function renderMelds(containerEl, melds, kitaPullsCount) {
    containerEl.innerHTML = '';
    for (const meld of melds) {
      const block = document.createElement('div');
      block.className = 'meld-block ' + meld.type;

      // 鳴き牌の位置は元コードでは tiles 配列の末尾（doPon/doMinkan で push される）
      // ankan は全 4 枚同じ・fromPlayer=null。表示は2枚裏向き+2枚表向きの伝統的スタイル
      if (meld.type === 'ankan') {
        const tiles = meld.tiles;
        // [裏, 表, 表, 裏] の伝統スタイル
        for (let i = 0; i < tiles.length; i++) {
          const tEl = makeTileEl(tiles[i]);
          if (i === 0 || i === 3) {
            tEl.classList.add('back', 'back-in-ankan');
          }
          block.appendChild(tEl);
        }
      } else {
        // pon / minkan / kakan / chi: 末尾が鳴き牌
        const tiles = meld.tiles;
        const calledIdx = tiles.length - 1;
        for (let i = 0; i < tiles.length; i++) {
          const tEl = makeTileEl(tiles[i]);
          if (i === calledIdx) tEl.classList.add('called');
          block.appendChild(tEl);
        }
      }
      containerEl.appendChild(block);
    }
    // 北抜き数（メルドの後ろに）
    if (kitaPullsCount > 0) {
      const kita = document.createElement('span');
      kita.className = 'kita-mark';
      kita.textContent = `北×${kitaPullsCount}`;
      containerEl.appendChild(kita);
    }
  }

  function renderMe(me, isCurrentTurn) {
    let nameHtml = `${escapeHtml(me.name)}（あなた）`;
    if (me.isReached) nameHtml += ' <span class="reach-banner">リーチ</span>';
    if (me.feverActive) nameHtml += ' <span class="fever-tag">🎰FEVER</span>';
    $('#me-name').innerHTML = nameHtml;
    $('#me-wind').textContent = WIND_NAMES[me.wind] || me.wind;
    // 自分の点数 + チップスタック視覚
    const meScoreEl = $('#me-score');
    meScoreEl.innerHTML = '';
    meScoreEl.appendChild(document.createTextNode(`${me.score}点 `));
    meScoreEl.appendChild(makeChipStackEl(me.chips || 0, playerIdx(me.id)));
    $('.me-area').classList.toggle('current-turn', isCurrentTurn);
    $('.me-area').classList.toggle('reached', !!me.isReached);
    $('.me-area').classList.toggle('fever', !!me.feverActive);

    // 自分の副露ブロック（5c）
    const myMeldsEl = document.getElementById('me-melds');
    if (myMeldsEl) {
      renderMelds(myMeldsEl, me.melds || [], me.kitaPullsCount || 0);
    }

    // 自分の河
    fillTileRow($('#me-discards'), me.discards.map((d) => d.tile));
  }

  function renderMyHand(hand, drawnTile) {
    const handEl = $('#me-hand');
    handEl.innerHTML = '';
    if (!hand) return;

    // リーチモード時にどのインデックスが選択可能か
    const reachOptions = view.myTurnOptions ? (view.myTurnOptions.reachOptions || []) : [];
    const reachIdxMap = new Map(reachOptions.map((o) => [o.discardIdx, o]));

    // リーチ後の待ち牌セット（自分の手牌の中の待ち牌を強調）
    const reachWaits = (view.myHand && view.myHand.reachWaits) ? view.myHand.reachWaits : [];
    const reachWaitsSet = new Set(reachWaits);

    // 牌をクリック可能にする処理
    const attachClick = (tileEl, tile, handIdx) => {
      // 待ち牌の強調（リーチ後）
      if (reachWaitsSet.has(tile.replace('r', ''))) {
        tileEl.classList.add('wait-tile');
      }
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
  //   北（z4）の場合は河に捨てられないので、自動で「北抜き」に変換して送信。
  function onTileClick(tile, handIdx) {
    if (!view.canDiscard || view.discarding) return;
    // 北は打牌不可 → 北抜きに変換
    if (tile === 'z4') {
      const opts = view.myTurnOptions && view.myTurnOptions.options;
      if (opts && opts.includes('kita')) {
        view.discarding = true;
        view.canDiscard = false;
        rerender();
        fm.sendKita();
      } else {
        showToast('現在は北抜きできません（リーチ後の制約等）', 'error');
      }
      return;
    }
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
    renderFeverStatusBar(view.publicState); // 待ち牌・山残量つきの新バナー
    renderFeverBanner(view.publicState);    // 既存の上部固定バナー（互換維持）
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
      // FEVER 発動検出: 前回 FEVER でなかった人が今回 FEVER になっていたら花火
      const nowFever = new Set(
        publicState.players.filter((p) => p.feverActive).map((p) => p.id)
      );
      for (const pid of nowFever) {
        if (!view.prevFeverActivePlayers.has(pid)) {
          const player = publicState.players.find((p) => p.id === pid);
          const isDouble = player && player.feverTrigger === 'double';
          showFeverFireworks(isDouble);
          break; // 1局1回でOK
        }
      }
      view.prevFeverActivePlayers = nowFever;

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

    // 誰かが何かしたという通知（トースト + 一部はカットイン）
    fm.on('game:action-result', ({ action, playerId, tile, isTsumogiri, isAuto }) => {
      if (!view.publicState) return;
      const name = view.publicState.players.find((p) => p.id === playerId)?.name || playerId;
      const isSelf = playerId === fm.state.playerId;
      const label = tile ? tileToLabel(tile) : '';

      if (action === 'discard') {
        if (!isSelf) showToast(`${name} が ${label} を${isTsumogiri ? 'ツモ切り' : '打牌'}`, 'info', 1200);
      } else if (action === 'pon') {
        showActionSplash('ポン', 'pon');
        if (!isSelf) showToast(`🟠 ${name} が ${label} をポン！`, 'info', 1500);
      } else if (action === 'minkan' || action === 'kan') {
        showActionSplash('カン', 'kan');
        if (!isSelf) showToast(`🟣 ${name} が ${label} で明カン！`, 'info', 1500);
      } else if (action === 'ankan') {
        showActionSplash('カン', 'kan');
        if (!isSelf) showToast(`🟣 ${name} が暗カン (${label})`, 'info', 1500);
      } else if (action === 'kakan') {
        showActionSplash('カン', 'kan');
        if (!isSelf) showToast(`🟣 ${name} が加カン (${label})`, 'info', 1500);
      } else if (action === 'reach') {
        // リーチはカットイン演出（全員に発動）
        showActionSplash('リーチ', 'reach');
        if (!isSelf) showToast(`🎯 ${name} がリーチ！`, 'ok', 1800);
      } else if (action === 'kita') {
        showActionSplash('北', 'kita');
        if (!isSelf) showToast(`🟢 ${name} が北抜き${isAuto ? '（FEVER 強制）' : ''}`, 'info', 1500);
      } else if (action === 'kita-pon') {
        showActionSplash('北ポン', 'pon');
        if (!isSelf) showToast(`🟠 ${name} が北ポン！`, 'info', 1500);
      } else if (action === 'kita-kan') {
        showActionSplash('北カン', 'kan');
        if (!isSelf) showToast(`🟣 ${name} が北カン！`, 'info', 1500);
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

      // ロン時：振り込み者の最後の捨て牌を赤点滅させる
      if (!payload.isTsumo && payload.fromPlayer && payload.winningTile) {
        flashLoserDiscard(payload.fromPlayer.id, payload.winningTile);
      }

      // ロン/ツモ のカットイン演出を先に出してから、少し遅らせてアガリ画面
      showActionSplash(payload.isTsumo ? 'ツモ' : 'ロン', payload.isTsumo ? 'tsumo' : 'ron');
      setTimeout(() => {
        showAgariOverlay(payload);
        // アガリ画面表示の 0.5 秒後にチップ移動アニメ
        if (payload.chipMoves) {
          setTimeout(() => animateChipMovesInOverlay(payload), 500);
        }
      }, 1200);
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

  // ------------------------------------------------------------
  // カットイン演出（フェーズ5a で旧 play.html から移植）
  //   showActionSplash: アクション種別ごとに大きな演出を出す
  //     ロン/ツモ/リーチ → showCutin（カットイン帯＋老師キャラ＋フラッシュ＋稲妻）
  //     ポン/カン/北     → シンプルなアクションテキスト
  //   showCutin: 帯がスライドイン、老師キャラがズームアップ、テキストがポップ
  // ------------------------------------------------------------
  function showActionSplash(text, type) {
    const splashEl = document.getElementById('action-splash');
    if (!splashEl) return;
    splashEl.innerHTML = '';

    const isMajor = type === 'ron' || type === 'tsumo' || type === 'reach';
    const isRonOrTsumo = type === 'ron' || type === 'tsumo';

    if (isMajor) {
      showCutin(text, type);
    }

    if (isRonOrTsumo) {
      // 画面フラッシュ
      const flash = document.createElement('div');
      flash.style.cssText = `
        position:fixed; inset:0; z-index:241; pointer-events:none;
        background: ${type === 'ron'
          ? 'radial-gradient(circle, rgba(255,80,100,0.9), rgba(255,0,0,0.3) 50%, transparent 80%)'
          : 'radial-gradient(circle, rgba(100,230,255,0.9), rgba(0,200,255,0.3) 50%, transparent 80%)'};
        animation: flash-fade 0.6s ease-out forwards;
      `;
      splashEl.appendChild(flash);

      // 8本の稲妻 SVG
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      const color = type === 'ron' ? '#ff2d55' : '#00e5ff';
      const glowColor = type === 'ron' ? '#ffd700' : '#ffffff';
      let svgPaths = '';
      const bolts = 8;
      for (let i = 0; i < bolts; i++) {
        const angle = (Math.PI * 2 / bolts) * i + Math.random() * 0.3;
        const len = Math.max(window.innerWidth, window.innerHeight) * 0.7;
        let pathData = `M ${cx} ${cy}`;
        const segments = 6;
        for (let j = 1; j <= segments; j++) {
          const t = j / segments;
          const r = len * t;
          const baseX = cx + Math.cos(angle) * r;
          const baseY = cy + Math.sin(angle) * r;
          const perpAngle = angle + Math.PI / 2;
          const offset = (Math.random() - 0.5) * 40 * (1 - t);
          const x = baseX + Math.cos(perpAngle) * offset;
          const y = baseY + Math.sin(perpAngle) * offset;
          pathData += ` L ${x.toFixed(0)} ${y.toFixed(0)}`;
        }
        svgPaths += `<path d="${pathData}" stroke="${color}" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`;
        svgPaths += `<path d="${pathData}" stroke="${glowColor}" stroke-width="1" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="1"/>`;
      }
      const lightning = document.createElement('div');
      lightning.style.cssText = 'position:fixed; inset:0; pointer-events:none; z-index:242;';
      lightning.innerHTML = `<svg width="100%" height="100%" style="filter: drop-shadow(0 0 8px ${color}) drop-shadow(0 0 16px ${color});">${svgPaths}</svg>`;
      lightning.style.animation = 'lightning-flash 0.5s ease-out forwards';
      splashEl.appendChild(lightning);

      // 30個の火花パーティクル
      const sparkContainer = document.createElement('div');
      sparkContainer.style.cssText = 'position:fixed; inset:0; pointer-events:none; z-index:243;';
      for (let i = 0; i < 30; i++) {
        const spark = document.createElement('div');
        const angle = Math.random() * Math.PI * 2;
        const distance = 50 + Math.random() * 250;
        const tx = Math.cos(angle) * distance;
        const ty = Math.sin(angle) * distance;
        spark.style.cssText = `
          position:absolute; left:50%; top:50%;
          width:4px; height:4px;
          background:${color};
          border-radius:50%;
          box-shadow:0 0 8px ${color}, 0 0 16px ${glowColor};
          --tx:${tx}px; --ty:${ty}px;
          animation: spark-fly 0.8s ease-out forwards;
        `;
        sparkContainer.appendChild(spark);
      }
      splashEl.appendChild(sparkContainer);
    }

    // メジャー以外（ポン・カン・北）はシンプルなテキスト
    if (!isMajor) {
      const t = document.createElement('div');
      t.className = `action-splash-text ${type}`;
      t.textContent = text;
      splashEl.appendChild(t);
    }

    // 振動（ハプティクス）
    if (navigator.vibrate) {
      if (type === 'ron') navigator.vibrate([120, 40, 80, 40, 120]);
      else if (type === 'tsumo') navigator.vibrate([100, 50, 200]);
      else if (type === 'reach') navigator.vibrate([60, 30, 100]);
      else navigator.vibrate([50]);
    }

    const finalDuration = isMajor ? 1400 : 900;
    setTimeout(() => { splashEl.innerHTML = ''; }, finalDuration);
  }

  function showCutin(text, type) {
    const cutinEl = document.getElementById('cutin-overlay');
    if (!cutinEl) return;
    cutinEl.innerHTML = '';

    const band = document.createElement('div');
    band.className = `cutin-bg-band ${type}`;
    cutinEl.appendChild(band);
    const topLine = document.createElement('div');
    topLine.className = 'cutin-line top';
    cutinEl.appendChild(topLine);
    const bottomLine = document.createElement('div');
    bottomLine.className = 'cutin-line bottom';
    cutinEl.appendChild(bottomLine);

    const charDiv = document.createElement('div');
    charDiv.className = 'cutin-character';
    charDiv.innerHTML = makeFeverMaster(type);
    cutinEl.appendChild(charDiv);

    const textWrap = document.createElement('div');
    textWrap.className = 'cutin-text-wrap';
    const mainText = document.createElement('div');
    mainText.className = `cutin-main-text ${type}`;
    mainText.textContent = text;
    textWrap.appendChild(mainText);
    const subText = document.createElement('div');
    subText.className = 'cutin-sub-text';
    subText.textContent = '★ FEVER老師 ★';
    textWrap.appendChild(subText);
    cutinEl.appendChild(textWrap);

    setTimeout(() => { cutinEl.innerHTML = ''; }, 1500);
  }

  // ------------------------------------------------------------
  // FEVER 花火（仕様書 7. FEVER 視覚演出）
  //   Canvas ベースで全画面に花火、3 秒間。
  //   isDouble なら W-FEVER!! 表示 + 白金系の色味
  // ------------------------------------------------------------
  let feverAnimId = null;
  let feverLaunchInterval = null;
  function showFeverFireworks(isDouble) {
    const overlay = document.getElementById('fever-overlay');
    const canvas = document.getElementById('fever-canvas');
    if (!overlay || !canvas) return;
    const ctx = canvas.getContext('2d');
    const mainText = document.getElementById('fever-main-text');
    const subText = document.getElementById('fever-sub-text');

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    if (isDouble) {
      mainText.className = 'fever-main-text double';
      mainText.textContent = 'W-FEVER!!';
      subText.textContent = '✨✨ DOUBLE FEVER ✨✨';
    } else {
      mainText.className = 'fever-main-text';
      mainText.textContent = 'FEVER!';
      subText.textContent = '🎰 FEVER START 🎰';
    }

    overlay.classList.add('show');
    if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 200]);

    let particles = [];

    function feverLaunch() {
      const cx = canvas.width / 2 + (Math.random() - 0.5) * canvas.width * 0.8;
      const cy = canvas.height / 2 + (Math.random() - 0.5) * canvas.height * 0.6;
      const cols = isDouble
        ? ['#ffffff', '#ffd700', '#ffec5c', '#fffde7']
        : ['#ff2d55', '#ffd700', '#ff9800', '#ff00aa', '#ffffff', '#00e5ff'];
      const color = cols[Math.floor(Math.random() * cols.length)];
      const count = 60 + Math.floor(Math.random() * 40);
      for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 / count) * i;
        const speed = 3 + Math.random() * 6;
        particles.push({
          x: cx, y: cy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          alpha: 1, color,
          r: 2 + Math.random() * 3,
          decay: 0.015 + Math.random() * 0.01,
        });
      }
    }

    function feverAnim() {
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      particles = particles.filter((p) => p.alpha > 0.02);
      particles.forEach((p) => {
        ctx.globalAlpha = p.alpha;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
        ctx.globalAlpha = 1;
        p.x += p.vx; p.y += p.vy;
        p.vy += 0.08;
        p.vx *= 0.97;
        p.alpha -= p.decay;
      });
      feverAnimId = requestAnimationFrame(feverAnim);
    }

    // 既存タイマーが残っていれば clear（連続発動への保険）
    if (feverLaunchInterval) clearInterval(feverLaunchInterval);
    if (feverAnimId) cancelAnimationFrame(feverAnimId);

    feverLaunch(); feverLaunch(); feverLaunch();
    feverLaunchInterval = setInterval(feverLaunch, 250);
    feverAnim();

    setTimeout(() => {
      clearInterval(feverLaunchInterval);
      cancelAnimationFrame(feverAnimId);
      feverLaunchInterval = null;
      feverAnimId = null;
      overlay.classList.remove('show');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }, 3000);
  }

  // ------------------------------------------------------------
  // チップ移動アニメ（仕様書 13. チップ移動アニメーション）
  //   敗者の行から勝者の行へチップが放物線軌道で飛ぶ。
  //   着弾時に金色の爆発エフェクト＋星型の火花。
  //   1.5秒の演出のあと勝者の行が金色に脈動。
  // ------------------------------------------------------------
  function animateChipMovesInOverlay(payload) {
    if (!payload.chipMoves) return;
    const overlay = document.getElementById('agari-overlay');
    if (!overlay) return;
    // .chip-row 要素を集める。winner = positive, losers = negative
    const rows = overlay.querySelectorAll('.chip-row');
    if (rows.length === 0) return;

    // playerId → row 要素のマップを作る（row 内のテキストから推定）
    const playerRowMap = new Map();
    const playersById = new Map(view.publicState.players.map((p) => [p.id, p]));
    rows.forEach((row) => {
      const nameEl = row.querySelector('.point-name');
      if (!nameEl) return;
      const text = nameEl.textContent.trim();
      for (const [pid, p] of playersById) {
        if (p.name === text) {
          playerRowMap.set(pid, row);
          break;
        }
      }
    });

    // 勝者の playerId を payload.winner から特定
    const winnerId = payload.winner && payload.winner.id;
    const winnerRow = playerRowMap.get(winnerId);
    if (!winnerRow) return;

    // 各敗者から勝者へチップを飛ばす
    const losers = [];
    for (const pid of ['P0', 'P1', 'P2']) {
      if (pid === winnerId) continue;
      const delta = payload.chipMoves[pid] || 0;
      if (delta < 0) {
        const fromRow = playerRowMap.get(pid);
        if (fromRow) losers.push({ pid, count: -delta, fromRow });
      }
    }

    losers.forEach((loser, idx) => {
      const playerIdx = parseInt(loser.pid.slice(1), 10);
      // 各敗者ごとに少しずらして発射
      setTimeout(() => {
        animateChipTransfer(loser.fromRow, winnerRow, loser.count, playerIdx);
      }, idx * 300);
    });
  }

  // 1組（敗者→勝者）のチップ飛行アニメ
  function animateChipTransfer(fromEl, toEl, count, playerIdx) {
    if (!fromEl || !toEl) return;
    const fromRect = fromEl.getBoundingClientRect();
    const toRect = toEl.getBoundingClientRect();
    const colorMap = ['blue', 'green', 'orange'];
    const color = colorMap[playerIdx] || 'blue';

    const blackCount = Math.min(Math.floor(count / 10), 8);
    const colorCount = Math.min(count - blackCount * 10, 15);
    const flyingChips = [];
    for (let i = 0; i < blackCount; i++) flyingChips.push('black');
    for (let i = 0; i < colorCount; i++) flyingChips.push(color);
    while (flyingChips.length > 20) flyingChips.pop();
    while (flyingChips.length < 6) flyingChips.push(color); // 最低6個

    let lastArrivalDelay = 0;

    flyingChips.forEach((chipColor, idx) => {
      const chip = document.createElement('div');
      chip.className = `chip-flying ${chipColor}`;
      const startX = fromRect.left + fromRect.width * (0.3 + Math.random() * 0.5);
      const startY = fromRect.top + fromRect.height / 2 + (Math.random() - 0.5) * 16;
      const endX = toRect.left + toRect.width * (0.3 + Math.random() * 0.5);
      const endY = toRect.top + toRect.height / 2 + (Math.random() - 0.5) * 16;
      const midX = (startX + endX) / 2 + (Math.random() - 0.5) * 60;
      const midY = Math.min(startY, endY) - 120 - Math.random() * 60;

      chip.style.left = startX + 'px';
      chip.style.top = startY + 'px';
      chip.style.opacity = '0';
      chip.style.transform = 'translate(-50%, -50%) scale(0.3) rotate(0deg)';
      chip.style.transition = 'none';
      document.body.appendChild(chip);

      const launchDelay = idx * 60;
      const arcUpTime = 500;
      const arcDownTime = 600;

      setTimeout(() => {
        chip.style.opacity = '1';
        chip.style.transition = `left ${arcUpTime}ms cubic-bezier(0.2, 0.6, 0.4, 1), top ${arcUpTime}ms cubic-bezier(0.2, 0.8, 0.6, 1), transform ${arcUpTime}ms ease-out`;
        chip.style.left = midX + 'px';
        chip.style.top = midY + 'px';
        chip.style.transform = `translate(-50%, -50%) scale(1.5) rotate(${360 + Math.random() * 360}deg)`;
      }, launchDelay);

      setTimeout(() => {
        chip.style.transition = `left ${arcDownTime}ms cubic-bezier(0.6, 0, 0.8, 0.4), top ${arcDownTime}ms cubic-bezier(0.4, 0.2, 0.8, 0.6), transform ${arcDownTime}ms ease-in`;
        chip.style.left = endX + 'px';
        chip.style.top = endY + 'px';
        chip.style.transform = `translate(-50%, -50%) scale(1.8) rotate(${720 + Math.random() * 720}deg)`;
      }, launchDelay + arcUpTime);

      // 飛行中の光の尾
      setTimeout(() => {
        const trailInterval = setInterval(() => {
          const rect = chip.getBoundingClientRect();
          if (rect.left === 0 && rect.top === 0) return;
          const trail = document.createElement('div');
          trail.className = 'chip-trail';
          trail.style.left = (rect.left + rect.width / 2) + 'px';
          trail.style.top = (rect.top + rect.height / 2) + 'px';
          trail.style.color = window.getComputedStyle(chip).color;
          document.body.appendChild(trail);
          setTimeout(() => trail.remove(), 500);
        }, 40);
        setTimeout(() => clearInterval(trailInterval), arcUpTime + arcDownTime - 100);
      }, launchDelay);

      // 着弾時の爆発エフェクト
      const arrivalTime = launchDelay + arcUpTime + arcDownTime;
      setTimeout(() => {
        const rect = chip.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;

        const impact = document.createElement('div');
        impact.className = 'chip-impact';
        impact.style.left = cx + 'px';
        impact.style.top = cy + 'px';
        document.body.appendChild(impact);
        setTimeout(() => impact.remove(), 600);

        // 8本の星型火花
        for (let s = 0; s < 8; s++) {
          const spark = document.createElement('div');
          const angle = (Math.PI * 2 / 8) * s;
          const dist = 30 + Math.random() * 20;
          const sx = Math.cos(angle) * dist;
          const sy = Math.sin(angle) * dist;
          spark.style.cssText = `
            position: fixed;
            left: ${cx}px; top: ${cy}px;
            width: 5px; height: 5px;
            background: #ffd700;
            border-radius: 50%;
            box-shadow: 0 0 6px #ffd700, 0 0 12px #ff8800;
            z-index: 602;
            pointer-events: none;
            transform: translate(-50%, -50%);
            transition: transform 0.5s ease-out, opacity 0.5s ease-out;
          `;
          document.body.appendChild(spark);
          setTimeout(() => {
            spark.style.transform = `translate(calc(-50% + ${sx}px), calc(-50% + ${sy}px)) scale(0.3)`;
            spark.style.opacity = '0';
          }, 10);
          setTimeout(() => spark.remove(), 600);
        }

        chip.style.transition = 'opacity 0.3s, transform 0.3s';
        chip.style.opacity = '0';
        chip.style.transform += ' scale(0.3)';
      }, arrivalTime);

      setTimeout(() => chip.remove(), arrivalTime + 500);
      lastArrivalDelay = Math.max(lastArrivalDelay, arrivalTime);
    });

    // 全チップ到着後、勝者の行が金色に光る
    setTimeout(() => {
      toEl.classList.add('winner-receive-flash');
      setTimeout(() => toEl.classList.remove('winner-receive-flash'), 1800);
    }, lastArrivalDelay - 200);

    if (navigator.vibrate) {
      navigator.vibrate([30, 80, 50, 80, 80, 80, 100]);
    }
  }

  // ------------------------------------------------------------
  // ロン時の振り込み牌の赤点滅
  //   振り込み者の河の DOM 上で、当該牌（基本牌コード一致）に
  //   .loser-discard-flash クラスを付ける。
  //   左右のどちらの対戦相手かを seatLayout で特定し対象の DOM を選ぶ。
  // ------------------------------------------------------------
  function flashLoserDiscard(fromPlayerId, winningTile) {
    if (!view.publicState) return;
    // 自分が振り込んだか、他家か
    const myPlayerId = fm.state.playerId;
    const layout = seatLayout(view.publicState, myPlayerId);
    let containerEl = null;
    if (fromPlayerId === layout.me.id) {
      containerEl = document.getElementById('me-discards');
    } else if (fromPlayerId === layout.leftOpp.id) {
      containerEl = document.querySelector('#opp-left [data-role="discards"]');
    } else if (fromPlayerId === layout.rightOpp.id) {
      containerEl = document.querySelector('#opp-right [data-role="discards"]');
    }
    if (!containerEl) return;
    // 河の最後の牌（= 振り込み牌）を点滅
    const tiles = containerEl.querySelectorAll('.tile');
    if (tiles.length === 0) return;
    const lastTile = tiles[tiles.length - 1];
    lastTile.classList.add('loser-discard-flash');
    setTimeout(() => {
      lastTile.classList.remove('loser-discard-flash');
    }, 1500);
  }

  // オリジナル FEVER 老師キャラ SVG（旧 play.html から）
  function makeFeverMaster(type) {
    const expressions = {
      ron:   { mouth: 'M 90 165 Q 100 178 110 165', brow: '-3', exclaim: '！' },
      tsumo: { mouth: 'M 88 168 Q 100 180 112 168', brow: '0',  exclaim: '★' },
      reach: { mouth: 'M 92 168 L 108 168',         brow: '-1', exclaim: '⚡' },
    };
    const expr = expressions[type] || expressions.tsumo;
    const browTop = 98 + parseInt(expr.brow, 10);
    return `
      <svg viewBox="0 0 200 220" xmlns="http://www.w3.org/2000/svg" style="width:100%; height:100%; filter: drop-shadow(0 4px 12px rgba(0,0,0,0.7));">
        <defs>
          <radialGradient id="bg-rad-${type}" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#ffe680" stop-opacity="0.8"/>
            <stop offset="60%" stop-color="#ffaa00" stop-opacity="0.4"/>
            <stop offset="100%" stop-color="transparent"/>
          </radialGradient>
        </defs>
        <circle cx="100" cy="110" r="100" fill="url(#bg-rad-${type})"/>
        <g stroke="#fff" stroke-width="2" opacity="0.4">
          ${Array.from({ length: 16 }).map((_, i) => {
            const a = (i * Math.PI * 2 / 16);
            const x1 = 100 + Math.cos(a) * 60, y1 = 110 + Math.sin(a) * 60;
            const x2 = 100 + Math.cos(a) * 105, y2 = 110 + Math.sin(a) * 105;
            return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
          }).join('')}
        </g>
        <path d="M 50 200 Q 60 175 80 165 L 100 180 L 120 165 Q 140 175 150 200 Z" fill="#c5002a" stroke="#7a0019" stroke-width="2"/>
        <ellipse cx="100" cy="175" rx="22" ry="14" fill="#f8d8a8"/>
        <ellipse cx="100" cy="125" rx="55" ry="60" fill="#fae0b5"/>
        <ellipse cx="100" cy="125" rx="55" ry="60" fill="none" stroke="#c9956c" stroke-width="1.5"/>
        <ellipse cx="100" cy="75"  rx="45" ry="35" fill="#f5d4a0"/>
        <path d="M 50 90 Q 45 100 48 115 Q 52 120 60 118 Q 55 105 58 92 Z" fill="#fff" stroke="#ccc" stroke-width="1"/>
        <path d="M 150 90 Q 155 100 152 115 Q 148 120 140 118 Q 145 105 142 92 Z" fill="#fff" stroke="#ccc" stroke-width="1"/>
        <path d="M 70 102 Q 78 ${browTop} 88 102 Q 82 105 70 105 Z" fill="#fff" stroke="#ccc" stroke-width="0.8"/>
        <path d="M 112 102 Q 122 ${browTop} 130 102 Q 118 105 112 105 Z" fill="#fff" stroke="#ccc" stroke-width="0.8"/>
        <circle cx="79"  cy="120" r="14" fill="#2a2a2a" stroke="#1a1a1a" stroke-width="2"/>
        <circle cx="121" cy="120" r="14" fill="#2a2a2a" stroke="#1a1a1a" stroke-width="2"/>
        <line x1="93" y1="120" x2="107" y2="120" stroke="#1a1a1a" stroke-width="2"/>
        <path d="M 100 130 Q 95 145 98 152 Q 100 154 102 152 Q 105 145 100 130" fill="#e8c090" stroke="#c9956c" stroke-width="1"/>
        <path d="M 78 158 Q 85 160 92 158 Q 95 162 100 161 Q 105 162 108 158 Q 115 160 122 158 Q 120 155 110 156 Q 105 155 100 155 Q 95 155 90 156 Q 80 155 78 158 Z" fill="#fff" stroke="#ccc" stroke-width="0.8"/>
        <path d="${expr.mouth}" fill="none" stroke="#7a0019" stroke-width="2.5" stroke-linecap="round"/>
        <path d="M 80 178 Q 75 195 78 215 Q 88 218 92 210 Q 95 200 92 185 Z" fill="#fff" stroke="#ccc" stroke-width="0.8"/>
        <path d="M 120 178 Q 125 195 122 215 Q 112 218 108 210 Q 105 200 108 185 Z" fill="#fff" stroke="#ccc" stroke-width="0.8"/>
        <text x="160" y="50" font-family="Bungee, sans-serif" font-size="36" fill="#ffd700" stroke="#c5002a" stroke-width="2" font-weight="900">${expr.exclaim}</text>
      </svg>
    `;
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
