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
| `mapdata.json` | The entire map — Natural Earth 50m land, lakes, country lines and state/province lines, minified (~645 KB gzipped). Fetched once at runtime. |

Results are also logged to Supabase so history survives a cleared browser — see
**[CLAUDE-supabase.md](CLAUDE-supabase.md)** for the schema, the no-login access
model, and why the publishable key is committed on purpose.

Deployed by GitHub Pages straight off `main` at repo root (`moshed/pinpoint-geo`).
`CNAME` holds the custom domain — GitHub rewrites this file if the domain is
changed in repo settings, so edit it there, not here.

## Design direction

A surveyor's console. Deep sea-chart ink, monospace data readouts, hairline
rules. Two accent colours carry meaning and are used for nothing else:

- **amber `--signal` `#ffa62b`** — always the player's guess
- **cyan `--fix` `#5fd4ff`** — always the true answer

Type: Familjen Grotesk for prose and headings, Azeret Mono for anything
numeric. The signature moment is the ranging readout — after you commit, the
distance spins up from zero like a rangefinder settling while the great-circle
arc draws between your pin and the truth.

## Decisions worth remembering

- **The map is fully self-rendered from vector data — there is no raster basemap.**
  This is the biggest architectural decision. `VectorMap` in `app.js` is an
  `L.GridLayer` subclass that draws `mapdata.json` (land + lakes as filled
  polygons, country + state lines as strokes) into canvas tiles. Three reasons it
  is not CARTO raster tiles:
  1. **Only the lines the player wants.** CARTO bakes rivers, roads and county
     lines into the land at z7+, and they *cannot* be filtered out — measured, the
     faint clutter sits at the same luminance as the ocean, so no contrast curve
     separates them. Drawing the map ourselves means those lines don't exist.
  2. **One layer, not two.** It replaced a raster basemap *plus* a canvas border
     overlay. Half the tiles to transform per zoom frame, and zero raster HTTP
     fetches mid-gesture — both were making zoom feel heavy.
  3. **Borders can't drift.** Land and borders are in the *same* canvas tile, so
     they are one object and cannot come apart (the whole saga below).

  Colours live in `MAP_COLORS` (land `#0c1a22`, lake/ocean `#22333b`, country and
  state strokes). **`.leaflet-container` / `#map` background must equal the ocean
  colour** — the canvas is transparent over water and in the sub-pixel gaps
  fractional zoom leaves, so the container shows through as the sea. Change one,
  change all three.

  Rendering detail: Web Mercator is projected by hand in `_draw` (projecting
  ~100k points per tile through `map.project` would allocate absurdly); features
  are culled by bounding box against the tile; `worldIndex` offsets the repeated
  world copies at the antimeridian, without which land vanishes on wrapped tiles;
  states draw only from z4 (noise at world zoom); tiles render in a `setTimeout`
  so panning never blocks on drawing. Measured ~1 ms median / 5.5 ms worst per
  tile — the land fill is cheap because of the bbox cull.
- **Labels appear on reveal only, as a transparent labels-only raster.** While
  guessing there are no place names (they'd be the answer key). On commit,
  `labelsLayer` (CARTO `dark_only_labels`, text only — no lines, so it doesn't
  reintroduce clutter) is added in the marker pane so you can learn the
  surrounding geography, and removed again on the next round. This is the one
  remaining CARTO dependency, and it's cosmetic — the game is fully playable if it
  fails to load.
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
- **The reveal is animated and the answer is withheld until it lands.** On commit,
  `fitBounds` frames the whole shot first, then the dashed great-circle line grows
  out from your pin toward the truth over `REVEAL_MS`, easing out, while the
  distance readout counts up on the same beat. The answer marker and its label are
  added only when the line arrives — showing them up front would give away the
  answer before the line got there. `prefers-reduced-motion` draws it complete
  immediately, and a timeout backstops the case where rAF never runs.
- **The vector map is not a performance problem.** Drawing was the first suspect
  for slow zoom both times; benchmarked, it costs nothing measurable — ~1 ms median
  per tile to draw, p50 8.3 ms per frame during continuous zoom, zero long tasks
  under aggressive zooming. The lag was the *approach* (raster + overlay, two
  layers, raster fetches mid-gesture), not the geometry. Measure before blaming the
  data; don't reach for the coarser 110m dataset reflexively.
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
