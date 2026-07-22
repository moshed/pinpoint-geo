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
- **Tile filter is not decoration.** `.leaflet-tile-pane { filter: brightness(1.75)… }`
  — CARTO's dark basemap is close to unreadable at world zoom without it.
- **Rhumb bearing, not great-circle.** `bearing()` in `app.js` uses the rhumb
  line so "WSW of it" matches the Mercator map the player is looking at. A
  great-circle heading says things like "NW" for a guess that is visibly
  south-west, which reads as a bug.
- **Scoring:** `5000 · e^(−km/1500)`, with anything inside 25 km counted as a
  perfect 5000. Roughly: 500 km ≈ 3,580 pts, 1,000 km ≈ 2,570, 2,500 km ≈ 945.
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
