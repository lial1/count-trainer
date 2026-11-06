import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, buildShoe, hiLo, handValue, basicAction, recommend, recommendedBet, DEVIATIONS, explain } from '../public/engine.js';

const ctx = (o) => ({ soft: false, pairValue: null, canDouble: true, canSplit: false, canSurrender: false, ...o });
const c = (rank) => ({ id: Math.random(), rank, suit: 'spades' });
// draw() pops from the end, so list cards in deal order: player, up, player, hole, then draws.
function rig(game, ranks) { game.shoe = [...Array(60).fill(0).map(() => c('7')), ...ranks.slice().reverse().map(c)]; game.cutRemaining = 0; game.rc = 0; }

test('Hi-Lo is balanced over a full shoe', () => {
  for (const d of [1, 2, 6, 8]) assert.equal(buildShoe(d).reduce((s, k) => s + hiLo(k.rank), 0), 0);
});
test('shoe has the right composition', () => {
  const s = buildShoe(6);
  assert.equal(s.length, 312);
  assert.equal(s.filter((k) => k.rank === 'A').length, 24);
});
test('random mode draws from the pool and varies', () => {
  const seen = new Set();
  const g = new Game();
  for (let i = 0; i < 200; i += 1) { g.newShoe(); seen.add(g.decks); }
  assert.deepEqual([...seen].sort((a, b) => a - b), [2, 4, 6, 8]);
});
test('hand values', () => {
  assert.deepEqual(handValue([c('A'), c('6')]), { total: 17, soft: true });
  assert.deepEqual(handValue([c('A'), c('6'), c('10')]), { total: 17, soft: false });
  assert.deepEqual(handValue([c('A'), c('A'), c('9')]), { total: 21, soft: true });
});
test('basic strategy spot checks', () => {
  assert.equal(basicAction(ctx({ total: 11, up: 11 })), 'hit');
  assert.equal(basicAction(ctx({ total: 11, up: 10 })), 'double');
  assert.equal(basicAction(ctx({ total: 12, up: 3 })), 'hit');
  assert.equal(basicAction(ctx({ total: 16, up: 10 })), 'hit');
  assert.equal(basicAction(ctx({ total: 18, soft: true, up: 2 })), 'stand');
  assert.equal(basicAction(ctx({ total: 18, soft: true, up: 6 })), 'double');
  assert.equal(basicAction(ctx({ total: 18, soft: true, up: 6, canDouble: false })), 'stand');
  assert.equal(basicAction(ctx({ total: 18, soft: true, up: 9 })), 'hit');
  assert.equal(basicAction(ctx({ total: 16, pairValue: 8, canSplit: true, up: 10 })), 'split');
  assert.equal(basicAction(ctx({ total: 18, pairValue: 9, canSplit: true, up: 7 })), 'stand');
  assert.equal(basicAction(ctx({ total: 16, up: 10, canSurrender: true })), 'surrender');
});
test('deviations fire on the right side of the index', () => {
  assert.equal(recommend(ctx({ total: 16, up: 10 }), 1).action, 'stand');
  assert.equal(recommend(ctx({ total: 16, up: 10 }), -1).action, 'hit');
  assert.equal(recommend(ctx({ total: 12, up: 4 }), -1).action, 'hit');
  assert.equal(recommend(ctx({ total: 12, up: 2 }), 4).action, 'stand');
  assert.equal(recommend(ctx({ total: 11, up: 11 }), 2).action, 'double');
  assert.equal(recommend(ctx({ total: 20, pairValue: 10, canSplit: true, up: 6 }), 5).action, 'split');
  assert.equal(recommend(ctx({ total: 20, pairValue: 10, canSplit: true, up: 6 }), 2).action, 'stand');
  assert.equal(recommend(ctx({ total: 20, pairValue: 10, canSplit: true, up: 4 }), 9).action, 'stand');
});
test('double deviations fall back when doubling is not allowed', () => {
  assert.equal(recommend(ctx({ total: 11, up: 11, canDouble: false }), 5).action, 'hit');
  assert.equal(recommend(ctx({ total: 10, up: 10, canDouble: false }), 5).rule, null);
});
test('pairs and soft hands do not pick up hard-total deviations', () => {
  assert.equal(recommend(ctx({ total: 16, pairValue: 8, canSplit: true, up: 10 }), 5).action, 'split');
  assert.equal(recommend(ctx({ total: 12, pairValue: 6, canSplit: true, up: 3 }), 5).action, 'split');
  assert.equal(recommend(ctx({ total: 16, soft: true, up: 10 }), 5).rule, null);
});
test('Fab 4 surrender', () => {
  const s = (o) => ctx({ canSurrender: true, ...o });
  assert.equal(recommend(s({ total: 14, up: 10 }), 3).action, 'surrender');
  assert.equal(recommend(s({ total: 14, up: 10 }), 1).action, 'hit');
  assert.equal(recommend(s({ total: 15, up: 10 }), -1).action, 'hit');
  assert.equal(recommend(s({ total: 15, up: 10 }), 5).action, 'surrender');
  assert.equal(recommend(s({ total: 15, up: 11 }), 2).action, 'surrender');
  assert.equal(recommend(s({ total: 16, up: 10 }), 3).action, 'surrender');
  assert.equal(recommend(ctx({ total: 15, up: 10 }), 5).action, 'stand');
});
test('close calls accept both plays', () => {
  assert.deepEqual(recommend(ctx({ total: 16, up: 10 }), 0.2).accepted.sort(), ['hit', 'stand']);
  assert.deepEqual(recommend(ctx({ total: 16, up: 10 }), 0.6).accepted, ['stand']);
});
test('all 21 indices present', () => assert.equal(DEVIATIONS.length, 21));
test('bet ramp', () => {
  assert.deepEqual([-3, 0.9, 2.1, 3.9, 4, 7].map(recommendedBet), [1, 1, 2, 4, 8, 12]);
});
test('hole card is not counted until revealed, and counts as unseen', () => {
  const g = new Game({ deckMode: 6 });
  rig(g, ['10', '9', '7', '2']); // player 10,7; up 9; hole 2
  const unseenBefore = g.shoe.length;
  g.deal(1);
  assert.equal(g.rc, -1);
  assert.equal(g.unseen, unseenBefore - 3);
  g.act('stand');
  assert.equal(g.phase, 'settled');
  assert.equal(g.holeHidden, false);
  assert.ok(g.dealer.length >= 3);
});
test('blackjack pays 3:2 and pushes dealer blackjack', () => {
  let g = new Game({ deckMode: 6 });
  rig(g, ['A', '9', 'K', '7']);
  g.deal(2);
  assert.equal(g.phase, 'settled');
  assert.equal(g.roundNet, 3);
  g = new Game({ deckMode: 6 });
  rig(g, ['A', 'K', 'K', 'A']);
  g.deal(2);
  assert.equal(g.roundNet, 0);
});
test('insurance pays 2:1 and is judged by the count', () => {
  const g = new Game({ deckMode: 6 });
  rig(g, ['10', 'A', '9', 'K']);
  g.deal(2);
  assert.equal(g.phase, 'insurance');
  g.rc = -5;
  const e = g.insurance(true);
  assert.equal(e.ok, false);
  assert.equal(g.roundNet, 0); // lose 2, win 1 x 2
});
test('dealer stands on soft 17', () => {
  const g = new Game({ deckMode: 6 });
  rig(g, ['10', 'A', '9', '6']);
  g.deal(1);
  g.insurance(false);
  g.act('stand');
  assert.equal(g.dealer.length, 2);
  assert.equal(g.hands[0].result, 'win');
});
test('double doubles the bet, bust skips the dealer draw', () => {
  let g = new Game({ deckMode: 6 });
  rig(g, ['5', '6', '6', '10', 'K']);
  g.deal(1);
  g.act('double');
  assert.equal(g.hands[0].bet, 2);
  assert.equal(g.hands[0].result, 'win'); // 21 vs 16 then 7 = 23
  g = new Game({ deckMode: 6 });
  rig(g, ['10', '6', '6', '10', 'K']);
  g.deal(1);
  g.act('hit');
  assert.equal(g.hands[0].result, 'bust');
  assert.equal(g.dealer.length, 2);
});
test('split deals the second hand only when it is reached', () => {
  const g = new Game({ deckMode: 6 });
  rig(g, ['8', '6', '8', '10', '3', '10']);
  g.deal(1);
  g.act('split');
  assert.equal(g.hands.length, 2);
  assert.equal(g.hands[0].cards.length, 2);
  assert.equal(g.hands[1].cards.length, 1);
  assert.ok(g.legalActions().includes('double')); // double after split
  g.act('stand');
  assert.equal(g.active, 1);
  assert.equal(g.hands[1].cards.length, 2);
});
test('split aces get one card and 21 is not blackjack', () => {
  const g = new Game({ deckMode: 6 });
  rig(g, ['A', '6', 'A', '10', 'K', 'Q']);
  g.deal(1);
  g.act('split');
  assert.equal(g.phase, 'settled');
  assert.deepEqual(g.hands.map((h) => h.result), ['win', 'win']);
  assert.equal(g.roundNet, 2);
});
test('surrender loses half and is first-two-cards only', () => {
  const g = new Game({ deckMode: 6, surrender: true });
  rig(g, ['10', '10', '6', '7']);
  g.deal(2);
  assert.ok(g.legalActions().includes('surrender'));
  g.act('surrender');
  assert.equal(g.roundNet, -1);
});
test('cut card ends the shoe only between rounds', () => {
  const g = new Game({ deckMode: 2 });
  g.cutRemaining = g.shoe.length; // already past it
  g.deal(1);
  if (g.phase !== 'settled') assert.equal(g.needsShuffle, false);
});
test('every explanation renders without undefined', () => {
  const g = new Game({ deckMode: 6, surrender: true });
  for (let i = 0; i < 3000; i += 1) {
    if (g.needsShuffle) g.newShoe();
    const check = (e) => { const x = explain(e); assert.ok(!JSON.stringify(x).match(/undefined|NaN|null/), JSON.stringify(x)); };
    g.deal(1);
    if (g.phase === 'insurance') check(g.insurance(i % 2 === 0));
    while (g.phase === 'play') { const l = g.legalActions(); check(g.act(l[i % l.length])); }
  }
});
