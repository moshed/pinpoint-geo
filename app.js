/* Pinpoint — unlimited location practice.
   One rule everywhere in this file: amber is the player's guess, cyan is the truth. */

(function () {
  'use strict';

  const STORE = 'pinpoint.v2';   // v1 stored 5000-point scores; don't average them in
  const MAX_POINTS = 100;
  const PERFECT_MI = 15;         // inside this, call it nailed
  // GeoHistory's curve, matched to its one published data point: 500 miles off
  // costs you 30 points. Harsh up close, forgiving once you're already lost.
  const FALLOFF_MI = 1400;
  const REVEAL_MS = 850;   // line growth and the distance readout share this beat

  const prefersReducedMotion = () =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Supabase "Misc" project. This is the publishable key — it is meant to ship in
  // client code. It grants INSERT on pin_rounds and nothing else: the table has no
  // SELECT policy, and history is read back through pin_stats(player_id), so your
  // rounds are only reachable by someone who knows your player uuid.
  const SB_URL = 'https://atqhfbaurrmivjarowco.supabase.co';
  const SB_KEY = 'sb_publishable_G44hmJHuAwEcoxq0QPWI7w_BWt_owiB';

  const TOPICS = [
    { id: 'history',  name: 'History & events' },
    { id: 'landmark', name: 'Landmarks & monuments' },
    { id: 'nature',   name: 'Natural wonders' },
    { id: 'city',     name: 'Cities & capitals' },
    { id: 'culture',  name: 'Culture & institutions' }
  ];

  const $ = (id) => document.getElementById(id);

  const el = {
    round: $('g-round'), mean: $('g-mean'), miss: $('g-miss'), best: $('g-best'),
    unit: $('unit-toggle'), openSettings: $('open-settings'), closeSettings: $('close-settings'),
    settings: $('settings'), topicGrid: $('topic-grid'), poolCount: $('pool-count'),
    logList: $('log-list'), logEmpty: $('log-empty'), resetLog: $('reset-log'),
    prompt: $('prompt'), qCat: $('q-cat'), qN: $('q-n'), qText: $('q-text'),
    dockIdle: $('dock-idle'), dockResult: $('dock-result'), hint: $('hint'),
    confirm: $('confirm'), next: $('next'),
    rDist: $('r-dist'), rUnit: $('r-unit'), rBearing: $('r-bearing'),
    rScore: $('r-score'), rName: $('r-name'), rNote: $('r-note'),
    cursor: $('cursor-readout')
  };

  /* ── persisted state ──────────────────────────────────── */

  const defaults = () => ({
    unit: 'mi',
    topics: TOPICS.map(t => t.id),
    played: [],
    rounds: []   // { n, km, score, name }
  });

  let state = load();

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE));
      if (!raw || typeof raw !== 'object') return defaults();
      const d = defaults();
      return {
        unit: raw.unit === 'km' ? 'km' : 'mi',
        topics: Array.isArray(raw.topics) && raw.topics.length ? raw.topics : d.topics,
        played: Array.isArray(raw.played) ? raw.played : [],
        rounds: Array.isArray(raw.rounds) ? raw.rounds : []
      };
    } catch (e) { return defaults(); }
  }

  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* private mode */ }
  }

  /* ── player identity & remote log ─────────────────────── */

  // A random key per browser, shown in the Progress panel so it can be copied to
  // another device. No login: knowing the key is what grants access to the history.
  const KEY_STORE = 'pinpoint.player';
  let memoryKey = null;

  const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || '');

  function playerKey() {
    let id;
    try { id = localStorage.getItem(KEY_STORE); } catch (e) { id = memoryKey; }
    if (!isUuid(id)) {
      id = (crypto && crypto.randomUUID) ? crypto.randomUUID()
         : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
             const r = Math.random() * 16 | 0;
             return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
           });
      setPlayerKey(id);
    }
    return id;
  }

  function setPlayerKey(id) {
    memoryKey = id;
    try { localStorage.setItem(KEY_STORE, id); } catch (e) { /* private mode */ }
  }

  function logRound(q, g, km, pts) {
    const body = {
      player_id: playerKey(),
      question_id: q.id, question: q.q, answer: q.a, category: q.cat,
      guess_lat: +g.lat.toFixed(5), guess_lon: +g.lon.toFixed(5),
      answer_lat: q.lat, answer_lon: q.lon,
      miss_km: +km.toFixed(3), score: pts
    };
    fetch(SB_URL + '/rest/v1/pin_rounds', {
      method: 'POST',
      headers: {
        'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal'
      },
      body: JSON.stringify(body),
      keepalive: true
    }).catch(() => { /* offline: the round still counts locally */ });
  }

  function fetchStats() {
    return fetch(SB_URL + '/rest/v1/rpc/pin_stats', {
      method: 'POST',
      headers: {
        'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ p_player: playerKey() })
    }).then(r => r.ok ? r.json() : Promise.reject(r.status));
  }

  /* ── geo maths ────────────────────────────────────────── */

  const R = 6371.0088;
  const rad = (d) => d * Math.PI / 180;
  const deg = (r) => r * 180 / Math.PI;

  function haversine(a, b) {
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const s = Math.sin(dLat / 2) ** 2 +
              Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  // Rhumb bearing, not great-circle. The player is reading a Mercator map, and
  // "you were WSW of it" should mean WSW as drawn — not a heading over the pole.
  function bearing(a, b) {
    const φ1 = rad(a.lat), φ2 = rad(b.lat);
    let Δλ = rad(b.lon - a.lon);
    if (Math.abs(Δλ) > Math.PI) Δλ -= Math.sign(Δλ) * 2 * Math.PI;
    const Δψ = Math.log(Math.tan(Math.PI / 4 + φ2 / 2) / Math.tan(Math.PI / 4 + φ1 / 2));
    return (deg(Math.atan2(Δλ, Δψ)) + 360) % 360;
  }

  const COMPASS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  const compass = (b) => COMPASS[Math.round(b / 22.5) % 16];

  // Great-circle path, with longitudes unwrapped so the line never
  // snaps back across the whole map at the antimeridian.
  function arc(a, b, steps) {
    const φ1 = rad(a.lat), λ1 = rad(a.lon), φ2 = rad(b.lat), λ2 = rad(b.lon);
    const d = 2 * Math.asin(Math.sqrt(
      Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2
    ));
    if (d === 0) return [[a.lat, a.lon], [b.lat, b.lon]];

    const pts = [];
    let prevLon = null;
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      const A = Math.sin((1 - f) * d) / Math.sin(d);
      const B = Math.sin(f * d) / Math.sin(d);
      const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
      const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
      const z = A * Math.sin(φ1) + B * Math.sin(φ2);
      let lat = deg(Math.atan2(z, Math.sqrt(x * x + y * y)));
      let lon = deg(Math.atan2(y, x));
      if (prevLon !== null) {
        while (lon - prevLon > 180) lon -= 360;
        while (lon - prevLon < -180) lon += 360;
      }
      prevLon = lon;
      pts.push([lat, lon]);
    }
    return pts;
  }

  // Scored in miles regardless of the display unit, so the curve doesn't move
  // when you flip the km/mi toggle.
  function scoreFor(km) {
    const mi = km * 0.621371;
    if (mi <= PERFECT_MI) return MAX_POINTS;
    return Math.max(0, Math.round(MAX_POINTS * Math.exp(-mi / FALLOFF_MI)));
  }

  /* ── formatting ───────────────────────────────────────── */

  const toUnit = (km) => state.unit === 'mi' ? km * 0.621371 : km;
  const unitLabel = () => state.unit;

  function fmtDist(km) {
    const v = toUnit(km);
    if (v < 10) return v.toFixed(1);
    return Math.round(v).toLocaleString('en-US');
  }

  function fmtCoord(lat, lon) {
    const la = Math.abs(lat).toFixed(4).padStart(7, '0') + ' ' + (lat >= 0 ? 'N' : 'S');
    const lo = Math.abs(lon).toFixed(4).padStart(8, '0') + ' ' + (lon >= 0 ? 'E' : 'W');
    return la + '  ' + lo;
  }

  /* ── map ──────────────────────────────────────────────── */

  const map = L.map('map', {
    worldCopyJump: true,
    minZoom: 2,
    maxZoom: 11,
    zoomControl: true,
    attributionControl: true,
    maxBounds: [[-88, -230], [88, 230]],
    maxBoundsViscosity: 0.6,
    // zoomSnap 0 stops zoom snapping to whole levels. The wheel is handled
    // manually below — Leaflet's own handler batches deltas behind a debounce
    // timer, which is what made trackpad zoom feel both slow and steppy.
    zoomSnap: 0,
    zoomDelta: 0.5,
    scrollWheelZoom: false
  }).setView([25, 10], 2);

  /* Trackpad zoom.

     Leaflet's own wheel handler batches deltas behind a debounce timer and runs
     them through a log curve, which reads as slow and steppy. But zooming with
     {animate:false} per frame — the obvious alternative — is worse: a
     non-animated setView fires `viewprereset`, and GridLayer's handler for that
     throws away every tile. Do it every frame and the map is blank for the whole
     gesture, because tiles never survive long enough to load.

     So: accumulate an absolute zoom target from the raw wheel deltas (fast,
     linear, no debounce), and hand it to Leaflet's *animated* path, which
     CSS-scales the existing tiles instead of dropping them. Leaflet silently
     drops a zoom request while one is already animating, so `pump` re-fires on
     zoomend until the map has caught up with the target. */
  (function wheelZoom() {
    const el = map.getContainer();
    const DURATION = 0.12;
    let target = map.getZoom(), point = null, last = -1e6;

    const gestureActive = () => performance.now() - last < 400;

    const pump = () => {
      if (!gestureActive() || !point) return;      // don't hijack fitBounds/setView
      if (map._animatingZoom) return;              // request would be dropped; zoomend retries
      if (Math.abs(target - map.getZoom()) < 0.004) return;
      map.setZoomAround(point, target, { animate: true, duration: DURATION });
    };
    map.on('zoomend', pump);

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;        // lines
      else if (e.deltaMode === 2) dy *= 400;  // pages

      const now = performance.now();
      if (now - last > 250) target = map.getZoom();   // fresh gesture: resync
      last = now;

      // macOS pinch-to-zoom arrives as ctrl+wheel, with much smaller deltas.
      const speed = e.ctrlKey ? 0.03 : 0.007;
      target = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), target - dy * speed));
      point = map.mouseEventToContainerPoint(e);
      pump();
    }, { passive: false });
  })();

  const ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

  const blindLayer = L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
    { attribution: ATTRIB, subdomains: 'abcd', maxZoom: 11 }
  ).addTo(map);

  // Only shown after you commit — labels while guessing would be the answer key.
  const namedLayer = L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    { attribution: ATTRIB, subdomains: 'abcd', maxZoom: 11 }
  );

  // The raster basemap's own borders are far too faint to guess against, so
  // country lines are drawn as vectors on top of whichever basemap is showing.
  fetch('borders.json')
    .then(r => r.ok ? r.json() : Promise.reject(r.status))
    .then(geo => {
      L.geoJSON(geo, {
        interactive: false,
        style: { color: '#8fb3c2', weight: 0.9, opacity: 0.9, fill: false }
      }).addTo(map);
    })
    .catch(() => { /* borders are an enhancement — the game works without them */ });

  const pinIcon = (cls) => L.divIcon({
    className: '',
    html: '<div class="pin ' + cls + '"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8]
  });

  let guessMarker = null, fixMarker = null, fixLabel = null, line = null;
  let guess = null, current = null, phase = 'guessing';

  map.on('click', (e) => {
    if (phase !== 'guessing') return;
    guess = { lat: e.latlng.lat, lon: ((e.latlng.lng + 540) % 360) - 180 };
    if (!guessMarker) {
      guessMarker = L.marker(e.latlng, { icon: pinIcon('pin-guess'), keyboard: false }).addTo(map);
    } else {
      guessMarker.setLatLng(e.latlng);
    }
    el.confirm.disabled = false;
    el.hint.textContent = fmtCoord(guess.lat, guess.lon);
    el.hint.classList.add('ready');
  });

  map.on('mousemove', (e) => {
    el.cursor.textContent = fmtCoord(e.latlng.lat, ((e.latlng.lng + 540) % 360) - 180);
  });

  function clearMarks() {
    [guessMarker, fixMarker, fixLabel, line].forEach(m => { if (m) map.removeLayer(m); });
    guessMarker = fixMarker = fixLabel = line = null;
    if (map.hasLayer(namedLayer)) { map.removeLayer(namedLayer); map.addLayer(blindLayer); }
  }

  /* ── question pool ────────────────────────────────────── */

  function pool() {
    return QUESTIONS.filter(q => state.topics.includes(q.cat));
  }

  function pickQuestion() {
    let p = pool();
    if (!p.length) { state.topics = TOPICS.map(t => t.id); p = pool(); }
    let unseen = p.filter(q => !state.played.includes(q.id));
    if (!unseen.length) {                       // seen them all — go round again
      state.played = state.played.filter(id => !p.some(q => q.id === id));
      unseen = p;
    }
    return unseen[Math.floor(Math.random() * unseen.length)];
  }

  /* ── round flow ───────────────────────────────────────── */

  function newRound() {
    phase = 'guessing';
    guess = null;
    clearMarks();
    current = pickQuestion();

    el.qCat.textContent = current.cat;
    el.qN.textContent = 'Round ' + (state.rounds.length + 1);
    el.qText.textContent = current.q;
    el.prompt.classList.remove('swap');
    void el.prompt.offsetWidth;
    el.prompt.classList.add('swap');

    el.dockResult.hidden = true;
    el.dockIdle.hidden = false;
    el.confirm.disabled = true;
    el.hint.textContent = 'Click the map to drop your pin.';
    el.hint.classList.remove('ready');

    map.setView([25, 10], window.innerWidth < 700 ? 1 : 2, { animate: false });
    renderGauges();
    syncPromptHeight();
  }

  // The prompt card floats over the map; tell CSS how tall it is so the
  // zoom buttons can sit below it on narrow screens.
  function syncPromptHeight() {
    requestAnimationFrame(() => {
      document.documentElement.style.setProperty('--prompt-h', el.prompt.offsetHeight + 'px');
    });
  }

  function commit() {
    if (phase !== 'guessing' || !guess) return;
    phase = 'revealed';

    const truth = { lat: current.lat, lon: current.lon };
    const km = haversine(guess, truth);
    const pts = scoreFor(km);
    const brg = compass(bearing(truth, guess));   // where the player landed, seen from the answer

    map.removeLayer(blindLayer);
    map.addLayer(namedLayer);

    const path = arc(guess, truth, 96);
    const fixLatLng = [truth.lat, path[path.length - 1][1]];

    // Frame the whole shot first, then run the line out to the answer inside it.
    const pad = window.innerWidth < 700 ? [30, 120] : [40, 150];
    map.fitBounds(L.latLngBounds(path), {
      paddingTopLeft: [pad[0], pad[1]],
      paddingBottomRight: [pad[0], window.innerWidth < 700 ? 260 : 250],
      maxZoom: 8,
      animate: true
    });

    line = L.polyline([path[0]], {
      color: '#7e9ca9', weight: 1.5, opacity: .85, dashArray: '5 5'
    }).addTo(map);

    const landAnswer = () => {
      if (phase !== 'revealed' || !line) return;       // round moved on
      fixMarker = L.marker(fixLatLng, { icon: pinIcon('pin-fix'), keyboard: false }).addTo(map);
      fixLabel = L.marker(fixLatLng, {
        icon: L.divIcon({ className: '', html: '<div class="fix-label">' + escapeHtml(current.a) + '</div>', iconSize: [0, 0] }),
        keyboard: false, interactive: false
      }).addTo(map);
    };

    // The line runs out from your pin toward the truth, in step with the
    // distance readout counting up — so you watch the miss accumulate.
    if (prefersReducedMotion()) {
      line.setLatLngs(path);
      landAnswer();
    } else {
      const t0 = performance.now();
      (function grow(now) {
        if (phase !== 'revealed' || !line) return;
        const p = Math.max(0, Math.min(1, (now - t0) / REVEAL_MS));
        const eased = 1 - Math.pow(1 - p, 3);
        const upto = Math.max(2, Math.round(eased * (path.length - 1)) + 1);
        line.setLatLngs(path.slice(0, upto));
        if (p < 1) requestAnimationFrame(grow);
        else { line.setLatLngs(path); landAnswer(); }
      })(t0);
      // Belt and braces: if rAF never runs (backgrounded tab), still land it.
      setTimeout(() => {
        if (phase === 'revealed' && line && !fixMarker) { line.setLatLngs(path); landAnswer(); }
      }, REVEAL_MS + 250);
    }

    el.dockIdle.hidden = true;
    el.dockResult.hidden = false;
    el.rUnit.textContent = unitLabel();
    el.rBearing.textContent = km * 0.621371 <= PERFECT_MI ? 'on it' : brg + ' of it';
    el.rName.textContent = current.a;
    el.rNote.textContent = current.note || '';
    countTo(el.rDist, toUnit(km), km);
    countTo(el.rScore, pts, null);
    el.next.focus({ preventScroll: true });

    state.played.push(current.id);
    state.rounds.push({ n: state.rounds.length + 1, km: km, score: pts, name: current.a });
    save();
    logRound(current, guess, km, pts);
    renderLog();
    renderGauges();
  }

  // The ranging readout: numbers spin up like a rangefinder settling.
  function countTo(node, target, km) {
    const render = (v) => {
      node.textContent = km === null
        ? Math.round(v).toLocaleString('en-US')
        : (v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString('en-US'));
    };
    if (prefersReducedMotion()) { render(target); return; }
    const dur = REVEAL_MS;
    let t0 = null, done = false;
    requestAnimationFrame(function step(now) {
      if (done) return;
      if (t0 === null) t0 = now;
      const p = Math.max(0, Math.min(1, (now - t0) / dur));
      render(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
    });
    render(0);
    // If the tab is backgrounded, rAF never fires and the readout would sit at zero.
    setTimeout(() => { done = true; render(target); }, dur + 250);
  }

  /* ── rendering ────────────────────────────────────────── */

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function scoreColor(pts) {
    if (pts >= 80) return 'var(--fix)';
    if (pts >= 50) return '#9fd9c4';
    if (pts >= 20) return 'var(--signal)';
    return '#c9765a';
  }

  function renderLog() {
    const rounds = state.rounds.slice().reverse().slice(0, 200);
    el.logEmpty.hidden = rounds.length > 0;
    el.logList.innerHTML = rounds.map(r =>
      '<li>' +
        '<span class="li-n">' + String(r.n).padStart(3, '0') + '</span>' +
        '<span class="li-d">' + fmtDist(r.km) + ' ' + unitLabel() + '</span>' +
        '<span class="li-s" style="color:' + scoreColor(r.score) + '">' + r.score + '</span>' +
        '<span class="li-place">' + escapeHtml(r.name) + '</span>' +
      '</li>'
    ).join('');
  }

  function renderGauges() {
    const rs = state.rounds;
    el.round.textContent = String(rs.length + 1).padStart(3, '0');
    if (!rs.length) {
      el.mean.textContent = el.miss.textContent = el.best.textContent = '—';
      return;
    }
    const mean = rs.reduce((a, r) => a + r.score, 0) / rs.length;
    const sorted = rs.map(r => r.km).sort((a, b) => a - b);
    const mid = sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    el.mean.textContent = Math.round(mean).toLocaleString('en-US');
    el.miss.textContent = fmtDist(mid) + ' ' + unitLabel();
    el.best.textContent = fmtDist(sorted[0]) + ' ' + unitLabel();
  }

  function renderTopics() {
    el.topicGrid.innerHTML = TOPICS.map(t => {
      const on = state.topics.includes(t.id);
      const n = QUESTIONS.filter(q => q.cat === t.id).length;
      return '<button type="button" class="topic" data-topic="' + t.id + '" aria-pressed="' + on + '">' +
        '<span class="box" aria-hidden="true"></span>' +
        '<span class="t-name">' + t.name + '</span>' +
        '<span class="t-count">' + n + '</span>' +
      '</button>';
    }).join('');
    el.poolCount.textContent = pool().length + ' questions in play';
  }

  /* ── progress panel ───────────────────────────────────── */

  const P = {
    sheet: $('progress'), body: $('prog-body'), note: $('prog-note'),
    total: $('p-total'), mean: $('p-mean'), median: $('p-median'), best: $('p-best'),
    daily: $('p-daily'), readout: $('p-readout'), cats: $('p-cats'), tough: $('p-tough'),
    key: $('p-key'), keyForm: $('key-form'), keyInput: $('key-input')
  };

  const CAT_NAME = TOPICS.reduce((m, t) => (m[t.id] = t.name, m), {});

  function loadProgress() {
    P.body.hidden = true;
    P.note.textContent = 'Loading your history…';
    P.key.textContent = playerKey();
    fetchStats().then(stats => {
      if (!stats || !stats.total) {
        P.note.textContent = 'No rounds recorded yet under this key. Play a round and it will show up here.';
        return;
      }
      P.note.textContent = 'Recorded since ' + new Date(stats.first_played)
        .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) + '.';
      renderProgress(stats);
      P.body.hidden = false;
    }).catch(() => {
      P.note.textContent = 'Could not reach the results server. Your rounds are still saved locally.';
    });
  }

  function renderProgress(s) {
    P.total.textContent = s.total.toLocaleString('en-US');
    P.mean.textContent = s.mean_score;
    P.median.textContent = fmtDist(s.median_miss_km) + ' ' + unitLabel();
    P.best.textContent = fmtDist(s.best_miss_km) + ' ' + unitLabel();

    drawDaily(s.daily || []);

    const cats = (s.by_category || []);
    P.cats.innerHTML = cats.map(c =>
      '<div class="cat-row">' +
        '<span class="cat-name">' + escapeHtml(CAT_NAME[c.category] || c.category) + '</span>' +
        '<span class="cat-bar"><span class="cat-fill" style="width:' + Math.max(1.5, c.mean_score) + '%"></span></span>' +
        '<span class="cat-val">' + c.mean_score + '</span>' +
        '<span class="cat-n">' + c.rounds + '</span>' +
      '</div>'
    ).join('') || '<p class="empty-note">Nothing yet.</p>';

    P.tough.innerHTML = (s.toughest || []).map(t =>
      '<li><span class="tough-name">' + escapeHtml(t.answer) + '</span>' +
      '<span class="tough-score">' + t.mean_score + '</span>' +
      '<span class="tough-seen">×' + t.seen + '</span></li>'
    ).join('') || '<li class="empty-note">Nothing yet.</li>';
  }

  // Single series, magnitude over time: length carries the value, so the bars stay
  // one colour. Only the first and last day get an axis label — a date under every
  // bar is noise.
  function drawDaily(days) {
    // Match the viewBox to the rendered width so the SVG never scales, and the
    // axis type stays at its true size on a phone.
    const svg = P.daily;
    const W = Math.max(300, Math.min(640, Math.round(svg.parentNode.clientWidth) || 640));
    const H = 150, padL = 26, padR = 6, padT = 10, padB = 20;
    const data = days.slice(-45);
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    if (!data.length) { svg.innerHTML = ''; return; }

    const plotW = W - padL - padR, plotH = H - padT - padB;
    const y = v => padT + plotH * (1 - v / 100);
    const slot = plotW / data.length;
    const bw = Math.max(2, Math.min(22, slot - 2));   // 2px surface gap between bars

    let out = '';
    [0, 50, 100].forEach(v => {
      out += '<line class="grid" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>' +
             '<text class="ax" x="' + (padL - 6) + '" y="' + (y(v) + 3.5) + '" text-anchor="end">' + v + '</text>';
    });

    data.forEach((d, i) => {
      const x = padL + slot * i + (slot - bw) / 2;
      const top = y(d.mean_score), h = Math.max(1.5, y(0) - top), r = Math.min(3, bw / 2);
      out += '<path class="bar" d="' + roundedTop(x, top, bw, h, r) + '"' +
             ' data-day="' + d.day + '" data-score="' + d.mean_score + '" data-rounds="' + d.rounds + '"/>';
    });

    const fmtDay = iso => {
      const [Y, M, D] = iso.split('-').map(Number);
      return new Date(Y, M - 1, D).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    };
    out += '<text class="ax" x="' + padL + '" y="' + (H - 6) + '">' + fmtDay(data[0].day) + '</text>';
    if (data.length > 1) {
      out += '<text class="ax" x="' + (W - padR) + '" y="' + (H - 6) + '" text-anchor="end">' +
             fmtDay(data[data.length - 1].day) + '</text>';
    }
    svg.innerHTML = out;
  }

  // Bar with rounded top corners, square on the baseline.
  function roundedTop(x, y, w, h, r) {
    r = Math.min(r, h);
    return 'M' + x + ',' + (y + h) + 'V' + (y + r) +
           'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + -r +
           'h' + (w - 2 * r) +
           'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + r +
           'V' + (y + h) + 'Z';
  }

  P.daily.addEventListener('mouseover', (e) => {
    const b = e.target.closest('.bar');
    if (!b) return;
    const [Y, M, D] = b.dataset.day.split('-').map(Number);
    P.readout.textContent =
      new Date(Y, M - 1, D).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
      ' · ' + b.dataset.score + ' avg · ' + b.dataset.rounds +
      (b.dataset.rounds === '1' ? ' round' : ' rounds');
  });
  P.daily.addEventListener('mouseleave', () => { P.readout.innerHTML = '&nbsp;'; });

  /* ── wiring ───────────────────────────────────────────── */

  el.confirm.addEventListener('click', commit);
  el.next.addEventListener('click', newRound);

  el.unit.addEventListener('click', () => {
    state.unit = state.unit === 'km' ? 'mi' : 'km';
    el.unit.textContent = state.unit;
    el.rUnit.textContent = state.unit;
    save(); renderLog(); renderGauges();
    if (phase === 'revealed' && current) {
      const km = haversine(guess, { lat: current.lat, lon: current.lon });
      el.rDist.textContent = fmtDist(km);
    }
  });

  el.openSettings.addEventListener('click', () => {
    renderTopics();
    el.settings.hidden = false;
    el.openSettings.setAttribute('aria-expanded', 'true');
    el.closeSettings.focus();
  });

  const closeSheet = () => {
    el.settings.hidden = true;
    el.openSettings.setAttribute('aria-expanded', 'false');
    el.openSettings.focus();
  };
  el.closeSettings.addEventListener('click', closeSheet);
  el.settings.addEventListener('click', (e) => { if (e.target === el.settings) closeSheet(); });

  el.topicGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('.topic');
    if (!btn) return;
    const id = btn.dataset.topic;
    const on = state.topics.includes(id);
    if (on && state.topics.length === 1) return;   // never empty the pool
    state.topics = on ? state.topics.filter(t => t !== id) : state.topics.concat(id);
    save();
    renderTopics();
    if (phase === 'guessing' && current && !state.topics.includes(current.cat)) newRound();
  });

  $('open-progress').addEventListener('click', () => {
    P.sheet.hidden = false;
    $('open-progress').setAttribute('aria-expanded', 'true');
    $('close-progress').focus();
    loadProgress();
  });

  const closeProgress = () => {
    P.sheet.hidden = true;
    P.keyForm.hidden = true;
    $('open-progress').setAttribute('aria-expanded', 'false');
    $('open-progress').focus();
  };
  $('close-progress').addEventListener('click', closeProgress);
  P.sheet.addEventListener('click', (e) => { if (e.target === P.sheet) closeProgress(); });

  $('copy-key').addEventListener('click', () => {
    const btn = $('copy-key');
    navigator.clipboard.writeText(playerKey())
      .then(() => { btn.textContent = 'Copied'; setTimeout(() => btn.textContent = 'Copy', 1400); })
      .catch(() => { btn.textContent = 'Press ⌘C'; });
  });

  $('swap-key').addEventListener('click', () => {
    P.keyForm.hidden = !P.keyForm.hidden;
    if (!P.keyForm.hidden) { P.keyInput.value = ''; P.keyInput.focus(); }
  });

  P.keyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = P.keyInput.value.trim();
    if (!isUuid(v)) { P.keyInput.setAttribute('aria-invalid', 'true'); return; }
    P.keyInput.removeAttribute('aria-invalid');
    setPlayerKey(v);
    P.keyForm.hidden = true;
    loadProgress();
  });

  el.resetLog.addEventListener('click', () => {
    state.rounds = [];
    state.played = [];
    save(); renderLog(); renderGauges();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.settings.hidden) { closeSheet(); return; }
    if (e.key === 'Escape' && !P.sheet.hidden) { closeProgress(); return; }
    if (!P.sheet.hidden) return;
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
    if (e.key === 'Enter') {
      if (phase === 'guessing' && guess) commit();
      else if (phase === 'revealed') newRound();
    }
  });

  window.addEventListener('resize', () => { map.invalidateSize(); syncPromptHeight(); });

  /* ── go ───────────────────────────────────────────────── */

  el.unit.textContent = state.unit;
  renderLog();
  renderGauges();
  newRound();
})();
