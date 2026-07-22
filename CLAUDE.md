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
| `borders.json` | Natural Earth 50m land boundary lines, minified. Fetched at runtime. |

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

- **Two basemaps, swapped on reveal.** While guessing you get CARTO
  `dark_nolabels` — labels would literally spell out the answer. The moment you
  commit, `dark_all` (labelled) is swapped in so you can learn the surrounding
  geography. This swap is the single most useful thing in the app; don't
  "simplify" it away.
- **Country borders are a vector overlay, not the basemap's.** `borders.json`
  (Natural Earth 50m boundary lines, ~20k points, 113 KB gzipped) is fetched and
  drawn over whichever basemap is showing. CARTO's own borders are far too faint
  to guess against. Coastlines are *not* in this file — they come from the
  land/sea contrast in the raster, which avoids a vector coastline sitting
  visibly offset from the raster one at high zoom.
- **Tile filter is not decoration.** `.leaflet-tile-pane { filter: brightness(1.25)
  contrast(1.08) sepia(.4) hue-rotate(158deg) saturate(1.9) }` lifts land off
  water and tints the sea from neutral grey toward the chart palette.
- **`.leaflet-container` background must match the filtered ocean colour**
  (currently `#252e33`). Fractional zoom leaves hairline sub-pixel gaps between
  tiles; whatever is behind them shows through as a visible 256 px grid. Matching
  the colour is what makes the seams disappear — if you retune the filter, sample
  the new ocean colour and update both `.leaflet-container` and `#map`.
- **Smooth zoom comes from `zoomSnap: 0`.** Leaflet's default snaps the wheel to
  whole zoom levels, which is what felt stepped. With `zoomDelta: 0.4` and
  `wheelPxPerZoomLevel: 200` the wheel is continuous. This is also what surfaced
  the tile-seam problem above — the two are linked.
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

## Adding questions

Append to the array in `questions.js` before the closing bracket:

```js
{ q: "Where is …?", a: "Name, Country", lat: 0.0, lon: 0.0, cat: "landmark",
  note: "One thing worth knowing, one or two sentences." },
```

`cat` must be one of `history | landmark | nature | city | culture` — these are
the five topic toggles, and `TOPICS` in `app.js` holds their display names. To
add a sixth category, add it in both places.

Sanity-check the bank after editing:

```bash
node -e '
const src = require("fs").readFileSync("questions.js","utf8");
const Q = new Function(src + "; return QUESTIONS;")();
const ids = new Set(); Q.forEach(q => { if (ids.has(q.id)) console.log("DUP", q.id); ids.add(q.id); });
console.log(Q.length, "questions");'
```

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

## Deployment

Push to `main`; GitHub Pages redeploys in a minute or so. DNS is a `geo` CNAME
on dancykier.com pointing at `moshed.github.io.` — see the
`dancykier_dns_namecheap` memory for the Namecheap API details and the
`EmailType=OX` landmine that breaks Moshe's email if a `setHosts` call omits it.
