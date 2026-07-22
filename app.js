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
    // Continuous zoom. zoomSnap 0 stops the wheel from jumping between whole
    // zoom levels, which is what makes the default feel stepped on a trackpad.
    zoomSnap: 0,
    zoomDelta: 0.4,
    wheelPxPerZoomLevel: 200,
    wheelDebounceTime: 12
  }).setView([25, 10], 2);

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
    line = L.polyline(path, {
      color: '#7e9ca9', weight: 1.5, opacity: .85, dashArray: '5 5'
    }).addTo(map);

    const fixLatLng = [truth.lat, path[path.length - 1][1]];
    fixMarker = L.marker(fixLatLng, { icon: pinIcon('pin-fix'), keyboard: false }).addTo(map);
    fixLabel = L.marker(fixLatLng, {
      icon: L.divIcon({ className: '', html: '<div class="fix-label">' + escapeHtml(current.a) + '</div>', iconSize: [0, 0] }),
      keyboard: false, interactive: false
    }).addTo(map);

    const pad = window.innerWidth < 700 ? [30, 120] : [40, 150];
    map.fitBounds(L.latLngBounds(path), {
      paddingTopLeft: [pad[0], pad[1]],
      paddingBottomRight: [pad[0], window.innerWidth < 700 ? 260 : 250],
      maxZoom: 8,
      animate: true
    });

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
    renderLog();
    renderGauges();
  }

  // The ranging readout: numbers spin up like a rangefinder settling.
  function countTo(node, target, km) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const render = (v) => {
      node.textContent = km === null
        ? Math.round(v).toLocaleString('en-US')
        : (v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString('en-US'));
    };
    if (reduce) { render(target); return; }
    const dur = 850;
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

  el.resetLog.addEventListener('click', () => {
    state.rounds = [];
    state.played = [];
    save(); renderLog(); renderGauges();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.settings.hidden) { closeSheet(); return; }
    if (e.target.tagName === 'BUTTON') return;
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
