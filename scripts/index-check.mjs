// Measures where each deviation really flips, independent of the published table.
// For each rule: build shoes with a wide spread of true counts, play both options on the SAME
// upcoming cards, then fit EV(above) - EV(below) against true count. The zero crossing is the index.
// Follow-up decisions use basic strategy. Dealer blackjack is excluded (dealer peeks), no resplits.
import { DEVIATIONS, basicAction, INSURANCE_INDEX } from '../public/engine.js';

const TRIALS = Number(process.argv[2] ?? 1500000);
const DECKS = (process.argv[3] ?? '2,6,8').split(',').map(Number);
const val = (i) => i; // card values 2..11 (11 = ace), counts indexed by value
const hi = (v) => (v <= 6 ? 1 : v <= 9 ? 0 : -1);

function fullCounts(decks) {
  const c = new Array(12).fill(0);
  for (let v = 2; v <= 9; v += 1) c[v] = 4 * decks;
  c[10] = 16 * decks;
  c[11] = 4 * decks;
  return c;
}

function drawFrom(c, n) {
  let r = Math.floor(Math.random() * n);
  for (let v = 2; v <= 11; v += 1) {
    if (r < c[v]) { c[v] -= 1; return v; }
    r -= c[v];
  }
  throw new Error('empty');
}

function score(cards) {
  let t = 0, a = 0;
  for (const v of cards) { t += v; if (v === 11) a += 1; }
  while (t > 21 && a) { t -= 10; a -= 1; }
  return { total: t, soft: a > 0 };
}

const ctxOf = (cards, up, canDouble) => {
  const { total, soft } = score(cards);
  return { total, soft, pairValue: null, up, canDouble, canSplit: false, canSurrender: false };
};

// seq is the fixed upcoming card order; pos is a shared cursor object.
function playOut(cards, up, seq, pos, canDouble) {
  const hand = [...cards];
  for (;;) {
    const s = score(hand);
    if (s.total >= 21) return { hand, mult: 1 };
    const a = basicAction(ctxOf(hand, up, canDouble && hand.length === 2));
    if (a === 'stand') return { hand, mult: 1 };
    hand.push(seq[pos.i++]);
    if (a === 'double') return { hand, mult: 2 };
  }
}

function dealerPlay(up, hole, seq, pos) {
  const d = [up, hole];
  while (score(d).total < 17) d.push(seq[pos.i++]);
  return score(d).total;
}

const payoff = (t, d) => (t > 21 ? -1 : d > 21 || t > d ? 1 : t === d ? 0 : -1);

function ev(option, cards, up, hole, seq) {
  const pos = { i: 0 };
  if (option === 'surrender') return -0.5;
  if (option === 'stand') return payoff(score(cards).total, dealerPlay(up, hole, seq, pos));
  if (option === 'hit' || option === 'double') {
    const hand = [...cards, seq[pos.i++]];
    const r = option === 'double' ? { hand, mult: 2 } : playOut(hand, up, seq, pos, false);
    return payoff(score(r.hand).total, dealerPlay(up, hole, seq, pos)) * r.mult;
  }
  if (option === 'split') {
    const hands = [cards[0], cards[1]].map((c) => playOut([c, seq[pos.i++]], up, seq, pos, true));
    const d = dealerPlay(up, hole, seq, pos);
    return hands.reduce((s, h) => s + payoff(score(h.hand).total, d) * h.mult, 0);
  }
  throw new Error(option);
}

function compositions(rule) {
  if (rule.group === 'pair') return [[10, 10, 1]];
  const out = [];
  for (let a = 2; a <= 10; a += 1) for (let b = a + 1; b <= 10; b += 1) {
    if (a + b === rule.total) out.push([a, b, (a === 10 || b === 10 ? 4 : 1)]);
  }
  return out;
}

function pick(comps) {
  let r = Math.random() * comps.reduce((s, c) => s + c[2], 0);
  for (const c of comps) { r -= c[2]; if (r <= 0) return c; }
  return comps[comps.length - 1];
}

// Remove cards with a random tilt toward low or high cards so high counts get plenty of samples.
// Tilting the low and high groups equally leaves 7s, 8s and 9s leaving at their natural rate, so
// the card mix at a given true count stays realistic. Insurance is the calibration: it must read +3.
function depleted(decks) {
  const c = fullCounts(decks);
  let n = decks * 52;
  const removeN = Math.floor(n * (0.1 + Math.random() * 0.7));
  const w = Math.exp((Math.random() * 2 - 1) * 0.5);
  let rc = 0;
  for (let k = 0; k < removeN; k += 1) {
    let low = 0, mid = 0, high = 0;
    for (let v = 2; v <= 11; v += 1) {
      if (hi(v) > 0) low += c[v]; else if (hi(v) < 0) high += c[v]; else mid += c[v];
    }
    const wl = low * w, wh = high / w;
    let r = Math.random() * (wl + mid + wh);
    const group = r < wl ? 1 : r < wl + mid ? 0 : -1;
    r = Math.floor(Math.random() * (group === 1 ? low : group === 0 ? mid : high));
    for (let v = 2; v <= 11; v += 1) {
      if (hi(v) !== group) continue;
      if (r < c[v]) { c[v] -= 1; n -= 1; rc += group; break; }
      r -= c[v];
    }
  }
  return { c, n, rc };
}

function fit(points) {
  // Weighted line through per-bucket means near the crossing.
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y, w] of points) { sw += w; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y; }
  const b = (sw * sxy - sx * sy) / (sw * sxx - sx * sx);
  const a = (sy - b * sx) / sw;
  return { a, b, cross: -a / b };
}

function measure(rule, decks) {
  const comps = compositions(rule);
  const below = rule.below ?? 'hit';
  const buckets = new Map();
  for (let t = 0; t < TRIALS; t += 1) {
    const { c, n: n0, rc: rc0 } = depleted(decks);
    let n = n0, rc = rc0;
    const [a, b] = pick(comps);
    if (c[a] < 1 || c[b] < 1 || c[rule.up] < 1) continue;
    c[a] -= 1; c[b] -= 1; c[rule.up] -= 1; n -= 3;
    rc += hi(a) + hi(b) + hi(rule.up);
    const tc = rc / (n / 52);
    if (Math.abs(tc - rule.index) > 3.25 || n < 15) continue;
    const seq = [];
    const hole = drawFrom(c, n); n -= 1;
    if (score([rule.up, hole]).total === 21) continue;
    for (let i = 0; i < 14 && n > 0; i += 1) { seq.push(drawFrom(c, n)); n -= 1; }
    if (seq.length < 14) continue;
    const d = ev(rule.above, [a, b], rule.up, hole, seq) - ev(below, [a, b], rule.up, hole, seq);
    const k = Math.round(tc * 2) / 2;
    const e = buckets.get(k) ?? [0, 0];
    e[0] += d; e[1] += 1;
    buckets.set(k, e);
  }
  const pts = [...buckets].filter(([, e]) => e[1] > 200).map(([k, e]) => [k, e[0] / e[1], e[1]]);
  return { ...fit(pts), n: pts.reduce((s, p) => s + p[2], 0) };
}

function insuranceIndex(decks) {
  const pts = new Map();
  for (let t = 0; t < TRIALS; t += 1) {
    const { c, n: n0, rc: rc0 } = depleted(decks);
    if (c[11] < 1) continue;
    c[11] -= 1;
    const n = n0 - 1;
    const tc = (rc0 - 1) / (n / 52);
    if (Math.abs(tc - INSURANCE_INDEX) > 3.25 || n < 15) continue;
    const k = Math.round(tc * 2) / 2;
    const e = pts.get(k) ?? [0, 0];
    e[0] += 3 * (c[10] / n) - 1; e[1] += 1;
    pts.set(k, e);
  }
  return fit([...pts].map(([k, e]) => [k, e[0] / e[1], e[1]])).cross;
}

const name = (r) => `${r.group === 'pair' ? '10,10' : r.total} v ${r.up === 11 ? 'A' : r.up} ${r.above}`;
const rows = [];
console.log(`deviation`.padEnd(24), 'app'.padStart(4), ...DECKS.map((d) => `${d}D`.padStart(7)), ' max gap');
const ins = DECKS.map(insuranceIndex);
console.log('insurance'.padEnd(24), String(INSURANCE_INDEX).padStart(4), ...ins.map((x) => x.toFixed(1).padStart(7)), ' ', Math.max(...ins.map((x) => Math.abs(x - 3))).toFixed(1));
for (const r of DEVIATIONS) {
  const m = DECKS.map((d) => measure(r, d).cross);
  const gap = Math.max(...m.map((x) => Math.abs(x - r.index)));
  rows.push(gap);
  console.log(name(r).padEnd(24), String(r.index).padStart(4), ...m.map((x) => x.toFixed(1).padStart(7)), ' ', gap.toFixed(1));
}
