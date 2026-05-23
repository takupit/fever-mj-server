// ============================================================
// public/js/stats-page.js
// 戦績画面（/stats.html）の動作。
// 1. localStorage から永続プレイヤーID を取り出す
// 2. /api/stats/:id と /api/games/:id を fetch
// 3. 結果を DOM に描画
// ============================================================

(function () {
  const PID_KEY = 'feverMj.persistentPlayerId';

  // HTML 注入対策のエスケープ
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  }

  function fmtDate(timestampMs) {
    if (!timestampMs) return '-';
    const d = new Date(timestampMs);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtSigned(n) {
    if (typeof n !== 'number') return '-';
    if (n > 0) return `+${n}`;
    return String(n);
  }

  // localStorage から ID を取得（無ければ空表示）
  function getPersistentPlayerId() {
    try {
      return localStorage.getItem(PID_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  // 通算戦績を fetch して描画
  async function loadStats(playerId) {
    const body = document.getElementById('stats-body');
    if (!playerId) {
      body.innerHTML = `
        <div class="empty-msg">
          まだ対局していません。<br>
          <a href="/">ロビー</a>から1局プレイすると戦績が記録されます。
        </div>`;
      document.getElementById('player-name').textContent = '（未対局）';
      return;
    }
    try {
      const res = await fetch(`/api/stats/${encodeURIComponent(playerId)}`);
      if (res.status === 404) {
        body.innerHTML = `
          <div class="empty-msg">
            まだ対局していません。<br>
            <a href="/">ロビー</a>から1局プレイすると戦績が記録されます。
          </div>`;
        document.getElementById('player-name').textContent = '（未対局）';
        document.getElementById('player-id').textContent = `ID: ${playerId.slice(0, 8)}...`;
        return;
      }
      if (res.status === 503) {
        body.innerHTML = `<div class="empty-msg">戦績ストアが無効です（サーバー側設定）</div>`;
        return;
      }
      if (!res.ok) {
        body.innerHTML = `<div class="empty-msg">読み込み失敗（HTTP ${res.status}）</div>`;
        return;
      }
      const stats = await res.json();
      document.getElementById('player-name').textContent = stats.name;
      document.getElementById('player-id').textContent = `ID: ${playerId.slice(0, 8)}...`;
      renderStats(body, stats);
    } catch (err) {
      body.innerHTML = `<div class="empty-msg">通信エラー: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderStats(el, s) {
    const winRate = s.totalGames > 0 ? ((s.wins / s.totalGames) * 100).toFixed(1) : '0.0';
    const secondRate = s.totalGames > 0 ? ((s.seconds / s.totalGames) * 100).toFixed(1) : '0.0';
    const thirdRate = s.totalGames > 0 ? ((s.thirds / s.totalGames) * 100).toFixed(1) : '0.0';
    const avgDiff = Math.round(s.avgScoreDiff || 0);
    const scoreClass = s.totalScoreDiff >= 0 ? 'gain' : 'loss';
    const avgClass = avgDiff >= 0 ? 'gain' : 'loss';

    el.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">通算対局数</div>
          <div class="stat-value">${s.totalGames}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">通算点数収支</div>
          <div class="stat-value ${scoreClass}">${fmtSigned(s.totalScoreDiff)}</div>
          <div class="stat-sub">平均 ${fmtSigned(avgDiff)} / 局</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">🥇 1位</div>
          <div class="stat-value">${s.wins} <small style="font-size:13px;">回</small></div>
          <div class="stat-sub">${winRate}%</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">🥈 2位</div>
          <div class="stat-value silver">${s.seconds} <small style="font-size:13px;">回</small></div>
          <div class="stat-sub">${secondRate}%</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">🥉 3位</div>
          <div class="stat-value bronze">${s.thirds} <small style="font-size:13px;">回</small></div>
          <div class="stat-sub">${thirdRate}%</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">💥 トビ回数</div>
          <div class="stat-value loss">${s.tobiCount}</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">🎖 役満</div>
          <div class="stat-value gain">${s.yakumanCount}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">🎰 FEVER</div>
          <div class="stat-value gain">${s.feverCount}</div>
        </div>
      </div>
    `;
  }

  // 直近対局リストを fetch して描画
  async function loadGames(playerId) {
    const body = document.getElementById('games-body');
    if (!playerId) {
      body.innerHTML = `<div class="empty-msg">未対局</div>`;
      return;
    }
    try {
      const res = await fetch(`/api/games/${encodeURIComponent(playerId)}?limit=20`);
      if (!res.ok) {
        body.innerHTML = `<div class="empty-msg">読み込み失敗</div>`;
        return;
      }
      const games = await res.json();
      if (!games || games.length === 0) {
        body.innerHTML = `<div class="empty-msg">まだ対局履歴がありません</div>`;
        return;
      }
      renderGames(body, games, playerId);
    } catch (err) {
      body.innerHTML = `<div class="empty-msg">通信エラー: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderGames(el, games, myPlayerId) {
    const wrap = document.createElement('div');
    wrap.className = 'game-list';
    for (const g of games) {
      const myEntry = g.players.find((p) => p.id === myPlayerId);
      if (!myEntry) continue;
      const row = document.createElement('div');
      row.className = 'game-row';
      const others = g.players.filter((p) => p.id !== myPlayerId).map((p) => p.name).join(' / ');
      const endReasonLabel = g.endReason === 'tobi' ? '🚨 トビ' : '🏁 完走';
      row.innerHTML = `
        <span class="game-date">${escapeHtml(fmtDate(g.endedAt))}</span>
        <span class="game-players">
          vs ${escapeHtml(others)}<br>
          <small style="opacity:0.6;">${endReasonLabel}</small>
        </span>
        <span class="my-result">
          <span class="my-rank r${myEntry.rank}">${myEntry.rank}位</span>
          <span class="my-score">${myEntry.score}点</span>
          <div style="font-size:10px; color:rgba(255,255,255,0.5);">${myEntry.chips}💎</div>
        </span>
      `;
      wrap.appendChild(row);
    }
    el.innerHTML = '';
    el.appendChild(wrap);
  }

  // メイン
  const playerId = getPersistentPlayerId();
  loadStats(playerId);
  loadGames(playerId);
})();
