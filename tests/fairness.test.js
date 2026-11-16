// Run with: node tests/fairness.test.js
const assert = require('assert');
const F = require('../fairness.js');

// Weights: left = travel less (counts more), right = travel more.
assert.strictEqual(F.weightMultiplier(0), 1);
assert.strictEqual(F.weightMultiplier(-100), 4);
assert.strictEqual(F.weightMultiplier(100), 0.25);

// Two people, a line of candidates between them; time = distance along the line.
const people = [{ id: 1, w: 0 }, { id: 2, w: 0 }];
const cands = Array.from({ length: 11 }, (_, i) => ({ key: 'k' + i, lat: 52, lng: -2 + i * 0.1, spacing: 5 }));
const time = (pid, key) => { const i = Number(key.slice(1)); return (pid === 1 ? i : 10 - i) * 600; };
let best = F.scoreCandidates(people, cands, time, 1)[0];
assert.strictEqual(best.cand.key, 'k5', 'equal weights meet in the middle');

// Person 1 should travel less: the point moves towards them.
people[0].w = -100;
best = F.scoreCandidates(people, cands, time, 1)[0];
assert.strictEqual(best.cand.key, 'k2', 'travel-less person gets a shorter drive (4x weight -> 2 vs 8)');

// Missing data excludes a candidate.
const partial = F.scoreCandidates(people, cands, (p, k) => (k === 'k2' ? null : time(p, k)), 1);
assert.ok(!partial.some((s) => s.cand.key === 'k2'));

// Zone is an ellipse polygon around the best point.
const z = F.fairZone(F.scoreCandidates([{ id: 1, w: 0 }, { id: 2, w: 0 }], cands, time, 0.75));
assert.ok(z.polygon.length === 72 && z.rx >= z.ry && z.rx > 0);

// Coarse grid stays bounded.
const g = F.coarseGrid([{ lat: 50.1, lng: -5.5 }, { lat: 58.6, lng: -3.0 }, { lat: 52.6, lng: 1.7 }]);
assert.ok(g.points.length <= 260 && g.points.length > 50, `grid size ${g.points.length}`);
assert.strictEqual(F.formatDuration(3660), '1 h 1 min');
console.log('fairness tests passed');
