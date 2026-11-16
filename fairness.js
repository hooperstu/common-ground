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

  const api = {
    weightMultiplier, weightLabel, coarseGrid, fineGrid, scoreCandidates, fairZone,
    formatDuration, formatMiles, bbox, kmPerDegLng, KM_PER_DEG_LAT,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Fairness = api;
})(typeof window !== 'undefined' ? window : globalThis);
