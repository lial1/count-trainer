// Home game: one browser is the bank and runs the table. Players talk to it through two free
// public MQTT brokers, end-to-end encrypted with a key that only lives in the invite link (net.js).
// Plain web traffic, so it works on cell data and strict Wi-Fi where direct browser links fail.

import { handValue } from './engine.js';
import { TableGame, money, cleanConfig, DEFAULTS, MAX_BUY_IN } from './table-engine.js';
import { openRoom, newKey, validKey } from './net.js';
import { play, soundPrefs, setSound } from './sound.js';

const $ = (id) => document.getElementById(id);
const SUIT = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };
const TEXT = '︎';
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LABELS = { hit: ['Hit', 'H'], stand: ['Stand', 'S'], double: ['Double', 'D'], split: ['Split', 'P'], surrender: ['Surrender', 'R'] };
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const PING_MS = 8000;
const STAGGER = 180; // between dealt cards
const PEEL_MS = 700; // dealer's hole card, or a double nobody peeled, turning over
const QUICK_MS = 280; // a double its owner already squeezed up
const DEAL_MS = 260;
let animMode = 'full'; // full: peels and suspense; quick: fast deals, plain flips; off: cards just appear
try { animMode = JSON.parse(localStorage.getItem('tc-anim')) || 'full'; } catch { /* default */ }
const AWAY_MS = 25000;

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const hostKey = (c) => `tc-host-${c}`;
const roomKey = (c) => `tc-key-${c}`;

let pid = store.get('tc-pid');
if (!pid) { pid = crypto.randomUUID(); store.set('tc-pid', pid); }

const S = {
  role: null, code: '', key: '', game: null, view: null, room: null, net: 'connecting',
  seen: new Map(), lastState: 0, stateAt: 0, flash: '', flashTimer: 0, closeArm: false,
  // Card animation bookkeeping: what each card slot showed last, and animations still running.
  slots: new Map(), anim: new Map(), lateAt: 0, primed: false, feltSig: '',
  squeeze: null, squeezeTimer: 0, peeling: new Set(), resultRound: 0, wasMyTurn: false,
};

/* ---------- start ---------- */

function boot() {
  const [rawCode = '', rawKey = ''] = location.hash.slice(1).split('.');
  const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) { lobbyCreate(); return; }
  const saved = store.get(hostKey(code));
  if (!saved) {
    if (!validKey(rawKey)) { badLink(); return; }
    startClient(code, rawKey);
    return;
  }
  // Only one tab can be the bank. If this table is already open here, say so instead of fighting over it.
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel(`tc-bank-${code}`) : null;
  let taken = false;
  if (bc) {
    bc.onmessage = (e) => { if (e.data === 'here') taken = true; };
    bc.postMessage('who');
  }
  setTimeout(() => {
    bc?.close();
    if (taken) {
      $('lobby').hidden = false;
      $('lobbyCard').innerHTML = '<h2>Already open</h2><p class="lede">This table is open in another tab in this browser. Use that tab.</p>';
      return;
    }
    let key = store.get(roomKey(code));
    if (!validKey(key || '')) { key = newKey(); store.set(roomKey(code), key); }
    history.replaceState(null, '', `#${code}.${key}`);
    startHost(code, key, TableGame.restore(saved));
  }, 300);
}
window.addEventListener('hashchange', () => location.reload());

function badLink() {
  $('lobby').hidden = false;
  $('lobbyCard').innerHTML = '<h2>Old invite link</h2><p class="lede">This link is missing its key, so it is probably from an older version. Ask the bank to hit "Copy invite link" and send it again.</p>';
}

function showTable() {
  $('lobby').hidden = true;
  $('tableView').hidden = false;
}

function lobbyCreate() {
  $('tableView').hidden = true;
  $('lobby').hidden = false;
  $('topActions').innerHTML = '';
  const last = store.get('tc-last-cfg') || {};
  const cfg = { ...DEFAULTS, ...last };
  const opt = (vals, cur, fmt) => vals.map((v) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${fmt(v)}</option>`).join('');
  $('lobbyCard').innerHTML = `
    <form id="createForm">
      <h2>New game</h2>
      <p class="lede">Private blackjack with friends. You're the bank. Send the link, approve who sits, settle up after.</p>
      <label for="cName">Your name</label>
      <input class="in" id="cName" maxlength="20" autocomplete="nickname" value="${esc(last.bankName && last.bankName !== 'Bank' ? last.bankName : '')}" placeholder="Your name" required>
      <div class="grid2">
        <div><label for="cMin">Min bet</label><div class="money-in"><input class="in" id="cMin" inputmode="numeric" value="${cfg.minBet}"></div></div>
        <div><label for="cMax">Max bet</label><div class="money-in"><input class="in" id="cMax" inputmode="numeric" value="${cfg.maxBet}"></div></div>
      </div>
      <label for="cStop">Stop loss (table closes when the bank is down this much)</label>
      <div class="money-in"><input class="in" id="cStop" inputmode="numeric" value="${cfg.stopLoss}"></div>
      <div class="grid2">
        <div><label for="cDecks">Decks</label><select class="in" id="cDecks">${opt([1, 2, 4, 6, 8], cfg.decks, (d) => `${d} deck${d > 1 ? 's' : ''}`)}</select></div>
        <div><label for="cPen">Deck penetration</label><select class="in" id="cPen">${opt([0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9], cfg.pen, (p) => `${Math.round(p * 100)}%`)}</select></div>
      </div>
      <label class="check-row"><input type="checkbox" id="cSurr" ${cfg.surrender ? 'checked' : ''}> Late surrender</label>
      <button class="act primary" type="submit">Create game</button>
      <p class="err" id="createErr"></p>
    </form>`;
}

function createGame() {
  let cfg;
  try {
    const name = $('cName').value.trim();
    if (!name) throw new Error('Put in your name');
    cfg = cleanConfig({
      bankName: name, minBet: $('cMin').value, maxBet: $('cMax').value, stopLoss: $('cStop').value,
      decks: $('cDecks').value, pen: $('cPen').value, surrender: $('cSurr').checked,
    });
  } catch (e) { $('createErr').textContent = e.message; return; }
  store.set('tc-last-cfg', cfg);
  const code = Array.from(crypto.getRandomValues(new Uint32Array(6)), (n) => ALPHA[n % ALPHA.length]).join('');
  const key = newKey();
  store.set(roomKey(code), key);
  history.replaceState(null, '', `#${code}.${key}`);
  startHost(code, key, new TableGame(cfg));
}

/* ---------- bank (host) ---------- */

async function startHost(code, key, game) {
  S.role = 'bank';
  S.code = code;
  S.key = key;
  S.game = game;
  if ('BroadcastChannel' in window) {
    S.bankChannel = new BroadcastChannel(`tc-bank-${code}`);
    S.bankChannel.onmessage = (e) => { if (e.data === 'who') S.bankChannel.postMessage('here'); };
  }
  showTable();
  publish();
  S.room = await openRoom(code, key, {
    subs: ['in'],
    onStatus: (st) => { const was = S.net; S.net = st; if (st === 'online' && was !== 'online') publish(false); else draw(); },
    onMessage: (_, msg) => onHostMsg(msg),
  });
  // Re-send the table now and then, so players can tell the bank is still here, and drop stale players.
  setInterval(() => publish(false), PING_MS);
}

function buildView() {
  const v = S.game.view();
  const now = Date.now();
  v.online = [...S.seen].filter(([, t]) => now - t < AWAY_MS).map(([id]) => id);
  return v;
}

function publish(save = true) {
  if (save) store.set(hostKey(S.code), S.game);
  S.view = buildView();
  S.room?.publish('state', { t: 'state', view: S.view, at: Date.now() }, true);
  draw();
}

function onHostMsg(msg) {
  if (!msg || typeof msg !== 'object' || !msg.pid) return;
  const who = String(msg.pid).slice(0, 64);
  const isNew = !S.seen.has(who) || Date.now() - S.seen.get(who) > AWAY_MS;
  S.seen.set(who, Date.now());
  if (msg.t === 'hello' || msg.t === 'ping') {
    if (isNew || msg.t === 'hello') publish(false);
    return;
  }
  const g = S.game;
  try {
    if (msg.t === 'request') g.request(who, msg.name, msg.amount);
    else if (msg.t === 'bet') g.bet(who, msg.amount);
    else if (msg.t === 'sitout') g.sitOut(who);
    else if (msg.t === 'act') g.act(who, String(msg.action));
    else if (msg.t === 'insurance') g.insurance(who, Boolean(msg.take));
    else if (msg.t === 'cashout') g.cashOut(who);
    else if (msg.t === 'peel') g.peel(who, msg.hand);
    else return;
  } catch (e) {
    S.room?.publish(`to/${who}`, { t: 'err', text: e.message });
    return;
  }
  publish();
}

function bank(fn) {
  try { fn(S.game); } catch (e) { flash(e.message); }
  publish();
}

/* ---------- player (client) ---------- */

async function startClient(code, key) {
  S.role = 'player';
  S.code = code;
  S.key = key;
  showTable();
  draw();
  S.room = await openRoom(code, key, {
    subs: ['state', `to/${pid}`],
    onStatus: (st) => {
      if (st === 'online') send({ t: 'hello' }, true);
      else S.net = 'connecting';
      draw();
    },
    onMessage: (_, msg) => {
      if (msg.t === 'state') {
        // Two brokers can deliver out of order. Keep the newest table.
        if (msg.at < S.stateAt) return;
        S.stateAt = msg.at;
        S.view = msg.view;
        S.lastState = Date.now();
        S.net = 'online';
        draw();
      } else if (msg.t === 'err') {
        // A failed peel should not leave the card stuck half lifted.
        if (S.squeeze) { S.squeeze = null; S.peeling.clear(); S.feltSig = ''; }
        flash(msg.text);
      }
    },
  });
  setInterval(() => {
    if (!S.room?.online) return;
    send({ t: 'ping' }, true);
    const away = !S.lastState || Date.now() - S.lastState > AWAY_MS;
    if (away && S.net !== 'away') { S.net = 'away'; draw(); }
  }, PING_MS);
}

function send(msg, quiet = false) {
  if (S.room?.online) S.room.publish('in', { ...msg, pid });
  else if (!quiet) flash('Not connected to the table yet');
}

/* ---------- rendering ---------- */

function flash(text) {
  S.flash = text;
  clearTimeout(S.flashTimer);
  S.flashTimer = setTimeout(() => { S.flash = ''; draw(); }, 4000);
  draw();
}

function faceInner(card) {
  const s = SUIT[card.suit] + TEXT;
  const corner = `<b>${card.rank}</b><i>${s}</i>`;
  return `<span class="corner">${corner}</span><span class="pip">${s}</span><span class="corner flip">${corner}</span>`;
}

// Works out which cards are new or newly face up since the last update, and gives each a start time:
// the deal goes round the table, the dealer's hole card peels before the dealer draws, and a double
// nobody peeled turns over last. Sounds are scheduled to match.
function planFelt(v) {
  const now = performance.now();
  const events = [];
  const look = (key, card, order, revealOrder) => {
    const prev = S.slots.get(key);
    S.slots.set(key, card.hidden ? 'down' : 'up');
    if (!S.primed) return;
    if (!prev) events.push({ key, kind: 'deal', order });
    else if (prev === 'down' && !card.hidden) {
      const quick = S.peeling.has(key);
      events.push({ key, kind: quick ? 'quick' : 'peel', order: quick ? -1 : revealOrder });
    }
  };
  v.dealer.forEach((c, i) => look(`${v.round}:D:0:${i}`, c, i === 0 ? 1 : i === 1 ? 3 : 100 + i, 99));
  v.players.forEach((p, pi) => p.hands.forEach((h, hi) => h.cards.forEach((c, ci) => {
    const order = hi === 0 && ci === 0 ? pi / 100 : hi === 0 && ci === 1 ? 2 + pi / 100 : 50 + pi + hi / 10 + ci / 100;
    look(`${v.round}:${p.pid}:${hi}:${ci}`, c, order, 200 + pi + hi / 10);
  })));
  S.primed = true;
  if (!events.length) return;
  events.sort((a, b) => a.order - b.order);
  if (animMode === 'off') {
    for (const e of events) S.peeling.delete(e.key);
    S.squeeze = null;
    play(events.some((e) => e.kind !== 'deal') ? 'flip' : 'deal');
    S.lateAt = 0;
    return;
  }
  if (animMode === 'quick') for (const e of events) if (e.kind === 'peel') e.kind = 'quick';
  const stagger = animMode === 'quick' ? 110 : STAGGER;
  let t = Math.max(0, S.lateAt - now);
  for (const e of events) {
    S.anim.set(e.key, { kind: e.kind, at: now + t });
    if (e.kind === 'deal') { play('deal', t); t += stagger; }
    else if (e.kind === 'peel') { play('peel', t); play('flip', t + PEEL_MS * 0.78); t += PEEL_MS + 80; }
    else { play('flip', t + 120); t += QUICK_MS; if (S.squeeze === e.key) S.squeeze = null; }
    S.peeling.delete(e.key);
  }
  S.lateAt = now + t;
}

const ANIM_MS = { deal: DEAL_MS, peel: PEEL_MS, quick: QUICK_MS };

function cardHtml(key, card, { side = false, peel = null } = {}) {
  const now = performance.now();
  const a = S.anim.get(key);
  const until = a ? a.at - now : 0;
  const running = a && until + ANIM_MS[a.kind] > 0;
  if (a && !running) S.anim.delete(key);
  // A negative delay picks an animation up where it was if the table redraws mid-way.
  const d = running ? `--d:${Math.round(until)}ms` : '';
  const kind = running ? a.kind : '';
  let html;
  if (card.hidden) {
    html = `<div class="card back ${kind === 'deal' ? 'new' : ''}" style="${d}" role="img" aria-label="Face down card"></div>`;
  } else {
    const red = card.suit === 'hearts' || card.suit === 'diamonds' ? 'red' : '';
    const label = `role="img" aria-label="${card.rank} of ${card.suit}"`;
    if (kind === 'peel' || kind === 'quick') {
      html = `<div class="card ${red} turning" ${label}>${faceInner(card)}<div class="peel-back ${kind}" style="${d}"></div></div>`;
    } else {
      html = `<div class="card ${red} ${kind === 'deal' ? 'new' : ''}" style="${d}" ${label}>${faceInner(card)}</div>`;
    }
  }
  if (!side) return html;
  const grip = peel !== null ? `peelable ${S.squeeze === key ? 'squeeze' : ''}" data-peel="${peel}" data-slot="${key}" title="Hold to peel` : '';
  return `<div class="side ${grip}">${html}</div>`;
}

// Totals and results wait until the last card in flight has landed.
function lateAttr() {
  const wait = Math.round(S.lateAt - performance.now());
  return wait > 0 ? ` late" style="animation-delay:${wait}ms` : '';
}

function totalLabel(cards) {
  const real = cards.filter((c) => !c.hidden);
  if (!real.length) return '';
  const { total, soft } = handValue(real);
  return soft && total < 21 ? `${total - 10}/${total}` : String(total);
}

const WORD = { win: 'Win', lose: 'Lose', push: 'Push', bust: 'Bust', blackjack: 'Blackjack', surrender: 'Surrender' };
const signedMoney = (n) => (n > 0 ? `+${money(n)}` : n < 0 ? money(n) : '$0');
const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

function me(v) {
  return S.role === 'player' ? v.players.find((p) => p.pid === pid) : null;
}

function nameOf(v, id) {
  return v.players.find((p) => p.pid === id)?.name ?? '';
}

function waitingOn(v) {
  if (v.phase === 'betting') {
    return v.players.filter((p) => p.status === 'none' && (p.stack >= v.cfg.minBet)).map((p) => p.name);
  }
  if (v.phase === 'insurance') return v.players.filter((p) => p.hands.length && p.ins === null).map((p) => p.name);
  return [];
}

function draw() {
  const v = S.view;
  renderTop();
  if (!v) {
    $('status').innerHTML = statusLine();
    $('controls').innerHTML = '';
    $('seats').innerHTML = '';
    $('dealer').innerHTML = '';
    return;
  }
  renderFelt(v);
  $('status').innerHTML = S.flash ? `<span class="neg">${esc(S.flash)}</span>` : statusLine(v);
  keepInputs('controls', () => { $('controls').innerHTML = renderControls(v); });
  renderSide(v);
  const mine = me(v);
  const myTurn = mine && ((v.turn && v.turn.pid === pid) || (v.phase === 'insurance' && mine.hands.length && mine.ins === null));
  document.title = myTurn ? 'Your turn · Home Game' : 'Home Game';
}

// Re-rendering on every update would wipe what someone is typing, so carry values and focus over.
function keepInputs(id, fn) {
  const box = $(id);
  const vals = {};
  box.querySelectorAll('input').forEach((i) => { if (i.id) vals[i.id] = i.value; });
  const focus = document.activeElement?.id;
  fn();
  for (const [k, val] of Object.entries(vals)) { const el = $(k); if (el && box.contains(el)) el.value = val; }
  if (focus && $(focus)) $(focus).focus();
}

function renderTop() {
  const dot = S.net === 'online' ? 'on' : S.net === 'connecting' ? '' : 'off';
  const label = { online: 'Online', connecting: 'Connecting', away: 'Bank is away' }[S.net];
  const bankBtns = S.role === 'bank' && S.view && !S.view.closed
    ? `<button class="ghost" id="pauseGame" aria-pressed="${S.view.paused}">${S.view.paused ? 'Resume' : 'Pause'}</button><button class="ghost" id="openLimits">Limits</button>${S.view.closeAfter
      ? '<button class="ghost" disabled>Closing after this hand</button>'
      : `<button class="ghost" id="closeTable">${S.closeArm ? 'Tap again to close' : 'Close table'}</button>`}`
    : S.role === 'bank' && S.view?.closed ? '<button class="ghost" id="newTable">New game</button>' : '';
  $('topActions').innerHTML = `<span class="ghost" style="border:0"><span class="dot ${dot}"></span>${label}</span>
    <span class="code" title="Table code">${esc(S.code)}</span>
    <button class="ghost" id="copyInvite">Copy invite link</button><button class="ghost" id="openSettings">Settings</button>${bankBtns}`;
}

function statusLine(v) {
  const line = statusCore(v);
  if (!v || v.closed || !v.closeAfter) return line;
  return `${line} <b>Table closes after this hand.</b>`;
}

function statusCore(v) {
  if (!v) {
    if (S.net === 'away') return `Can't find the bank for table ${esc(S.code)}. Their page has to be open. Still trying.`;
    return `Connecting to table ${esc(S.code)}…`;
  }
  if (v.closed) return `<b>Table closed.</b> ${esc(v.closeReason)}`;
  if (S.role === 'player' && S.net === 'away') return "<b>The bank's page is closed or asleep.</b> Your seat and chips are saved.";
  const mine = me(v);
  const myDown = mine?.hands.some((h) => h.doubled && h.cards[2]?.hidden);
  if (v.phase === 'peel') {
    const dealer = `Dealer has <b>${totalLabel(v.dealer)}</b>.`;
    if (myDown) return `${dealer} Hold your double to peel it.`;
    const who = v.players.filter((p) => p.hands.some((h) => h.doubled && h.cards[2]?.hidden)).map((p) => p.name);
    return `${dealer} Waiting on ${esc(who.join(', '))} to peel.`;
  }
  if (myDown && v.phase === 'play') {
    const turn = v.turn && v.turn.pid !== pid ? ` <b>${esc(nameOf(v, v.turn.pid))}</b>'s turn.` : '';
    return `Hold your double to peel it.${turn}`;
  }
  if (v.phase === 'play' && v.turn) {
    return v.turn.pid === pid ? '<b>Your turn</b>' : `<b>${esc(nameOf(v, v.turn.pid))}</b>'s turn`;
  }
  const wait = waitingOn(v);
  if (v.paused && v.phase === 'betting') return `<b>Paused.</b> ${S.role === 'bank' ? 'Hit Resume to deal again.' : 'Cards come out when the game resumes.'}`;
  if (v.phase === 'insurance') return `Dealer shows an ace. Insurance? ${wait.length ? `Waiting on ${esc(wait.join(', '))}` : ''}`;
  if (!v.players.length) return S.role === 'bank' ? 'Copy the invite link and send it. You approve each seat.' : 'Nobody is seated yet.';
  if (mine && mine.status === 'bet' && wait.length) return `Bet in. Waiting on ${esc(wait.join(', '))}`;
  return wait.length ? `Place your bets. Waiting on ${esc(wait.join(', '))}` : 'Place your bets';
}

function feltSignature(v) {
  return JSON.stringify([v.round, v.phase, v.dealer, v.turn, v.online, v.cfg.minBet, v.cfg.maxBet,
    v.players.map((p) => [p.pid, p.name, p.stack, p.status, p.wager, p.ins, p.insNet, p.hands])]);
}

function renderFelt(v) {
  // Redrawing the same table would restart nothing, but it is wasted work on every status ping.
  const sig = feltSignature(v);
  if (sig === S.feltSig) return;
  S.feltSig = sig;
  planFelt(v);
  const r = v.round;
  const late = lateAttr();
  $('dealer').innerHTML = `<div class="cards">${v.dealer.map((c, i) => cardHtml(`${r}:D:0:${i}`, c)).join('')}</div>
    <div class="meta"><span class="total${late}">${totalLabel(v.dealer)}</span><span class="tag" style="font-size:12px;opacity:.8">${esc(v.cfg.bankName)} (bank)</span></div>`;
  const seats = $('seats');
  seats.className = `seats ${v.players.length > 3 ? 'many' : ''}`;
  seats.innerHTML = v.players.map((p) => {
    const online = v.online ? v.online.includes(p.pid) : true;
    const mine = S.role === 'player' && p.pid === pid;
    const hands = p.hands.length
      ? p.hands.map((h, i) => {
          const active = v.turn && v.turn.pid === p.pid && v.turn.hand === i && p.hands.length > 1;
          const res = h.result ? `<span class="result ${h.net > 0 ? 'win' : h.net < 0 ? 'lose' : ''}${late}">${WORD[h.result]}${h.net ? ` ${signedMoney(h.net)}` : ''}</span>` : '';
          const cards = h.cards.map((c, ci) => {
            const side = Boolean(h.doubled && ci === 2);
            const peel = mine && side && c.hidden && (v.phase === 'play' || v.phase === 'peel') ? i : null;
            return cardHtml(`${r}:${p.pid}:${i}:${ci}`, c, { side, peel });
          }).join('');
          return `<div class="hand ${active ? 'active' : ''}"><div class="cards">${cards}</div>
            <div class="meta"><span class="total${late}">${totalLabel(h.cards)}</span><span class="spot">${money(h.bet)}</span>${res}</div></div>`;
        }).join('')
      : p.status === 'bet' ? `<div class="meta"><span class="spot">${money(p.wager)}</span></div>` : '';
    const ins = p.ins && p.insNet ? `<span class="result ${p.insNet > 0 ? 'win' : 'lose'}${late}">Insurance ${signedMoney(p.insNet)}</span>` : p.ins ? '<span class="tag">Insured</span>' : '';
    const tag = !online ? 'Offline' : p.status === 'out' ? 'Sitting out' : p.stack < v.cfg.minBet && !p.hands.length && p.status !== 'bet' ? 'Needs chips' : '';
    return `<div class="seat ${v.turn?.pid === p.pid ? 'turn' : ''} ${mine ? 'me' : ''}">
      <div class="hands">${hands}</div>${ins}
      <span class="name">${esc(p.name)}</span><span class="stack">${money(p.stack)}</span>${tag ? `<span class="tag">${tag}</span>` : ''}</div>`;
  }).join('');

  const total = v.decks * 52;
  const ticks = Array.from({ length: v.decks - 1 }, (_, i) =>
    `<div class="tray-tick" style="bottom:${((i + 1) / v.decks) * 100}%"></div>`).join('');
  $('tray').innerHTML = `<div class="tray-box"><div class="tray-fill" style="height:${Math.min(100, (v.discarded / total) * 100)}%"></div>${ticks}</div><span>Discards</span>`;
  $('shoe').innerHTML = `${v.decks} deck shoe<br><span style="font:500 12px var(--sans);opacity:.8">Bets ${money(v.cfg.minBet)} to ${money(v.cfg.maxBet)}</span>`;
  roundSounds(v);
}

// One result sound per hand, after the cards land, and a ping when it becomes your turn.
function roundSounds(v) {
  const mine = me(v);
  const myTurn = Boolean(mine && ((v.turn && v.turn.pid === pid) || (v.phase === 'insurance' && mine.hands.length && mine.ins === null)
    || (v.phase === 'peel' && mine.hands.some((h) => h.doubled && h.cards[2]?.hidden))));
  const wait = Math.max(0, S.lateAt - performance.now());
  const settled = v.phase === 'betting' && v.players.some((p) => p.hands.some((h) => h.result));
  // Opening the page mid-game should not replay the last hand's sounds.
  if (!S.soundPrimed) {
    S.soundPrimed = true;
    S.wasMyTurn = myTurn;
    S.resultRound = v.round;
    return;
  }
  if (myTurn && !S.wasMyTurn) play('turn', wait);
  S.wasMyTurn = myTurn;
  if (!settled || S.resultRound === v.round) return;
  S.resultRound = v.round;
  let net;
  if (S.role === 'bank') net = -v.players.reduce((n, p) => n + (p.hands.length ? p.lastNet || 0 : 0), 0);
  else if (mine?.hands.length) net = mine.lastNet;
  else return;
  const bj = S.role === 'player' && mine.hands.some((h) => h.result === 'blackjack');
  play(bj ? 'blackjack' : net > 0 ? 'win' : net < 0 ? 'lose' : 'push', wait + 150);
}

function renderControls(v) {
  if (v.closed) return '';
  if (S.role === 'bank') {
    if (v.phase === 'betting') {
      const any = v.players.some((p) => p.status === 'bet');
      return any && !v.paused ? '<button class="act primary" id="dealNow">Deal now</button>' : '';
    }
    if (v.phase === 'insurance') return '<button class="act" id="skip">Skip insurance</button>';
    if (v.phase === 'play' && v.turn) return `<button class="act" id="skip">Stand for ${esc(nameOf(v, v.turn.pid))}</button>`;
    if (v.phase === 'peel') return '<button class="act" id="skip">Turn over doubles</button>';
    return '';
  }

  const mine = me(v);
  const pending = v.requests.find((r) => r.pid === pid);
  if (!mine) {
    if (pending) return `<p class="status">Waiting for ${esc(v.cfg.bankName)} to let you sit with ${money(pending.amount)}.</p>`;
    return `<form class="betbox" id="joinForm">
      <input class="in" id="jName" maxlength="20" placeholder="Your name" autocomplete="nickname" style="width:160px" value="${esc(store.get('tc-name') || '')}">
      <div class="money-in"><input class="in" id="jAmt" inputmode="numeric" placeholder="Buy-in"></div>
      <button class="act primary" type="submit">Request seat</button></form>`;
  }

  let main = '';
  const inHand = mine.hands.length && (v.phase === 'play' || v.phase === 'insurance' || v.phase === 'peel');
  if (v.phase === 'betting' && mine.stack + (mine.status === 'bet' ? mine.wager : 0) >= v.cfg.minBet) {
    const def = mine.status === 'bet' ? mine.wager : Math.min(v.cfg.maxBet, Math.max(v.cfg.minBet, mine.lastWager || v.cfg.minBet));
    main = `<form class="betbox" id="betForm">
      <div class="money-in"><input class="in" id="betAmt" inputmode="numeric" value="${def}"></div>
      <button class="act primary" type="submit">${mine.status === 'bet' ? 'Change bet' : 'Bet'}</button>
      ${mine.status !== 'out' ? '<button class="act" type="button" id="sitOut">Sit out</button>' : ''}</form>`;
  } else if (v.phase === 'insurance' && mine.hands.length && mine.ins === null) {
    const cost = mine.hands[0].bet / 2;
    main = `<button class="act" data-ins="yes" ${mine.stack < cost ? 'disabled' : ''}>Insure ${money(cost)}<kbd>Y</kbd></button><button class="act primary" data-ins="no">No insurance<kbd>N</kbd></button>`;
  } else if (v.phase === 'play' && v.turn?.pid === pid) {
    main = mine.legal.map((a) => `<button class="act ${a === 'stand' ? 'primary' : ''}" data-act="${a}">${LABELS[a][0]}<kbd>${LABELS[a][1]}</kbd></button>`).join('');
  }
  const buy = pending
    ? `<span class="tag">Buy-in of ${money(pending.amount)} waiting on the bank</span>`
    : `<form class="betbox" id="buyForm"><div class="money-in"><input class="in" id="buyAmt" inputmode="numeric" placeholder="Amount" style="font-size:15px"></div><button class="small-act" type="submit">Buy in</button></form>`;
  return `<div style="display:flex;flex-direction:column;gap:12px;align-items:center;width:100%">
    <div class="betbox">${main}</div>
    <div class="betbox">${buy}<button class="small-act" id="cashOut" ${inHand ? 'disabled' : ''}>Cash out ${money(mine.stack)}</button></div></div>`;
}

function renderSide(v) {
  const req = $('requests');
  if (S.role === 'bank' && v.requests.length) {
    req.hidden = false;
    req.innerHTML = `<h3>Waiting on you</h3>${v.requests.map((r) => `<div class="row"><span>${esc(r.name)} ${r.kind === 'join' ? 'wants to sit with' : 'buys in'} <b>${money(r.amount)}</b></span>
      <span class="btns"><button class="small-act" data-approve="${r.id}">Approve</button><button class="small-act" data-deny="${r.id}">No</button></span></div>`).join('')}`;
  } else req.hidden = true;

  const rows = v.players.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${money(p.buyIns)}</td><td class="num">${money(p.cashOuts)}</td><td class="num">${money(p.stack)}</td><td class="num ${cls(p.net)}">${signedMoney(p.net)}</td></tr>`).join('');
  $('ledger').innerHTML = `<h3>Ledger</h3><div class="scroll"><table>
    <tr><th>Player</th><th class="num">In</th><th class="num">Out</th><th class="num">Chips</th><th class="num">Net</th></tr>${rows}
    <tr><td><b>${esc(v.cfg.bankName)}</b> (bank)</td><td></td><td></td><td></td><td class="num ${cls(v.bankNet)}"><b>${signedMoney(v.bankNet)}</b></td></tr></table></div>
    <p class="tag" style="margin:8px 0 0">Stop loss ${money(v.cfg.stopLoss)}${v.bankNet < 0 ? `, ${money(v.cfg.stopLoss + v.bankNet)} left` : ''}</p>`;

  const lines = v.settlement.length
    ? v.settlement.map((x) => `<p class="pay">${esc(x.from)} pays ${esc(x.to)} <b>${money(x.amount)}</b></p>`).join('')
    : '<p class="pay">Everyone is even.</p>';
  $('settle').innerHTML = v.closed
    ? `<div class="closed-banner"><h3>Settle up</h3>${lines}<p class="tag">Send these on Zelle.</p></div>`
    : `<h3>If you stopped now</h3>${lines}`;

  $('log').innerHTML = `<h3>Table log</h3>${v.log.slice().reverse().map((l) => `<p>${esc(l)}</p>`).join('')}`;
}

/* ---------- limits ---------- */

function openLimits() {
  const c = S.game.cfg;
  $('limitsForm').innerHTML = `
    <label class="field">Min bet<span class="money-in"><input class="in" id="lMin" inputmode="numeric" value="${c.minBet}" style="width:120px"></span></label>
    <label class="field">Max bet<span class="money-in"><input class="in" id="lMax" inputmode="numeric" value="${c.maxBet}" style="width:120px"></span></label>
    <label class="field">Stop loss<span class="money-in"><input class="in" id="lStop" inputmode="numeric" value="${c.stopLoss}" style="width:120px"></span></label>
    <p class="err neg" id="limitsErr"></p>
    <div class="row-actions"><button class="act primary" type="submit">Save</button></div>`;
  $('limits').showModal();
}

function openSettings() {
  const p = soundPrefs();
  const opt = (v, label) => `<option value="${v}" ${animMode === v ? 'selected' : ''}>${label}</option>`;
  $('setBody').innerHTML = `
    <label class="field">Sound<input type="checkbox" id="sOn" ${p.on ? 'checked' : ''}></label>
    <label class="field">Volume<input type="range" id="sVol" min="0" max="1" step="0.05" value="${p.volume}" style="accent-color:var(--brass)"></label>
    <label class="field">Animations<select id="sAnim">${opt('full', 'Full, with peels')}${opt('quick', 'Quick')}${opt('off', 'Off')}</select></label>`;
  $('setDlg').showModal();
}

/* ---------- events ---------- */

async function copyInvite() {
  const url = `${location.origin}${location.pathname}#${S.code}.${S.key}`;
  try { await navigator.clipboard.writeText(url); flash('Invite link copied'); }
  catch { flash(url); }
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if ('close' in t.dataset) { t.closest('dialog').close(); return; }
  if (t.id === 'copyInvite') copyInvite();
  else if (t.id === 'openSettings') openSettings();
  else if (t.id === 'pauseGame') bank((g) => g.setPaused(!g.paused));
  else if (t.id === 'openLimits') openLimits();
  else if (t.id === 'closeTable') {
    if (!S.closeArm) { S.closeArm = true; draw(); setTimeout(() => { S.closeArm = false; draw(); }, 3000); return; }
    S.closeArm = false;
    bank((g) => g.close());
  } else if (t.id === 'newTable') {
    store.del(hostKey(S.code));
    store.del(roomKey(S.code));
    S.room?.close();
    location.hash = '';
  } else if (t.id === 'dealNow') bank((g) => g.dealNow());
  else if (t.id === 'skip') bank((g) => g.skip());
  else if (t.dataset.approve) bank((g) => g.approve(Number(t.dataset.approve)));
  else if (t.dataset.deny) bank((g) => g.deny(Number(t.dataset.deny)));
  else if (t.id === 'sitOut') send({ t: 'sitout' });
  else if (t.id === 'cashOut') send({ t: 'cashout' });
  else if (t.dataset.act) send({ t: 'act', action: t.dataset.act });
  else if (t.dataset.ins) send({ t: 'insurance', take: t.dataset.ins === 'yes' });
});

document.addEventListener('submit', (e) => {
  const f = e.target;
  e.preventDefault();
  if (f.id === 'createForm') createGame();
  else if (f.id === 'joinForm') {
    const name = $('jName').value.trim();
    const amount = Number($('jAmt').value);
    if (!name) { flash('Put in your name'); return; }
    if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_BUY_IN) { flash('Buy-in has to be a whole dollar amount'); return; }
    store.set('tc-name', name);
    send({ t: 'request', name, amount });
  } else if (f.id === 'betForm') {
    play('chip');
    send({ t: 'bet', amount: Number($('betAmt').value) });
  } else if (f.id === 'buyForm') {
    const amount = Number($('buyAmt').value);
    if (!Number.isInteger(amount) || amount <= 0) { flash('Buy-in has to be a whole dollar amount'); return; }
    send({ t: 'request', amount });
    $('buyAmt').value = '';
  } else if (f.id === 'limitsForm') {
    try {
      S.game.setLimits({ minBet: $('lMin').value, maxBet: $('lMax').value, stopLoss: $('lStop').value });
      $('limits').close();
      publish();
    } catch (err) { $('limitsErr').textContent = err.message; }
  }
});

// Hold your face-down double to peel it: the corner lifts while you hold, and it turns over
// once you have held long enough. Let go early and it drops back.
const SQUEEZE_MS = 450;
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('[data-peel]');
  if (!el || S.squeeze) return;
  e.preventDefault();
  S.squeeze = el.dataset.slot;
  el.classList.add('squeeze');
  play('peel');
  const hand = Number(el.dataset.peel);
  const slot = el.dataset.slot;
  S.squeezeTimer = setTimeout(() => {
    S.squeezeTimer = 0;
    S.peeling.add(slot);
    send({ t: 'peel', hand });
  }, animMode === 'full' ? SQUEEZE_MS : animMode === 'quick' ? 300 : 0);
});
function letGo() {
  if (!S.squeeze || !S.squeezeTimer) return;
  clearTimeout(S.squeezeTimer);
  S.squeezeTimer = 0;
  document.querySelector(`[data-slot="${S.squeeze}"]`)?.classList.remove('squeeze');
  S.squeeze = null;
}
for (const ev of ['pointerup', 'pointercancel']) document.addEventListener(ev, letGo);

document.addEventListener('change', (e) => {
  if (e.target.id === 'sOn') { setSound({ on: e.target.checked }); play('chip'); }
  else if (e.target.id === 'sVol') { setSound({ volume: Number(e.target.value) }); play('chip'); }
  else if (e.target.id === 'sAnim') {
    animMode = e.target.value;
    try { localStorage.setItem('tc-anim', JSON.stringify(animMode)); } catch { /* private window */ }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.tagName === 'INPUT' || document.querySelector('dialog[open]')) return;
  const v = S.view;
  const mine = v && me(v);
  if (!mine) return;
  const k = e.key.toLowerCase();
  if (v.phase === 'play' && v.turn?.pid === pid) {
    const map = { h: 'hit', s: 'stand', d: 'double', p: 'split', r: 'surrender' };
    if (map[k] && mine.legal.includes(map[k])) send({ t: 'act', action: map[k] });
  } else if (v.phase === 'insurance' && mine.hands.length && mine.ins === null) {
    if (k === 'y') send({ t: 'insurance', take: true });
    if (k === 'n') send({ t: 'insurance', take: false });
  }
});

if (typeof mqtt === 'undefined') {
  document.body.innerHTML = '<p style="padding:20px">Could not load the connection library. Check your internet and refresh.</p>';
} else {
  boot();
}
