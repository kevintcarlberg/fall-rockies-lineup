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
  // P and C are infield positions for the KNLL 2-inning infield minimum. They're
  // still tracked as their own "battery" category for display, but they count as
  // infield time — without them the rule is unsatisfiable (13 kids x 2 innings =
  // 26 needed, but 4 infield slots x 6 innings = only 24 available).
  countsAsInfield(pos) {
    const g = this.groupOf(pos);
    return g === 'infield' || g === 'battery';
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
      carryover: {}, // pid -> { owedSitInnings }
      updatedAt: 0
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

  function persist() { localStorage.setItem(KEY, JSON.stringify(state)); }
  // save() stamps a local edit; replaceAll() adopts a whole snapshot (import or
  // sync) and keeps that snapshot's own timestamp so freshness comparisons stay honest.
  function save() { state.updatedAt = Date.now(); persist(); }
  function get() { return state; }
  function replaceAll(newState) { state = Object.assign(defaultState(), newState); persist(); }

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

  function emptyLine() { return { infield: 0, outfield: 0, battery: 0, bench: 0, pitcher: 0, catcher: 0, infieldCredit: 0, innings: 0 }; }

  function addStat(stats, pid, pos) {
    if (!pos) return;
    const s = stats[pid] || (stats[pid] = emptyLine());
    s.innings++;
    s[Positions.groupOf(pos)]++;
    if (Positions.countsAsInfield(pos)) s.infieldCredit++;
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
    let pitcherStreak = 0;      // consecutive innings (through the previous inning) lastPitcher has thrown
    let streakWasLocked = false; // ...and whether the coach pinned it there

    // How many innings this player still has available, counting the current one.
    const inningsLeftFor = (pid, inning) => {
      const att = attendanceOf(game, pid);
      return Math.max(0, Math.min(game.innings, att.toInning) - inning + 1);
    };
    // Infield innings this player still owes toward the KNLL minimum (starters only).
    const needOf = pid => isStarter(game, pid)
      ? Math.max(0, 2 - ((thisGame[pid] && thisGame[pid].infieldCredit) || 0)) : 0;

    for (let inning = 1; inning <= game.innings; inning++) {
      const presentIds = roster.filter(p => p.active && presentDuring(game, p.id, inning)).map(p => p.id);
      const isFinal = game.status === 'final' || inning < game.currentInning;
      const existing = game.assignments[inning] || {};
      const locks = game.locks[inning] || {};
      let assign = {};

      if (isFinal) {
        // History is history — never re-decided by the engine. Keyed off the stored
        // assignments rather than the active roster so deactivating or removing a
        // player later can't erase what they actually played.
        Object.keys(existing).forEach(pid => { if (existing[pid] && presentDuring(game, pid, inning)) assign[pid] = existing[pid]; });
      } else {
        // Seed with anything the coach explicitly locked.
        presentIds.forEach(pid => { if (locks[pid] && existing[pid]) assign[pid] = existing[pid]; });

        let remaining = presentIds.filter(pid => !assign[pid]);
        const takenSlots = new Set(Object.values(assign).filter(p => p && p !== 'BN'));
        let openSlots = slotsAll.filter(s => !takenSlots.has(s));
        const benchAlready = Object.values(assign).filter(p => p === 'BN').length;
        const benchCapacity = Math.max(0, presentIds.length - slotsAll.length);
        let benchLeft = Math.max(0, benchCapacity - benchAlready);

        // Pitcher exception: a normal single-inning turn doesn't force a sit, and
        // neither does a streak the engine had no choice about (one eligible pitcher
        // on the roster). The mandatory-sit only follows an exception the *coach*
        // invoked by locking that pitcher in for a 2nd consecutive inning.
        if (pitcherStreak >= 2 && streakWasLocked && lastPitcher && remaining.includes(lastPitcher) && assign[lastPitcher] === undefined) {
          assign[lastPitcher] = 'BN';
          remaining = remaining.filter(x => x !== lastPitcher);
          benchLeft = Math.max(0, benchLeft - 1);
        }

        // Bench is chosen FIRST, from everyone available, so the rotation stays even.
        // (Picking positions first and benching the leftovers lets the same kids get
        // skipped over and over, which is how bench counts drift past the ±1 rule.)
        if (benchLeft > 0) {
          // Bench count is the hard rule, so it sorts first and nothing below it can
          // push a player past someone who has already sat more. "Can't spare the
          // inning" (still owes infield innings) only breaks ties among equals.
          const cantSpare = pid => needOf(pid) > 0 && needOf(pid) >= inningsLeftFor(pid, inning) ? 1 : 0;
          const ordered = remaining.slice().sort((a, b) => {
            const ba = (thisGame[a] && thisGame[a].bench) || 0, bb = (thisGame[b] && thisGame[b].bench) || 0;
            if (ba !== bb) return ba - bb;                       // fewest sits this game
            const ta = cantSpare(a), tb = cantSpare(b);
            if (ta !== tb) return ta - tb;                       // spare the kid who owes infield
            const sa = seasonFraction(seasonStats, a, 'bench'), sb = seasonFraction(seasonStats, b, 'bench');
            if (sa !== sb) return sa - sb;                       // then fewest sits this season
            const pa = (thisGame[a] && thisGame[a].innings) || 0, pb = (thisGame[b] && thisGame[b].innings) || 0;
            return pb - pa;
          });
          const chosen = [];
          // The one hard veto: seating the last kid who can pitch (or catch) strands
          // that slot and forces an exception streak nobody asked for.
          const wouldStrand = pid => ['canPitch:P', 'canCatch:C'].some(spec => {
            const [flag, posCode] = spec.split(':');
            const p = playerById(pid);
            if (!openSlots.includes(posCode) || !p || !p[flag]) return false;
            return !remaining.some(x => x !== pid && !chosen.includes(x) && playerById(x) && playerById(x)[flag]);
          });
          for (const pid of ordered) {
            if (chosen.length >= benchLeft) break;
            if (!wouldStrand(pid)) chosen.push(pid);
          }
          // Only if the mound veto starved the bench do we seat a protected player.
          for (const pid of ordered) {
            if (chosen.length >= benchLeft) break;
            if (!chosen.includes(pid)) chosen.push(pid);
          }
          chosen.forEach(pid => { assign[pid] = 'BN'; remaining = remaining.filter(x => x !== pid); });
          benchLeft = 0;
        }

        // Pitcher / catcher, from eligible kids only. `avoid` keeps the engine from
        // re-picking the same pitcher on its own — a 2nd straight inning is the
        // coach's call, not the algorithm's.
        const assignBattery = (posCode, flag, avoid) => {
          if (!openSlots.includes(posCode)) return;
          let cands = remaining.filter(pid => playerById(pid) && playerById(pid)[flag]);
          if (!cands.length) { warnings.push(`Inning ${inning}: no eligible ${Positions.label(posCode).toLowerCase()} available.`); return; }
          if (avoid && cands.length > 1) cands = cands.filter(pid => pid !== avoid);
          cands.sort((a, b) => {
            // P/C count toward the infield minimum, so serve anyone still short first.
            const na = needOf(a) > 0 ? 0 : 1, nb = needOf(b) > 0 ? 0 : 1;
            if (na !== nb) return na - nb;
            return (seasonFraction(seasonStats, a, 'battery') - prefBonus(playerById(a), posCode) * 0.1) -
                   (seasonFraction(seasonStats, b, 'battery') - prefBonus(playerById(b), posCode) * 0.1);
          });
          const pid = cands[0];
          assign[pid] = posCode;
          remaining = remaining.filter(x => x !== pid);
          openSlots = openSlots.filter(s => s !== posCode);
        };
        assignBattery('P', 'canPitch', lastPitcher);
        assignBattery('C', 'canCatch');

        // Fill infield then outfield: unmet infield minimums outrank everything,
        // ordered by who has the least room left to fix it; then season fairness
        // with a light nudge toward each kid's preferred spots.
        const fillGroup = (group) => {
          let slots = openSlots.filter(s => Positions.groupOf(s) === group);
          if (!slots.length || !remaining.length) return;
          // Infield fairness is measured on infield credit (P/C included), so a kid
          // who pitches a lot isn't also first in line for shortstop.
          const key = group === 'infield' ? 'infieldCredit' : group;
          const pool = [...remaining];
          pool.sort((a, b) => {
            if (group === 'infield') {
              const na = needOf(a), nb = needOf(b);
              if ((na > 0) !== (nb > 0)) return na > 0 ? -1 : 1;
              if (na > 0) {
                const slackA = inningsLeftFor(a, inning) - na, slackB = inningsLeftFor(b, inning) - nb;
                if (slackA !== slackB) return slackA - slackB;
                if (na !== nb) return nb - na;
              }
            }
            const fa = seasonFraction(seasonStats, a, key) - prefBonus(playerById(a), group) * 0.15;
            const fb = seasonFraction(seasonStats, b, key) - prefBonus(playerById(b), group) * 0.15;
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
      Object.keys(assign).forEach(pid => { addStat(thisGame, pid, assign[pid]); addStat(seasonStats, pid, assign[pid]); });
      const pitcherThisInning = Object.keys(assign).find(pid => assign[pid] === 'P') || null;
      const pinnedHere = !!(pitcherThisInning && (game.locks[inning] || {})[pitcherThisInning]);
      if (pitcherThisInning && pitcherThisInning === lastPitcher) {
        pitcherStreak += 1;
        streakWasLocked = streakWasLocked || pinnedHere;
      } else {
        pitcherStreak = pitcherThisInning ? 1 : 0;
        streakWasLocked = pinnedHere;
      }
      lastPitcher = pitcherThisInning;
    }

    repairInfieldMinimums(state, game, newAssignments, thisGame, seasonStats);
    return { assignments: newAssignments, thisGameStats: thisGame, warnings };
  }

  /**
   * Greedy inning-by-inning planning can leave a starter short of the 2-inning
   * infield minimum even when the schedule as a whole has room for everyone.
   *
   * This trades that kid into an infield slot in an inning where they're playing
   * outfield. When the donor can't spare the inning either, it recurses and finds
   * the donor a replacement elsewhere — a chain of swaps — which is what tight
   * rosters need (15 kids over 5 innings needs all 30 infield innings, so no
   * single donor ever has slack). Only outfield-for-infield trades are used, so
   * bench counts, and therefore the ±1 bench rule, are never disturbed.
   */
  function repairInfieldMinimums(state, game, assignments, thisGame, seasonStats) {
    if (game.status === 'final') return;
    const editable = inning => inning >= game.currentInning;
    const recount = () => {
      Object.keys(thisGame).forEach(k => delete thisGame[k]);
      for (let i = 1; i <= game.innings; i++) {
        Object.keys(assignments[i] || {}).forEach(pid => addStat(thisGame, pid, assignments[i][pid]));
      }
    };
    const creditOf = pid => (thisGame[pid] && thisGame[pid].infieldCredit) || 0;
    const settled = pid => !isStarter(game, pid) || creditOf(pid) >= 2;
    const canSpare = pid => (!isStarter(game, pid) || creditOf(pid) - 1 >= 2) ? 1 : 0;
    const snapshot = () => JSON.stringify(assignments);
    const restore = snap => {
      const saved = JSON.parse(snap);
      Object.keys(assignments).forEach(k => delete assignments[k]);
      Object.assign(assignments, saved);
      recount();
    };
    const swap = (a, x, y) => { const t = a[x]; a[x] = a[y]; a[y] = t; };

    const gain = (pid, depth, chain) => {
      if (creditOf(pid) >= 2) return true;
      if (depth > 3 || chain.has(pid)) return false;
      chain.add(pid);
      for (let i = 1; i <= game.innings; i++) {
        if (!editable(i)) continue;
        const a = assignments[i], locks = game.locks[i] || {};
        if (!a || locks[pid] || Positions.groupOf(a[pid]) !== 'outfield') continue;
        const donors = Object.keys(a)
          .filter(o => o !== pid && !locks[o] && !chain.has(o) && Positions.groupOf(a[o]) === 'infield')
          .sort((x, y) => canSpare(y) - canSpare(x));
        for (const donor of donors) {
          const before = snapshot();
          swap(a, pid, donor); recount();
          if (creditOf(pid) >= 2 && (settled(donor) || gain(donor, depth + 1, chain))) { chain.delete(pid); return true; }
          restore(before);
        }
      }
      chain.delete(pid);
      return false;
    };

    for (let pass = 0; pass < 3; pass++) {
      const short = state.roster.filter(p => p.active && isStarter(game, p.id) && creditOf(p.id) < 2);
      if (!short.length) return;
      let changed = false;
      short.forEach(p => { if (gain(p.id, 0, new Set())) changed = true; });
      if (!changed) return;
    }
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
      const inf = (stats[p.id] && stats[p.id].infieldCredit) || 0;
      if (inf < 2) issues.push({ level: 'warn', msg: `${p.name}: only ${inf} infield inning${inf === 1 ? '' : 's'} (needs 2 — pitcher and catcher count).` });
    });
    // Players serving a carryover sit (see applyCarryoverToNewGame) are *expected* to
    // sit more than everyone else right now — that imbalance is a sanctioned exception,
    // not a rule violation, so they're excluded from the parity check.
    const carryoverIds = new Set(game.carryoverPlayers || []);
    // A kid who pitches every inning is allowed to sit less than everyone else —
    // that's the pitcher exception itself, and the rule settles up next game.
    const wholeGamePitchers = starters.filter(p => ((stats[p.id] || {}).pitcher || 0) === game.innings);
    wholeGamePitchers.forEach(p => issues.push({ level: 'info', msg: `${p.name} is pitching the whole game — if they never sit, they owe two bench innings (starting with the first) next game.` }));
    const exempt = new Set([...carryoverIds, ...wholeGamePitchers.map(p => p.id)]);
    const fullGame = starters.filter(p => attendanceOf(game, p.id).toInning === game.innings && !exempt.has(p.id));
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
    if (game.status !== 'final') {
      // Finalizing mid-game means the current inning was the last one played, so
      // planned-but-unplayed innings are dropped rather than counted as played.
      if (game.currentInning < game.innings) {
        game.innings = game.currentInning;
        Object.values(game.attendance).forEach(a => { if (a.toInning > game.innings) a.toInning = game.innings; });
      }
      game.currentInning = game.innings + 1;
    }
    const stats = applyRecompute(state, gameId)._lastStats;
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
