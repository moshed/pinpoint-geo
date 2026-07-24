# Pinpoint

Unlimited location-guessing practice, live at **https://geo.dancykier.com**.

Read a clue, drop a pin on a world map, see how far off you were. Modelled on
geohistory.gg's play mode, minus the two things Moshe didn't want: sports
questions and a five-a-day limit.

## Structure

Four static files. No build step, no dependencies to install, no backend.

| File | What's in it |
|---|---|
| `index.html` | Markup only. Loads Leaflet + Google Fonts from CDN. |
| `styles.css` | All styling. Design tokens at the top under `:root`. |
| `app.js` | Game logic in one IIFE — geo maths, round flow, rendering, persistence. |
| `questions.js` | The 350-question bank as a plain `const QUESTIONS = [...]`. |
| `mapdata.json` | Coastline, lake shores, country + state/province lines (Natural Earth 50m), minified (~645 KB gzipped). Drawn over the satellite basemap. Fetched once at runtime. |

Results are also logged to Supabase so history survives a cleared browser — see
**[CLAUDE-supabase.md](CLAUDE-supabase.md)** for the schema, the no-login access
model, and why the publishable key is committed on purpose.

Deployed by GitHub Pages straight off `main` at repo root (`moshed/pinpoint-geo`).
`CNAME` holds the custom domain — GitHub rewrites this file if the domain is
changed in repo settings, so edit it there, not here.

**Cache-busting:** asset URLs carry a `?v=N` query (`app.js`, `styles.css`,
`questions.js`, and the `mapdata.json` fetch inside `app.js`). GitHub Pages
serves assets with `max-age=600`, so without this a returning visitor can run
stale JS/data for up to 10 minutes — which once made a shipped fix look
missing. **Bump every `?v=` when you change those files** so the next load is
guaranteed fresh (they must all match; currently `v=7`).

## Design direction

A surveyor's console over satellite imagery. Dark UI chrome, monospace data
readouts, hairline rules, and toned-down real terrain under gold/white admin
lines. Two accent colours carry meaning and are used for nothing else:

- **amber `--signal` `#ffa62b`** — always the player's guess
- **cyan `--fix` `#5fd4ff`** — always the true answer

Type: Familjen Grotesk for prose and headings, Azeret Mono for anything
numeric. The signature moment is the ranging readout — after you commit, the
distance spins up from zero like a rangefinder settling while the great-circle
arc draws between your pin and the truth.

## Decisions worth remembering

- **The basemap is satellite imagery; the lines are drawn on top.** This is the
  core map decision, and it arrived in two steps. The basemap is **Esri World
  Imagery** raster tiles (free, no key) — real satellite photography, like
  GeoHistory. Coast, lake shore, country and state lines are drawn over it by
  `LinesLayer` in `app.js`, an `L.GridLayer` subclass rendering `mapdata.json`
  (`coast`, `lakes`, `countries`, `states` — all lines) into canvas tiles.

  Why imagery + our own lines rather than a styled raster: satellite is
  *photographic*, so it carries no road/river/county **lines** to clutter the map
  — the exact problem CARTO's raster had, where the baked-in clutter sat at the
  same luminance as the ocean and no contrast curve could remove it. So we get
  real terrain AND only the admin lines we want.

  **Two GridLayers, and they stay welded.** The satellite raster and the line
  canvas are sibling tile layers sharing the identical tile transform, so the
  lines never drift from the imagery during a zoom (measured: zero scale mismatch
  across a gesture). An SVG *overlay* drifts — a sibling tile layer does not. This
  is the resolution of the long borders-drift saga: the earlier "one combined
  canvas layer" also solved it, but satellite forced two layers again, and two
  *tile* layers are fine; only the overlay pane was the problem.

  Line styling: **thin white lines with a black outline** (`haloed()` in `_draw`:
  a black casing under a white stroke). White-with-black-outline is the most
  universally legible — the white shows on dark ocean/forest, the black edge
  shows on bright desert/snow. The colour went gold → black → white across a
  few rounds of feedback; white-cased is the keeper. Colour and thinness
  were both explicit asks (bright gold, and thicker, read as too heavy).
  Weight `cw` is thin and scales gently with zoom (0.7 at world → 1.1 deep) —
  world-zoom thickness was the specific complaint. Coast and country share one
  weight (a country's outline is its land borders plus its coast); lakes and
  states are thinner. The line data is Natural Earth **50m** — accurate world→metro but visibly
  wrong at city zoom (a state line drifts off the river it follows). Rather
  than show wrong lines, `_draw` **fades them out past z8 and drops them by
  z10** (`la` factor): at city zoom the satellite is the accurate ground
  truth and no line beats a wrong one. 10m data would fix it but is ~3–5 MB
  gzipped — too heavy for an upfront fetch; don't add it without progressive
  loading. Natural Earth's `admin_0_boundary_lines_land` omits
  coasts, which is why `coast`/`lakes` are separate datasets — without them,
  island nations like Australia (all coast) had no outline at all. The
  lines live in their own `lines` pane at z-index 350 (above tiles 200, below
  markers 400). Web Mercator is projected by hand and features culled by bbox, as
  before. The imagery is toned down by `.sat-tiles { filter: brightness(.82)
  saturate(.92) }` for line contrast and to sit closer to the dark palette.
  `#map` / `.leaflet-container` background is just a deep-water tone shown until
  tiles load — it is no longer load-bearing (satellite covers the ocean).
- **Labels appear on reveal only, as a transparent labels-only raster.** While
  guessing there are no place names (they'd be the answer key). On commit,
  `labelsLayer` (CARTO `dark_only_labels`, text only — no lines) is added in the
  marker pane so you can learn the surrounding geography, and removed on the next
  round. It reads well over the toned satellite. Cosmetic — the game is playable
  if it fails to load.
- **Wheel zoom is hand-rolled; Leaflet's is disabled** (`scrollWheelZoom: false`).
  `wheelZoom()` in `app.js` accumulates an absolute zoom target from raw wheel
  deltas — linear, no debounce — and hands it to Leaflet's **animated** zoom path.
  Two traps are baked into that design, both found the hard way:

  1. **Never zoom with `{animate:false}` per frame.** A non-animated `setView`
     fires `viewprereset`, and `GridLayer`'s handler for it destroys every tile.
     Do that each frame and the map is *blank for the entire gesture* — measured
     at 24 of 26 frames with zero tile coverage. The animated path CSS-scales the
     existing tiles instead, and stays at full coverage throughout. Overriding
     `_invalidateAll` does not help: `getEvents()` captures the function reference
     when the layer is added, so a later reassignment is never seen.
  2. **Leaflet silently drops a zoom request while one is animating**
     (`_tryAnimatedZoom` returns true and `setView` bails). Fire once and the map
     stops at the first step. Hence `pump()` re-firing on `zoomend` until the map
     reaches the target — that is what makes the total travel correct.

  3. **`pump()` must be deferred a frame** (`requestAnimationFrame`). This listener
     is registered before the map tile layer exists, so it otherwise runs *first*
     on `zoomend` and starts the next animation before the layer has re-projected
     for the previous one. Deferring puts it last. (This mattered more when borders
     were a separate overlay that could visibly lag the basemap; with one layer the
     symptom is subtler, but the ordering is still correct.)

  `pump()` is also guarded on a recent wheel event, or the `zoomend` from the
  reveal's `fitBounds` would yank the map back to a stale target.

  Leaflet's zoom transition is **0.25s eased and set in CSS, not by the `duration`
  option** — passing `duration` to a zoom does nothing. Chained 0.25s eased
  animations update roughly 4×/second and read as pulsing, so `styles.css`
  shortens it to `80ms linear` while the `wheeling` class is on the container.
  That takes motion to ~42 distinct transforms per 45 frames.

  Tuning is one constant: `speed`, 0.007 per wheel pixel (0.03 for ctrl+wheel,
  which is how macOS pinch-to-zoom arrives). A 300 px two-finger swipe travels
  ~2 zoom levels. `zoomSnap: 0` is required or each step rounds to a whole level.
  `wheelPxPerZoomLevel` does nothing now — don't "restore" it.
- **`maxZoom` is 14** so you can zoom right into the answer on the satellite (it
  was 11). The satellite tile layer allows z18; the line layer matches the map at
  14, so borders stay drawn when you zoom in (coarse at deep zoom — the data is
  50m — but present). The labels layer also goes to 14.
- **The reveal animates a path from your wrong guess to the right answer.** On
  commit, `fitBounds` frames the shot, then a dashed great-circle line grows out
  from your pin toward the truth over `REVEAL_MS`, easing out, with a **travel dot**
  riding its tip and the distance readout counting up on the same beat. The line is
  a bright gold stroke over a dark casing (`lineCasing` + `line`) so it reads on
  satellite. The answer marker and label are added only when the line *lands* — and
  the travel dot is removed then — because showing them up front gives away the
  destination. The reveal **no longer reframes the map** — it keeps the player's current
  zoom and center (a fit-to-both zoom-in was disorienting); the line just runs out
  from the pin at whatever zoom they guessed at, and they pan/zoom freely after.
  `prefers-reduced-motion` draws it complete immediately; a timeout
  backstops the backgrounded-tab case where rAF never runs.
- **The map is not a performance problem.** Drawing the lines was the first suspect
  for slow zoom; benchmarked, it costs nothing measurable — p50 8.3 ms per frame
  during continuous zoom, zero long tasks under aggressive zooming. The lag was
  always the *approach* (an SVG overlay, or a raster basemap fetching tiles
  mid-gesture), not the geometry. Measure before blaming the data.
- **Two game modes: Clues and Practice** (header toggle, `state.mode`). Clues is
  the trivia game — a clue, you locate the answer. Practice hands you the answer
  name (`q.a`) straight up to locate; the category chip reads "locate". Everything
  downstream (map, scoring, reveal, field log) is identical — only the prompt text
  differs (`promptFor`).

  **Practice is deliberately ephemeral.** Because the answer is given, its scores
  are meaningless mixed into the tracked record, so practice rounds live in
  in-memory `practiceRounds` / `practicePlayed` — never persisted, never sent to
  Supabase. `activeRounds()` / `activePlayed()` return the practice set or the
  persisted clue set depending on mode, and the field log + header gauges read
  through them, so each mode shows its own rounds and switching swaps the view.
  The Progress panel is clue-only by construction (only clue rounds are ever
  logged). The mode *choice* is persisted (so it's remembered); the practice
  *rounds* are not. Don't "helpfully" start logging practice — it would pollute
  the real record, which is the whole reason it's separate.
- **Rhumb bearing, not great-circle.** `bearing()` in `app.js` uses the rhumb
  line so "WSW of it" matches the Mercator map the player is looking at. A
  great-circle heading says things like "NW" for a guess that is visibly
  south-west, which reads as a bug.
- **Scoring copies GeoHistory: out of 100, computed in miles.** `100 · e^(−mi/1400)`,
  with anything inside 15 miles counted as a flat 100. That constant is pinned to
  GeoHistory's one published data point — 500 miles off costs you 30 points — and
  reproduces it exactly. Roughly: 100 mi ≈ 93, 250 mi ≈ 84, 500 mi ≈ 70,
  1,000 mi ≈ 49, 2,000 mi ≈ 24, 4,000 mi ≈ 6. Scoring is always done in miles so
  the curve doesn't shift when the km/mi toggle flips; **miles is the default unit**.
- **`STORE` is versioned.** It went to `pinpoint.v2` when scoring changed from a
  5,000-point scale to 100 — old rounds would otherwise wreck the mean-score
  gauge. Bump it again on any change to what a stored round means.
- **Question ids are derived from the answer name**, slugified at the bottom of
  `questions.js`. So answer names must stay unique — a duplicate silently
  collapses two questions into one "already played" entry. Adding questions
  needs no id bookkeeping; renaming an answer resets its played state.
- **`[hidden] { display: none !important }`** is load-bearing. Several blocks set
  `display: flex`, which otherwise beats the `hidden` attribute and leaves the
  Topics sheet stuck open on load.
- **`--prompt-h`** is written by `syncPromptHeight()` so Leaflet's zoom buttons
  can sit clear of the floating prompt card on narrow screens.

- **Questions must never name the answer's city or country.** Moshe asked for this
  explicitly — a clue that says "the capital of Bhutan" or "a Paris crowd" gives the
  answer away. The subject's own proper name is fine even when it doubles as a place
  ("Where is Chernobyl?", "Where is the Eiffel Tower?"); what's banned is an
  appositive or qualifier naming where the answer *is*. Run the leak check below
  after adding or editing any question.

## Adding questions

Append to the array in `questions.js` before the closing bracket:

```js
{ q: "Where is …?", a: "Name, Country", lat: 0.0, lon: 0.0, cat: "landmark",
  note: "One thing worth knowing, one or two sentences." },
```

`cat` must be one of `history | landmark | nature | city | culture` — these are
the five topic toggles, and `TOPICS` in `app.js` holds their display names. To
add a sixth category, add it in both places.

Sanity-check the bank after editing — duplicate ids **and** place-name leaks. This
flags any question whose text contains something from its own answer after the first
comma, i.e. the city/country. The one expected hit is "Where is Panama City?", where
the city's name contains the country's:

```bash
node -e '
const src = require("fs").readFileSync("questions.js","utf8");
const Q = new Function(src + "; return QUESTIONS;")();
const ids = new Set(); Q.forEach(q => { if (ids.has(q.id)) console.log("DUP", q.id); ids.add(q.id); });
const strip = s => s.normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase();
Q.forEach(q => q.a.split(",").slice(1).map(s=>s.trim()).forEach(t =>
  t.split(/[–—\/()]/).map(s=>s.trim()).filter(s=>s.length>3).forEach(w => {
    if (strip(q.q).includes(strip(w))) console.log("LEAK:", w, "::", q.q, "->", q.a);
  })));
console.log(Q.length, "questions");'
```

Demonyms slip past that check ("the Swiss capital" never contains "Switzerland"), so
also eyeball new questions for nationality adjectives that pin down a country.

## Local development

```bash
cd "/Users/moshe/Apps/Pinpoint" && python3 -m http.server 8777
```

Then open http://localhost:8777. There is no watch step — just reload.

Headless screenshots (the Chrome extension was not connected during the build):

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --disable-gpu --window-size=1440,900 --virtual-time-budget=10000 \
  --screenshot=/tmp/shot.png http://localhost:8777/index.html
```

Headless Chrome clamps the viewport to a 500 px minimum, so a `--window-size`
narrower than that produces a *cropped* 500 px render, not a mobile layout. To
check the ≤700 px breakpoint honestly, load the page in a 390 px-wide iframe
inside a 500 px window.

**`requestAnimationFrame` does not run under `--virtual-time-budget`**, so any
timing or interaction test built on rAF silently produces nothing. For those, drive
a real browser over CDP instead — Node's built-in `WebSocket` is enough, no
dependencies:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --no-sandbox --remote-debugging-port=9222 --user-data-dir=/tmp/cdpprof about:blank &
# then: PUT (not GET) http://127.0.0.1:9222/json/new?<url> to open a tab,
# connect to webSocketDebuggerUrl, and Runtime.evaluate with awaitPromise:true
```

Useful probes, all used to settle the zoom work:

- **Tile coverage** — sum the viewport intersection of every `img.leaflet-tile-loaded`
  and divide by the viewport area. This is what caught the blank-map regression;
  tile *counts* look fine while coverage is zero.
- **Zoom** — read `map.getZoom()` directly. Reading it from a tile `src` breaks once
  several zoom levels are retained, and the map pane's transform is reset after every
  non-animated `setView`, so neither works as a general probe.
- **Reveal animation** — find the line by `stroke-dasharray="5 5"` (the borders share
  its SVG pane) and sample `getTotalLength()` per frame.

Sample for at least `REVEAL_MS` plus a margin when testing the reveal — a window
that stops early makes a working animation look like it never finishes.

## Deployment

Push to `main`; GitHub Pages redeploys in a minute or so. DNS is a `geo` CNAME
on dancykier.com pointing at `moshed.github.io.` — see the
`dancykier_dns_namecheap` memory for the Namecheap API details and the
`EmailType=OX` landmine that breaks Moshe's email if a `setHosts` call omits it.
