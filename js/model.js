/* ===================================================================
   model.js — data model, storage, and the KNLL rules/recommendation
   engine. No DOM code lives here; ui.js consumes this module.
   =================================================================== */

/* ---------- small utilities ---------- */
const Util = (() => {
  function uid(prefix) {
    return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function todayISO() { return new Date().toISOString().slice(0, 10); }
  function pct(n) { return isFinite(n) ? Math.round(n * 100) + '%' : '—'; }
  function byId(arr, id) { return (arr || []).find(x => x.id === id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  return { uid, clone, todayISO, pct, byId, esc };
})();

/* ---------- position constants ---------- */
const Positions = {
  BENCH: 'BN',
  battery: ['P', 'C'],
  infield: ['1B', '2B', '3B', 'SS'],
  outfield3: ['LF', 'CF', 'RF'],
  outfield4: ['LF', 'LC', 'RC', 'RF'],
  fieldSlots(outfieldCount) {
    return [...this.battery, ...this.infield, ...(outfieldCount >= 4 ? this.outfield4 : this.outfield3)];
  },
  allPositions(outfieldCount) {
    return [...this.fieldSlots(outfieldCount), this.BENCH];
  },
  groupOf(pos) {
    if (!pos || pos === 'BN') return 'bench';
    if (pos === 'P' || pos === 'C') return 'battery';
    if (this.infield.includes(pos)) return 'infield';
    return 'outfield';
  },
  label(pos) {
    const map = { P: 'Pitcher', C: 'Catcher', '1B': 'First Base', '2B': 'Second Base', '3B': 'Third Base', SS: 'Shortstop', LF: 'Left Field', CF: 'Center Field', RF: 'Right Field', LC: 'Left-Center', RC: 'Right-Center', BN: 'Bench' };
    return map[pos] || pos;
  }
};

/* ---------- persistence ---------- */
const Store = (() => {
  const KEY = 'rockiesLineupData_v1';

  // Only used to populate the roster on the very first load (no saved data yet) —
  // after that, the roster is whatever's in localStorage, and "Erase all data" in
  // Settings wipes to a truly empty roster rather than resetting back to this list.
  const SEED_ROSTER_NAMES = [
    'Peter Bartels', 'Chase Carlberg', 'Landon Conrad', 'Lennox Dixon', 'Brady Doton',
    'Haruki Kaninworapan', 'Cooper Kweon', 'Jack Levering', 'Jerry North', 'Perry Smith',
    'Luca Tidwell', 'Brayden Vagt', 'Wesley Wegener'
  ];
  function seedRoster() {
    return SEED_ROSTER_NAMES.map(name => ({
      id: Util.uid('p'), name, active: true, canPitch: false, canCatch: false, preferred: [], notes: ''
    }));
  }

  function defaultState() {
    return {
      version: 1,
      settings: { teamName: 'Fall Rockies', defaultInnings: 6, outfieldCount: 3 },
      roster: [],
      games: [],
      carryover: {} // pid -> { owedSitInnings }
    };
  }

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) { const s = defaultState(); s.roster = seedRoster(); return s; }
      const parsed = JSON.parse(raw);
      const merged = Object.assign(defaultState(), parsed);
      merged.settings = Object.assign(defaultState().settings, parsed.settings || {});
      return merged;
    } catch (e) {
      console.error('Failed to load saved data, starting fresh.', e);
      return defaultState();
    }
  }

  function save() { localStorage.setItem(KEY, JSON.stringify(state)); }
  function get() { return state; }
  function replaceAll(newState) { state = Object.assign(defaultState(), newState); save(); }

  return { get, save, replaceAll, defaultState, KEY };
})();

/* ---------- rules engine ---------- */
const Engine = (() => {

  function attendanceOf(game, pid) {
    return game.attendance[pid] || { in: false, fromInning: 1, toInning: game.innings };
  }
  function presentDuring(game, pid, inning) {
    const a = attendanceOf(game, pid);
    return !!a.in && inning >= a.fromInning && inning <= a.toInning;
  }
  function isStarter(game, pid) {
    const a = attendanceOf(game, pid);
    return !!a.in && a.fromInning === 1;
  }

  function emptyLine() { return { infield: 0, outfield: 0, battery: 0, bench: 0, pitcher: 0, catcher: 0, innings: 0 }; }

  function addStat(stats, pid, pos) {
    if (!pos) return;
    const s = stats[pid] || (stats[pid] = emptyLine());
    s.innings++;
    s[Positions.groupOf(pos)]++;
    if (pos === 'P') s.pitcher++;
    if (pos === 'C') s.catcher++;
  }

  // Sum only *finalized* innings across games (a live game only counts innings
  // already played; a planning game counts nothing yet). This is what keeps
  // "season stats" an honest record rather than a mix of fact and forecast.
  function seasonStatsExcluding(state, excludeGameId) {
    const stats = {};
    state.games.forEach(g => {
      if (g.id === excludeGameId) return;
      const finalInnings = g.status === 'final' ? g.innings : Math.max(0, g.currentInning - 1);
      for (let inning = 1; inning <= finalInnings; inning++) {
        const a = g.assignments[inning] || {};
        Object.keys(a).forEach(pid => { if (presentDuring(g, pid, inning)) addStat(stats, pid, a[pid]); });
      }
    });
    return stats;
  }

  function seasonFraction(stats, pid, category) {
    const s = stats[pid];
    if (!s || !s.innings) return 0; // no history yet -> most "in need", sorts first
    return s[category] / s.innings;
  }

  function prefBonus(player, posOrGroup) {
    if (!player || !player.preferred || !player.preferred.length) return 0;
    if (player.preferred.includes(posOrGroup)) return 1;
    if (player.preferred.some(p => Positions.groupOf(p) === posOrGroup)) return 0.4;
    return 0;
  }

  /**
   * Recompute a game's full assignment grid.
   * - Innings before game.currentInning are treated as history (already played) and left untouched.
   * - Any cell explicitly locked by the coach is treated as fixed input.
   * - Everything else is filled in by the greedy fairness/rules heuristic below.
   */
  function recomputeGame(state, gameId) {
    const game = Util.byId(state.games, gameId);
    const roster = state.roster;
    const playerById = id => Util.byId(roster, id);
    const seasonStats = seasonStatsExcluding(state, gameId);
    const thisGame = {};
    const slotsAll = Positions.fieldSlots(game.outfieldCount);
    const warnings = [];
    const newAssignments = {};
    let lastPitcher = null;
    let pitcherStreak = 0; // consecutive innings (ending at the previous inning) lastPitcher has thrown

    for (let inning = 1; inning <= game.innings; inning++) {
      const presentIds = roster.filter(p => p.active && presentDuring(game, p.id, inning)).map(p => p.id);
      const isFinal = inning < game.currentInning;
      const existing = game.assignments[inning] || {};
      const locks = game.locks[inning] || {};
      let assign = {};

      if (isFinal) {
        // History is history — never re-decided by the engine.
        presentIds.forEach(pid => { if (existing[pid]) assign[pid] = existing[pid]; });
      } else {
        // Seed with anything the coach explicitly locked.
        presentIds.forEach(pid => { if (locks[pid] && existing[pid]) assign[pid] = existing[pid]; });

        let remaining = presentIds.filter(pid => !assign[pid]);
        const takenSlots = new Set(Object.values(assign).filter(p => p && p !== 'BN'));
        let openSlots = slotsAll.filter(s => !takenSlots.has(s));
        const benchAlready = Object.values(assign).filter(p => p === 'BN').length;
        const benchCapacity = Math.max(0, presentIds.length - slotsAll.length);
        let benchLeft = Math.max(0, benchCapacity - benchAlready);

        // Pitcher exception: a normal single-inning pitching turn does NOT force a sit —
        // that's just ordinary rotation. The mandatory-sit-next-inning consequence only
        // kicks in once a pitcher has actually been kept in for 2+ consecutive innings
        // (i.e. the exception was invoked, usually via "Keep pitching") and is now coming off.
        if (pitcherStreak >= 2 && lastPitcher && remaining.includes(lastPitcher) && assign[lastPitcher] === undefined) {
          assign[lastPitcher] = 'BN';
          remaining = remaining.filter(x => x !== lastPitcher);
          benchLeft = Math.max(0, benchLeft - 1);
        }

        // Infield 2-inning minimum (hard requirement for players present at the start)
        // comes first — it's a hard legal floor and must not be blocked by anything else.
        const innsRemainingTotal = game.innings - inning + 1;
        let urgent = remaining.filter(pid => {
          if (!isStarter(game, pid)) return false;
          const have = (thisGame[pid] && thisGame[pid].infield) || 0;
          const need = 2 - have;
          if (need <= 0) return false;
          const att = attendanceOf(game, pid);
          const inningsLeftForPlayer = Math.min(innsRemainingTotal, att.toInning - inning + 1);
          return need >= inningsLeftForPlayer;
        });
        urgent.sort((a, b) => (2 - ((thisGame[b] && thisGame[b].infield) || 0)) - (2 - ((thisGame[a] && thisGame[a].infield) || 0)));
        urgent.forEach(pid => {
          const infSlots = openSlots.filter(s => Positions.groupOf(s) === 'infield');
          if (!infSlots.length) {
            warnings.push(`Inning ${inning}: ${playerById(pid) ? playerById(pid).name : pid} may miss the 2-infield-inning minimum.`);
            return;
          }
          const player = playerById(pid);
          const slot = infSlots.find(s => player && player.preferred && player.preferred.includes(s)) || infSlots[0];
          assign[pid] = slot;
          openSlots = openSlots.filter(s => s !== slot);
          remaining = remaining.filter(x => x !== pid);
        });

        // Pitcher / catcher come next, before bench selection — canPitch/canCatch
        // eligible kids are usually a scarce subset, and bench selection must not be
        // allowed to sit the only remaining alternative to the current pitcher (that
        // would strand the mound and force an unwanted, unrequested pitcher-exception
        // streak). `avoid` also keeps the auto recommendation from re-picking the same
        // pitcher back-to-back on its own — staying in for a 2nd+ consecutive inning is
        // the pitcher exception, a coach decision (the "keep pitching" lock), not
        // something to auto-invoke, since invoking it carries a mandatory-sit consequence.
        const assignBattery = (posCode, flag, avoid) => {
          if (!openSlots.includes(posCode)) return;
          let cands = remaining.filter(pid => playerById(pid) && playerById(pid)[flag]);
          if (avoid && cands.length > 1) cands = cands.filter(pid => pid !== avoid);
          if (!cands.length) { warnings.push(`Inning ${inning}: no eligible ${Positions.label(posCode).toLowerCase()} available.`); return; }
          cands.sort((a, b) =>
            (seasonFraction(seasonStats, a, 'battery') - prefBonus(playerById(a), posCode) * 0.1) -
            (seasonFraction(seasonStats, b, 'battery') - prefBonus(playerById(b), posCode) * 0.1));
          const pid = cands[0];
          assign[pid] = posCode;
          remaining = remaining.filter(x => x !== pid);
          openSlots = openSlots.filter(s => s !== posCode);
        };
        assignBattery('P', 'canPitch', lastPitcher);
        assignBattery('C', 'canCatch');

        // Bench selection: whoever has sat least so far (this game), then whoever has
        // played the most total innings so far, sits now — keeps the ±1 balance rule.
        if (benchLeft > 0) {
          const pool = [...remaining];
          pool.sort((a, b) => {
            const ba = (thisGame[a] && thisGame[a].bench) || 0, bb = (thisGame[b] && thisGame[b].bench) || 0;
            if (ba !== bb) return ba - bb;
            const pa = (thisGame[a] && thisGame[a].innings) || 0, pb = (thisGame[b] && thisGame[b].innings) || 0;
            if (pa !== pb) return pb - pa;
            return seasonFraction(seasonStats, b, 'innings') - seasonFraction(seasonStats, a, 'innings');
          });
          pool.slice(0, benchLeft).forEach(pid => { assign[pid] = 'BN'; remaining = remaining.filter(x => x !== pid); });
        }

        // Generic fill for the remaining infield/outfield slots: fairness first
        // (lowest season fraction in that group), light nudge toward preference.
        const fillGroup = (group) => {
          let slots = openSlots.filter(s => Positions.groupOf(s) === group);
          if (!slots.length || !remaining.length) return;
          const pool = [...remaining];
          pool.sort((a, b) => {
            const fa = seasonFraction(seasonStats, a, group) - prefBonus(playerById(a), group) * 0.15;
            const fb = seasonFraction(seasonStats, b, group) - prefBonus(playerById(b), group) * 0.15;
            return fa - fb;
          });
          const chosen = pool.slice(0, slots.length);
          const slotsLeft = [...slots];
          chosen.forEach(pid => {
            const player = playerById(pid);
            const slot = slotsLeft.find(s => player && player.preferred && player.preferred.includes(s)) || slotsLeft[0];
            assign[pid] = slot;
            slotsLeft.splice(slotsLeft.indexOf(slot), 1);
            openSlots = openSlots.filter(s => s !== slot);
            remaining = remaining.filter(x => x !== pid);
          });
        };
        fillGroup('infield');
        fillGroup('outfield');

        // Fallback: if a battery slot had no eligible (canPitch/canCatch) candidate,
        // it's still left open here. Fill any remaining open field slots from whoever
        // is left before anyone is sent to the bench — an unfamiliar-position fill-in
        // (flagged for the coach to review) keeps the bench count fair; silently
        // benching the leftover player instead would break the ±1 bench rule.
        while (openSlots.length && remaining.length) {
          const slot = openSlots[0];
          const pid = remaining[0];
          assign[pid] = slot;
          openSlots = openSlots.slice(1);
          remaining = remaining.slice(1);
          if (Positions.groupOf(slot) === 'battery') {
            warnings.push(`Inning ${inning}: ${playerById(pid) ? playerById(pid).name : pid} filled in at ${Positions.label(slot)} (not marked eligible) — no eligible player was available.`);
          }
        }

        // True safety net: anyone still left over (should only happen if there are
        // literally more open field slots than players, which can't occur here) sits.
        remaining.forEach(pid => { assign[pid] = 'BN'; });
      }

      newAssignments[inning] = assign;
      presentIds.forEach(pid => { addStat(thisGame, pid, assign[pid]); addStat(seasonStats, pid, assign[pid]); });
      const pitcherThisInning = presentIds.find(pid => assign[pid] === 'P') || null;
      pitcherStreak = (pitcherThisInning && pitcherThisInning === lastPitcher) ? pitcherStreak + 1 : (pitcherThisInning ? 1 : 0);
      lastPitcher = pitcherThisInning;
    }

    return { assignments: newAssignments, thisGameStats: thisGame, warnings };
  }

  function applyRecompute(state, gameId) {
    const game = Util.byId(state.games, gameId);
    const { assignments, thisGameStats, warnings } = recomputeGame(state, gameId);
    game.assignments = assignments;
    game._lastStats = thisGameStats;
    game._lastWarnings = warnings;
    return game;
  }

  function validateGame(state, gameId) {
    const game = Util.byId(state.games, gameId);
    const stats = game._lastStats || {};
    const issues = [];
    const starters = state.roster.filter(p => p.active && isStarter(game, p.id));
    starters.forEach(p => {
      const inf = (stats[p.id] && stats[p.id].infield) || 0;
      if (inf < 2) issues.push({ level: 'warn', msg: `${p.name}: only ${inf} infield inning${inf === 1 ? '' : 's'} so far (needs 2).` });
    });
    // Players serving a carryover sit (see applyCarryoverToNewGame) are *expected* to
    // sit more than everyone else right now — that imbalance is a sanctioned exception,
    // not a rule violation, so they're excluded from the parity check.
    const carryoverIds = new Set(game.carryoverPlayers || []);
    const fullGame = starters.filter(p => attendanceOf(game, p.id).toInning === game.innings && !carryoverIds.has(p.id));
    if (fullGame.length > 1) {
      const benches = fullGame.map(p => (stats[p.id] && stats[p.id].bench) || 0);
      const max = Math.max(...benches), min = Math.min(...benches);
      if (max - min > 1) issues.push({ level: 'error', msg: `Bench imbalance: max ${max}, min ${min} innings sat (should differ by at most 1).` });
    }
    (game.carryoverPlayers || []).forEach(pid => {
      const p = Util.byId(state.roster, pid);
      issues.push({ level: 'info', msg: `${p ? p.name : pid} is serving a carryover bench requirement (pitched a full game last time without sitting).` });
    });
    (game._lastWarnings || []).forEach(w => issues.push({ level: 'warn', msg: w }));
    return issues;
  }

  function applyCarryoverToNewGame(state, game) {
    Object.keys(state.carryover || {}).forEach(pid => {
      const owed = (state.carryover[pid] && state.carryover[pid].owedSitInnings) || 0;
      if (!owed) return;
      const att = attendanceOf(game, pid);
      if (!att.in || att.fromInning !== 1) return;
      const inningsToForce = Math.min(owed, game.innings);
      for (let i = 1; i <= inningsToForce; i++) {
        game.locks[i] = game.locks[i] || {};
        game.assignments[i] = game.assignments[i] || {};
        game.assignments[i][pid] = 'BN';
        game.locks[i][pid] = true;
      }
      game.carryoverPlayers = game.carryoverPlayers || [];
      game.carryoverPlayers.push(pid);
      delete state.carryover[pid];
    });
  }

  function finalizeGame(state, gameId) {
    const game = Util.byId(state.games, gameId);
    const stats = game._lastStats || recomputeGame(state, gameId).thisGameStats;
    const starters = state.roster.filter(p => p.active && isStarter(game, p.id) && attendanceOf(game, p.id).toInning === game.innings);
    const benches = starters.map(p => (stats[p.id] && stats[p.id].bench) || 0);
    const maxBench = benches.length ? Math.max(...benches) : 0;
    starters.forEach(p => {
      const s = stats[p.id];
      if (s && s.pitcher === game.innings && (s.bench || 0) === 0 && maxBench > 0) {
        // Owes the full 2 innings the rule calls for: sit inning 1 of the next game,
        // and sit twice total, before anyone else is asked to sit a second inning.
        state.carryover[p.id] = { owedSitInnings: 2 };
      }
    });
    game.status = 'final';
  }

  return {
    presentDuring, isStarter, attendanceOf, recomputeGame, applyRecompute, validateGame,
    finalizeGame, applyCarryoverToNewGame, seasonStatsExcluding, seasonFraction, emptyLine
  };
})();
