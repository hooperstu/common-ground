/* Common Ground: find the fairest place for a group to meet by car.
 *
 * How it stays live: drive times from every person to a grid of candidate spots are fetched once
 * and cached. Moving a slider only re-scores that cached grid in the browser, so the meeting point,
 * zone and summary move instantly. Real road routes for the new point are then fetched in the
 * background (and cached), and a finer grid is fetched around the winner to sharpen it.
 */
(function () {
  'use strict';
  const CFG = window.CG_CONFIG;
  const F = window.Fairness;
  const STORE_KEY = 'common-ground:v1';

  // ---------- State ----------
  const state = {
    people: [], // {id, name, label, lat, lng, w, color, ride (driver id|null), carMode ('home'|'meet')}
    alpha: 0.75,
    candidates: new Map(), // key -> {key, lat, lng, spacing, fine, snapped:[lat,lng]|null, valid:bool|undefined}
    times: new Map(), // `${pid}|${key}` -> seconds|null
    dists: new Map(), // `${pid}|${key}` -> metres|null
    coarseSpacing: null,
    fineGroups: [], // keys of fine grids, newest last
    best: null, // scored entry
    zone: null,
    routes: new Map(), // `${pid}@${lat},${lng}>${key}` -> {coords, duration, distance, summary}
    places: new Map(),
    pp: new Map(), // `${a}>${b}` -> {t, d} home-to-home drive
    cars: [],
    pickups: new Map(), // driverId -> {key, originId, lat, lng} shown on the map
    venuePickups: new Map(), // neutral meet points used to choose the venue
    journeys: null,
    selected: null,
    syncGen: 0,
  };
  let nextId = 1;

  // ---------- Small helpers ----------
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function debounce(fn, ms) {
    let t;
    const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    d.cancel = () => clearTimeout(t);
    return d;
  }
  // 30 distinct colours, one per person, most distinct first.
  const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324', '#469990', '#000075',
    '#800000', '#808000', '#ffe119', '#000000', '#bfef45', '#ff8fab', '#a78bfa', '#6b7280', '#00a36c', '#c71585',
    '#14532d', '#7c2d12', '#0369a1', '#d2b48c', '#93c5fd', '#65a30d', '#ca8a04', '#155e75', '#a3a3a3', '#ff4500'];
  function colourFor(i) {
    return PALETTE[i % PALETTE.length];
  }
  function nextColour() {
    const used = new Set(state.people.map((p) => p.color));
    for (let i = 0; ; i++) if (!used.has(colourFor(i))) return colourFor(i);
  }
  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  // A polite, rate-limited request queue per free service.
  function makeQueue(gapMs) {
    let chain = Promise.resolve();
    let last = 0;
    return function enqueue(task) {
      const run = chain.then(async () => {
        const wait = last + gapMs - Date.now();
        if (wait > 0) await sleep(wait);
        last = Date.now();
        return task();
      });
      chain = run.catch(() => {});
      return run;
    };
  }
  const osrmQ = makeQueue(CFG.osrmGapMs);
  const nominatimQ = makeQueue(CFG.nominatimGapMs);

  async function fetchJson(url, opts, tries = 3) {
    for (let a = 0; ; a++) {
      try {
        const res = await fetch(url, opts);
        if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status}`), { retry: true });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw Object.assign(new Error((body && (body.error || body.message)) || `HTTP ${res.status}`), { body });
        return body;
      } catch (e) {
        if (a + 1 >= tries || (e.body !== undefined && !e.retry)) throw e;
        await sleep(1500 * (a + 1));
      }
    }
  }

  // ---------- Map ----------
  const map = L.map('map', { zoomControl: true, preferCanvas: false }).setView([54.2, -2.5], 6);
  L.tileLayer(CFG.tileUrl, { maxZoom: 18, attribution: CFG.tileAttribution }).addTo(map);
  const layers = {
    zone: L.layerGroup().addTo(map),
    routes: L.layerGroup().addTo(map),
    people: L.layerGroup().addTo(map),
    meet: L.layerGroup().addTo(map),
    pickups: L.layerGroup().addTo(map),
  };
  const markers = new Map();
  const routeLines = new Map();
  let meetMarker = null;

  function personIcon(p) {
    return L.divIcon({
      className: '',
      html: `<div class="pin" style="background:${p.color}"><span>${esc(initials(p.name))}</span></div>`,
      iconSize: [26, 26], iconAnchor: [13, 26], tooltipAnchor: [0, -24],
    });
  }

  function drawPeople() {
    for (const [id, m] of markers) {
      if (!state.people.find((p) => p.id === id)) { layers.people.removeLayer(m); markers.delete(id); }
    }
    for (const p of state.people) {
      let m = markers.get(p.id);
      if (!m) {
        m = L.marker([p.lat, p.lng], { draggable: true, icon: personIcon(p), autoPan: true }).addTo(layers.people);
        m.on('click', () => selectPerson(state.selected === p.id ? null : p.id));
        m.on('dragend', () => {
          const ll = m.getLatLng();
          movePerson(p.id, ll.lat, ll.lng);
        });
        markers.set(p.id, m);
      } else {
        m.setLatLng([p.lat, p.lng]);
        m.setIcon(personIcon(p));
      }
      m.bindTooltip(`<strong>${esc(p.name)}</strong><br>${esc(p.label)}`);
    }
  }

  function fitAll() {
    const pts = state.people.map((p) => [p.lat, p.lng]);
    if (state.best) pts.push(meetLatLng());
    if (pts.length === 1) map.setView(pts[0], 11);
    else if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 12 });
  }

  // ---------- People list UI ----------
  function renderPeople() {
    const ol = $('people');
    $('people-count').textContent = `${state.people.length}/${CFG.maxPeople}`;
    $('people-empty').hidden = state.people.length > 0;
    // Keep existing rows so a slider being dragged is not replaced mid-drag.
    const rows = new Map([...ol.children].map((li) => [Number(li.dataset.id), li]));
    for (const [id, li] of rows) if (!state.people.find((p) => p.id === id)) li.remove();
    state.people.forEach((p, idx) => {
      let li = rows.get(p.id);
      if (!li) {
        li = document.createElement('li');
        li.className = 'person';
        li.dataset.id = p.id;
        li.innerHTML = `
          <div class="person-top">
            <span class="swatch"></span>
            <span class="person-name" tabindex="0" ></span>
            <button class="icon-btn" type="button" aria-label="Remove">×</button>
          </div>
          <div class="person-addr"></div>
          <div class="controls">
            <input type="range" min="-100" max="100" step="1" aria-label="Travel less or more">
            <span class="weight-label"></span>
            <div class="select-wrap"><select class="ride" aria-label="Car"></select></div>
            <div class="seg mode" role="group" aria-label="Pickup" hidden>
              <button type="button" data-mode="home" title="Pick up from home">Home</button>
              <button type="button" data-mode="meet" title="Meet at a pickup point">Meet</button>
            </div>
          </div>`;
        const range = li.querySelector('input[type=range]');
        range.addEventListener('input', () => setWeight(p.id, Number(range.value)));
        range.addEventListener('change', () => { save(); scheduleRefine(); });
        range.addEventListener('dblclick', () => { range.value = 0; setWeight(p.id, 0); save(); scheduleRefine(); });
        li.querySelector('.icon-btn').addEventListener('click', () => removePerson(p.id));
        li.querySelector('.ride').addEventListener('change', (e) => setRide(p.id, e.target.value === '' ? null : Number(e.target.value)));
        li.querySelector('.mode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setMode(p.id, b.dataset.mode); });
        const nameEl = li.querySelector('.person-name');
        const startRename = () => renamePerson(p.id, nameEl);
        nameEl.addEventListener('click', startRename);
        nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') startRename(); });
      }
      li.querySelector('.swatch').style.background = p.color;
      const nameEl = li.querySelector('.person-name');
      if (!nameEl.querySelector('input')) nameEl.textContent = p.name;
      li.querySelector('.person-addr').textContent = p.label;
      const range = li.querySelector('input[type=range]');
      if (document.activeElement !== range) range.value = p.w;
      updateWeightLabel(li, p.w);
      renderLift(li, p);
      if (ol.children[idx] !== li) ol.insertBefore(li, ol.children[idx] || null);
    });
  }

  function renderLift(li, p) {
    const sel = li.querySelector('.ride');
    const hasPassengers = state.people.some((q) => q.ride === p.id);
    const drivers = state.people.filter((q) => q.id !== p.id && q.ride == null);
    const opts = hasPassengers
      ? [['', 'Driving']]
      : [['', 'Own car'], ...drivers.map((q) => [String(q.id), `In ${q.name}’s car`])];
    const sig = JSON.stringify(opts);
    if (sel.dataset.sig !== sig) {
      sel.innerHTML = opts.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('');
      sel.dataset.sig = sig;
    }
    sel.value = p.ride == null ? '' : String(p.ride);
    sel.disabled = hasPassengers;
    sel.classList.toggle('on', p.ride != null || hasPassengers);
    const mode = li.querySelector('.mode');
    mode.hidden = !hasPassengers;
    const driver = state.people.find((q) => q.id === p.ride);
    const noEffect = !!driver && driver.carMode !== 'meet';
    const range = li.querySelector('input[type=range]');
    range.disabled = noEffect;
    li.querySelector('.controls').classList.toggle('no-weight', noEffect);
    li.querySelector('.controls').classList.toggle('driving', hasPassengers);
    const cur = p.carMode === 'meet' ? 'meet' : 'home';
    mode.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === cur)));
  }

  function setRide(id, driverId) {
    const p = state.people.find((x) => x.id === id);
    if (!p) return;
    const d = state.people.find((x) => x.id === driverId);
    p.ride = d && d.ride == null && d.id !== id ? d.id : null;
    ridesChanged();
  }

  function setMode(id, mode) {
    const p = state.people.find((x) => x.id === id);
    if (!p) return;
    p.carMode = mode === 'meet' ? 'meet' : 'home';
    ridesChanged();
  }

  function ridesChanged() {
    renderPeople();
    save();
    recompute();
    scheduleSync();
  }

  function updateWeightLabel(li, w) {
    const lab = F.weightLabel(w);
    const el = li.querySelector('.weight-label');
    el.textContent = lab.text;
    el.className = `weight-label ${lab.cls}`;
  }

  function renamePerson(id, nameEl) {
    const p = state.people.find((x) => x.id === id);
    if (!p || nameEl.querySelector('input')) return;
    const input = document.createElement('input');
    input.type = 'text'; input.value = p.name; input.maxLength = 40;
    nameEl.textContent = ''; nameEl.appendChild(input); input.focus(); input.select();
    const done = () => {
      p.name = input.value.trim() || p.name;
      nameEl.textContent = p.name;
      drawPeople(); renderPeople(); renderSummary(); save();
    };
    input.addEventListener('blur', done, { once: true });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = p.name; input.blur(); } });
  }

  // ---------- People changes ----------
  function addPerson({ name, label, lat, lng, w = 0, ride = null, carMode = 'home' }) {
    if (state.people.length >= CFG.maxPeople) { flash(`Max ${CFG.maxPeople}.`, 'error'); return false; }
    const p = { id: nextId++, name: (name || '').trim() || `Person ${state.people.length + 1}`, label, lat, lng, w, ride, carMode, color: nextColour() };
    state.people.push(p);
    peopleChanged(true);
    return true;
  }

  function removePerson(id) {
    state.people = state.people.filter((p) => p.id !== id);
    for (const q of state.people) if (q.ride === id) q.ride = null;
    forgetPerson(id);
    peopleChanged(true);
  }

  function movePerson(id, lat, lng) {
    const p = state.people.find((x) => x.id === id);
    if (!p) return;
    p.lat = lat; p.lng = lng; p.label = `Pin at ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    forgetPerson(id);
    peopleChanged(false);
  }

  function forgetPerson(id) {
    for (const k of [...state.times.keys()]) if (k.startsWith(`${id}|`)) { state.times.delete(k); state.dists.delete(k); }
    for (const k of [...state.pp.keys()]) { const [a, b] = k.split('>'); if (+a === id || +b === id) state.pp.delete(k); }
  }

  function setWeight(id, w) {
    const p = state.people.find((x) => x.id === id);
    if (!p) return;
    p.w = w;
    const li = document.querySelector(`.person[data-id="${id}"]`);
    if (li) updateWeightLabel(li, w);
    recompute(); // live: local re-score only
  }

  function peopleChanged(refit) {
    drawPeople();
    renderPeople();
    save();
    if (refit) fitAll();
    if (state.people.length < 2) {
      clearResult();
      setStatus('');
      return;
    }
    recompute();
    scheduleSync();
  }

  // ---------- Drive-time matrix ----------
  const tkey = (pid, ckey) => `${pid}|${ckey}`;

  // Origins are people plus any lift-share meet points.
  function origins() {
    const pks = new Map([...state.pickups.values(), ...state.venuePickups.values()].map((pk) => [pk.originId, pk]));
    return [...state.people, ...[...pks.values()].map((pk) => ({ id: pk.originId, lat: pk.lat, lng: pk.lng }))];
  }

  async function fetchMatrix(people, cands, gen) {
    if (!people.length || !cands.length) return;
    const perCall = Math.max(10, 100 - people.length);
    for (let i = 0; i < cands.length; i += perCall) {
      if (gen !== state.syncGen) return;
      const chunk = cands.slice(i, i + perCall);
      const coords = [...people.map((p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`), ...chunk.map((c) => `${c.lng.toFixed(5)},${c.lat.toFixed(5)}`)];
      const src = people.map((_, k) => k).join(';');
      const dst = chunk.map((_, k) => k + people.length).join(';');
      const url = `${CFG.osrmUrl}/table/v1/driving/${coords.join(';')}?sources=${src}&destinations=${dst}&annotations=duration,distance`;
      const data = await osrmQ(() => fetchJson(url));
      if (!data || data.code !== 'Ok') throw new Error((data && data.message) || 'Routing service error');
      chunk.forEach((c, j) => {
        const d = data.destinations[j];
        if (c.valid === undefined) {
          // Skip grid points that are far from any road (sea, mountains).
          c.valid = d && d.distance <= Math.max(2500, c.spacing * 1000 * 0.6);
          c.snapped = d ? [d.location[1], d.location[0]] : null;
        }
        people.forEach((p, k) => {
          state.times.set(tkey(p.id, c.key), data.durations[k][j]);
          state.dists.set(tkey(p.id, c.key), data.distances ? data.distances[k][j] : null);
        });
      });
      recompute();
    }
  }

  // Work out which (person, candidate) drive times are missing and fetch them in as few calls as possible.
  async function fillMissing(cands, gen) {
    const os = origins();
    const missingCands = cands.filter((c) => c.valid !== false && os.some((p) => !state.times.has(tkey(p.id, c.key))));
    if (!missingCands.length) return;
    const needPeople = os.filter((p) => missingCands.some((c) => !state.times.has(tkey(p.id, c.key))));
    await fetchMatrix(needPeople, missingCands, gen);
  }

  // Home-to-home drive times, needed for lift-share home pickups.
  async function fillPeopleTable(gen) {
    const need = state.cars.some((c) => c.mode === 'home') &&
      state.people.some((a) => state.people.some((b) => a !== b && !state.pp.has(`${a.id}>${b.id}`)));
    if (!need || gen !== state.syncGen) return;
    const ppl = state.people.slice();
    const coords = ppl.map((p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`).join(';');
    const data = await osrmQ(() => fetchJson(`${CFG.osrmUrl}/table/v1/driving/${coords}?annotations=duration,distance`));
    if (!data || data.code !== 'Ok') throw new Error('Routing service error');
    ppl.forEach((a, i) => ppl.forEach((b, j) => {
      if (i !== j) state.pp.set(`${a.id}>${b.id}`, { t: data.durations[i][j], d: data.distances ? data.distances[i][j] : null });
    }));
    recompute();
  }

  const scheduleSync = debounce(sync, 500);
  async function sync() {
    if (state.people.length < 2) return;
    const gen = ++state.syncGen;
    const grid = F.coarseGrid(state.people);
    if (grid.spacing !== state.coarseSpacing) {
      // The area changed a lot: start a fresh grid.
      state.candidates.clear(); state.times.clear(); state.dists.clear(); state.fineGroups = []; state.pickups.clear(); state.venuePickups.clear();
      state.coarseSpacing = grid.spacing;
    }
    // Keep fine points and coarse points still inside the area; add any new coarse points.
    const keep = new Set(grid.points.map((g) => g.key));
    for (const [k, c] of state.candidates) if (!c.fine && !keep.has(k)) state.candidates.delete(k);
    for (const g of grid.points) if (!state.candidates.has(g.key)) state.candidates.set(g.key, { ...g, fine: false });
    // Finer spots around each lift-share car's members, so meet points can sit close to home.
    for (const car of F.buildCars(state.people)) {
      if (car.mode !== 'meet') continue;
      const ms = [car.driver, ...car.passengers];
      const mid = { lat: ms.reduce((a, m) => a + m.lat, 0) / ms.length, lng: ms.reduce((a, m) => a + m.lng, 0) / ms.length };
      for (const g of F.fineGrid(mid, Math.max(state.coarseSpacing, 6)).points) if (!state.candidates.has(g.key)) state.candidates.set(g.key, { ...g, fine: true, pickupGrid: true });
    }
    try {
      setStatus('Calculating…', 'working');
      await fillMissing([...state.candidates.values()], gen);
      if (gen !== state.syncGen) return;
      await fillPeopleTable(gen);
      if (gen !== state.syncGen) return;
      recompute();
      await fillMissing([...state.candidates.values()], gen); // rows for any new meet points
      if (gen !== state.syncGen) return;
      await refine(gen);
      if (gen !== state.syncGen) return;
      setStatus('');
    } catch (e) {
      if (gen === state.syncGen) setStatus('Routing service busy. Try again shortly.', 'error');
    }
  }

  // Add a finer grid around the current best spot so the answer is sharp, not just grid-sized.
  async function refine(gen) {
    if (!state.best) return;
    const best = state.best.cand;
    const grid = F.fineGrid(best, state.coarseSpacing);
    const groupKey = `${best.key}`;
    if (!state.fineGroups.includes(groupKey)) {
      state.fineGroups.push(groupKey);
      for (const g of grid.points) if (!state.candidates.has(g.key)) state.candidates.set(g.key, { ...g, fine: true });
      // Cap memory: drop the oldest fine grids.
      while (state.fineGroups.length > 8) {
        const old = state.fineGroups.shift();
        const oc = state.candidates.get(old);
        if (oc) for (const g of F.fineGrid(oc, state.coarseSpacing).points) {
          if (state.best && state.best.cand.key === g.key) continue;
          state.candidates.delete(g.key);
        }
      }
    }
    await fillMissing(grid.points.map((g) => state.candidates.get(g.key)).filter(Boolean), gen);
  }

  const scheduleRefine = debounce(async () => {
    if (state.people.length < 2 || !state.best) return;
    const gen = state.syncGen;
    try { await refine(gen); } catch (e) { /* refinement is optional */ }
  }, 700);

  // ---------- Scoring (local, instant) ----------
  function recompute() {
    if (state.people.length < 2) { clearResult(); return; }
    const cands = [...state.candidates.values()].filter((c) => c.valid);
    const t = (o, k) => state.times.get(tkey(o, k));
    const d = (o, k) => state.dists.get(tkey(o, k));
    state.cars = F.buildCars(state.people);
    // Meet points. The venue is chosen using neutral meet points (no sliders), so a passenger's slider
    // never moves the venue; the meet point actually shown follows each member's own slider.
    const gridReady = ![...state.candidates.values()].some((c) => c.valid === undefined);
    const anchorHit = state.cars.some((c) => c.mode === 'meet') && F.scoreCandidates(state.people.map((p) => ({ id: p.id, w: 0 })), cands, t, 0.75)[0];
    const anchor = anchorHit ? anchorHit.cand : null;
    let needRows = false;
    const pickFor = (old, weighted) => {
      const out = new Map();
      for (const car of state.cars) {
        if (car.mode !== 'meet') continue;
        if (!gridReady) { const o = old.get(car.driver.id); if (o) out.set(car.driver.id, o); continue; }
        const members = [car.driver, ...car.passengers].map((m) => ({ id: m.id, w: weighted ? m.w : 0 }));
        const pc = F.choosePickup(members, cands, t, anchor);
        if (!pc) continue;
        const ll = pc.snapped || [pc.lat, pc.lng];
        const pk = { key: pc.key, originId: `x:${pc.key}`, lat: ll[0], lng: ll[1] };
        out.set(car.driver.id, pk);
        if (cands.some((c) => !state.times.has(tkey(pk.originId, c.key)))) needRows = true;
      }
      return out;
    };
    const newVenuePickups = pickFor(state.venuePickups, false);
    const newPickups = pickFor(state.pickups, true);
    const pickupsChanged = JSON.stringify([...newPickups]) !== JSON.stringify([...state.pickups]) ||
      JSON.stringify([...newVenuePickups]) !== JSON.stringify([...state.venuePickups]);
    state.pickups = newPickups;
    state.venuePickups = newVenuePickups;
    if (needRows && pickupsChanged) scheduleSync();
    const pp = (a, b) => { const v = state.pp.get(`${a}>${b}`); return v ? v.t : null; };
    const ppd = (a, b) => { const v = state.pp.get(`${a}>${b}`); return v ? v.d : null; };
    state.journeys = F.journeys(state.people, state.cars, { t, d, pp, ppd, pickups: state.pickups });
    const venueJourneys = F.journeys(state.people, state.cars, { t, d, pp, ppd, pickups: state.venuePickups });
    const scored = F.scoreCandidates(F.venueWeights(state.people, state.cars), cands, (pid, key) => venueJourneys.get(pid).t(key), state.alpha);
    if (!scored.length) {
      if (state.candidates.size && [...state.candidates.values()].every((c) => c.valid !== undefined) && cands.length) {
        setStatus('No route found for everyone.', 'error');
      }
      return;
    }
    const prevKey = state.best && state.best.cand.key;
    state.best = scored[0];
    state.zone = F.fairZone(scored);
    drawResult();
    renderSummary();
    if (prevKey !== state.best.cand.key || pickupsChanged) {
      scheduleRoutes();
      scheduleRefine();
      schedulePlace();
    }
  }

  function meetLatLng() {
    const c = state.best.cand;
    return c.snapped || [c.lat, c.lng];
  }

  function clearResult() {
    state.best = null; state.zone = null;
    layers.zone.clearLayers(); layers.routes.clearLayers(); layers.meet.clearLayers(); layers.pickups.clearLayers();
    routeLines.clear(); meetMarker = null;
    $('summary').hidden = true;
    $('chip').hidden = true;
  }

  function drawResult() {
    const ll = meetLatLng();
    layers.zone.clearLayers();
    if (state.zone) {
      L.polygon(state.zone.polygon, { color: '#111', weight: 1.5, dashArray: '5 5', fillColor: '#4f46e5', fillOpacity: 0.12, interactive: true })
        
        .addTo(layers.zone);
    }
    if (!meetMarker) {
      meetMarker = L.marker(ll, {
        icon: L.divIcon({ className: '', html: '<div class="meet" aria-label="Meeting point">★</div>', iconSize: [34, 34], iconAnchor: [17, 17] }),
        zIndexOffset: 1000,
      }).addTo(layers.meet);
      
    } else meetMarker.setLatLng(ll);
    drawRoutes();
  }

  // ---------- Routes ----------
  // A leg is one line on the map: a solo drive, a shared car, or a walk-up drive to a meet point.
  function legs() {
    if (!state.best) return [];
    const venue = meetLatLng();
    const at = (p) => [p.lat, p.lng];
    const out = [];
    const inCar = new Set();
    for (const car of state.cars) {
      const members = [car.driver, ...car.passengers];
      members.forEach((m) => inCar.add(m.id));
      if (car.mode === 'home') {
        const j = state.journeys.get(car.driver.id);
        const order = (j && j.order) || members;
        out.push({ id: `car${car.driver.id}`, color: car.driver.color, pts: [...order.map(at), venue], people: members.map((m) => m.id), main: true, weight: 6 });
      } else {
        const pk = state.pickups.get(car.driver.id);
        if (!pk) { members.forEach((m) => inCar.delete(m.id)); continue; }
        for (const m of members) out.push({ id: `to${m.id}`, color: m.color, pts: [at(m), [pk.lat, pk.lng]], people: [m.id], dashed: true });
        out.push({ id: `car${car.driver.id}`, color: car.driver.color, pts: [[pk.lat, pk.lng], venue], people: members.map((m) => m.id), main: true, weight: 6 });
      }
    }
    for (const p of state.people) if (!inCar.has(p.id)) out.push({ id: `p${p.id}`, color: p.color, pts: [at(p), venue], people: [p.id], main: true });
    return out;
  }
  const legKey = (leg) => leg.pts.map(([a, b]) => `${a.toFixed(5)},${b.toFixed(5)}`).join(';');

  function drawRoutes() {
    if (!state.best) return;
    const live = new Set();
    for (const leg of legs()) {
      live.add(leg.id);
      const k = legKey(leg);
      const r = state.routes.get(k);
      const sig = `${r ? 'r' : 's'}:${k}:${leg.color}:${leg.people.join(',')}`;
      const existing = routeLines.get(leg.id);
      if (existing && existing.sig === sig) continue;
      if (existing) layers.routes.removeLayer(existing.layer);
      const w = leg.weight || 4;
      let layer;
      const colors = leg.people.length > 1 ? leg.people.map((id) => (state.people.find((q) => q.id === id) || {}).color).filter(Boolean) : [];
      if (r && colors.length > 1) {
        // Shared car: alternating dashes in the colour of everyone on board, starting with the driver.
        const dash = 14;
        layer = L.layerGroup([
          L.polyline(r.coords, { color: '#fff', weight: w + 3, opacity: 0.9, lineCap: 'butt' }),
          ...colors.map((c, i) => L.polyline(r.coords, {
            color: c, weight: w, opacity: 1, lineCap: 'butt',
            dashArray: `${dash} ${dash * (colors.length - 1)}`, dashOffset: String(-dash * i),
          })),
        ]);
      } else if (r) {
        layer = L.layerGroup([
          L.polyline(r.coords, { color: '#fff', weight: w + 3, opacity: 0.85 }),
          L.polyline(r.coords, { color: leg.color, weight: w, opacity: 0.95, dashArray: leg.dashed ? '8 6' : null }),
        ]);
      } else {
        layer = L.polyline(leg.pts, { color: leg.color, weight: 2.5, opacity: 0.8, dashArray: '2 8' });
      }
      layer.addTo(layers.routes);
      layer.on('click', (ev) => { L.DomEvent.stopPropagation(ev); selectPerson(leg.people.includes(state.selected) ? null : leg.people[0]); });
      routeLines.set(leg.id, { sig, layer, people: leg.people });
    }
    for (const [id, v] of routeLines) if (!live.has(id)) { layers.routes.removeLayer(v.layer); routeLines.delete(id); }
    applySelection();
    // Meet points.
    layers.pickups.clearLayers();
    for (const [did, pk] of state.pickups) {
      const d = state.people.find((p) => p.id === did);
      if (!d) continue;
      L.marker([pk.lat, pk.lng], {
        icon: L.divIcon({ className: '', html: `<div class="pickup" style="border-color:${d.color}">⇄</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }),
        zIndexOffset: 900,
      }).addTo(layers.pickups);
    }
  }

  let routeGen = 0;
  const scheduleRoutes = debounce(fetchRoutes, 450);
  async function fetchRoutes() {
    if (!state.best) return;
    const gen = ++routeGen;
    for (const leg of legs()) {
      if (gen !== routeGen) return;
      const k = legKey(leg);
      if (state.routes.has(k)) continue;
      const url = `${CFG.osrmUrl}/route/v1/driving/${leg.pts.map(([a, b]) => `${b.toFixed(5)},${a.toFixed(5)}`).join(';')}?overview=full&geometries=geojson&steps=false`;
      try {
        const data = await osrmQ(() => (gen === routeGen ? fetchJson(url) : null));
        if (!data) return;
        if (data.code !== 'Ok' || !data.routes || !data.routes.length) continue;
        const route = data.routes[0];
        const roads = [];
        for (const l of route.legs || []) for (const n of String(l.summary || '').split(', ')) if (n && !roads.includes(n)) roads.push(n);
        state.routes.set(k, { coords: route.geometry.coordinates.map(([x, y]) => [y, x]), summary: roads.slice(0, 3).join(', ') });
        if (state.routes.size > 600) state.routes.delete(state.routes.keys().next().value);
        if (gen === routeGen) { drawRoutes(); renderSummary(); }
      } catch (e) { /* keep the straight line */ }
    }
  }

  // ---------- Place name ----------
  const schedulePlace = debounce(async () => {
    if (!state.best) return;
    const [lat, lng] = meetLatLng();
    const k = `${lat.toFixed(3)},${lng.toFixed(3)}`;
    if (!state.places.has(k)) {
      try {
        const d = await nominatimQ(() => fetchJson(`${CFG.nominatimUrl}/reverse?format=jsonv2&zoom=14&lat=${lat}&lon=${lng}`));
        const a = (d && d.address) || {};
        const town = a.village || a.town || a.city || a.hamlet || a.suburb || a.municipality || (d && d.name) || '';
        const area = a.county || a.state_district || a.city || a.state || '';
        state.places.set(k, { town, area: area && area !== town ? area : '' });
      } catch (e) { state.places.set(k, { town: '', area: '' }); }
    }
    renderSummary();
  }, 1200);

  // ---------- Summary ----------
  function routeInfo(p) {
    const key = state.best.cand.key;
    const j = state.journeys.get(p.id);
    const myLegs = legs().filter((l) => l.main && l.people.includes(p.id));
    const r = myLegs.length ? state.routes.get(legKey(myLegs[0])) : null;
    let car = '';
    if (j && j.car) {
      const others = [j.car.driver, ...j.car.passengers].filter((m) => m.id !== p.id).map((m) => m.name);
      car = `${j.car.driver.id === p.id ? 'Driving' : 'With'} ${others.join(', ')}${j.car.mode === 'meet' ? ' · meet point' : ''}`;
    }
    return { time: j.t(key), dist: j.d(key), via: r ? r.summary : '', exact: !!r, car };
  }

  function renderSummary() {
    if (!state.best) return;
    $('summary').hidden = false;
    const [lat, lng] = meetLatLng();
    const place = state.places.get(`${lat.toFixed(3)},${lng.toFixed(3)}`);
    const name = place && place.town ? place.town : `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    $('place').innerHTML = `${esc(name)}${place && place.area ? `<small>${esc(place.area)}</small>` : '<small>&nbsp;</small>'}
      <a href="https://www.google.com/maps/search/?api=1&query=${lat},${lng}" target="_blank" rel="noopener">Map ↗</a>`;

    const infos = state.people.map((p) => ({ p, ...routeInfo(p) }));
    const times = infos.map((x) => x.time);
    const max = Math.max(...times), min = Math.min(...times);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    $('stats').innerHTML = [
      ['Average', F.formatDuration(avg)],
      ['Longest', F.formatDuration(max)],
      ['Shortest', F.formatDuration(min)],
      ['Gap', F.formatDuration(max - min)],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

    const chip = $('chip');
    chip.hidden = false;
    chip.innerHTML = `★ <strong>${esc(name)}</strong><span class="sep">·</span>avg ${F.formatDuration(avg)}<span class="sep">·</span>longest ${F.formatDuration(max)}`;

    const cars = state.cars.length ? state.people.length - state.cars.reduce((n, c) => n + c.passengers.length, 0) : 0;
    if (cars) $('stats').insertAdjacentHTML('beforeend', `<div><dt>Cars</dt><dd>${cars}</dd></div>`);
    const pending = infos.filter((x) => !x.exact).length;
    infos.sort((a, b) => b.time - a.time);
    $('routes').innerHTML = infos.map((x) => {
      const wl = F.weightLabel(x.p.w);
      const bits = [F.formatMiles(x.dist)];
      if (x.car) bits.push(esc(x.car));
      if (x.via) bits.push(`via ${esc(x.via)}`);
      
      return `<li class="route${x.exact ? '' : ' pending'}" data-id="${x.p.id}" >
        <span class="swatch" style="background:${x.p.color}"></span>
        <span class="r-name">${esc(x.p.name)}</span>
        <span class="r-time">${F.formatDuration(x.time)}</span>
        <span class="r-detail">${bits.join(' · ')}</span>
        <span class="bar"><span style="width:${max ? Math.round((x.time / max) * 100) : 0}%;background:${x.p.color}"></span></span>
      </li>`;
    }).join('');
    applySelection();
    if (pending && !$('status').classList.contains('error') && !$('status').classList.contains('working')) {
      setStatus(`Routes ${state.people.length - pending}/${state.people.length}`, 'working', true);
    } else if (!pending && $('status').dataset.routes) setStatus('');
  }

  // Selecting a person brings their route(s) to the front and fades the rest.
  function eachLine(layer, fn) {
    if (layer instanceof L.LayerGroup) layer.eachLayer((l) => eachLine(l, fn)); else fn(layer);
  }
  function applySelection() {
    const sel = state.selected;
    if (sel != null && !state.people.some((p) => p.id === sel)) state.selected = null;
    for (const v of routeLines.values()) {
      const on = state.selected == null || v.people.includes(state.selected);
      eachLine(v.layer, (l) => {
        if (l.options.baseOpacity == null) l.options.baseOpacity = l.options.opacity;
        l.setStyle({ opacity: on ? l.options.baseOpacity : l.options.baseOpacity * 0.25 });
      });
    }
    if (state.selected != null) {
      for (const v of routeLines.values()) if (v.people.includes(state.selected)) eachLine(v.layer, (l) => l.bringToFront());
    }
    document.querySelectorAll('#routes .route').forEach((li) => li.classList.toggle('selected', Number(li.dataset.id) === state.selected));
  }
  function selectPerson(id) {
    state.selected = id;
    applySelection();
  }
  map.on('click', () => { if (state.selected != null) selectPerson(null); });

  $('routes').addEventListener('click', (e) => {
    const li = e.target.closest('.route');
    if (!li || !state.best) return;
    const p = state.people.find((x) => x.id === Number(li.dataset.id));
    if (!p) return;
    selectPerson(p.id);
    const pts = [];
    for (const l of legs().filter((x) => x.people.includes(p.id))) {
      const r = state.routes.get(legKey(l));
      pts.push(...(r ? r.coords : l.pts));
    }
    if (pts.length) map.fitBounds(pts, { padding: [40, 40] });
    if (window.innerWidth <= 820) window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  function setStatus(text, cls, fromRoutes) {
    const el = $('status');
    el.textContent = text;
    el.className = `status ${cls || ''}`;
    el.hidden = !text;
    if (fromRoutes) el.dataset.routes = '1'; else delete el.dataset.routes;
  }

  // ---------- Geocoding ----------
  const POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
  const OUTCODE = /^[A-Z]{1,2}\d[A-Z\d]?$/i;

  async function lookup(query) {
    const q = query.trim();
    if (POSTCODE.test(q)) {
      try {
        const d = await fetchJson(`${CFG.postcodesUrl}/postcodes/${encodeURIComponent(q.replace(/\s+/g, ''))}`);
        const r = d.result;
        return [{ label: `${r.postcode}, ${r.admin_district || r.region || ''}`.replace(/, $/, ''), lat: r.latitude, lng: r.longitude }];
      } catch (e) { /* fall through to address search */ }
    } else if (OUTCODE.test(q)) {
      try {
        const d = await fetchJson(`${CFG.postcodesUrl}/outcodes/${encodeURIComponent(q)}`);
        const r = d.result;
        return [{ label: `${r.outcode} area, ${(r.admin_district || [])[0] || ''}`.replace(/, $/, ''), lat: r.latitude, lng: r.longitude }];
      } catch (e) { /* fall through */ }
    }
    const url = `${CFG.nominatimUrl}/search?format=jsonv2&countrycodes=gb&limit=5&q=${encodeURIComponent(q)}`;
    const res = await nominatimQ(() => fetchJson(url));
    return (res || []).map((r) => ({ label: r.display_name.replace(/, United Kingdom$/, ''), lat: Number(r.lat), lng: Number(r.lon) }));
  }

  function flash(text, cls) {
    const el = $('add-msg');
    el.textContent = text;
    el.className = `msg ${cls || ''}`;
  }

  $('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('add-name').value;
    const q = $('add-query').value;
    if (!q.trim()) return;
    const btn = e.submitter || $('add-form').querySelector('button');
    btn.disabled = true;
    flash('');
    $('search-results').hidden = true;
    try {
      const results = await lookup(q);
      if (!results.length) { flash('Not found.', 'error'); return; }
      if (results.length === 1) {
        if (addPerson({ name, ...results[0] })) { flash(''); resetAddForm(); }
        return;
      }
      flash('');
      const ul = $('search-results');
      ul.innerHTML = '';
      results.forEach((r) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = r.label;
        b.addEventListener('click', () => {
          if (addPerson({ name, ...r })) { flash(''); resetAddForm(); }
          ul.hidden = true;
        });
        li.appendChild(b); ul.appendChild(li);
      });
      ul.hidden = false;
    } catch (err) {
      flash('Lookup failed.', 'error');
    } finally { btn.disabled = false; }
  });

  function resetAddForm() {
    $('add-name').value = '';
    $('add-query').value = '';
    $('add-name').focus();
  }

  $('bulk-add').addEventListener('click', async () => {
    const lines = $('bulk-text').value.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const btn = $('bulk-add');
    btn.disabled = true;
    const rows = lines.map((l) => {
      const i = l.indexOf(',');
      return i > 0 ? { name: l.slice(0, i).trim(), q: l.slice(i + 1).trim(), line: l } : { name: '', q: l, line: l };
    });
    const failed = [];
    let added = 0;
    // Postcodes in one bulk request.
    const pcs = rows.filter((r) => POSTCODE.test(r.q));
    const pcResults = new Map();
    if (pcs.length) {
      try {
        const d = await fetchJson(`${CFG.postcodesUrl}/postcodes`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ postcodes: pcs.map((r) => r.q) }),
        });
        d.result.forEach((x) => { if (x.result) pcResults.set(x.query, x.result); });
      } catch (e) { /* fall back to one by one below */ }
    }
    for (const [i, r] of rows.entries()) {
      if (state.people.length >= CFG.maxPeople) { failed.push(r.line); continue; }
      
      try {
        let hit = null;
        const pc = pcResults.get(r.q);
        if (pc) hit = { label: `${pc.postcode}, ${pc.admin_district || pc.region || ''}`.replace(/, $/, ''), lat: pc.latitude, lng: pc.longitude };
        else { const res = await lookup(r.q); hit = res[0]; }
        if (hit && addPerson({ name: r.name, ...hit })) added++;
        else failed.push(r.line);
      } catch (e) { failed.push(r.line); }
    }
    btn.disabled = false;
    $('bulk-text').value = failed.join('\n');
    flash(failed.length ? `${failed.length} not found.` : '', failed.length ? 'error' : '');
  });

  // ---------- Fairness balance ----------
  $('alpha').addEventListener('input', (e) => { state.alpha = Number(e.target.value) / 100; recompute(); });
  $('alpha').addEventListener('change', () => { save(); scheduleRefine(); });

  // ---------- Save, share, clear ----------
  function serialise() {
    const idx = new Map(state.people.map((p, i) => [p.id, i]));
    return { a: Math.round(state.alpha * 100), p: state.people.map((p) => [p.name, p.label, +p.lat.toFixed(5), +p.lng.toFixed(5), p.w,
      p.ride != null && idx.has(p.ride) ? idx.get(p.ride) : -1, p.carMode === 'meet' ? 'm' : 'h']) };
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(serialise())); } catch (e) { /* private mode */ }
  }
  function load(data) {
    if (!data || !Array.isArray(data.p)) return;
    state.alpha = Math.min(1, Math.max(0, (Number(data.a) || 75) / 100));
    $('alpha').value = Math.round(state.alpha * 100);
    const byIndex = [];
    const rides = [];
    for (const row of data.p.slice(0, CFG.maxPeople)) {
      const [name, label, lat, lng, w, ride, mode] = row;
      if (!isFinite(lat) || !isFinite(lng)) { byIndex.push(null); continue; }
      const p = { id: nextId++, name: String(name || 'Person'), label: String(label || ''), lat: Number(lat), lng: Number(lng), w: Math.max(-100, Math.min(100, Number(w) || 0)), ride: null, carMode: mode === 'm' ? 'meet' : 'home', color: nextColour() };
      state.people.push(p); byIndex.push(p); rides.push([p, Number.isInteger(ride) ? ride : -1]);
    }
    for (const [p, r] of rides) { const d = byIndex[r]; if (d && d !== p) p.ride = d.id; }
    for (const p of state.people) { const d = state.people.find((q) => q.id === p.ride); if (d && d.ride != null) p.ride = null; }
  }
  const b64 = {
    enc: (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    dec: (s) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))),
  };

  $('share-btn').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}#d=${b64.enc(JSON.stringify(serialise()))}`;
    try { await navigator.clipboard.writeText(url); flash('Link copied.', 'ok'); } catch (e) { prompt('', url); }
  });

  $('clear-btn').addEventListener('click', () => {
    if (!state.people.length || !confirm('Clear all?')) return;
    state.people = []; state.times.clear(); state.dists.clear(); state.candidates.clear();
    state.coarseSpacing = null; state.fineGroups = []; state.pp.clear(); state.pickups.clear(); state.venuePickups.clear();
    peopleChanged(false);
  });

  // ---------- Start ----------
  (function init() {
    let data = null;
    const m = location.hash.match(/#d=([\w-]+)/);
    if (m) { try { data = JSON.parse(b64.dec(m[1])); } catch (e) { /* ignore bad link */ } history.replaceState(null, '', location.pathname); }
    if (!data) { try { data = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { /* none */ } }
    load(data);
    peopleChanged(true);
  })();

  // Exposed for tests and tinkering in the console.
  window.CommonGround = { state, recompute };
})();
