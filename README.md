# Fall Rockies Lineup Manager

A no-build, static web app for planning and running Little League lineups: fair
infield/outfield/bench rotation, live in-game pitcher/position overrides, and
built-in KNLL rule checking. Everything runs client-side — plain HTML/CSS/JS,
no framework, no server. Team data is shared between coaches by storing it as
`data/state.json` in this same GitHub repo (see "Multi-coach sync" below), with
a `localStorage` copy in each browser so the app also works offline.

## Hosting it on GitHub Pages

1. Push this folder to a GitHub repository (see below if you need the git commands).
2. On GitHub: **Settings → Pages → Source**, choose the `main` branch and `/ (root)`, then save.
3. GitHub gives you a URL like `https://<you>.github.io/<repo>/` — that's your app.

```bash
git init
git add -A
git commit -m "Initial commit"
git branch -M main
git remote add origin <your-repo-url>
git push -u origin main
```

You can also just open `index.html` directly in a browser (no server needed) to
use it locally without GitHub Pages at all.

## Using it

- **Roster tab** — add your players. Check "Pitch" / "Catch" for kids eligible
  at those spots (the engine will never schedule a kid at pitcher or catcher
  unless checked). Click position chips to mark a kid's desired positions —
  used as a light tiebreaker once innings are otherwise balanced.
- **Games tab** — create a game: date, opponent, innings, outfielder count (3
  or 4), and who showed up. The full lineup grid is generated immediately —
  that's your pre-plan.
- **Game detail** — the grid shows every inning for every present player,
  color-coded by infield/outfield/battery/bench. Click any cell's dropdown to
  override a position (locks it 📌) or pick "Auto" to hand it back to the
  recommendation engine — everything else recomputes instantly around your
  change.
- **Live mode** — hit "Start Game." The current inning is highlighted. When a
  pitcher is in and you want to leave them in longer, hit "Keep pitching next
  inning" — that's the pitcher exception in action. "Advance to Inning N"
  locks the just-played inning into the permanent record and refreshes
  recommendations for what's left. You can add a late arrival or mark someone
  as having left early at any point, and everything rebalances.
- **Season Stats tab** — the cumulative, honest record: only innings actually
  played count (a live game's not-yet-played innings never leak into this).
  This is also what the engine uses to keep everyone's fractional playing time
  balanced *across* games, not just within one.
- **Settings tab** — team name, defaults, the multi-coach sync token, and JSON
  export/import for backups.

## Multi-coach sync

The shared source of truth is `data/state.json` in this repo.

- **Reading needs no setup.** Every page load (and every ~10 seconds while the
  tab is visible, plus whenever you switch back to the tab) the app fetches the
  file straight from GitHub and adopts it if it's newer than what the browser
  has. Any coach who opens the URL sees the current roster, games, and lineups.
- **Publishing needs a token.** To make *your* edits show up for everyone, go
  to Settings → Multi-Coach Sync and paste a GitHub fine-grained personal
  access token that is scoped to **only this repository** with
  **Contents: Read and write** and nothing else. The token is kept in that
  browser's `localStorage`, sent only to `api.github.com`, and never included
  in the shared file or in exports. Each edit is then committed to the repo
  within about a second — so the git history doubles as an audit log of every
  lineup change.
- **Without a token**, edits stay local to that browser and get replaced the
  next time newer shared data arrives. Fine for viewing; not for coaching.
- **Conflicts** are resolved last-write-wins by timestamp. Two coaches editing
  the same game at the exact same moment is rare at this scale; if it happens,
  whoever saved last wins and the other can re-apply their change.

## How the recommendation engine applies the KNLL rules

- **Infield minimum (2 innings)** — a hard requirement for every player present
  at the start. **Pitcher and catcher count as infield** for this rule, which is
  both the standard Little League reading and a practical necessity: with only
  1B/2B/3B/SS there are 24 infield innings in a 6-inning game, and 13 kids need
  26. The planner serves whoever is shortest on infield time first, and a repair
  pass afterward trades kids between outfield and infield — chaining swaps when
  the roster is tight — until everyone clears the minimum. Bench counts are never
  touched by those trades, so fixing one rule can't break the other.
- **Bench balance (±1 inning)** — the bench is chosen *before* positions each
  inning, always seating whoever has sat the fewest innings (ties broken by who
  has sat least this season, then who's played the most today). Choosing
  positions first and benching the leftovers is what lets the same kids get
  skipped repeatedly, so the rotation is decided first and everything else fits
  around it. The one exception: the last kid who can pitch or catch is never
  benched, since that strands the position.
- **Pitcher exception** — a normal single-inning pitching turn is just
  ordinary rotation and doesn't force anything. The moment you keep a pitcher
  in for a **second consecutive inning** (via "Keep pitching"), the exception
  is in effect; when that pitcher is eventually taken off the mound, the
  engine automatically forces them to sit the very next inning, even if that
  temporarily pushes their bench count above others'.
- **Pitched the whole game** — if a pitcher throws every inning of a game and
  never sits, the app remembers: at their next game, they're automatically
  locked to the bench for the first two innings before anyone else is asked to
  sit twice. You'll see a banner on the Games tab and a note on the game
  itself when this is active.
- **Partial attendance** — a late addition or a kid who leaves early isn't
  held to the hard infield/bench math the same way a full-game starter is
  (there literally aren't enough innings to guarantee it); the engine still
  tries to get them a fair share, just without flagging it as a violation.

The rule-check panel on each game surfaces anything the engine couldn't
resolve automatically (e.g., an inning has no one currently marked eligible to
pitch or catch, or an infield-minimum requirement is at risk to being missed)
so you always know before first pitch — and you can always override any cell
by hand, and it's the coach's call, not the algorithm's, in every case.

## Data & privacy

The shared `data/state.json` lives in this repository. If the repo is public,
so is that file — keep the roster to names only (no birthdays, contact info,
or photos). Sync tokens never leave the browser they were entered in, except
to authenticate directly with GitHub's API.
