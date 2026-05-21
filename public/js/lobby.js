// ============================================================
// public/js/lobby.js
// ロビー画面の操作（部屋作成・参加・待機）を制御するクライアントロジック。
// socket-client.js が公開している window.feverMj API を経由してサーバーと通信。
// ============================================================
// 画面（ビュー）は同一 HTML 上に4種類あり、CSS の .active クラスで切り替える:
//   #view-menu     : メニュー（作る/入る選択）
//   #view-create   : 部屋作成フォーム
//   #view-join     : 部屋参加フォーム
//   #view-waiting  : 待機中（1/3, 2/3 表示）
//   #view-game     : 対局開始通知（仮）
// ============================================================

(function () {
  const $ = (sel) => document.querySelector(sel);
  const fm = window.feverMj;

  // ===== ビュー切替 =====
  const VIEWS = ['view-menu', 'view-create', 'view-join', 'view-solo', 'view-waiting', 'view-game'];
  function showView(id) {
    for (const v of VIEWS) {
      const el = document.getElementById(v);
      if (!el) continue;
      el.classList.toggle('active', v === id);
    }
  }

  // ===== トースト通知 =====
  let toastTimer = null;
  function toast(message, type = 'info') {
    const el = $('#toast');
    if (!el) return;
    el.textContent = message;
    el.className = 'toast show ' + type;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.className = 'toast';
    }, 3500);
  }

  // ===== 接続状態の表示 =====
  function setConnStatus(text, ok) {
    const el = $('#conn-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'conn-status ' + (ok ? 'ok' : 'bad');
  }

  // ===== 待機リスト・プレイヤー数の更新 =====
  function updateWaitingView(room, myPlayerId) {
    $('#player-count').textContent = String(room.players.length);
    const list = $('#player-list');
    list.innerHTML = '';
    for (let i = 0; i < 3; i++) {
      const p = room.players[i];
      const li = document.createElement('li');
      li.className = 'player-row';
      if (p) {
        li.classList.add('joined');
        const isMe = p.id === myPlayerId;
        li.innerHTML = `
          <span class="seat">${p.id}</span>
          <span class="pname">${escapeHtml(p.name)}${isMe ? ' <small>（あなた）</small>' : ''}</span>
          <span class="badge ok">参加済</span>
        `;
      } else {
        li.innerHTML = `
          <span class="seat">P${i}</span>
          <span class="pname"><em>待機中…</em></span>
          <span class="badge waiting">空席</span>
        `;
      }
      list.appendChild(li);
    }
  }

  // HTML 注入対策のためのエスケープ
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  }

  // ===== ボタンの紐付け =====
  function bindButtons() {
    // メニュー
    $('#btn-create').addEventListener('click', () => showView('view-create'));
    $('#btn-join').addEventListener('click', () => showView('view-join'));
    $('#btn-solo').addEventListener('click', () => showView('view-solo'));

    // ソロ練習
    $('#solo-submit').addEventListener('click', () => {
      const name = $('#solo-name').value.trim();
      if (!name) { toast('名前を入力してください', 'error'); return; }
      fm.sendCreateSoloRoom({ name });
    });
    $('#solo-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#solo-submit').click();
    });

    // 戻るボタン（全フォーム共通）
    document.querySelectorAll('.btn-back').forEach((btn) => {
      btn.addEventListener('click', () => showView('view-menu'));
    });

    // 部屋作成
    $('#create-submit').addEventListener('click', () => {
      const name = $('#create-name').value.trim();
      const password = $('#create-password').value.trim();
      if (!name || !password) {
        toast('名前と合言葉を入力してください', 'error');
        return;
      }
      fm.sendCreateRoom({ name, password });
    });

    // 部屋参加
    $('#join-submit').addEventListener('click', () => {
      const name = $('#join-name').value.trim();
      const password = $('#join-password').value.trim();
      if (!name || !password) {
        toast('名前と合言葉を入力してください', 'error');
        return;
      }
      fm.sendJoinRoom({ name, password });
    });

    // 退室
    $('#leave').addEventListener('click', () => {
      fm.sendLeaveRoom();
      fm.clearSession();
      showView('view-menu');
      toast('退室しました');
    });

    // Enter キーでフォーム送信
    ['create-name', 'create-password'].forEach((id) => {
      $(`#${id}`).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') $('#create-submit').click();
      });
    });
    ['join-name', 'join-password'].forEach((id) => {
      $(`#${id}`).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') $('#join-submit').click();
      });
    });
  }

  // ===== サーバーイベントの購読 =====
  function bindSocketEvents() {
    fm.on('connected', () => setConnStatus('● 接続OK', true));
    fm.on('disconnected', ({ reason }) => setConnStatus(`× 切断 (${reason})`, false));
    fm.on('connect_error', ({ message }) => setConnStatus(`× ${message}`, false));

    // 部屋作成成功
    fm.on('lobby:room-created', ({ room }) => {
      $('#waiting-title').textContent = '対局メンバー待ち（あなたが部屋を作りました）';
      updateWaitingView(room, fm.state.playerId);
      showView('view-waiting');
      toast(`部屋を作りました（合言葉: ${escapeHtml($('#create-password').value)}）`);
    });

    // 部屋参加成功（新規参加 / 再接続 両方扱う）
    fm.on('lobby:room-joined', ({ room, reconnected }) => {
      if (reconnected) {
        // フェーズ6: 再接続時は対局画面に直接戻る
        showView('view-game');
        toast('再接続しました', 'ok');
        return;
      }
      $('#waiting-title').textContent = '対局メンバー待ち';
      updateWaitingView(room, fm.state.playerId);
      showView('view-waiting');
      toast('部屋に参加しました');
    });

    // 他のメンバーが入ってきた
    fm.on('lobby:player-joined', ({ player, room }) => {
      updateWaitingView(room, fm.state.playerId);
      toast(`${player.name} さんが入室しました`);
    });

    // 誰かが退室した
    fm.on('lobby:player-left', ({ room }) => {
      updateWaitingView(room, fm.state.playerId);
      toast('メンバーが退室しました');
    });

    // エラー
    fm.on('lobby:error', ({ message }) => {
      toast(message, 'error');
    });

    // 3人揃って対局開始 → ビューを切り替える（描画は game.js が担当）
    fm.on('game:start', () => {
      showView('view-game');
      toast('対局開始しました！', 'ok');
    });
  }

  // ===== 初期化 =====
  function init() {
    bindButtons();
    bindSocketEvents();
    showView('view-menu');
    setConnStatus('接続中…', false);
  }

  // DOMContentLoaded を待つ
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
