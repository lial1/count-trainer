// Home game: one browser is the bank and runs the table; friends connect to it peer to peer.
// No server of ours. PeerJS's free broker only introduces the browsers; cards and money stay between them.

import { handValue } from './engine.js';
import { TableGame, money, cleanConfig, DEFAULTS, MAX_BUY_IN } from './table-engine.js';

const $ = (id) => document.getElementById(id);
const SUIT = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };
const TEXT = '︎';
const PREFIX = 'truecount-hg-';
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LABELS = { hit: ['Hit', 'H'], stand: ['Stand', 'S'], double: ['Double', 'D'], split: ['Split', 'P'], surrender: ['Surrender', 'R'] };
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const hostKey = (c) => `tc-host-${c}`;

let pid = store.get('tc-pid');
if (!pid) { pid = crypto.randomUUID(); store.set('tc-pid', pid); }

const S = {
  role: null, code: '', game: null, view: null, peer: null, conn: null,
  conns: new Map(), net: 'connecting', flash: '', flashTimer: 0, shown: new Set(), closeArm: false,
};

/* ---------- start ---------- */

function boot() {
  const code = location.hash.slice(1).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) { lobbyCreate(); return; }
  const saved = store.get(hostKey(code));
  if (saved) startHost(code, TableGame.restore(saved));
  else startClient(code);
}
window.addEventListener('hashchange', () => location.reload());

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
  history.replaceState(null, '', `#${code}`);
  startHost(code, new TableGame(cfg));
}

/* ---------- bank (host) ---------- */

function startHost(code, game) {
  S.role = 'bank';
  S.code = code;
  S.game = game;
  showTable();
  connectHost();
  publish();
}

function connectHost() {
  const peer = new Peer(PREFIX + S.code);
  S.peer = peer;
  S.net = 'connecting';
  peer.on('open', () => { if (S.peer === peer) { S.net = 'online'; draw(); } });
  peer.on('connection', (conn) => {
    conn.on('data', (msg) => onHostMsg(conn, msg));
    const drop = () => { if (S.conns.delete(conn)) publish(false); };
    conn.on('close', drop);
    conn.on('error', drop);
  });
  peer.on('disconnected', () => {
    if (S.peer !== peer || peer.destroyed) return;
    S.net = 'reconnecting'; draw();
    setTimeout(() => { if (S.peer === peer && !peer.destroyed) peer.reconnect(); }, 2000);
  });
  peer.on('error', (e) => {
    if (S.peer !== peer || e.type === 'peer-unavailable') return;
    // After a refresh the broker can hold the old id for a bit. Keep trying.
    S.net = 'reconnecting'; draw();
    peer.destroy();
    setTimeout(() => { if (S.peer === peer) connectHost(); }, e.type === 'unavailable-id' ? 4000 : 3000);
  });
}

function buildView() {
  const v = S.game.view();
  v.online = [...new Set(S.conns.values())];
  return v;
}

function publish(save = true) {
  if (save) store.set(hostKey(S.code), S.game);
  S.view = buildView();
  for (const [conn, who] of S.conns) {
    if (conn.open) conn.send({ t: 'state', view: S.view, you: who });
  }
  draw();
}

function onHostMsg(conn, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'hello') {
    S.conns.set(conn, String(msg.pid).slice(0, 64));
    publish(false);
    return;
  }
  const who = S.conns.get(conn);
  if (!who) return;
  const g = S.game;
  try {
    if (msg.t === 'request') g.request(who, msg.name, msg.amount);
    else if (msg.t === 'bet') g.bet(who, msg.amount);
    else if (msg.t === 'sitout') g.sitOut(who);
    else if (msg.t === 'act') g.act(who, String(msg.action));
    else if (msg.t === 'insurance') g.insurance(who, Boolean(msg.take));
    else if (msg.t === 'cashout') g.cashOut(who);
    else return;
  } catch (e) {
    if (conn.open) conn.send({ t: 'err', text: e.message });
    return;
  }
  publish();
}

function bank(fn) {
  try { fn(S.game); } catch (e) { flash(e.message); }
  publish();
}

/* ---------- player (client) ---------- */

function startClient(code) {
  S.role = 'player';
  S.code = code;
  showTable();
  draw();
  connectClient();
}

function connectClient() {
  const peer = new Peer();
  S.peer = peer;
  S.net = 'connecting';
  peer.on('open', () => { if (S.peer === peer) openConn(); });
  peer.on('disconnected', () => {
    if (S.peer !== peer || peer.destroyed) return;
    setTimeout(() => { if (S.peer === peer && !peer.destroyed) peer.reconnect(); }, 2000);
  });
  peer.on('error', (e) => {
    if (S.peer !== peer) return;
    if (e.type === 'peer-unavailable') {
      S.net = 'notfound'; draw();
      setTimeout(openConn, 4000);
      return;
    }
    S.net = 'reconnecting'; draw();
    peer.destroy();
    setTimeout(() => { if (S.peer === peer) connectClient(); }, 3000);
  });
}

function openConn() {
  if (S.conn && S.conn.open) return;
  if (!S.peer || S.peer.destroyed || S.peer.disconnected) return;
  const conn = S.peer.connect(PREFIX + S.code, { reliable: true });
  S.conn = conn;
  conn.on('open', () => { S.net = 'online'; conn.send({ t: 'hello', pid }); draw(); });
  conn.on('data', (msg) => {
    if (msg?.t === 'state') { S.view = msg.view; draw(); }
    else if (msg?.t === 'err') flash(msg.text);
  });
  conn.on('close', () => {
    if (S.conn !== conn) return;
    S.net = 'reconnecting'; draw();
    setTimeout(openConn, 2000);
  });
}

function send(msg) {
  if (S.conn?.open) S.conn.send(msg);
  else flash('Not connected to the table yet');
}

/* ---------- rendering ---------- */

function flash(text) {
  S.flash = text;
  clearTimeout(S.flashTimer);
  S.flashTimer = setTimeout(() => { S.flash = ''; draw(); }, 4000);
  draw();
}

function cardHtml(card, round) {
  const key = `${round}:${card.id}`;
  const fresh = !S.shown.has(key);
  S.shown.add(key);
  if (card.hidden) return `<div class="card back ${fresh ? 'new' : ''}" role="img" aria-label="Face down card"></div>`;
  const red = card.suit === 'hearts' || card.suit === 'diamonds';
  const s = SUIT[card.suit] + TEXT;
  const corner = `<b>${card.rank}</b><i>${s}</i>`;
  return `<div class="card ${red ? 'red' : ''} ${fresh ? 'new' : ''}" role="img" aria-label="${card.rank} of ${card.suit}">
    <span class="corner">${corner}</span><span class="pip">${s}</span><span class="corner flip">${corner}</span></div>`;
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
  const label = { online: 'Online', connecting: 'Connecting', reconnecting: 'Reconnecting', notfound: 'Table not found', offline: 'Offline' }[S.net];
  const bankBtns = S.role === 'bank' && S.view && !S.view.closed
    ? `<button class="ghost" id="openLimits">Limits</button><button class="ghost" id="closeTable">${S.closeArm ? 'Tap again to close' : 'Close table'}</button>`
    : S.role === 'bank' && S.view?.closed ? '<button class="ghost" id="newTable">New game</button>' : '';
  $('topActions').innerHTML = `<span class="ghost" style="border:0"><span class="dot ${dot}"></span>${label}</span>
    <span class="code" title="Table code">${esc(S.code)}</span>
    <button class="ghost" id="copyInvite">Copy invite link</button>${bankBtns}`;
}

function statusLine(v) {
  if (!v) {
    if (S.net === 'notfound') return `Can't find table ${esc(S.code)}. The bank's page has to be open. Retrying.`;
    return `Connecting to table ${esc(S.code)}…`;
  }
  if (v.closed) return `<b>Table closed.</b> ${esc(v.closeReason)}`;
  const mine = me(v);
  if (v.phase === 'play' && v.turn) {
    return v.turn.pid === pid ? '<b>Your turn</b>' : `<b>${esc(nameOf(v, v.turn.pid))}</b>'s turn`;
  }
  const wait = waitingOn(v);
  if (v.phase === 'insurance') return `Dealer shows an ace. Insurance? ${wait.length ? `Waiting on ${esc(wait.join(', '))}` : ''}`;
  if (!v.players.length) return S.role === 'bank' ? 'Copy the invite link and send it. You approve each seat.' : 'Nobody is seated yet.';
  if (mine && mine.status === 'bet' && wait.length) return `Bet in. Waiting on ${esc(wait.join(', '))}`;
  return wait.length ? `Place your bets. Waiting on ${esc(wait.join(', '))}` : 'Place your bets';
}

function renderFelt(v) {
  const r = v.round;
  $('dealer').innerHTML = `<div class="cards">${v.dealer.map((c) => cardHtml(c, r)).join('')}</div>
    <div class="meta"><span class="total">${totalLabel(v.dealer)}</span><span class="tag" style="font-size:12px;opacity:.8">${esc(v.cfg.bankName)} (bank)</span></div>`;
  const seats = $('seats');
  seats.className = `seats ${v.players.length > 3 ? 'many' : ''}`;
  seats.innerHTML = v.players.map((p) => {
    const online = v.online ? v.online.includes(p.pid) : true;
    const hands = p.hands.length
      ? p.hands.map((h, i) => {
          const active = v.turn && v.turn.pid === p.pid && v.turn.hand === i && p.hands.length > 1;
          const res = h.result ? `<span class="result ${h.net > 0 ? 'win' : h.net < 0 ? 'lose' : ''}">${WORD[h.result]}${h.net ? ` ${signedMoney(h.net)}` : ''}</span>` : '';
          return `<div class="hand ${active ? 'active' : ''}"><div class="cards">${h.cards.map((c) => cardHtml(c, r)).join('')}</div>
            <div class="meta"><span class="total">${totalLabel(h.cards)}</span><span class="spot">${money(h.bet)}</span>${res}</div></div>`;
        }).join('')
      : p.status === 'bet' ? `<div class="meta"><span class="spot">${money(p.wager)}</span></div>` : '';
    const ins = p.ins && p.insNet ? `<span class="result ${p.insNet > 0 ? 'win' : 'lose'}">Insurance ${signedMoney(p.insNet)}</span>` : p.ins ? '<span class="tag">Insured</span>' : '';
    const tag = !online ? 'Offline' : p.status === 'out' ? 'Sitting out' : p.stack < v.cfg.minBet && !p.hands.length && p.status !== 'bet' ? 'Needs chips' : '';
    return `<div class="seat ${v.turn?.pid === p.pid ? 'turn' : ''} ${p.pid === pid && S.role === 'player' ? 'me' : ''}">
      <div class="hands">${hands}</div>${ins}
      <span class="name">${esc(p.name)}</span><span class="stack">${money(p.stack)}</span>${tag ? `<span class="tag">${tag}</span>` : ''}</div>`;
  }).join('');

  const total = v.decks * 52;
  const ticks = Array.from({ length: v.decks - 1 }, (_, i) =>
    `<div class="tray-tick" style="bottom:${((i + 1) / v.decks) * 100}%"></div>`).join('');
  $('tray').innerHTML = `<div class="tray-box"><div class="tray-fill" style="height:${Math.min(100, (v.discarded / total) * 100)}%"></div>${ticks}</div><span>Discards</span>`;
  $('shoe').innerHTML = `${v.decks} deck shoe<br><span style="font:500 12px var(--sans);opacity:.8">Bets ${money(v.cfg.minBet)} to ${money(v.cfg.maxBet)}</span>`;
}

function renderControls(v) {
  if (v.closed) return '';
  if (S.role === 'bank') {
    if (v.phase === 'betting') {
      const any = v.players.some((p) => p.status === 'bet');
      return any ? '<button class="act primary" id="dealNow">Deal now</button>' : '';
    }
    if (v.phase === 'insurance') return '<button class="act" id="skip">Skip insurance</button>';
    if (v.phase === 'play' && v.turn) return `<button class="act" id="skip">Stand for ${esc(nameOf(v, v.turn.pid))}</button>`;
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
  const inHand = mine.hands.length && (v.phase === 'play' || v.phase === 'insurance');
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

/* ---------- events ---------- */

async function copyInvite() {
  const url = `${location.origin}${location.pathname}#${S.code}`;
  try { await navigator.clipboard.writeText(url); flash('Invite link copied'); }
  catch { flash(url); }
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if ('close' in t.dataset) { t.closest('dialog').close(); return; }
  if (t.id === 'copyInvite') copyInvite();
  else if (t.id === 'openLimits') openLimits();
  else if (t.id === 'closeTable') {
    if (!S.closeArm) { S.closeArm = true; draw(); setTimeout(() => { S.closeArm = false; draw(); }, 3000); return; }
    S.closeArm = false;
    bank((g) => g.close());
  } else if (t.id === 'newTable') {
    store.del(hostKey(S.code));
    S.peer?.destroy();
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
  } else if (f.id === 'betForm') send({ t: 'bet', amount: Number($('betAmt').value) });
  else if (f.id === 'buyForm') {
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

if (typeof Peer === 'undefined') {
  document.body.innerHTML = '<p style="padding:20px">Could not load the connection library. Check your internet and refresh.</p>';
} else {
  boot();
}
