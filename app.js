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
    people: [], // {id, name, label, lat, lng, w, color}
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
  function colourFor(i) {
    const fixed = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#0aa1a8', '#d6297a', '#7a9a01',
      '#9a6324', '#1f77b4', '#800000', '#2e8b57', '#000075', '#b8860b', '#6a3d9a', '#ff1493'];
    if (i < fixed.length) return fixed[i];
    return `hsl(${Math.round((i * 137.508) % 360)}, 68%, ${i % 2 ? 38 : 48}%)`;
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
          <div class="weight">
            <input type="range" min="-100" max="100" step="1" aria-label="Travel less or more">
            <span class="weight-label"></span>
          </div>`;
        const range = li.querySelector('input[type=range]');
        range.addEventListener('input', () => setWeight(p.id, Number(range.value)));
        range.addEventListener('change', () => { save(); scheduleRefine(); });
        range.addEventListener('dblclick', () => { range.value = 0; setWeight(p.id, 0); save(); scheduleRefine(); });
        li.querySelector('.icon-btn').addEventListener('click', () => removePerson(p.id));
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
      if (ol.children[idx] !== li) ol.insertBefore(li, ol.children[idx] || null);
    });
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
      drawPeople(); renderSummary(); save();
    };
    input.addEventListener('blur', done, { once: true });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = p.name; input.blur(); } });
  }

  // ---------- People changes ----------
  function addPerson({ name, label, lat, lng, w = 0 }) {
    if (state.people.length >= CFG.maxPeople) { flash(`Max ${CFG.maxPeople}.`, 'error'); return false; }
    const p = { id: nextId++, name: (name || '').trim() || `Person ${state.people.length + 1}`, label, lat, lng, w, color: nextColour() };
    state.people.push(p);
    peopleChanged(true);
    return true;
  }

  function removePerson(id) {
    state.people = state.people.filter((p) => p.id !== id);
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
    const missingCands = cands.filter((c) => c.valid !== false && state.people.some((p) => !state.times.has(tkey(p.id, c.key))));
    if (!missingCands.length) return;
    const needPeople = state.people.filter((p) => missingCands.some((c) => !state.times.has(tkey(p.id, c.key))));
    await fetchMatrix(needPeople, missingCands, gen);
  }

  const scheduleSync = debounce(sync, 500);
  async function sync() {
    if (state.people.length < 2) return;
    const gen = ++state.syncGen;
    const grid = F.coarseGrid(state.people);
    if (grid.spacing !== state.coarseSpacing) {
      // The area changed a lot: start a fresh grid.
      state.candidates.clear(); state.times.clear(); state.dists.clear(); state.fineGroups = [];
      state.coarseSpacing = grid.spacing;
    }
    // Keep fine points and coarse points still inside the area; add any new coarse points.
    const keep = new Set(grid.points.map((g) => g.key));
    for (const [k, c] of state.candidates) if (!c.fine && !keep.has(k)) state.candidates.delete(k);
    for (const g of grid.points) if (!state.candidates.has(g.key)) state.candidates.set(g.key, { ...g, fine: false });
    try {
      setStatus('Calculating…', 'working');
      await fillMissing([...state.candidates.values()], gen);
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
    const scored = F.scoreCandidates(state.people, cands, (pid, key) => state.times.get(tkey(pid, key)), state.alpha);
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
    if (prevKey !== state.best.cand.key) {
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
    layers.zone.clearLayers(); layers.routes.clearLayers(); layers.meet.clearLayers();
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
  const rkey = (p, cand) => `${p.id}@${p.lat.toFixed(5)},${p.lng.toFixed(5)}>${cand.key}`;

  function drawRoutes() {
    if (!state.best) return;
    const cand = state.best.cand;
    const ll = meetLatLng();
    const live = new Set();
    for (const p of state.people) {
      live.add(p.id);
      const r = state.routes.get(rkey(p, cand));
      const existing = routeLines.get(p.id);
      const sig = r ? `r:${rkey(p, cand)}:${p.color}` : `s:${p.lat},${p.lng}>${ll}:${p.color}`;
      if (existing && existing.sig === sig) continue;
      if (existing) layers.routes.removeLayer(existing.layer);
      let layer;
      if (r) {
        layer = L.layerGroup([
          L.polyline(r.coords, { color: '#fff', weight: 7, opacity: 0.85 }),
          L.polyline(r.coords, { color: p.color, weight: 4, opacity: 0.95 }),
        ]);
      } else {
        layer = L.polyline([[p.lat, p.lng], ll], { color: p.color, weight: 2.5, opacity: 0.8, dashArray: '2 8' });
      }
      layer.addTo(layers.routes);
      routeLines.set(p.id, { sig, layer });
    }
    for (const [id, v] of routeLines) if (!live.has(id)) { layers.routes.removeLayer(v.layer); routeLines.delete(id); }
  }

  let routeGen = 0;
  const scheduleRoutes = debounce(fetchRoutes, 450);
  async function fetchRoutes() {
    if (!state.best) return;
    const gen = ++routeGen;
    const cand = state.best.cand;
    const ll = meetLatLng();
    // Fetch the longest drives first so the most important lines appear first.
    const order = state.people.map((p, i) => ({ p, t: state.best.times[i] || 0 })).sort((a, b) => b.t - a.t).map((x) => x.p);
    for (const p of order) {
      if (gen !== routeGen) return;
      const k = rkey(p, cand);
      if (state.routes.has(k)) continue;
      const url = `${CFG.osrmUrl}/route/v1/driving/${p.lng.toFixed(5)},${p.lat.toFixed(5)};${ll[1].toFixed(5)},${ll[0].toFixed(5)}?overview=full&geometries=geojson&steps=false`;
      try {
        const data = await osrmQ(() => (gen === routeGen ? fetchJson(url) : null));
        if (!data) return;
        if (data.code !== 'Ok' || !data.routes || !data.routes.length) continue;
        const route = data.routes[0];
        state.routes.set(k, {
          coords: route.geometry.coordinates.map(([x, y]) => [y, x]),
          duration: route.duration,
          distance: route.distance,
          summary: (route.legs[0] && route.legs[0].summary) || '',
        });
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
  function routeInfo(p, i) {
    const r = state.routes.get(rkey(p, state.best.cand));
    if (r) return { time: r.duration, dist: r.distance, via: r.summary, exact: true };
    return { time: state.best.times[i], dist: state.dists.get(tkey(p.id, state.best.cand.key)), via: '', exact: false };
  }

  function renderSummary() {
    if (!state.best) return;
    $('summary').hidden = false;
    const [lat, lng] = meetLatLng();
    const place = state.places.get(`${lat.toFixed(3)},${lng.toFixed(3)}`);
    const name = place && place.town ? place.town : `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    $('place').innerHTML = `${esc(name)}${place && place.area ? `<small>${esc(place.area)}</small>` : '<small>&nbsp;</small>'}
      <a href="https://www.google.com/maps/search/?api=1&query=${lat},${lng}" target="_blank" rel="noopener">Map ↗</a>`;

    const infos = state.people.map((p, i) => ({ p, ...routeInfo(p, i) }));
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

    const pending = infos.filter((x) => !x.exact).length;
    infos.sort((a, b) => b.time - a.time);
    $('routes').innerHTML = infos.map((x) => {
      const wl = F.weightLabel(x.p.w);
      const bits = [F.formatMiles(x.dist)];
      if (x.via) bits.push(`via ${esc(x.via)}`);
      
      return `<li class="route${x.exact ? '' : ' pending'}" data-id="${x.p.id}" >
        <span class="swatch" style="background:${x.p.color}"></span>
        <span class="r-name">${esc(x.p.name)}</span>
        <span class="r-time">${x.exact ? '' : '≈ '}${F.formatDuration(x.time)}</span>
        <span class="r-detail">${bits.join(' · ')}</span>
        <span class="bar"><span style="width:${max ? Math.round((x.time / max) * 100) : 0}%;background:${x.p.color}"></span></span>
      </li>`;
    }).join('');
    if (pending && !$('status').classList.contains('error') && !$('status').classList.contains('working')) {
      setStatus(`Routes ${state.people.length - pending}/${state.people.length}`, 'working', true);
    } else if (!pending && $('status').dataset.routes) setStatus('');
  }

  $('routes').addEventListener('click', (e) => {
    const li = e.target.closest('.route');
    if (!li || !state.best) return;
    const p = state.people.find((x) => x.id === Number(li.dataset.id));
    if (!p) return;
    const r = state.routes.get(rkey(p, state.best.cand));
    const pts = r ? r.coords : [[p.lat, p.lng], meetLatLng()];
    map.fitBounds(pts, { padding: [40, 40] });
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
    return { a: Math.round(state.alpha * 100), p: state.people.map((p) => [p.name, p.label, +p.lat.toFixed(5), +p.lng.toFixed(5), p.w]) };
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(serialise())); } catch (e) { /* private mode */ }
  }
  function load(data) {
    if (!data || !Array.isArray(data.p)) return;
    state.alpha = Math.min(1, Math.max(0, (Number(data.a) || 75) / 100));
    $('alpha').value = Math.round(state.alpha * 100);
    for (const row of data.p.slice(0, CFG.maxPeople)) {
      const [name, label, lat, lng, w] = row;
      if (!isFinite(lat) || !isFinite(lng)) continue;
      state.people.push({ id: nextId++, name: String(name || 'Person'), label: String(label || ''), lat: Number(lat), lng: Number(lng), w: Math.max(-100, Math.min(100, Number(w) || 0)), color: nextColour() });
    }
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
    state.coarseSpacing = null; state.fineGroups = [];
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
