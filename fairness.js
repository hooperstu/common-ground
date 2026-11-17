// Pure maths for Common Ground: weights, candidate grids, scoring and the "fair zone" ellipse.
// No DOM or network code lives here, so it can be tested on its own (see tests/fairness.test.js).
(function (root) {
  'use strict';

  const KM_PER_DEG_LAT = 110.57;
  const kmPerDegLng = (lat) => 111.32 * Math.cos((lat * Math.PI) / 180);
  // The lattice uses one fixed longitude scale for the whole UK so grid keys stay stable.
  const LATTICE_LAT = 54;
  const SPACINGS_KM = [1, 2, 3, 5, 8, 12, 20, 30, 45, 60, 80, 100];
  const MAX_COARSE = 260;

  // Slider value -100..100. Left (negative) = travel less, so their minutes count for more.
  function weightMultiplier(v) {
    return Math.pow(2, -(Number(v) || 0) / 50);
  }

  function weightLabel(v) {
    v = Number(v) || 0;
    if (v <= -80) return { text: 'Much less', cls: 'less' };
    if (v <= -15) return { text: 'Less', cls: 'less' };
    if (v < 15) return { text: 'Equal', cls: '' };
    if (v < 80) return { text: 'More', cls: 'more' };
    return { text: 'Much more', cls: 'more' };
  }

  function bbox(points) {
    let s = 90, n = -90, w = 180, e = -180;
    for (const p of points) {
      s = Math.min(s, p.lat); n = Math.max(n, p.lat);
      w = Math.min(w, p.lng); e = Math.max(e, p.lng);
    }
    return { s, n, w, e };
  }

  // Pad the people's bounding box and choose a grid spacing that keeps the grid to about MAX_COARSE points.
  function coarseGrid(people) {
    const b = bbox(people);
    const midLat = (b.s + b.n) / 2;
    const wKm = (b.e - b.w) * kmPerDegLng(midLat);
    const hKm = (b.n - b.s) * KM_PER_DEG_LAT;
    const padKm = Math.max(10, 0.12 * Math.max(wKm, hKm));
    const W = wKm + 2 * padKm, H = hKm + 2 * padKm;
    let spacing = SPACINGS_KM[SPACINGS_KM.length - 1];
    for (const s of SPACINGS_KM) {
      if ((W / s + 2) * (H / s + 2) <= MAX_COARSE) { spacing = s; break; }
    }
    const padLat = padKm / KM_PER_DEG_LAT, padLng = padKm / kmPerDegLng(midLat);
    return latticePoints({ s: b.s - padLat, n: b.n + padLat, w: b.w - padLng, e: b.e + padLng }, spacing, 'c');
  }

  function latticeStep(spacingKm) {
    return { dLat: spacingKm / KM_PER_DEG_LAT, dLng: spacingKm / kmPerDegLng(LATTICE_LAT) };
  }

  function latticePoints(box, spacingKm, prefix) {
    const { dLat, dLng } = latticeStep(spacingKm);
    const out = [];
    const i0 = Math.floor(box.s / dLat), i1 = Math.ceil(box.n / dLat);
    const j0 = Math.floor(box.w / dLng), j1 = Math.ceil(box.e / dLng);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        out.push({ key: `${prefix}${spacingKm}:${i}:${j}`, lat: i * dLat, lng: j * dLng, spacing: spacingKm });
      }
    }
    return { spacing: spacingKm, points: out };
  }

  // A finer grid around a point, used to sharpen the answer once things settle.
  function fineGrid(center, coarseSpacing) {
    const spacing = Math.max(0.5, coarseSpacing / 3);
    const span = coarseSpacing * 1.05;
    const box = {
      s: center.lat - span / KM_PER_DEG_LAT, n: center.lat + span / KM_PER_DEG_LAT,
      w: center.lng - span / kmPerDegLng(center.lat), e: center.lng + span / kmPerDegLng(center.lat),
    };
    return latticePoints(box, spacing, 'f');
  }

  // people: [{id, w}], candidates: [{key, ...}], getTime(personId, key) -> seconds or null/undefined.
  // alpha 0..1: 0 = least total weighted time, 1 = smallest worst-case weighted time.
  function scoreCandidates(people, candidates, getTime, alpha) {
    const mult = people.map((p) => weightMultiplier(p.w));
    const scored = [];
    for (const c of candidates) {
      let max = 0, sum = 0, ok = true;
      const times = new Array(people.length);
      for (let i = 0; i < people.length; i++) {
        const t = getTime(people[i].id, c.key);
        if (t == null || !isFinite(t)) { ok = false; break; }
        times[i] = t;
        const cost = t * mult[i];
        if (cost > max) max = cost;
        sum += cost;
      }
      if (!ok) continue;
      const mean = sum / people.length;
      scored.push({ cand: c, times, score: alpha * max + (1 - alpha) * mean });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored;
  }

  // Fit an ellipse round every candidate that scores almost as well as the best one.
  // Returns {center:{lat,lng}, rx, ry (km), angle (radians), polygon:[[lat,lng]...], tolSeconds}.
  function fairZone(scored, opts) {
    opts = opts || {};
    if (!scored.length) return null;
    const best = scored[0];
    const tol = Math.max(opts.minTolSeconds || 180, best.score * (opts.tolFraction || 0.04));
    const good = scored.filter((s) => s.score <= best.score + tol);
    const lat0 = best.cand.lat, lng0 = best.cand.lng;
    const kx = kmPerDegLng(lat0), ky = KM_PER_DEG_LAT;
    let sw = 0, mx = 0, my = 0;
    const pts = good.map((s) => {
      const w = 1 - (s.score - best.score) / tol * 0.7;
      const x = (s.cand.lng - lng0) * kx, y = (s.cand.lat - lat0) * ky;
      sw += w; mx += w * x; my += w * y;
      return { x, y, w };
    });
    mx /= sw; my /= sw;
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of pts) {
      const dx = p.x - mx, dy = p.y - my;
      sxx += p.w * dx * dx; syy += p.w * dy * dy; sxy += p.w * dx * dy;
    }
    sxx /= sw; syy /= sw; sxy /= sw;
    // Eigen-decomposition of the 2x2 covariance matrix.
    const tr = sxx + syy, det = sxx * syy - sxy * sxy;
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 + disc, l2 = Math.max(0, tr / 2 - disc);
    const angle = Math.abs(sxy) < 1e-12 ? (sxx >= syy ? 0 : Math.PI / 2) : Math.atan2(l1 - sxx, sxy);
    const spacing = best.cand.spacing || 2;
    const minR = Math.max(0.8, spacing * 0.6);
    const rx = Math.max(minR, 2 * Math.sqrt(l1) + spacing * 0.4);
    const ry = Math.max(minR, 2 * Math.sqrt(l2) + spacing * 0.4);
    const center = { lat: lat0 + my / ky, lng: lng0 + mx / kx };
    const polygon = [];
    const ca = Math.cos(angle), sa = Math.sin(angle);
    for (let k = 0; k < 72; k++) {
      const t = (k / 72) * 2 * Math.PI;
      const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
      const x = ex * ca - ey * sa, y = ex * sa + ey * ca;
      polygon.push([center.lat + y / ky, center.lng + x / kmPerDegLng(center.lat)]);
    }
    return { center, rx, ry, angle, polygon, tolSeconds: tol, count: good.length };
  }

  function formatDuration(sec) {
    if (sec == null || !isFinite(sec)) return '–';
    const m = Math.round(sec / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h} h ${r} min` : `${h} h`;
  }

  function formatMiles(metres) {
    if (metres == null || !isFinite(metres)) return '–';
    const mi = metres / 1609.344;
    return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
  }


  // ---------- Lift sharing ----------
  // people: [{id, ride (driver id or null), carMode ('home'|'meet')}]. Returns cars with at least one passenger.
  function buildCars(people) {
    const byId = new Map(people.map((p) => [p.id, p]));
    const cars = new Map();
    for (const p of people) {
      const d = p.ride != null ? byId.get(p.ride) : null;
      if (!d || d === p || d.ride != null) continue;
      if (!cars.has(d.id)) cars.set(d.id, { driver: d, passengers: [], mode: d.carMode === 'meet' ? 'meet' : 'home' });
      cars.get(d.id).passengers.push(p);
    }
    return [...cars.values()];
  }

  // Home pickup order: driver collects the nearest passenger next. pp(a, b) = seconds from a's home to b's home.
  function pickupOrder(car, pp) {
    const left = car.passengers.slice();
    const order = [car.driver];
    while (left.length) {
      const from = order[order.length - 1];
      let bi = 0, bt = Infinity;
      left.forEach((q, i) => { const t = pp(from.id, q.id); if (t != null && t < bt) { bt = t; bi = i; } });
      order.push(left.splice(bi, 1)[0]);
    }
    return order;
  }

  // Rough drive time between two points from straight-line distance (for choosing meet points only).
  function roughSeconds(a, b) {
    const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
    return (2 * 6371 * Math.asin(Math.sqrt(x)) * 1.25 / 75) * 3600;
  }

  // Meet point for a car: keeps the longest drive to it short, leaning slightly towards the venue.
  // t(originId, key) = seconds; toward (optional) = {lat, lng} of the likely venue.
  function choosePickup(members, candidates, t, toward) {
    let best = null, bestScore = Infinity;
    for (const c of candidates) {
      let max = 0, sum = 0, ok = true;
      for (const m of members) {
        const raw = t(m.id, c.key);
        if (raw == null) { ok = false; break; }
        // Each person's own slider shapes only their drive to the meet point.
        const v = raw * weightMultiplier(m.w);
        if (v > max) max = v;
        sum += v;
      }
      if (!ok) continue;
      // Stay near the people being picked up; leaning towards the venue only breaks near-ties.
      const sc = max + 0.2 * sum + (toward ? 0.25 * roughSeconds(c, toward) : 0);
      if (sc < bestScore) { bestScore = sc; best = c; }
    }
    return best;
  }

  // Build per-person journey lookups. Returns {time(pid, key), dist(pid, key), plan: Map pid -> description}.
  // opts: t(originId, key), d(originId, key), pp(a, b), ppd(a, b), pickups: Map driverId -> {key, originId}.
  // Weights used to pick the venue: everyone in a car shares the driver's slider, so a
  // passenger's own slider never moves the venue.
  function venueWeights(people, cars) {
    const w = new Map(people.map((p) => [p.id, p.w]));
    for (const car of cars) for (const q of car.passengers) w.set(q.id, car.driver.w);
    return people.map((p) => ({ id: p.id, w: w.get(p.id) }));
  }

  function journeys(people, cars, opts) {
    const fn = new Map();
    const sum = (a, b) => (a == null || b == null ? null : a + b);
    for (const p of people) {
      fn.set(p.id, { t: (k) => opts.t(p.id, k), d: (k) => opts.d(p.id, k), car: null });
    }
    for (const car of cars) {
      if (car.mode === 'home') {
        const order = pickupOrder(car, opts.pp);
        const last = order[order.length - 1];
        for (let i = 0; i < order.length; i++) {
          let tt = 0, dd = 0;
          for (let j = i; j < order.length - 1; j++) {
            tt = sum(tt, opts.pp(order[j].id, order[j + 1].id));
            dd = sum(dd, opts.ppd(order[j].id, order[j + 1].id));
          }
          const tt0 = tt, dd0 = dd;
          fn.set(order[i].id, { t: (k) => sum(tt0, opts.t(last.id, k)), d: (k) => sum(dd0, opts.d(last.id, k)), car, order });
        }
      } else {
        const pk = opts.pickups.get(car.driver.id);
        for (const m of [car.driver, ...car.passengers]) {
          if (!pk) { fn.set(m.id, { t: () => null, d: () => null, car }); continue; }
          const tm = opts.t(m.id, pk.key), dm = opts.d(m.id, pk.key);
          fn.set(m.id, { t: (k) => sum(tm, opts.t(pk.originId, k)), d: (k) => sum(dm, opts.d(pk.originId, k)), car, pickup: pk });
        }
      }
    }
    return fn;
  }

  const api = {
    buildCars, pickupOrder, choosePickup, journeys, roughSeconds, venueWeights,
    weightMultiplier, weightLabel, coarseGrid, fineGrid, scoreCandidates, fairZone,
    formatDuration, formatMiles, bbox, kmPerDegLng, KM_PER_DEG_LAT,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Fairness = api;
})(typeof window !== 'undefined' ? window : globalThis);
