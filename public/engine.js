// Blackjack + Hi-Lo engine. No DOM here, so tests and the simulator run the same code as the app.
// Table rules: dealer stands on all 17s, 3:2 blackjack, double any two, double after split,
// split to 4 hands, split aces get one card, dealer peeks. Late surrender is optional.

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
export const BETS = [1, 2, 4, 8, 12];
export const DECK_POOL = [2, 4, 6, 8];
const MAX_HANDS = 4;
// You estimate decks by eye, so a true count this close to an index is treated as a coin flip.
export const MARGIN = 0.5;

export const cardValue = (rank) =>
  rank === 'A' ? 11 : ['10', 'J', 'Q', 'K'].includes(rank) ? 10 : Number(rank);

export function hiLo(rank) {
  const v = cardValue(rank);
  if (v <= 6) return 1;
  if (v <= 9) return 0;
  return -1;
}

export function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    const v = cardValue(c.rank);
    total += v === 11 ? 1 : v;
    if (v === 11) aces += 1;
  }
  const soft = aces > 0 && total + 10 <= 21;
  return { total: soft ? total + 10 : total, soft };
}

export function buildShoe(decks, rng = Math.random) {
  const cards = [];
  let id = 0;
  for (let d = 0; d < decks; d += 1) {
    for (const suit of SUITS) for (const rank of RANKS) cards.push({ id: id++, rank, suit });
  }
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

/* ---------- basic strategy ---------- */

function hardAction(t, up) {
  if (t <= 8) return 'hit';
  if (t === 9) return up >= 3 && up <= 6 ? 'double' : 'hit';
  if (t === 10) return up <= 9 ? 'double' : 'hit';
  if (t === 11) return up <= 10 ? 'double' : 'hit';
  if (t === 12) return up >= 4 && up <= 6 ? 'stand' : 'hit';
  if (t <= 16) return up <= 6 ? 'stand' : 'hit';
  return 'stand';
}

function softAction(t, up) {
  if (t >= 19) return 'stand';
  if (t === 18) {
    if (up >= 3 && up <= 6) return 'double-or-stand';
    return up <= 8 ? 'stand' : 'hit';
  }
  if (t === 17) return up >= 3 && up <= 6 ? 'double' : 'hit';
  if (t === 16 || t === 15) return up >= 4 && up <= 6 ? 'double' : 'hit';
  if (t === 14 || t === 13) return up >= 5 && up <= 6 ? 'double' : 'hit';
  return 'hit';
}

export function pairSplits(v, up) {
  if (v === 11 || v === 8) return true;
  if (v === 10 || v === 5) return false;
  if (v === 9) return (up >= 2 && up <= 6) || up === 8 || up === 9;
  if (v === 7) return up <= 7;
  if (v === 6) return up <= 6;
  if (v === 4) return up === 5 || up === 6;
  return up <= 7; // 2s and 3s
}

export function basicAction(ctx) {
  const { total, soft, pairValue, up, canDouble, canSplit, canSurrender } = ctx;
  if (canSplit && pairSplits(pairValue, up)) return 'split';
  if (canSurrender && !soft) {
    if (total === 16 && up >= 9) return 'surrender';
    if (total === 15 && up === 10) return 'surrender';
  }
  const a = soft ? softAction(total, up) : hardAction(total, up);
  if (a === 'double-or-stand') return canDouble ? 'double' : 'stand';
  if (a === 'double') return canDouble ? 'double' : 'hit';
  return a;
}

/* ---------- deviations: Illustrious 18 and Fab 4, Hi-Lo, S17 ---------- */

const WHY = {
  stiffHigh:
    'Lots of tens are left. Hitting busts more often and the dealer busts more often too, so you let the dealer take the risk.',
  stiffLow:
    'Few tens are left. You are less likely to bust by hitting and the dealer is less likely to bust, so standing stops being safe.',
  doubleHigh:
    'Extra tens make your one double card stronger and the dealer weaker, so a hand that is normally only worth hitting becomes worth twice the money.',
  splitTens:
    'This is the rarest play in the set. At this count the dealer busts so often that two hands starting on a 10 earn more than one 20.',
  surrender:
    'Tens hurt this hand twice: you bust more if you hit and the dealer makes a hand more if you stand. Past the index, losing half a bet is cheaper than playing on.',
};

const rule = (group, total, up, index, above, below, why) => ({
  id: `${group}-${total}-${up}`,
  group,
  total,
  up,
  index,
  above,
  below,
  why,
});

export const DEVIATIONS = [
  rule('play', 16, 10, 0, 'stand', 'hit', WHY.stiffHigh),
  rule('play', 15, 10, 4, 'stand', 'hit', WHY.stiffHigh),
  rule('pair', 20, 5, 5, 'split', 'stand', WHY.splitTens),
  rule('pair', 20, 6, 4, 'split', 'stand', WHY.splitTens),
  rule('play', 10, 10, 4, 'double', 'hit', WHY.doubleHigh),
  rule('play', 12, 3, 2, 'stand', 'hit', WHY.stiffHigh),
  rule('play', 12, 2, 3, 'stand', 'hit', WHY.stiffHigh),
  rule('play', 11, 11, 1, 'double', 'hit', WHY.doubleHigh),
  rule('play', 9, 2, 1, 'double', 'hit', WHY.doubleHigh),
  rule('play', 10, 11, 4, 'double', 'hit', WHY.doubleHigh),
  rule('play', 9, 7, 3, 'double', 'hit', WHY.doubleHigh),
  rule('play', 16, 9, 5, 'stand', 'hit', WHY.stiffHigh),
  rule('play', 13, 2, -1, 'stand', 'hit', WHY.stiffLow),
  rule('play', 12, 4, 0, 'stand', 'hit', WHY.stiffLow),
  rule('play', 12, 5, -2, 'stand', 'hit', WHY.stiffLow),
  rule('play', 12, 6, -1, 'stand', 'hit', WHY.stiffLow),
  rule('play', 13, 3, -2, 'stand', 'hit', WHY.stiffLow),
  rule('surrender', 14, 10, 3, 'surrender', null, WHY.surrender),
  rule('surrender', 15, 10, 0, 'surrender', null, WHY.surrender),
  rule('surrender', 15, 9, 2, 'surrender', null, WHY.surrender),
  rule('surrender', 15, 11, 1, 'surrender', null, WHY.surrender),
];

export const INSURANCE_INDEX = 3;

export function findRule(ctx) {
  const { total, soft, pairValue, up, canDouble, canSplit, canSurrender } = ctx;
  if (canSplit && pairValue) {
    if (pairValue === 10) return DEVIATIONS.find((r) => r.group === 'pair' && r.up === up) ?? null;
    if (pairSplits(pairValue, up)) return null;
  }
  if (soft) return null;
  const match = (group) =>
    DEVIATIONS.find((r) => r.group === group && r.total === total && r.up === up);
  if (canSurrender) {
    const s = match('surrender');
    if (s) return s;
    if (basicAction(ctx) === 'surrender') return null;
  }
  const p = match('play');
  if (!p) return null;
  if (p.above === 'double' && !canDouble) return null;
  return p;
}

export function recommend(ctx, tc) {
  const basic = basicAction(ctx);
  const r = findRule(ctx);
  if (!r) return { action: basic, basic, rule: null, accepted: [basic], close: false };
  const below = r.below ?? recommend({ ...ctx, canSurrender: false }, tc).action;
  const action = tc >= r.index ? r.above : below;
  const close = Math.abs(tc - r.index) < MARGIN && r.above !== below;
  return { action, basic, rule: r, accepted: close ? [r.above, below] : [action], close };
}

export function recommendedBet(tc) {
  const t = Math.floor(tc);
  if (t >= 5) return 12;
  if (t === 4) return 8;
  if (t === 3) return 4;
  if (t === 2) return 2;
  return 1;
}

/* ---------- game ---------- */

export class Game {
  constructor({ deckMode = 'random', penMode = 'random', surrender = false, rng = Math.random } = {}) {
    this.deckMode = deckMode;
    this.penMode = penMode;
    this.surrender = surrender;
    this.rng = rng;
    this.newShoe();
  }

  newShoe() {
    this.decks =
      this.deckMode === 'random'
        ? DECK_POOL[Math.floor(this.rng() * DECK_POOL.length)]
        : Number(this.deckMode);
    this.shoe = buildShoe(this.decks, this.rng);
    const total = this.shoe.length;
    this.placeCut(total);
    this.rc = 0;
    this.shoeId = (this.shoeId ?? 0) + 1;
    this.resetTable();
    this.phase = 'ready';
  }

  // Moves the cut card in the current shoe, so a new penetration setting applies right away.
  placeCut(total = this.decks * 52) {
    this.penetration = this.penMode === 'random' ? 0.7 + this.rng() * 0.1 : Number(this.penMode);
    this.cutRemaining = Math.max(10, Math.round(total * (1 - this.penetration)));
  }

  setPenetration(mode) {
    this.penMode = mode;
    this.placeCut();
  }

  resetTable() {
    this.dealer = [];
    this.holeHidden = false;
    this.hands = [];
    this.active = 0;
    this.insuranceBet = 0;
    this.insuranceNet = 0;
    this.roundNet = 0;
  }

  get needsShuffle() {
    return this.phase !== 'play' && this.phase !== 'insurance' && this.shoe.length <= this.cutRemaining;
  }

  get unseen() {
    return this.shoe.length + (this.holeHidden ? 1 : 0);
  }

  get decksLeft() {
    return this.unseen / 52;
  }

  get trueCount() {
    return this.rc / this.decksLeft;
  }

  get onTable() {
    return this.dealer.length + this.hands.reduce((n, h) => n + h.cards.length, 0);
  }

  get discarded() {
    return this.decks * 52 - this.shoe.length - this.onTable;
  }

  // Share of unseen cards that are ten-valued. This is what insurance really depends on.
  get tenDensity() {
    const unseenCards = this.holeHidden ? [...this.shoe, this.dealer[1]] : this.shoe;
    const tens = unseenCards.filter((c) => cardValue(c.rank) === 10).length;
    return tens / unseenCards.length;
  }

  draw(visible = true) {
    // The cut card leaves at least 20 cards, so this only guards a freak four-way split.
    if (!this.shoe.length) this.shoe = buildShoe(1, this.rng);
    const card = this.shoe.pop();
    if (visible) this.rc += hiLo(card.rank);
    return card;
  }

  snapshot() {
    return { tc: this.trueCount, rc: this.rc, decksLeft: this.decksLeft };
  }

  deal(bet) {
    if (this.phase !== 'ready' && this.phase !== 'settled') throw new Error('Round in progress');
    const before = this.snapshot();
    const rec = recommendedBet(before.tc);
    const lo = recommendedBet(before.tc - MARGIN);
    const hi = recommendedBet(before.tc + MARGIN);
    this.resetTable();
    const hand = this.makeHand(bet);
    hand.cards.push(this.draw());
    this.dealer.push(this.draw());
    hand.cards.push(this.draw());
    this.dealer.push(this.draw(false));
    this.holeHidden = true;
    this.hands = [hand];
    this.phase = this.upValue === 11 ? 'insurance' : 'play';
    if (this.phase === 'play') this.afterPeek();
    return { type: 'bet', ...before, bet, rec, ok: bet >= lo && bet <= hi };
  }

  makeHand(bet, extra = {}) {
    return { cards: [], bet, done: false, fromSplit: false, fromAces: false, ...extra };
  }

  get upValue() {
    return cardValue(this.dealer[0].rank);
  }

  dealerHasBlackjack() {
    return handValue(this.dealer).total === 21;
  }

  isBlackjack(hand) {
    return !hand.fromSplit && hand.cards.length === 2 && handValue(hand.cards).total === 21;
  }

  afterPeek() {
    if (this.dealerHasBlackjack() || this.isBlackjack(this.hands[0])) this.settle();
  }

  insurance(take) {
    if (this.phase !== 'insurance') throw new Error('No insurance offered');
    const before = this.snapshot();
    const density = this.tenDensity;
    const should = before.tc >= INSURANCE_INDEX;
    const close = Math.abs(before.tc - INSURANCE_INDEX) < MARGIN;
    if (take) this.insuranceBet = this.hands[0].bet / 2;
    this.phase = 'play';
    this.afterPeek();
    return { type: 'insurance', ...before, take, should, close, density, ok: close || take === should };
  }

  context(hand = this.hands[this.active]) {
    const { total, soft } = handValue(hand.cards);
    const [a, b] = hand.cards;
    const two = hand.cards.length === 2;
    const pairValue = two && cardValue(a.rank) === cardValue(b.rank) ? cardValue(a.rank) : null;
    return {
      total,
      soft,
      pairValue,
      up: this.upValue,
      canDouble: two && !hand.fromAces,
      canSplit: Boolean(pairValue) && this.hands.length < MAX_HANDS && !hand.fromAces,
      canSurrender: this.surrender && two && this.hands.length === 1 && !hand.fromSplit,
    };
  }

  legalActions() {
    if (this.phase !== 'play') return [];
    const c = this.context();
    return [
      'hit',
      'stand',
      ...(c.canDouble ? ['double'] : []),
      ...(c.canSplit ? ['split'] : []),
      ...(c.canSurrender ? ['surrender'] : []),
    ];
  }

  act(action) {
    if (!this.legalActions().includes(action)) throw new Error(`Illegal action: ${action}`);
    const before = this.snapshot();
    const ctx = this.context();
    const rec = recommend(ctx, before.tc);
    const hand = this.hands[this.active];

    if (action === 'hit') {
      hand.cards.push(this.draw());
      if (handValue(hand.cards).total >= 21) this.finishHand();
    } else if (action === 'stand') {
      this.finishHand();
    } else if (action === 'double') {
      hand.bet *= 2;
      hand.doubled = true;
      hand.cards.push(this.draw());
      this.finishHand();
    } else if (action === 'surrender') {
      hand.surrendered = true;
      this.finishHand();
    } else if (action === 'split') {
      this.split(hand);
    }

    return {
      type: 'play',
      ...before,
      ctx,
      chosen: action,
      ...rec,
      ok: rec.accepted.includes(action),
    };
  }

  split(hand) {
    const aces = hand.cards[0].rank === 'A';
    const second = this.makeHand(hand.bet, { fromSplit: true, fromAces: aces });
    second.cards.push(hand.cards.pop());
    hand.fromSplit = true;
    hand.fromAces = aces;
    this.hands.splice(this.active + 1, 0, second);
    if (aces) {
      hand.cards.push(this.draw());
      second.cards.push(this.draw());
      hand.done = true;
      second.done = true;
      this.finishHand();
      return;
    }
    hand.cards.push(this.draw());
    if (handValue(hand.cards).total === 21) this.finishHand();
  }

  finishHand() {
    this.hands[this.active].done = true;
    const next = this.hands.findIndex((h) => !h.done);
    if (next === -1) {
      this.settle();
      return;
    }
    this.active = next;
    const hand = this.hands[next];
    if (hand.cards.length === 1) {
      hand.cards.push(this.draw());
      if (handValue(hand.cards).total === 21) this.finishHand();
    }
  }

  revealHole() {
    if (!this.holeHidden) return;
    this.holeHidden = false;
    this.rc += hiLo(this.dealer[1].rank);
  }

  settle() {
    this.revealHole();
    const dealerBJ = this.dealerHasBlackjack();
    const live = this.hands.some(
      (h) => !h.surrendered && handValue(h.cards).total <= 21 && !this.isBlackjack(h),
    );
    if (live && !dealerBJ) {
      // Stands on all 17s, soft 17 included.
      while (handValue(this.dealer).total < 17) this.dealer.push(this.draw());
    }
    const dealerTotal = handValue(this.dealer).total;
    let net = 0;
    for (const h of this.hands) {
      const { total } = handValue(h.cards);
      const bj = this.isBlackjack(h);
      if (h.surrendered) [h.result, h.net] = ['surrender', -h.bet / 2];
      else if (total > 21) [h.result, h.net] = ['bust', -h.bet];
      else if (bj && dealerBJ) [h.result, h.net] = ['push', 0];
      else if (bj) [h.result, h.net] = ['blackjack', h.bet * 1.5];
      else if (dealerBJ) [h.result, h.net] = ['lose', -h.bet];
      else if (dealerTotal > 21 || total > dealerTotal) [h.result, h.net] = ['win', h.bet];
      else if (total === dealerTotal) [h.result, h.net] = ['push', 0];
      else [h.result, h.net] = ['lose', -h.bet];
      net += h.net;
    }
    if (this.insuranceBet) {
      this.insuranceNet = dealerBJ ? this.insuranceBet * 2 : -this.insuranceBet;
      net += this.insuranceNet;
    }
    this.roundNet = net;
    this.phase = 'settled';
  }
}

/* ---------- coaching text ---------- */

export const signed = (n, digits = 0) => {
  const v = Number(n.toFixed(digits));
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;
};

export const upLabel = (v) => (v === 11 ? 'A' : String(v));

export function handName(ctx) {
  if (ctx.pairValue && ctx.canSplit) {
    const name = ctx.pairValue === 11 ? 'aces' : ctx.pairValue === 10 ? 'tens' : `${ctx.pairValue}s`;
    return `Pair of ${name}`;
  }
  return `${ctx.soft ? 'Soft' : 'Hard'} ${ctx.total}`;
}

export const ruleName = (r) => {
  const hand = r.group === 'pair' ? '10,10' : String(r.total);
  return `${hand} vs ${upLabel(r.up)}`;
};

function basicWhy(ctx, action) {
  const { total, soft, pairValue, up } = ctx;
  const weak = up <= 6;
  const u = upLabel(up);
  if (action === 'split') {
    if (pairValue === 11) return 'Together they are a weak 12. Apart they are two hands starting on 11.';
    if (pairValue === 8) return '16 is the worst total you can hold. Two hands starting on 8 lose much less.';
    return `Against a dealer ${u}, two hands from this pair earn more than one.`;
  }
  if (action === 'surrender') return 'Played out, this hand loses more than half a bet on average, so giving up half is cheaper.';
  if (action === 'double') {
    return soft
      ? 'One more card cannot bust a soft hand and the dealer is weak, so get more money out.'
      : `You are ahead of a dealer ${u}, so get more money out while you are the favorite.`;
  }
  if (action === 'stand') {
    if (soft) return `Soft ${total} is already good enough against a dealer ${u}.`;
    if (total >= 17) return 'At 17 or more, hitting busts too often to be worth it.';
    return `A dealer ${u} is a bust card. Do not risk busting first, make the dealer draw.`;
  }
  if (soft) return `Soft ${total} cannot bust on one card and it is not strong enough to stop on against a dealer ${u}.`;
  if (total <= 11) return 'You cannot bust on one card, so there is nothing to lose by hitting.';
  if (weak) return `Only tens bust a 12, and a dealer ${u} is not weak enough to stand on it.`;
  return `A dealer ${u} usually ends on 17 or better, so standing on ${total} loses most of the time.`;
}

const countLine = (e) =>
  `True count ${signed(e.tc, 1)}: running ${signed(e.rc)} over ${e.decksLeft.toFixed(1)} decks left.`;

const cap = (s) => s[0].toUpperCase() + s.slice(1);

export function explain(e) {
  if (e.type === 'insurance') {
    const pct = (e.density * 100).toFixed(1);
    const action = e.take ? 'Took insurance' : 'Declined insurance';
    const lines = [
      countLine(e),
      `Index: take it at ${signed(INSURANCE_INDEX)} or higher.`,
      `Insurance pays 2 to 1, so it breaks even when tens are one third (33.3%) of unseen cards. Right now they are ${pct}%.`,
    ];
    if (e.close) return { tone: 'close', tag: 'Deviation', title: `${action}: too close to call`, lines };
    if (e.should) return { tone: e.ok ? 'good' : 'bad', tag: 'Deviation', title: e.ok ? 'Took insurance: correct deviation' : 'Missed deviation: take insurance', lines };
    return { tone: e.ok ? 'good' : 'bad', tag: 'Insurance', title: e.ok ? 'Declined insurance: correct' : 'Insurance is a bad bet here', lines };
  }

  const spot = `${handName(e.ctx)} vs ${upLabel(e.ctx.up)}`;
  if (!e.rule) {
    return e.ok
      ? { tone: 'good', tag: 'Basic', title: `${cap(e.chosen)}: correct`, lines: [`${spot}.`] }
      : {
          tone: 'bad',
          tag: 'Basic',
          title: `${cap(e.action)}, not ${e.chosen}`,
          lines: [`${spot}. ${basicWhy(e.ctx, e.action)}`],
        };
  }

  const r = e.rule;
  const below = r.below ?? 'play on';
  const index = `Index: ${r.above} at ${signed(r.index)} or higher, otherwise ${below}.`;
  const lines = [spot + '.', countLine(e), index];
  if (e.close) {
    return {
      tone: 'close',
      tag: 'Deviation',
      title: `${cap(e.chosen)}: too close to call`,
      lines: [...lines, `The count is within ${MARGIN} of the index, so either play is fine. ${r.why}`],
    };
  }
  const deviating = e.action !== e.basic;
  if (deviating) {
    return {
      tone: e.ok ? 'good' : 'bad',
      tag: 'Deviation',
      title: e.ok ? `${cap(e.action)}: correct deviation` : `Missed deviation: ${e.action}, not ${e.chosen}`,
      lines: [...lines, `Basic strategy says ${e.basic}, but the count overrides it. ${r.why}`],
    };
  }
  return {
    tone: e.ok ? 'good' : 'bad',
    tag: 'Near deviation',
    title: e.ok ? `${cap(e.action)}: correct, stay with basic` : `${cap(e.action)}, not ${e.chosen}: count is not there`,
    lines: [...lines, `This hand has a deviation, but the count has not reached it, so basic strategy stands.`],
  };
}

export function explainBet(e) {
  return {
    tone: 'bad',
    tag: 'Bet',
    title: `Bet ${e.rec}u, not ${e.bet}u`,
    lines: [countLine(e), 'Ramp: 1u below +2, then 2u at +2, 4u at +3, 8u at +4, 12u at +5 or higher.'],
  };
}

/* ---------- deviation drill ---------- */

const TEN_RANKS = ['10', 'J', 'Q', 'K'];
const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];
const rankFor = (v, rng) => (v === 11 ? 'A' : v === 10 ? pick(TEN_RANKS, rng) : String(v));
const drillCard = (v, rng) => ({ id: `d${rng()}`, rank: rankFor(v, rng), suit: pick(SUITS, rng) });

// Two different values from 2 to 10 that add up to a hard total, so the hand is never a pair or soft.
function hardSplits(total) {
  const out = [];
  for (let a = 2; a <= 10; a += 1) {
    const b = total - a;
    if (b > a && b <= 10) out.push([a, b]);
  }
  return out;
}

function drillContext(rule, surrender) {
  const pair = rule.group === 'pair';
  return {
    total: rule.total,
    soft: false,
    pairValue: pair ? 10 : null,
    up: rule.up,
    canDouble: true,
    canSplit: pair,
    canSurrender: surrender,
  };
}

// Every spot the drill can ask about with these rules: the deviations that really apply, plus insurance.
export function drillSpots({ surrender = false } = {}) {
  const spots = DEVIATIONS.filter((r) => findRule(drillContext(r, surrender)) === r)
    .map((r) => ({ id: r.id, rule: r, index: r.index }));
  return [...spots, { id: 'insurance', rule: null, index: INSURANCE_INDEX }];
}

export const spotName = (s) => (s.rule ? ruleName(s.rule) : 'Insurance');

// A scenario near one index: a hand, a dealer upcard, and a count that is clearly on one side of it.
// `weight(spot)` lets the app lean toward spots you keep missing.
export function makeDrill({ surrender = false, rng = Math.random, weight = () => 1 } = {}) {
  const spots = drillSpots({ surrender });
  const weights = spots.map((s) => Math.max(0.01, weight(s)));
  let roll = rng() * weights.reduce((a, b) => a + b, 0);
  let spot = spots[spots.length - 1];
  for (let i = 0; i < spots.length; i += 1) {
    roll -= weights[i];
    if (roll < 0) { spot = spots[i]; break; }
  }

  // Half deck steps from 1 to 6, the way you would read the tray. Running count is a whole number.
  let decksLeft;
  let rc;
  let tc;
  do {
    decksLeft = 1 + Math.floor(rng() * 11) / 2;
    const side = rng() < 0.5 ? -1 : 1;
    const target = spot.index + side * (MARGIN + rng() * 3);
    rc = Math.round(target * decksLeft);
    tc = rc / decksLeft;
  } while (Math.abs(tc - spot.index) < MARGIN || Math.abs(tc) > 9);

  if (!spot.rule) {
    const total = pick([12, 13, 14, 15, 16, 17, 18, 19], rng);
    const [x, y] = pick(hardSplits(total), rng);
    const take = tc >= INSURANCE_INDEX;
    return {
      kind: 'insurance', spot, rc, decksLeft, tc,
      player: [drillCard(x, rng), drillCard(y, rng)], up: drillCard(11, rng),
      options: ['take', 'decline'], answer: take ? 'take' : 'decline',
    };
  }

  const r = spot.rule;
  const ctx = drillContext(r, surrender);
  const [x, y] = r.group === 'pair' ? [10, 10] : pick(hardSplits(r.total), rng);
  const rec = recommend(ctx, tc);
  const options = ['hit', 'stand', 'double', ...(ctx.canSplit ? ['split'] : []), ...(surrender ? ['surrender'] : [])];
  return {
    kind: 'play', spot, rc, decksLeft, tc, ctx,
    player: [drillCard(x, rng), drillCard(y, rng)], up: drillCard(r.up, rng),
    options, answer: rec.action, rec,
  };
}

export function gradeDrill(d, chosen) {
  const ok = chosen === d.answer;
  const base = { tc: d.tc, rc: d.rc, decksLeft: d.decksLeft };
  if (d.kind === 'insurance') {
    const lines = [
      countLine(base),
      `Index: take it at ${signed(INSURANCE_INDEX)} or higher.`,
      'Insurance pays 2 to 1, so it only pays off on average when more than a third of unseen cards are tens. Below the index they are not.',
    ];
    const title = ok
      ? `${d.answer === 'take' ? 'Take insurance' : 'Decline insurance'}: correct`
      : d.answer === 'take' ? 'Take insurance: the count is past the index' : 'Decline insurance: the count is not there';
    return { ok, note: { tone: ok ? 'good' : 'bad', tag: 'Insurance', title, lines } };
  }
  const note = explain({ type: 'play', ...base, ctx: d.ctx, chosen, ...d.rec, ok, close: false });
  return { ok, note };
}
