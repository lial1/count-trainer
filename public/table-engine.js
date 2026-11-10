// Multi-seat blackjack for a home game. The host's browser runs this and is the bank.
// Same table rules as the trainer: S17, 3:2, double any two, DAS, split to 4, split aces one card,
// dealer peeks. Money is in dollars. Bets come out of a player's stack when placed.

import { buildShoe, handValue, cardValue } from './engine.js';

const MAX_HANDS = 4;
export const MAX_SEATS = 6;
export const MAX_BUY_IN = 100000;

export const money = (n) => {
  const v = Math.round(n * 100) / 100;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
  return `${v < 0 ? '-' : ''}$${s}`;
};

const round2 = (n) => Math.round(n * 100) / 100;

function wholeDollars(n, what) {
  const v = Number(n);
  if (!Number.isInteger(v) || v <= 0) throw new Error(`${what} has to be a whole dollar amount`);
  return v;
}

export const DEFAULTS = { bankName: 'Bank', decks: 6, pen: 0.75, minBet: 5, maxBet: 100, stopLoss: 500, surrender: false };

export function cleanConfig(c = {}) {
  const cfg = { ...DEFAULTS, ...c };
  cfg.bankName = String(cfg.bankName || 'Bank').trim().slice(0, 20) || 'Bank';
  cfg.decks = [1, 2, 4, 6, 8].includes(Number(cfg.decks)) ? Number(cfg.decks) : 6;
  cfg.pen = Math.min(0.9, Math.max(0.5, Number(cfg.pen) || 0.75));
  cfg.minBet = wholeDollars(cfg.minBet, 'Min bet');
  cfg.maxBet = wholeDollars(cfg.maxBet, 'Max bet');
  if (cfg.maxBet < cfg.minBet) throw new Error('Max bet has to be at least the min bet');
  cfg.stopLoss = wholeDollars(cfg.stopLoss, 'Stop loss');
  cfg.surrender = Boolean(cfg.surrender);
  return cfg;
}

export class TableGame {
  constructor(cfg = {}, rng = Math.random) {
    this.rng = rng;
    this.cfg = cleanConfig(cfg);
    this.players = [];
    this.dealer = [];
    this.holeHidden = false;
    this.phase = 'betting';
    this.round = 0;
    this.turn = null;
    this.log = [];
    this.closed = false;
    this.closeReason = '';
    this.shoeNo = 0;
    this.requests = [];
    this.reqId = 0;
    this.shuffle();
  }

  static restore(data, rng = Math.random) {
    const g = new TableGame(data.cfg, rng);
    Object.assign(g, data, { rng });
    return g;
  }

  toJSON() {
    const { rng, ...rest } = this;
    return rest;
  }

  note(text) {
    this.log.push(text);
    if (this.log.length > 80) this.log.shift();
  }

  shuffle() {
    this.shoe = buildShoe(this.cfg.decks, this.rng);
    this.cutRemaining = Math.max(10, Math.round(this.shoe.length * (1 - this.cfg.pen)));
    this.shoeNo += 1;
    if (this.shoeNo > 1) this.note(`New shoe, ${this.cfg.decks} decks shuffled.`);
  }

  draw() {
    // The cut card always leaves cards behind, so this only guards a freak run of splits.
    if (!this.shoe.length) this.shoe = buildShoe(1, this.rng);
    return this.shoe.pop();
  }

  player(pid) {
    const p = this.players.find((x) => x.pid === pid);
    if (!p) throw new Error('You are not at this table');
    return p;
  }

  open() {
    if (this.closed) throw new Error('The table is closed');
  }

  /* ---------- money ---------- */

  // Money a player has in play right now (bets and insurance not yet settled).
  committed(p) {
    if (this.phase === 'betting') return p.status === 'bet' ? p.wager : 0;
    return p.hands.filter((h) => !h.settled).reduce((n, h) => n + h.bet, 0) + (p.insBet || 0);
  }

  net(p) {
    return round2(p.stack + this.committed(p) + p.cashOuts - p.buyIns);
  }

  get bankNet() {
    return round2(-this.players.reduce((n, p) => n + this.net(p), 0));
  }

  get inRound() {
    return this.phase === 'insurance' || this.phase === 'play' || this.phase === 'peel';
  }

  /* ---------- seats ---------- */

  join(pid, name, buyIn) {
    this.open();
    const clean = String(name || '').trim().slice(0, 20);
    const existing = this.players.find((x) => x.pid === pid);
    if (existing) {
      if (clean) existing.name = clean;
      return existing;
    }
    if (!clean) throw new Error('Put in a name');
    if (this.players.length >= MAX_SEATS) throw new Error('The table is full');
    if (this.players.some((x) => x.name.toLowerCase() === clean.toLowerCase())) throw new Error('Someone already has that name');
    const amount = wholeDollars(buyIn, 'Buy-in');
    const p = { pid, name: clean, stack: 0, buyIns: 0, cashOuts: 0, status: 'none', wager: 0, lastWager: 0, hands: [], ins: null, insBet: 0, lastNet: null };
    this.players.push(p);
    this.note(`${clean} sat down.`);
    this.buyIn(pid, amount);
    return p;
  }

  // Seats and buy-ins wait for the bank to approve them, like a host letting someone sit down.
  request(pid, name, amount) {
    this.open();
    const v = wholeDollars(amount, 'Buy-in');
    const seated = this.players.find((x) => x.pid === pid);
    const clean = seated ? seated.name : String(name || '').trim().slice(0, 20);
    if (!clean) throw new Error('Put in a name');
    if (!seated) {
      if (this.players.length >= MAX_SEATS) throw new Error('The table is full');
      if (this.players.some((x) => x.name.toLowerCase() === clean.toLowerCase())) throw new Error('Someone already has that name');
    }
    if (v > MAX_BUY_IN) throw new Error(`Buy-ins top out at ${money(MAX_BUY_IN)}`);
    this.requests = this.requests.filter((r) => r.pid !== pid);
    this.reqId += 1;
    this.requests.push({ id: this.reqId, pid, name: clean, amount: v, kind: seated ? 'buyin' : 'join' });
  }

  approve(id) {
    const r = this.requests.find((x) => x.id === id);
    if (!r) throw new Error('That request is gone');
    this.requests = this.requests.filter((x) => x.id !== id);
    if (r.kind === 'join') this.join(r.pid, r.name, r.amount);
    else this.buyIn(r.pid, r.amount);
    this.maybeDeal();
  }

  deny(id) {
    const r = this.requests.find((x) => x.id === id);
    this.requests = this.requests.filter((x) => x.id !== id);
    if (r) this.note(`Bank turned down ${r.name}'s ${r.kind === 'join' ? 'seat' : 'buy-in'}.`);
  }

  buyIn(pid, amount) {
    this.open();
    const p = this.player(pid);
    const v = wholeDollars(amount, 'Buy-in');
    if (p.buyIns + v > MAX_BUY_IN) throw new Error(`Buy-ins top out at ${money(MAX_BUY_IN)}`);
    p.stack += v;
    p.buyIns += v;
    this.note(`${p.name} bought in for ${money(v)}.`);
  }

  cashOut(pid) {
    const p = this.player(pid);
    if (this.inRound && p.hands.length) throw new Error('Finish this hand first');
    this.unbet(p);
    p.status = 'none';
    const amount = p.stack;
    p.cashOuts = round2(p.cashOuts + amount);
    p.stack = 0;
    this.note(`${p.name} cashed out ${money(amount)}.`);
    this.maybeDeal();
    return amount;
  }

  /* ---------- betting ---------- */

  // Takes back a bet that has not been dealt yet.
  unbet(p) {
    if (this.phase !== 'betting') return;
    if (p.status === 'bet') p.stack = round2(p.stack + p.wager);
    p.wager = 0;
    if (p.status === 'bet') p.status = 'none';
  }

  bet(pid, amount) {
    this.open();
    if (this.phase !== 'betting') throw new Error('Wait for the next hand');
    const p = this.player(pid);
    const v = wholeDollars(amount, 'Bet');
    const { minBet, maxBet } = this.cfg;
    if (v < minBet || v > maxBet) throw new Error(`Bets are ${money(minBet)} to ${money(maxBet)}`);
    this.unbet(p);
    if (v > p.stack) throw new Error('Not enough chips. Buy in more first.');
    p.stack = round2(p.stack - v);
    p.wager = v;
    p.status = 'bet';
    this.maybeDeal();
  }

  sitOut(pid) {
    if (this.phase !== 'betting') throw new Error('Wait for the next hand');
    const p = this.player(pid);
    this.unbet(p);
    p.status = 'out';
    this.maybeDeal();
  }

  canPlay(p) {
    return p.stack >= this.cfg.minBet || p.status === 'bet';
  }

  maybeDeal() {
    if (this.phase !== 'betting' || this.closed) return;
    const waiting = this.players.filter((p) => this.canPlay(p) && p.status === 'none');
    if (!waiting.length && this.players.some((p) => p.status === 'bet')) this.deal();
  }

  // Bank: deal now without waiting. Anyone who has not bet just misses this hand.
  dealNow() {
    this.open();
    if (this.phase !== 'betting') throw new Error('A hand is already going');
    if (!this.players.some((p) => p.status === 'bet')) throw new Error('Nobody has bet yet');
    this.deal();
  }

  makeHand(bet, extra = {}) {
    return { cards: [], bet, done: false, fromSplit: false, fromAces: false, ...extra };
  }

  deal() {
    if (this.shoe.length <= this.cutRemaining) this.shuffle();
    this.round += 1;
    this.dealer = [];
    const seated = this.players.filter((p) => p.status === 'bet');
    for (const p of this.players) {
      p.hands = [];
      p.ins = null;
      p.insBet = 0;
      p.insNet = 0;
      p.lastNet = null;
    }
    for (const p of seated) {
      p.hands = [this.makeHand(p.wager)];
      p.lastWager = p.wager;
    }
    for (const p of seated) p.hands[0].cards.push(this.draw());
    this.dealer.push(this.draw());
    for (const p of seated) p.hands[0].cards.push(this.draw());
    this.dealer.push(this.draw());
    this.holeHidden = true;
    if (cardValue(this.dealer[0].rank) === 11) this.phase = 'insurance';
    else this.peek();
  }

  /* ---------- insurance ---------- */

  insurance(pid, take) {
    if (this.phase !== 'insurance') throw new Error('No insurance right now');
    const p = this.player(pid);
    if (!p.hands.length || p.ins !== null) throw new Error('Already decided');
    if (take) {
      const cost = round2(p.hands[0].bet / 2);
      if (cost > p.stack) throw new Error('Not enough chips for insurance');
      p.stack = round2(p.stack - cost);
      p.insBet = cost;
    }
    p.ins = Boolean(take);
    if (this.players.every((x) => !x.hands.length || x.ins !== null)) this.peek();
  }

  peek() {
    if (handValue(this.dealer).total === 21) {
      this.settle();
      return;
    }
    for (const p of this.players) for (const h of p.hands) if (this.isBlackjack(h)) h.done = true;
    this.phase = 'play';
    this.advance();
  }

  /* ---------- play ---------- */

  isBlackjack(h) {
    return !h.fromSplit && h.cards.length === 2 && handValue(h.cards).total === 21;
  }

  advance() {
    for (const p of this.players) {
      for (let i = 0; i < p.hands.length; i += 1) {
        const h = p.hands[i];
        if (h.done) continue;
        if (h.cards.length === 1) h.cards.push(this.draw());
        if (handValue(h.cards).total >= 21) { h.done = true; continue; }
        this.turn = { pid: p.pid, hand: i };
        return;
      }
    }
    this.turn = null;
    this.settle();
  }

  legal(pid) {
    if (this.phase !== 'play' || !this.turn || this.turn.pid !== pid) return [];
    const p = this.player(pid);
    const h = p.hands[this.turn.hand];
    const two = h.cards.length === 2;
    const [a, b] = h.cards;
    const pair = two && cardValue(a.rank) === cardValue(b.rank);
    const out = ['hit', 'stand'];
    if (two && !h.fromAces && p.stack >= h.bet) out.push('double');
    if (pair && p.hands.length < MAX_HANDS && !h.fromAces && p.stack >= h.bet) out.push('split');
    if (this.cfg.surrender && two && p.hands.length === 1 && !h.fromSplit) out.push('surrender');
    return out;
  }

  act(pid, action) {
    if (!this.legal(pid).includes(action)) throw new Error("You can't do that right now");
    const p = this.player(pid);
    const h = p.hands[this.turn.hand];
    if (action === 'hit') {
      h.cards.push(this.draw());
      if (handValue(h.cards).total >= 21) h.done = true;
    } else if (action === 'stand') {
      h.done = true;
    } else if (action === 'double') {
      p.stack = round2(p.stack - h.bet);
      h.bet *= 2;
      h.doubled = true;
      // Dealt face down, like a casino double. The player can peel it, otherwise it turns over at the end.
      h.cards.push(this.draw());
      h.down = true;
      h.done = true;
    } else if (action === 'surrender') {
      h.surrendered = true;
      h.done = true;
    } else if (action === 'split') {
      p.stack = round2(p.stack - h.bet);
      const aces = h.cards[0].rank === 'A';
      const second = this.makeHand(h.bet, { fromSplit: true, fromAces: aces });
      second.cards.push(h.cards.pop());
      h.fromSplit = true;
      h.fromAces = aces;
      p.hands.splice(this.turn.hand + 1, 0, second);
      h.cards.push(this.draw());
      if (aces) {
        second.cards.push(this.draw());
        h.done = true;
        second.done = true;
      }
    }
    this.advance();
  }

  // Bank: move a stuck table along. Stands the hand in play, or declines insurance for everyone left.
  skip() {
    if (this.phase === 'play' && this.turn) {
      const p = this.player(this.turn.pid);
      this.note(`Bank stood ${p.name}'s hand.`);
      p.hands[this.turn.hand].done = true;
      this.advance();
    } else if (this.phase === 'insurance') {
      for (const p of this.players) if (p.hands.length && p.ins === null) p.ins = false;
      this.peek();
    } else if (this.phase === 'peel') {
      this.note('Bank turned over the doubles.');
      for (const p of this.players) for (const h of p.hands) h.down = false;
      this.payout();
    } else {
      this.dealNow();
    }
  }

  settle() {
    this.holeHidden = false;
    this.turn = null;
    const dealerBJ = handValue(this.dealer).total === 21 && this.dealer.length === 2;
    // A face-down double counts as live even if it busted, so the dealer's play gives nothing away.
    const live = this.players.some((p) => p.hands.some((h) =>
      !h.surrendered && (h.down || handValue(h.cards).total <= 21) && !this.isBlackjack(h)));
    if (live && !dealerBJ) {
      while (handValue(this.dealer).total < 17) this.dealer.push(this.draw());
    }
    // Like a real table: the dealer finishes first, then whoever doubled peels their card.
    if (this.players.some((p) => p.hands.some((h) => h.down))) {
      this.phase = 'peel';
      return;
    }
    this.payout();
  }

  payout() {
    const dealerBJ = handValue(this.dealer).total === 21 && this.dealer.length === 2;
    const dealerTotal = handValue(this.dealer).total;
    for (const p of this.players) {
      if (!p.hands.length) continue;
      let net = 0;
      for (const h of p.hands) {
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
        h.net = round2(h.net);
        p.stack = round2(p.stack + h.bet + h.net);
        net += h.net;
      }
      if (p.insBet) {
        const ins = dealerBJ ? p.insBet * 2 : -p.insBet;
        p.insNet = ins;
        p.stack = round2(p.stack + p.insBet + ins);
        net += ins;
      }
      p.lastNet = round2(net);
      // Hands stay on the felt until the next deal, but no money is in them any more.
      for (const h of p.hands) { h.settled = true; h.down = false; }
      p.insBet = 0;
      p.status = 'none';
      p.wager = 0;
      this.note(`${p.name} ${p.lastNet > 0 ? 'won' : p.lastNet < 0 ? 'lost' : 'pushed'}${p.lastNet ? ` ${money(Math.abs(p.lastNet))}` : ''}.`);
    }
    this.phase = 'betting';
    if (this.bankNet <= -this.cfg.stopLoss) this.close(`Stop loss hit: the bank is down ${money(-this.bankNet)}.`);
  }

  close(reason = 'The bank closed the table.') {
    if (this.inRound) throw new Error('Finish this hand first');
    for (const p of this.players) this.unbet(p);
    this.closed = true;
    this.closeReason = reason;
    this.note(reason);
  }

  // The player turns over their own face-down double.
  peel(pid, index) {
    if (!this.inRound) throw new Error('Nothing to peel');
    const h = this.player(pid).hands[Number(index)];
    if (!h || !h.down) throw new Error('Nothing to peel');
    h.down = false;
    if (this.phase === 'peel' && !this.players.some((p) => p.hands.some((x) => x.down))) this.payout();
  }

  setLimits({ minBet, maxBet, stopLoss }) {
    if (this.inRound) throw new Error('Change limits between hands');
    this.cfg = cleanConfig({ ...this.cfg, minBet, maxBet, stopLoss });
    this.note(`Bank set bets ${money(this.cfg.minBet)} to ${money(this.cfg.maxBet)}, stop loss ${money(this.cfg.stopLoss)}.`);
  }

  // Who Zelles whom if everyone cashed out now. Chips on the table count at face value.
  settlement() {
    const bank = this.cfg.bankName;
    return this.players
      .map((p) => ({ name: p.name, net: this.net(p) }))
      .filter((x) => x.net !== 0)
      .map((x) => (x.net > 0
        ? { from: bank, to: x.name, amount: x.net }
        : { from: x.name, to: bank, amount: -x.net }));
  }

  // What a client is allowed to see: no shoe, no hole card until it flips.
  view() {
    const hidden = this.holeHidden;
    return {
      cfg: this.cfg,
      phase: this.phase,
      round: this.round,
      closed: this.closed,
      closeReason: this.closeReason,
      dealer: hidden ? [this.dealer[0], { hidden: true, id: `h${this.round}` }] : this.dealer,
      turn: this.turn,
      decks: this.cfg.decks,
      discarded: this.cfg.decks * 52 - this.shoe.length,
      bankNet: this.bankNet,
      settlement: this.settlement(),
      requests: this.requests,
      log: this.log.slice(-30),
      players: this.players.map((p) => ({
        pid: p.pid,
        name: p.name,
        stack: p.stack,
        buyIns: p.buyIns,
        cashOuts: p.cashOuts,
        net: this.net(p),
        status: p.status,
        wager: p.wager,
        lastWager: p.lastWager,
        lastNet: p.lastNet,
        ins: p.ins,
        insNet: p.insNet,
        hands: p.hands.map((h, i) => (h.down
          ? { ...h, cards: [...h.cards.slice(0, -1), { hidden: true, side: true, id: `d${this.round}-${p.pid}-${i}` }] }
          : h)),
        legal: this.legal(p.pid),
      })),
    };
  }
}
