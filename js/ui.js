/* ===================================================================
   ui.js — rendering, routing, and event wiring. Depends on model.js.
   =================================================================== */

const UI = (() => {
  const app = () => document.getElementById('app');
  const modalRoot = () => document.getElementById('modalRoot');

  function rerender() { route(); }

  function closeModal() { modalRoot().innerHTML = ''; }
  function openModal(html) {
    modalRoot().innerHTML = `<div class="modal-backdrop" data-close="1"><div class="modal-card">${html}</div></div>`;
    modalRoot().querySelector('.modal-backdrop').addEventListener('click', e => { if (e.target.dataset.close) closeModal(); });
  }

  /* ---------------- router ---------------- */
  function route() {
    const hash = location.hash.replace(/^#\/?/, '');
    const parts = hash.split('/').filter(Boolean);
    highlightTab(parts[0] || 'games');
    const state = Store.get();
    document.getElementById('teamNameLabel').textContent = state.settings.teamName;
    if (parts[0] === 'games' && parts[1]) renderGameDetail(state, parts[1]);
    else if (parts[0] === 'roster') renderRoster(state);
    else if (parts[0] === 'stats') renderStats(state);
    else if (parts[0] === 'settings') renderSettings(state);
    else renderGamesList(state);
  }
  function highlightTab(tab) {
    document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
  }

  /* ---------------- Roster ---------------- */
  function renderRoster(state) {
    const rows = state.roster.map(p => {
      const chips = Positions.fieldSlots(4).map(pos => {
        const on = p.preferred.includes(pos);
        return `<button class="chip ${on ? 'chip-on' : ''}" data-act="pref" data-pid="${p.id}" data-pos="${pos}">${pos}</button>`;
      }).join('');
      return `<tr class="${p.active ? '' : 'row-inactive'}">
        <td class="col-name"><input class="inline-input" data-act="rename" data-pid="${p.id}" value="${Util.esc(p.name)}"></td>
        <td class="col-check"><input type="checkbox" data-act="canPitch" data-pid="${p.id}" ${p.canPitch ? 'checked' : ''}></td>
        <td class="col-check"><input type="checkbox" data-act="canCatch" data-pid="${p.id}" ${p.canCatch ? 'checked' : ''}></td>
        <td class="col-prefs">${chips}</td>
        <td class="col-check"><input type="checkbox" data-act="active" data-pid="${p.id}" ${p.active ? 'checked' : ''}></td>
        <td><button class="btn-icon danger" data-act="delete" data-pid="${p.id}" title="Remove player">✕</button></td>
      </tr>`;
    }).join('');

    app().innerHTML = `
      <section class="card">
        <h2>Roster</h2>
        <p class="muted">Check "Pitch" / "Catch" for kids eligible at those spots. Click position chips to mark desired positions — used as a tiebreaker when innings are otherwise balanced.</p>
        <div class="table-wrap">
        <table class="roster-table">
          <thead><tr><th>Name</th><th>Pitch</th><th>Catch</th><th>Preferred positions</th><th>Active</th><th></th></tr></thead>
          <tbody>${rows || `<tr><td colspan="6" class="muted">No players yet — add your roster below.</td></tr>`}</tbody>
        </table>
        </div>
        <form id="addPlayerForm" class="inline-form">
          <input type="text" id="newPlayerName" placeholder="New player name" required>
          <button class="btn" type="submit">Add Player</button>
        </form>
      </section>`;

    app().querySelectorAll('[data-act="pref"]').forEach(btn => btn.addEventListener('click', () => {
      const p = Util.byId(state.roster, btn.dataset.pid); const pos = btn.dataset.pos;
      const i = p.preferred.indexOf(pos);
      if (i >= 0) p.preferred.splice(i, 1); else p.preferred.push(pos);
      Store.save(); rerender();
    }));
    app().querySelectorAll('[data-act="rename"]').forEach(inp => inp.addEventListener('change', () => {
      Util.byId(state.roster, inp.dataset.pid).name = inp.value.trim() || 'Unnamed'; Store.save(); rerender();
    }));
    app().querySelectorAll('[data-act="canPitch"],[data-act="canCatch"],[data-act="active"]').forEach(inp => inp.addEventListener('change', () => {
      Util.byId(state.roster, inp.dataset.pid)[inp.dataset.act] = inp.checked; Store.save();
    }));
    app().querySelectorAll('[data-act="delete"]').forEach(btn => btn.addEventListener('click', () => {
      if (!confirm('Remove this player from the roster? Past game records that reference them are kept.')) return;
      state.roster = state.roster.filter(p => p.id !== btn.dataset.pid); Store.save(); rerender();
    }));
    document.getElementById('addPlayerForm').addEventListener('submit', e => {
      e.preventDefault();
      const input = document.getElementById('newPlayerName');
      state.roster.push({ id: Util.uid('p'), name: input.value.trim(), active: true, canPitch: false, canCatch: false, preferred: [], notes: '' });
      Store.save(); rerender();
    });
  }

  /* ---------------- Games list ---------------- */
  function renderGamesList(state) {
    const games = [...state.games].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const rows = games.map(g => {
      const presentCount = Object.values(g.attendance).filter(a => a.in).length;
      return `<tr class="clickable" data-goto="games/${g.id}">
        <td>${Util.esc(g.date || '—')}</td><td>${Util.esc(g.opponent || '(opponent TBD)')}</td>
        <td>${g.innings}</td><td>${presentCount}</td>
        <td><span class="badge badge-${g.status}">${g.status}</span></td>
        <td><button class="btn-icon danger" data-act="delGame" data-gid="${g.id}" title="Delete game">✕</button></td>
      </tr>`;
    }).join('');
    app().innerHTML = `
      <section class="card">
        <div class="row-between"><h2>Games</h2><button id="newGameBtn" class="btn">+ New Game</button></div>
        <div class="table-wrap">
        <table class="roster-table">
          <thead><tr><th>Date</th><th>Opponent</th><th>Innings</th><th>Present</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows || `<tr><td colspan="6" class="muted">No games yet.</td></tr>`}</tbody>
        </table>
        </div>
      </section>
      ${renderCarryoverNotice(state)}`;
    app().querySelectorAll('[data-goto]').forEach(tr => tr.addEventListener('click', e => {
      if (e.target.closest('[data-act]')) return;
      location.hash = '#/' + tr.dataset.goto;
    }));
    app().querySelectorAll('[data-act="delGame"]').forEach(btn => btn.addEventListener('click', e => {
      e.stopPropagation();
      if (!confirm('Delete this game permanently? This removes its record from season stats.')) return;
      state.games = state.games.filter(g => g.id !== btn.dataset.gid); Store.save(); rerender();
    }));
    document.getElementById('newGameBtn').addEventListener('click', () => openNewGameModal(state));
  }

  function renderCarryoverNotice(state) {
    const entries = Object.entries(state.carryover || {}).filter(([, v]) => v && v.owedSitInnings);
    if (!entries.length) return '';
    const names = entries.map(([pid]) => (Util.byId(state.roster, pid) || {}).name || pid).join(', ');
    return `<section class="card notice">
      <strong>Carryover:</strong> ${Util.esc(names)} pitched a full game without meeting the bench minimum — they'll be seated for inning 1 of their next game automatically.
    </section>`;
  }

  function openNewGameModal(state) {
    const activePlayers = state.roster.filter(p => p.active);
    const checks = activePlayers.map(p => `
      <label class="attend-row"><input type="checkbox" class="attend-check" data-pid="${p.id}" checked> ${Util.esc(p.name)}</label>
    `).join('');
    openModal(`
      <h3>New Game</h3>
      <form id="newGameForm">
        <label>Date <input type="date" name="date" value="${Util.todayISO()}"></label>
        <label>Opponent <input type="text" name="opponent" placeholder="e.g. Cubs"></label>
        <label>Innings <input type="number" name="innings" min="1" max="12" value="${state.settings.defaultInnings}"></label>
        <label>Outfielders
          <select name="outfieldCount"><option value="3" ${state.settings.outfieldCount === 3 ? 'selected' : ''}>3</option><option value="4" ${state.settings.outfieldCount === 4 ? 'selected' : ''}>4</option></select>
        </label>
        <fieldset><legend>Who's here today?</legend><div class="attend-grid">${checks || '<span class="muted">Add players to the roster first.</span>'}</div></fieldset>
        <div class="modal-actions">
          <button type="button" class="btn ghost" data-close="1">Cancel</button>
          <button type="submit" class="btn primary">Create Game</button>
        </div>
      </form>`);
    document.getElementById('newGameForm').addEventListener('submit', e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const innings = Math.max(1, parseInt(fd.get('innings'), 10) || state.settings.defaultInnings);
      const outfieldCount = parseInt(fd.get('outfieldCount'), 10) === 4 ? 4 : 3;
      const game = {
        id: Util.uid('g'), date: fd.get('date'), opponent: fd.get('opponent'),
        innings, outfieldCount, status: 'planning', currentInning: 1,
        attendance: {}, assignments: {}, locks: {}
      };
      activePlayers.forEach(p => {
        const checked = e.target.querySelector(`.attend-check[data-pid="${p.id}"]`).checked;
        game.attendance[p.id] = { in: checked, fromInning: 1, toInning: innings };
      });
      Engine.applyCarryoverToNewGame(state, game);
      state.games.push(game);
      Engine.applyRecompute(state, game.id);
      Store.save();
      closeModal();
      location.hash = '#/games/' + game.id;
    });
  }

  /* ---------------- Game detail ---------------- */
  function renderGameDetail(state, gameId) {
    const game = Util.byId(state.games, gameId);
    if (!game) { renderGamesList(state); return; }
    Engine.applyRecompute(state, gameId);
    const issues = Engine.validateGame(state, gameId);
    const roster = state.roster;
    const everPresentIds = roster.filter(p => Object.keys(game.assignments).some(i => game.assignments[i][p.id])
      || (game.attendance[p.id] && game.attendance[p.id].in)).map(p => p.id);
    const stats = game._lastStats || {};

    const attendanceRows = roster.filter(p => p.active).map(p => {
      const a = Engine.attendanceOf(game, p.id);
      let extra = '';
      if (game.status !== 'planning') {
        if (a.in && a.toInning === game.innings && a.toInning >= game.currentInning) {
          extra = `<button class="link-btn" data-act="leaveEarly" data-pid="${p.id}">left game</button>`;
        } else if (!a.in) {
          extra = `<button class="link-btn" data-act="lateAdd" data-pid="${p.id}">add now (inning ${game.currentInning})</button>`;
        } else if (a.in && a.toInning < game.innings) {
          extra = `<span class="muted small">left after inning ${a.toInning}</span>`;
        }
      }
      return `<label class="attend-row"><input type="checkbox" class="attend-check" data-pid="${p.id}" ${a.in ? 'checked' : ''} ${game.status !== 'planning' ? 'disabled' : ''}> ${Util.esc(p.name)}</label>${extra}`;
    }).join('');

    const slots = Positions.fieldSlots(game.outfieldCount);
    const inningCols = [];
    for (let i = 1; i <= game.innings; i++) inningCols.push(i);

    const headerRow = `<tr><th class="sticky-col">Player</th>${inningCols.map(i => `<th class="${i === game.currentInning && game.status === 'live' ? 'col-current' : ''}">Inn ${i}${i < game.currentInning ? ' ✓' : ''}</th>`).join('')}<th>INF</th><th>OUT</th><th>BAT</th><th>BN</th></tr>`;

    const bodyRows = everPresentIds.map(pid => {
      const player = Util.byId(roster, pid);
      const cells = inningCols.map(i => {
        const present = Engine.presentDuring(game, pid, i);
        if (!present) return `<td class="cell-na">–</td>`;
        const pos = (game.assignments[i] || {})[pid] || 'BN';
        const locked = !!((game.locks[i] || {})[pid]);
        const group = Positions.groupOf(pos);
        const isCurrent = i === game.currentInning && game.status === 'live';
        return `<td class="cell-pos grp-${group} ${isCurrent ? 'col-current' : ''}">
          <select class="pos-select" data-act="setPos" data-pid="${pid}" data-inning="${i}">
            <option value="__auto__">Auto</option>
            ${Positions.allPositions(game.outfieldCount).map(s => `<option value="${s}" ${s === pos ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
          ${locked ? '<span class="pin" title="Manually set">📌</span>' : ''}
        </td>`;
      }).join('');
      const s = stats[pid] || Engine.emptyLine();
      return `<tr><td class="sticky-col">${Util.esc(player ? player.name : pid)}</td>${cells}<td>${s.infield}</td><td>${s.outfield}</td><td>${s.battery}</td><td>${s.bench}</td></tr>`;
    }).join('');

    const currentPitcher = game.status === 'live' ? Object.entries(game.assignments[game.currentInning] || {}).find(([, pos]) => pos === 'P') : null;
    const nextInningExists = game.currentInning + 1 <= game.innings;

    const liveControls = game.status === 'planning' ? `
      <button id="startGameBtn" class="btn primary">▶ Start Game</button>` :
      game.status === 'live' ? `
      <div class="live-bar">
        <div><strong>Live — Inning ${game.currentInning} of ${game.innings}</strong></div>
        ${currentPitcher && nextInningExists ? `<button class="btn" id="keepPitchingBtn" data-pid="${currentPitcher[0]}">Keep ${Util.esc((Util.byId(roster, currentPitcher[0]) || {}).name || '')} pitching next inning</button>` : ''}
        <button class="btn" id="addInningBtn">+ Add extra inning</button>
        ${game.currentInning < game.innings ? `<button class="btn primary" id="advanceBtn">Advance to Inning ${game.currentInning + 1} →</button>` : ''}
        <button class="btn ${game.currentInning < game.innings ? 'ghost' : 'primary'}" id="finalizeBtn">Finalize Game</button>
      </div>` :
      `<div class="live-bar"><span class="badge badge-final">Final</span></div>`;

    app().innerHTML = `
      <section class="card">
        <div class="row-between">
          <div>
            <h2>${Util.esc(game.opponent || 'Game')} <span class="muted">— ${Util.esc(game.date || '')}</span></h2>
            <span class="badge badge-${game.status}">${game.status}</span>
          </div>
          <button class="btn ghost" id="recomputeBtn">↻ Recompute recommendations</button>
        </div>
        ${liveControls}
      </section>

      <section class="card">
        <h3>Who's here</h3>
        <div class="attend-grid">${attendanceRows}</div>
      </section>

      ${issues.length ? `<section class="card issues">
        <h3>Rule check</h3>
        <ul>${issues.map(i => `<li class="issue-${i.level}">${Util.esc(i.msg)}</li>`).join('')}</ul>
      </section>` : `<section class="card issues-ok">✓ No rule issues detected right now.</section>`}

      <section class="card">
        <h3>Lineup</h3>
        <div class="legend">
          <span class="legend-item grp-infield">Infield</span>
          <span class="legend-item grp-outfield">Outfield</span>
          <span class="legend-item grp-battery">Battery (P/C)</span>
          <span class="legend-item grp-bench">Bench</span>
        </div>
        <div class="table-wrap">
          <table class="lineup-table">
            <thead>${headerRow}</thead>
            <tbody>${bodyRows || `<tr><td class="muted">Nobody marked present yet.</td></tr>`}</tbody>
          </table>
        </div>
      </section>`;

    wireGameDetailEvents(state, game);
  }

  function wireGameDetailEvents(state, game) {
    app().querySelectorAll('.attend-check').forEach(inp => inp.addEventListener('change', () => {
      game.attendance[inp.dataset.pid] = { in: inp.checked, fromInning: 1, toInning: game.innings };
      Engine.applyRecompute(state, game.id); Store.save(); rerender();
    }));
    app().querySelectorAll('[data-act="lateAdd"]').forEach(btn => btn.addEventListener('click', () => {
      game.attendance[btn.dataset.pid] = { in: true, fromInning: game.currentInning, toInning: game.innings };
      Engine.applyRecompute(state, game.id); Store.save(); rerender();
    }));
    app().querySelectorAll('[data-act="leaveEarly"]').forEach(btn => btn.addEventListener('click', () => {
      const a = Engine.attendanceOf(game, btn.dataset.pid);
      a.toInning = Math.max(a.fromInning - 1, game.currentInning - 1);
      game.attendance[btn.dataset.pid] = a;
      Engine.applyRecompute(state, game.id); Store.save(); rerender();
    }));
    app().querySelectorAll('[data-act="setPos"]').forEach(sel => sel.addEventListener('change', () => {
      const pid = sel.dataset.pid, inning = sel.dataset.inning, val = sel.value;
      game.assignments[inning] = game.assignments[inning] || {};
      game.locks[inning] = game.locks[inning] || {};
      if (val === '__auto__') { delete game.assignments[inning][pid]; delete game.locks[inning][pid]; }
      else { game.assignments[inning][pid] = val; game.locks[inning][pid] = true; }
      Engine.applyRecompute(state, game.id); Store.save(); rerender();
    }));
    const recomputeBtn = document.getElementById('recomputeBtn');
    if (recomputeBtn) recomputeBtn.addEventListener('click', () => { Store.save(); rerender(); });
    const startBtn = document.getElementById('startGameBtn');
    if (startBtn) startBtn.addEventListener('click', () => { game.status = 'live'; Engine.applyRecompute(state, game.id); Store.save(); rerender(); });
    const advanceBtn = document.getElementById('advanceBtn');
    if (advanceBtn) advanceBtn.addEventListener('click', () => {
      game.currentInning += 1;
      Engine.applyRecompute(state, game.id); Store.save(); rerender();
    });
    const finalizeBtn = document.getElementById('finalizeBtn');
    if (finalizeBtn) finalizeBtn.addEventListener('click', () => {
      if (!confirm('Finalize this game? You can still edit it afterward if you need to correct the record.')) return;
      Engine.finalizeGame(state, game.id); Store.save(); rerender();
    });
    const addInningBtn = document.getElementById('addInningBtn');
    if (addInningBtn) addInningBtn.addEventListener('click', () => {
      const prev = game.innings;
      game.innings += 1;
      Object.values(game.attendance).forEach(a => { if (a.toInning === prev) a.toInning = game.innings; });
      Engine.applyRecompute(state, game.id); Store.save(); rerender();
    });
    const keepBtn = document.getElementById('keepPitchingBtn');
    if (keepBtn) keepBtn.addEventListener('click', () => {
      const next = game.currentInning + 1;
      game.assignments[next] = game.assignments[next] || {};
      game.locks[next] = game.locks[next] || {};
      game.assignments[next][keepBtn.dataset.pid] = 'P';
      game.locks[next][keepBtn.dataset.pid] = true;
      Engine.applyRecompute(state, game.id); Store.save(); rerender();
    });
  }

  /* ---------------- Season stats ---------------- */
  function renderStats(state) {
    const stats = Engine.seasonStatsExcluding(state, null);
    const rows = state.roster.map(p => {
      const s = stats[p.id] || Engine.emptyLine();
      const gamesPlayed = state.games.filter(g => Engine.presentDuring(g, p.id, 1) || Object.keys(g.assignments).some(i => (g.assignments[i] || {})[p.id])).length;
      return `<tr class="${p.active ? '' : 'row-inactive'}">
        <td>${Util.esc(p.name)}</td><td>${gamesPlayed}</td><td>${s.innings}</td>
        <td>${s.infield} <span class="muted">(${Util.pct(s.infield / (s.innings || 1))})</span></td>
        <td>${s.outfield} <span class="muted">(${Util.pct(s.outfield / (s.innings || 1))})</span></td>
        <td>${s.battery} <span class="muted">(${Util.pct(s.battery / (s.innings || 1))})</span></td>
        <td>${s.bench} <span class="muted">(${Util.pct(s.bench / (s.innings || 1))})</span></td>
      </tr>`;
    }).join('');
    app().innerHTML = `
      <section class="card">
        <h2>Season Stats</h2>
        <p class="muted">Cumulative record across all games (only innings already played count). This is the source the recommendation engine uses to keep everyone's fractional playing time balanced over the season.</p>
        <div class="table-wrap">
        <table class="roster-table">
          <thead><tr><th>Player</th><th>Games</th><th>Def. Innings</th><th>Infield</th><th>Outfield</th><th>Battery</th><th>Bench</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="7" class="muted">No data yet.</td></tr>`}</tbody>
        </table>
        </div>
      </section>`;
  }

  /* ---------------- Settings ---------------- */
  function renderSettings(state) {
    const cfg = Sync.getConfig();
    app().innerHTML = `
      <section class="card">
        <h2>Settings</h2>
        <form id="settingsForm" class="settings-form">
          <label>Team name <input type="text" name="teamName" value="${Util.esc(state.settings.teamName)}"></label>
          <label>Default innings per game <input type="number" name="defaultInnings" min="1" max="12" value="${state.settings.defaultInnings}"></label>
          <label>Default outfielders
            <select name="outfieldCount"><option value="3" ${state.settings.outfieldCount === 3 ? 'selected' : ''}>3</option><option value="4" ${state.settings.outfieldCount === 4 ? 'selected' : ''}>4</option></select>
          </label>
          <button class="btn primary" type="submit">Save</button>
        </form>
      </section>
      <section class="card">
        <h3>Multi-Coach Sync</h3>
        <p class="muted">The team's roster, games, and lineups are shared through this app's GitHub repo (<code>${Util.esc(cfg.owner)}/${Util.esc(cfg.repo)}</code>). Anyone who opens this page automatically sees the latest shared copy — no setup needed. To <strong>publish</strong> your own changes so other coaches see them, add a GitHub token below.</p>
        <p id="syncStatusLine" class="muted"></p>
        <form id="syncForm" class="settings-form">
          <label>GitHub token (for publishing)
            <input type="password" name="token" placeholder="github_pat_…" value="${Util.esc(cfg.token)}" autocomplete="off">
          </label>
          <p class="muted small">Create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token</a>: under "Repository access" pick only <code>${Util.esc(cfg.repo)}</code>, and under "Permissions → Repository permissions" set <strong>Contents: Read and write</strong>. Nothing else. The token stays in this browser only — it's never sent anywhere but GitHub and never included in exports.</p>
          <div class="btn-row">
            <button class="btn primary" type="submit">Save token</button>
            <button class="btn" type="button" id="pullNowBtn">⬇ Pull latest shared data</button>
            <button class="btn" type="button" id="pushNowBtn">⬆ Publish my changes now</button>
          </div>
        </form>
        <p class="muted small">Without a token, changes you make here stay in this browser only and are replaced whenever newer shared data arrives.</p>
      </section>
      <section class="card">
        <h3>Backup &amp; Transfer</h3>
        <p class="muted">Download a snapshot of the data, or load one from a file. Importing only affects this browser — use "Publish my changes now" above if you want it shared with the team.</p>
        <div class="btn-row">
          <button class="btn" id="exportBtn">⬇ Export JSON</button>
          <label class="btn" for="importFile">⬆ Import JSON</label>
          <input type="file" id="importFile" accept="application/json" style="display:none">
        </div>
      </section>
      <section class="card danger-zone">
        <h3>Danger Zone</h3>
        <p class="muted small">Clears this browser only. The shared team copy on GitHub is untouched and will be pulled back in on the next sync.</p>
        <button class="btn danger" id="resetBtn">Erase local data</button>
      </section>`;

    document.getElementById('settingsForm').addEventListener('submit', e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      state.settings.teamName = fd.get('teamName').trim() || 'Team';
      state.settings.defaultInnings = Math.max(1, parseInt(fd.get('defaultInnings'), 10) || 6);
      state.settings.outfieldCount = parseInt(fd.get('outfieldCount'), 10) === 4 ? 4 : 3;
      Store.save(); rerender();
    });
    document.getElementById('exportBtn').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `rockies-lineup-backup-${Util.todayISO()}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    });
    document.getElementById('importFile').addEventListener('change', e => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result);
          if (!confirm('Import will replace all current data in this browser. Continue?')) return;
          Store.replaceAll(parsed); rerender();
        } catch (err) { alert('Could not read that file as valid backup JSON.'); }
      };
      reader.readAsText(file);
    });
    document.getElementById('resetBtn').addEventListener('click', () => {
      if (!confirm('This erases roster, game, and stats data in this browser (the shared GitHub copy is not affected). Export a backup first if unsure. Continue?')) return;
      Store.replaceAll(Store.defaultState()); rerender();
    });
    document.getElementById('syncForm').addEventListener('submit', e => {
      e.preventDefault();
      Sync.saveConfig({ token: new FormData(e.target).get('token').trim() });
      Sync.syncOnce(true);
      rerender();
    });
    document.getElementById('pullNowBtn').addEventListener('click', async () => {
      const remote = await Sync.pull();
      if (!remote) { alert('No shared data found on GitHub yet (or the network request failed).'); return; }
      if (!confirm("Replace this browser's data with the shared team copy? Any local changes you haven't published will be lost.")) return;
      Store.replaceAll(remote); rerender();
    });
    document.getElementById('pushNowBtn').addEventListener('click', () => {
      if (!Sync.hasToken()) { alert('Save a GitHub token first — publishing requires one.'); return; }
      Sync.push();
    });
    updateSyncUI();
  }

  /* ---------------- Sync status ---------------- */
  let syncState = { status: 'idle', lastError: '', lastSyncedAt: null };
  function syncLabel() {
    const token = Sync.hasToken();
    switch (syncState.status) {
      case 'pulling': return '⟳ Checking for team updates…';
      case 'pushing': return '⬆ Publishing…';
      case 'synced': return token ? '✓ Synced with team' : '✓ Viewing shared team data (read-only)';
      case 'error': return '⚠ Sync problem: ' + syncState.lastError;
      case 'no-token': return '⚠ Add a token in Settings to publish';
      default: return token ? 'Waiting to sync…' : 'Not connected to shared data yet';
    }
  }
  function updateSyncUI() {
    const label = syncLabel();
    const badge = document.getElementById('syncBadge');
    if (badge) { badge.textContent = label; badge.className = 'sync-badge sync-' + syncState.status; }
    const line = document.getElementById('syncStatusLine');
    if (line) line.textContent = label;
  }
  function initSync() {
    Sync.onStatus(s => { syncState = s; updateSyncUI(); });
    Sync.init(() => rerender());
  }

  return { route, initSync };
})();

window.addEventListener('hashchange', UI.route);
window.addEventListener('DOMContentLoaded', () => {
  if (!location.hash) location.hash = '#/games';
  UI.route();
  UI.initSync();
});
