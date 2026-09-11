# Fall Rockies Lineup Manager

A no-build, static web app for planning and running Little League lineups: fair
infield/outfield/bench rotation, live in-game pitcher/position overrides, and
built-in KNLL rule checking. Everything runs client-side — plain HTML/CSS/JS,
no framework, no server. Data is stored in your browser's `localStorage`.

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
- **Settings tab** — team name, defaults, and JSON export/import. Since data
  lives only in this browser, export a backup occasionally, and use
  export/import to move your plan between devices (e.g. plan on a laptop,
  load it on your phone at the field).

## How the recommendation engine applies the KNLL rules

- **Infield minimum (2 innings)** — treated as a hard requirement for every
  player present at the start. As a game gets closer to its last innings for a
  given player, the engine forces an infield placement once there's no more
  slack left to satisfy it.
- **Bench balance (±1 inning)** — the engine always benches whoever has sat
  the fewest innings so far this game (ties broken by who's played the most
  total innings), so nobody's bench count can drift more than one inning away
  from anyone else's, barring the pitcher exception below.
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

Everything is stored locally in your browser via `localStorage` — nothing is
sent anywhere. That also means data doesn't sync between devices or browsers
automatically; use Settings → Export/Import JSON to move it around or keep a
backup.
