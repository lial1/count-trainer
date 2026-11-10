import test from 'node:test';
import assert from 'node:assert/strict';
import { TableGame } from '../public/table-engine.js';

const seeded = (seed) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const c = (rank, suit = 'spades') => ({ id: Math.random(), rank, suit });
// draw() pops, so the first card dealt goes last in the array.
const rig = (g, ranks) => { g.shoe = [...Array(60).fill(null).map(() => c('5')), ...ranks.reverse().map((r) => c(r))]; g.cutRemaining = 0; };

function table(cfg = {}) {
  const g = new TableGame({ bankName: 'Lia', minBet: 5, maxBet: 100, stopLoss: 500, ...cfg }, seeded(7));
  g.join('a', 'Sam', 200);
  return g;
}

test('a bet deals once everyone has bet or sat out', () => {
  const g = table();
  g.join('b', 'Max', 100);
  g.bet('a', 10);
  assert.equal(g.phase, 'betting');
  g.sitOut('b');
  assert.equal(g.round, 1, 'should have dealt');
});

test('bets come out of the stack and can be taken back before the deal', () => {
  const g = table();
  g.join('b', 'Max', 100);
  g.bet('a', 50);
  assert.equal(g.player('a').stack, 150);
  g.bet('a', 20);
  assert.equal(g.player('a').stack, 180);
  g.cashOut('a');
  assert.equal(g.player('a').cashOuts, 200);
  assert.equal(g.net(g.player('a')), 0);
});

test('limits are enforced', () => {
  const g = table();
  assert.throws(() => g.bet('a', 4));
  assert.throws(() => g.bet('a', 101));
  assert.throws(() => g.bet('a', 7.5));
  g.join('b', 'Max', 10);
  assert.throws(() => g.bet('b', 20), /Not enough/);
  assert.throws(() => g.join('c', 'sam', 50), /already/);
});

test('blackjack pays 3 to 2', () => {
  const g = table();
  rig(g, ['A', '9', 'K', '7']); // Sam A, dealer 9, Sam K, dealer 7
  g.bet('a', 10);
  assert.equal(g.player('a').lastNet, 15);
  assert.equal(g.player('a').stack, 215);
  assert.equal(g.bankNet, -15);
});

test('insurance pays 2 to 1 when the dealer has blackjack', () => {
  const g = table();
  rig(g, ['10', 'A', '9', 'K']);
  g.bet('a', 20);
  assert.equal(g.phase, 'insurance');
  g.insurance('a', true);
  assert.equal(g.player('a').lastNet, 0); // lose 20, insurance wins 20
  assert.equal(g.player('a').stack, 200);
});

test('double and split take money from the stack and settle right', () => {
  const g = table();
  // Sam 8,8 vs dealer 6 hole 10. Split: hand 1 gets 3 (11), double gets 10 = 21. Hand 2 gets 9 (17), stand. Dealer 16 draws 10, busts.
  rig(g, ['8', '6', '8', '10', '3', '10', '9', '10']);
  g.bet('a', 10);
  assert.deepEqual(g.legal('a').includes('split'), true);
  g.act('a', 'split');
  assert.equal(g.player('a').stack, 180);
  g.act('a', 'double');
  assert.equal(g.player('a').stack, 170);
  g.act('a', 'stand');
  assert.equal(g.phase, 'peel'); // the doubled hand's card is still face down
  g.peel('a', 0);
  assert.equal(g.phase, 'betting');
  assert.equal(g.player('a').lastNet, 30);
  assert.equal(g.player('a').stack, 230);
  assert.equal(g.net(g.player('a')), 30);
});

test('cannot cash out mid hand, can after', () => {
  const g = table();
  rig(g, ['10', '9', '6', '7']);
  g.bet('a', 10);
  assert.equal(g.phase, 'play');
  assert.throws(() => g.cashOut('a'), /Finish/);
  g.act('a', 'stand');
  assert.equal(g.cashOut('a'), 190);
  assert.deepEqual(g.settlement(), [{ from: 'Sam', to: 'Lia', amount: 10 }]);
});

test('stop loss closes the table', () => {
  const g = table({ stopLoss: 10 });
  rig(g, ['A', '9', 'K', '7']);
  g.bet('a', 10);
  assert.equal(g.closed, true);
  assert.throws(() => g.bet('a', 10), /closed/);
  assert.deepEqual(g.settlement(), [{ from: 'Lia', to: 'Sam', amount: 15 }]);
});

test('clients never see the shoe or the hole card', () => {
  const g = table();
  rig(g, ['10', '9', '6', '7']);
  g.bet('a', 10);
  const v = g.view();
  assert.equal(v.shoe, undefined);
  assert.equal(v.dealer[1].hidden, true);
  assert.equal(v.dealer[1].rank, undefined);
});

test('random play: money always adds up', () => {
  const rng = seeded(42);
  const g = new TableGame({ minBet: 5, maxBet: 50, stopLoss: 1e9, surrender: true }, rng);
  g.join('a', 'A', 1000); g.join('b', 'B', 1000); g.join('c', 'C', 1000);
  let played = 0;
  // Add up every round's results as they settle, then check the bank's books match.
  const payout = g.payout.bind(g);
  g.payout = () => { payout(); played += g.players.reduce((n, p) => n + (p.hands.length ? p.lastNet : 0), 0); };
  for (let i = 0; i < 3000; i += 1) {
    for (const p of g.players) {
      if (g.phase !== 'betting') break;
      if (p.stack < 50) g.buyIn(p.pid, 500);
      if (rng() < 0.1) g.sitOut(p.pid); else g.bet(p.pid, Math.min(p.stack, 5 + Math.floor(rng() * 46)));
    }
    if (g.phase === 'betting' && g.players.some((p) => p.status === 'bet')) g.dealNow();
    while (g.inRound) {
      if (g.phase === 'peel') { for (const p of g.players) p.hands.forEach((h, i) => { if (h.down) g.peel(p.pid, i); }); continue; }
      if (g.phase === 'insurance') { for (const p of g.players) if (p.hands.length && p.ins === null) g.insurance(p.pid, rng() < 0.3 && p.stack >= p.hands[0].bet / 2); continue; }
      const moves = g.legal(g.turn.pid);
      g.act(g.turn.pid, moves[Math.floor(rng() * moves.length)]);
    }
    for (const p of g.players) assert.ok(p.stack >= 0);
    if (i % 500 === 0) g.cashOut('b');
  }
  assert.ok(Math.abs(g.bankNet + played) < 1e-6, `bank ${g.bankNet} vs players ${played}`);
  const r = TableGame.restore(JSON.parse(JSON.stringify(g)));
  assert.equal(r.bankNet, g.bankNet);
  assert.equal(r.shoe.length, g.shoe.length);
});

test('seats and buy-ins wait for the bank', () => {
  const g = table();
  g.request('b', 'Max', 100);
  assert.equal(g.players.length, 1);
  g.approve(g.requests[0].id);
  assert.equal(g.player('b').stack, 100);
  g.request('b', '', 50);
  assert.equal(g.requests[0].kind, 'buyin');
  g.deny(g.requests[0].id);
  assert.equal(g.player('b').stack, 100);
  assert.throws(() => g.request('c', 'max', 50), /already/);
});

test('a double is dealt face down until peeled or settled', () => {
  const g = table();
  g.join('b', 'Max', 100);
  // Sam 6,5 (11) vs dealer 10, hole 7. Max 10,8. Sam doubles and gets a 9 face down.
  rig(g, ['6', '10', '10', '5', '8', '7', '9']);
  g.bet('a', 10);
  g.bet('b', 10);
  g.act('a', 'double');
  const card = g.view().players[0].hands[0].cards[2];
  assert.equal(card.hidden, true);
  assert.equal(card.rank, undefined);
  g.peel('a', 0);
  assert.equal(g.view().players[0].hands[0].cards[2].rank, '9');
  assert.throws(() => g.peel('a', 0));
  g.act('b', 'stand');
  assert.equal(g.player('a').lastNet, 20);
});

test('a busted face-down double still makes the dealer play', () => {
  const g = table();
  // Sam 6,6 (12) vs dealer 6, hole 10. Sam doubles, gets a K (bust) face down. Dealer 16 must still draw.
  rig(g, ['6', '6', '6', '10', 'K', '5']);
  g.bet('a', 10);
  g.act('a', 'double');
  assert.equal(g.dealer.length, 3);
  assert.equal(g.phase, 'peel');
  assert.equal(g.view().players[0].hands[0].cards[2].hidden, true);
  assert.throws(() => g.cashOut('a'), /Finish/);
  g.peel('a', 0);
  assert.equal(g.phase, 'betting');
  assert.equal(g.player('a').lastNet, -20);
  assert.equal(g.view().players[0].hands[0].cards[2].rank, 'K');
});

test('the bank can turn over a double nobody peels', () => {
  const g = table();
  rig(g, ['6', '10', '5', '7', '9']);
  g.bet('a', 10);
  g.act('a', 'double');
  assert.equal(g.phase, 'peel');
  g.skip();
  assert.equal(g.phase, 'betting');
  assert.equal(g.player('a').lastNet, 20);
});

test('pause holds the next deal, resume deals it', () => {
  const g = table();
  g.setPaused(true);
  g.bet('a', 10);
  assert.equal(g.round, 0);
  assert.throws(() => g.dealNow(), /paused/);
  g.setPaused(false);
  assert.equal(g.round, 1);
});

test('closing mid-hand closes right after the hand is paid', () => {
  const g = table();
  rig(g, ['10', '9', '6', '7']);
  g.bet('a', 10);
  assert.equal(g.phase, 'play');
  g.close();
  assert.equal(g.closed, false);
  assert.equal(g.closeAfter, true);
  g.act('a', 'stand');
  assert.equal(g.closed, true);
  assert.equal(g.player('a').lastNet, -10); // dealer 16 draws a 5
});

test('max players caps seats', () => {
  const g = table({ maxPlayers: 2 });
  g.join('b', 'Max', 100);
  assert.throws(() => g.request('c', 'Zoe', 50), /full/);
  assert.throws(() => g.join('c', 'Zoe', 50), /full/);
  g.setLimits({ minBet: 5, maxBet: 100, stopLoss: 500, maxPlayers: 3 });
  g.request('c', 'Zoe', 50);
  assert.equal(g.requests.length, 1);
});

test('pausing mid-hand warns first and pauses once the hand is paid', () => {
  const g = table();
  rig(g, ['10', '9', '6', '7']);
  g.bet('a', 10);
  g.setPaused(true);
  assert.equal(g.paused, false);
  assert.equal(g.pauseAfter, true);
  g.act('a', 'stand');
  assert.equal(g.paused, true);
  assert.equal(g.pauseAfter, false);
  g.bet('a', 10);
  assert.equal(g.round, 1);
  g.close();
  assert.equal(g.closed, true);
});
