import {
  Game, BETS, DEVIATIONS, INSURANCE_INDEX, DECK_POOL, MARGIN,
  explain, explainBet, handValue, ruleName, signed, upLabel, makeDrill, gradeDrill,
} from './engine.js';

const PEN_POOL = [0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9];
const STORE = 'true-count-v1';
const STAGGER = 150;
const $ = (id) => document.getElementById(id);
const SUIT = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };
const TEXT = '︎'; // keeps suits as text glyphs instead of emoji on phones

const blankStats = () => ({ plays: [0, 0], devs: [0, 0], counts: [0, 0], bets: [0, 0], net: 0 });

function load() {
  try { return JSON.parse(localStorage.getItem(STORE)) ?? {}; } catch { return {}; }
}
const saved = load();
const settings = { deckMode: 'random', penMode: 'random', surrender: false, every: 3, showCount: false, drillTrue: false, ...saved.settings };
const drillStats = { ...saved.drill }; // spot id -> [right, asked]
const stats = { ...blankStats(), ...saved.stats };
let shoeStats = blankStats();

function save() {
  try { localStorage.setItem(STORE, JSON.stringify({ settings, stats, drill: drillStats })); } catch { /* private window */ }
}

const game = new Game({ deckMode: settings.deckMode, penMode: settings.penMode, surrender: settings.surrender });
const ui = { bet: 1, checkDue: false, sinceCheck: 0, guess: 0, busy: false, feed: [], shown: new Set(), flipped: new Set(), late: 0 };

function bump(key, ok) {
  for (const s of [stats, shoeStats]) { s[key][1] += 1; if (ok) s[key][0] += 1; }
}

function pushNote(note, big = false) {
  ui.feed.unshift({ ...note, big });
  ui.feed.length = Math.min(ui.feed.length, 40);
}

function record(entry) {
  if (entry.type === 'bet') {
    bump('bets', entry.ok);
    if (!entry.ok) pushNote(explainBet(entry));
    return;
  }
  const note = explain(entry);
  const isDev = entry.type === 'insurance'
    ? entry.should && !entry.close
    : Boolean(entry.rule) && !entry.close && entry.action !== entry.basic;
  bump('plays', entry.ok);
  if (isDev) bump('devs', entry.ok);
  pushNote(note, note.tag === 'Deviation' || note.tag === 'Near deviation' || note.tone === 'bad');
}

/* ---------- rendering ---------- */

function cardHtml(card, delay, cls = '') {
  const red = card.suit === 'hearts' || card.suit === 'diamonds';
  const s = SUIT[card.suit] + TEXT;
  const corner = `<b>${card.rank}</b><i>${s}</i>`;
  return `<div class="card ${red ? 'red' : ''} ${cls}" style="--d:${delay}ms" role="img" aria-label="${card.rank} of ${card.suit}">
    <span class="corner">${corner}</span><span class="pip">${s}</span><span class="corner flip">${corner}</span></div>`;
}

// Cards get their animation class once. The stagger order follows the order they appear in.
function renderCards(cards, clock, hideIndex = -1) {
  return cards.map((c, i) => {
    if (i === hideIndex) {
      const fresh = !ui.shown.has(c.id);
      ui.shown.add(c.id);
      const d = fresh ? clock.next() : 0;
      return `<div class="card back ${fresh ? 'new' : ''}" style="--d:${d}ms" role="img" aria-label="Face down card"></div>`;
    }
    if (ui.shown.has(c.id)) {
      if (i === 1 && cards === game.dealer && !ui.flipped.has(c.id)) {
        ui.flipped.add(c.id);
        return cardHtml(c, clock.next(), 'flipup');
      }
      return cardHtml(c, 0);
    }
    ui.shown.add(c.id);
    if (cards === game.dealer && i === 1) ui.flipped.add(c.id);
    return cardHtml(c, clock.next(), 'new');
  }).join('');
}

function resultLabel(h) {
  const n = h.net;
  const amount = n === 0 ? '' : ` ${n > 0 ? '+' : '-'}${Math.abs(n)}u`;
  const word = { win: 'Win', lose: 'Lose', push: 'Push', bust: 'Bust', blackjack: 'Blackjack', surrender: 'Surrender' }[h.result];
  return `${word}${amount}`;
}

function totalLabel(cards) {
  const { total, soft } = handValue(cards);
  return soft && total < 21 ? `${total - 10}/${total}` : String(total);
}

function renderTable() {
  // Two passes share one clock so the hit card lands before the dealer's draws.
  const clock = { n: 0, next() { const d = this.n * STAGGER; this.n += 1; return d; } };
  const playing = game.phase === 'play' || game.phase === 'insurance';

  const playerHtml = game.hands.length
    ? game.hands.map((h, i) => {
        const settled = game.phase === 'settled';
        const active = game.phase === 'play' && i === game.active && game.hands.length > 1;
        const result = settled
          ? `<span class="result late ${h.net > 0 ? 'win' : h.net < 0 ? 'lose' : ''}">${resultLabel(h)}</span>`
          : '';
        return `<div class="hand ${active ? 'active' : ''}">
          <div class="cards">${renderCards(h.cards, clock)}</div>
          <div class="meta"><span class="total">${totalLabel(h.cards)}</span><span class="spot" aria-label="Bet ${h.bet} units">${h.bet}</span>${result}</div>
        </div>`;
      }).join('')
    : `<p class="empty-note">Place your bet</p>`;
  const dealerCards = renderCards(game.dealer, clock, game.holeHidden ? 1 : -1);

  ui.late = clock.n * STAGGER;
  const dealerTotal = !game.dealer.length ? '' : game.holeHidden ? String(handValue([game.dealer[0]]).total) : totalLabel(game.dealer);
  const insured = game.insuranceBet && game.phase === 'settled'
    ? `<span class="result late ${game.insuranceNet > 0 ? 'win' : 'lose'}">Insurance ${game.insuranceNet > 0 ? '+' : '-'}${Math.abs(game.insuranceNet)}u</span>`
    : '';
  $('dealer').innerHTML = `<div class="cards">${dealerCards}</div><div class="meta"><span class="total ${playing ? '' : 'late'}">${dealerTotal}</span>${insured}</div>`;

  const player = $('player');
  player.className = `zone player hands-${game.hands.length}`;
  player.innerHTML = playerHtml;
  document.querySelector('.felt').style.setProperty('--late', `${ui.late}ms`);

  const total = game.decks * 52;
  const ticks = Array.from({ length: game.decks - 1 }, (_, i) =>
    `<div class="tray-tick" style="bottom:${((i + 1) / game.decks) * 100}%"></div>`).join('');
  $('tray').innerHTML = `<div class="tray-box"><div class="tray-fill" style="height:${(game.discarded / total) * 100}%"></div>${ticks}</div><span>Discards</span>`;
  $('shoe').innerHTML = settings.penMode === 'random'
    ? `${game.decks} deck shoe`
    : `${game.decks} deck shoe<br><span style="font:500 12px var(--sans);opacity:.8">Cut at ${Math.round(game.penetration * 100)}%</span>`;

  const chip = $('countchip');
  chip.hidden = !settings.showCount;
  if (settings.showCount) {
    chip.innerHTML = `Running <b>${signed(game.rc)}</b><br>True <b>${signed(game.trueCount, 1)}</b><br>Decks <b>${game.decksLeft.toFixed(1)}</b>`;
  }
  $('toggleCount').setAttribute('aria-pressed', String(settings.showCount));
}

const LABELS = { hit: ['Hit', 'H'], stand: ['Stand', 'S'], double: ['Double', 'D'], split: ['Split', 'P'], surrender: ['Surrender', 'R'] };

function renderControls() {
  const box = $('controls');
  const off = ui.busy ? 'disabled' : '';
  if (game.phase === 'play') {
    const legal = game.legalActions();
    const names = settings.surrender ? Object.keys(LABELS) : Object.keys(LABELS).filter((a) => a !== 'surrender');
    box.innerHTML = names.map((a) =>
      `<button class="act" data-act="${a}" ${legal.includes(a) && !ui.busy ? '' : 'disabled'}>${LABELS[a][0]}<kbd>${LABELS[a][1]}</kbd></button>`).join('');
    return;
  }
  if (game.phase === 'insurance') {
    box.innerHTML = `<span class="label">Insurance?</span>
      <button class="act" data-ins="yes" ${off}>Take<kbd>Y</kbd></button>
      <button class="act" data-ins="no" ${off}>No<kbd>N</kbd></button>`;
    return;
  }
  if (ui.checkDue) {
    box.innerHTML = `<form class="check" id="checkForm">
      <label class="label" for="guess">Running count?</label>
      <button type="button" class="step" data-step="-1" aria-label="Lower" ${off}>−</button>
      <input id="guess" inputmode="text" autocomplete="off" value="${ui.guess}" ${off}>
      <button type="button" class="step" data-step="1" aria-label="Higher" ${off}>+</button>
      <button class="act primary" ${off}>Check</button></form>`;
    if (!ui.busy) { const g = $('guess'); g.focus({ preventScroll: true }); g.select(); }
    return;
  }
  if (game.needsShuffle) {
    box.innerHTML = `<button class="act primary" id="finishShoe" ${off}>Finish shoe</button>`;
    return;
  }
  box.innerHTML = `<div class="chips" role="group" aria-label="Bet in units">${BETS.map((b) =>
    `<button class="chip" data-bet="${b}" aria-pressed="${b === ui.bet}" aria-label="Bet ${b} units" ${off}>${b}</button>`).join('')}</div>
    <button class="act primary" data-deal ${off}>Deal<kbd>Enter</kbd></button>`;
}

const pct = ([ok, n]) => (n ? `${Math.round((ok / n) * 100)}%` : '–');

function renderCoach() {
  const net = stats.net;
  $('scores').innerHTML = [
    ['Plays', pct(stats.plays)], ['Deviations', pct(stats.devs)], ['Count', pct(stats.counts)],
    ['Bets', pct(stats.bets)], ['Units', `${net > 0 ? '+' : ''}${net}`],
  ].map(([k, v]) => `<div class="score"><b>${v}</b><span>${k}</span></div>`).join('');

  $('feed').innerHTML = ui.feed.length
    ? ui.feed.map((n) => `<article class="note ${n.tone ?? ''} ${n.big ? 'big' : ''}">
        <div class="tag">${n.tag}</div><h3>${n.title}</h3>${n.lines.map((l) => `<p>${l}</p>`).join('')}</article>`).join('')
    : '';
}

function render() {
  renderTable();
  renderControls();
  renderCoach();
}

// Hold input until the cards have landed, so nobody acts on a hand still being dealt.
function renderThenSettle() {
  ui.busy = true;
  render();
  setTimeout(() => { ui.busy = false; renderControls(); }, Math.min(ui.late + 120, 1400));
}

/* ---------- flow ---------- */

function afterAction() {
  if (game.phase === 'settled') {
    stats.net += game.roundNet;
    shoeStats.net += game.roundNet;
    ui.sinceCheck += 1;
    if (settings.every > 0 && ui.sinceCheck >= settings.every) {
      ui.checkDue = true;
      ui.guess = 0;
    }
  }
  save();
  renderThenSettle();
}

function deal() {
  if (ui.busy || ui.checkDue || game.needsShuffle) return;
  if (game.phase !== 'ready' && game.phase !== 'settled') return;
  game.surrender = settings.surrender;
  record(game.deal(ui.bet));
  afterAction();
}

function play(action) {
  if (ui.busy || !game.legalActions().includes(action)) return;
  record(game.act(action));
  afterAction();
}

function insurance(take) {
  if (ui.busy || game.phase !== 'insurance') return;
  record(game.insurance(take));
  afterAction();
}

function submitCheck() {
  const raw = $('guess').value.trim().replace('−', '-').replace('+', '');
  const guess = Number(raw);
  if (raw === '' || !Number.isInteger(guess)) return;
  const ok = guess === game.rc;
  bump('counts', ok);
  pushNote({
    tone: ok ? 'good' : 'bad',
    tag: 'Count',
    title: ok ? `Running count ${signed(game.rc)}: correct` : `Running count is ${signed(game.rc)}, you said ${signed(guess)}`,
    lines: [`True count ${signed(game.trueCount, 1)}: ${signed(game.rc)} over ${game.decksLeft.toFixed(1)} decks left.`],
  }, !ok);
  ui.checkDue = false;
  ui.sinceCheck = 0;
  save();
  render();
}

function openShoeEnd() {
  const rows = [
    ['Decks in this shoe', game.decks],
    ['Final running count', signed(game.rc)],
    ['Plays', `${shoeStats.plays[0]} of ${shoeStats.plays[1]}`],
    ['Deviations', `${shoeStats.devs[0]} of ${shoeStats.devs[1]}`],
    ['Count checks', `${shoeStats.counts[0]} of ${shoeStats.counts[1]}`],
    ['Bets', `${shoeStats.bets[0]} of ${shoeStats.bets[1]}`],
    ['Units', `${shoeStats.net > 0 ? '+' : ''}${shoeStats.net}`],
  ];
  $('shoeEndBody').innerHTML = `<div class="summary">${rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('')}</div>
    <button class="act primary" id="shuffle">Shuffle new shoe</button>`;
  $('shoeEnd').showModal();
}

function shuffleNewShoe() {
  game.deckMode = settings.deckMode;
  game.penMode = settings.penMode;
  game.newShoe();
  shoeStats = blankStats();
  ui.sinceCheck = 0;
  ui.checkDue = false;
  pushNote({ tag: 'New shoe', title: `${game.decks} decks shuffled`, lines: ['Running count is back to 0.'] });
  render();
}

/* ---------- deviation drill ---------- */

const drill = { cur: null, picked: null, result: null, right: 0, asked: 0, fresh: false };
const DRILL_LABELS = { ...LABELS, take: ['Take insurance', 'Y'], decline: ['No insurance', 'N'] };

// Spots you miss come up more often. Unseen spots get a small bump so every one shows up early.
function drillWeight(spot) {
  const [ok, n] = drillStats[spot.id] ?? [0, 0];
  return n ? 1 + (3 * (n - ok)) / n : 1.5;
}

function nextDrill() {
  drill.cur = makeDrill({ surrender: settings.surrender, weight: drillWeight });
  drill.picked = null;
  drill.result = null;
  drill.fresh = true;
  renderDrill();
}

function answerDrill(choice) {
  const d = drill.cur;
  if (!d || drill.result || !d.options.includes(choice)) return;
  drill.picked = choice;
  drill.result = gradeDrill(d, choice);
  drill.asked += 1;
  if (drill.result.ok) drill.right += 1;
  const s = drillStats[d.spot.id] ?? [0, 0];
  drillStats[d.spot.id] = [s[0] + (drill.result.ok ? 1 : 0), s[1] + 1];
  save();
  renderDrill();
}

function weakest() {
  return Object.entries(drillStats)
    .filter(([, [ok, n]]) => n >= 2 && ok < n)
    .sort((a, b) => (a[1][0] / a[1][1]) - (b[1][0] / b[1][1]))
    .slice(0, 3)
    .map(([id, [ok, n]]) => {
      const r = DEVIATIONS.find((x) => x.id === id);
      return `${r ? ruleName(r) : 'Insurance'} (${ok} of ${n})`;
    });
}

function renderDrill() {
  const d = drill.cur;
  $('drillScore').textContent = drill.asked ? `${drill.right} of ${drill.asked}` : '';
  const count = settings.drillTrue
    ? `<div class="stat"><b>${signed(d.tc, 1)}</b><span>True count</span></div>`
    : `<div class="stat"><b>${signed(d.rc)}</b><span>Running count</span></div><div class="stat"><b>${d.decksLeft.toFixed(1)}</b><span>Decks left</span></div>`;
  const done = Boolean(drill.result);
  const buttons = d.options.map((o) => {
    const cls = !done ? '' : o === d.answer ? 'right' : o === drill.picked ? 'wrong' : '';
    return `<button class="act ${cls}" data-drill="${o}" ${done ? 'disabled' : ''}>${DRILL_LABELS[o][0]}<kbd>${DRILL_LABELS[o][1]}</kbd></button>`;
  }).join('');
  const n = drill.result?.note;
  const feedback = n
    ? `<article class="note big ${n.tone}"><div class="tag">${n.tag}</div><h3>${n.title}</h3>${n.lines.map((l) => `<p>${l}</p>`).join('')}</article>
       <div class="drill-next"><button class="act primary" id="drillNext">Next<kbd>Enter</kbd></button></div>`
    : '';
  const weak = weakest();
  const deal = drill.fresh ? 'new' : '';
  drill.fresh = false;
  $('drillBody').innerHTML = `
    <div class="drill-felt">
      <div class="drill-count">${count}</div>
      <div class="drill-hands">
        <div class="drill-hand"><span>Dealer</span><div class="cards">${cardHtml(d.up, 0, deal)}</div></div>
        <div class="drill-hand"><span>You</span><div class="cards">${d.player.map((c, i) => cardHtml(c, (i + 1) * STAGGER, deal)).join('')}</div></div>
      </div>
    </div>
    <div class="controls">${buttons}</div>
    ${feedback}
    <div class="drill-foot">
      <label class="field">Give the true count<input type="checkbox" id="setDrillTrue" ${settings.drillTrue ? 'checked' : ''}></label>
      ${weak.length ? `<p class="drill-weak">Missed most: ${weak.join(', ')}</p>` : ''}
    </div>`;
  if (done) $('drillNext').focus({ preventScroll: true });
}

function openDrill() {
  nextDrill();
  $('drill').showModal();
}

/* ---------- learn and settings ---------- */

function renderLearn() {
  const row = (r) => `<tr><td>${ruleName(r)}</td><td>${r.above}</td><td>${signed(r.index)} or higher</td><td>${r.below ?? 'play on'}</td></tr>`;
  const head = '<tr><th>Hand</th><th>Play</th><th>When true count is</th><th>Otherwise</th></tr>';
  const plays = DEVIATIONS.filter((r) => r.group !== 'surrender');
  const fab = DEVIATIONS.filter((r) => r.group === 'surrender');
  $('learnBody').innerHTML = `
    <h3>1. Keep the running count</h3>
    <p>Add each card's value as you see it. Every shuffle starts at 0.</p>
    <div class="values"><div><b>+1</b>2, 3, 4, 5, 6</div><div><b>0</b>7, 8, 9</div><div><b>−1</b>10, J, Q, K, A</div></div>
    <p>High cards help you: more blackjacks, more dealer busts, better doubles. So when low cards leave the shoe, the count rises and the shoe gets better for you.</p>

    <h3>2. Convert to the true count</h3>
    <p>True count = running count ÷ decks left. A running +6 means much more with 2 decks left (+3) than with 6 (+1). Judge decks left from the discard tray. The brass lines mark one deck each.</p>
    <p>The dealer's face down card is not counted until it is turned over.</p>

    <h3>3. Bet with the count</h3>
    <div class="scroll"><table><tr><th>True count</th><th>Below +2</th><th>+2</th><th>+3</th><th>+4</th><th>+5 or higher</th></tr>
      <tr><td>Bet</td><td>1u</td><td>2u</td><td>4u</td><td>8u</td><td>12u</td></tr></table></div>

    <h3>4. Deviations</h3>
    <p>Basic strategy is right for an average shoe. A deviation is a spot where the count changes the right play. Each has an index: the true count where the better play flips. Hands within ${MARGIN} of an index are close enough that either play is accepted.</p>
    <p><b>Illustrious 18.</b> Insurance plus the 17 plays below. Insurance: take it at ${signed(INSURANCE_INDEX)} or higher, because it pays 2 to 1 and breaks even when a third of unseen cards are tens.</p>
    <div class="scroll"><table>${head}${plays.map(row).join('')}</table></div>
    <p><b>Why they work.</b> At high counts, extra tens make you bust more when you hit and make the dealer bust more, so you stand on stiff hands and double more. At negative counts it flips, so you hit 12 and 13 hands you would normally stand on.</p>
    <p><b>Fab 4.</b> Surrender plays, only when late surrender is on in Settings. Check these before the plays above.</p>
    <div class="scroll"><table>${head}${fab.map(row).join('')}</table></div>

    <h3>Table rules</h3>
    <p>Dealer stands on all 17s, blackjack pays 3 to 2, double any two cards, double after split, split to 4 hands, split aces get one card, dealer peeks for blackjack. Shoes are ${DECK_POOL.join(', ').replace(/, (\d)$/, ' or $1')} decks and the cut card falls ${settings.penMode === 'random' ? '70 to 80%' : `${Math.round(settings.penMode * 100)}%`} of the way in.</p>
    <p>Keys: H hit, S stand, D double, P split, R surrender, Y and N for insurance, Enter to deal.</p>`;
}

function renderSettings() {
  const deckOptions = ['random', ...DECK_POOL].map((d) =>
    `<option value="${d}" ${String(settings.deckMode) === String(d) ? 'selected' : ''}>${d === 'random' ? 'Random each shoe' : `${d} decks`}</option>`).join('');
  const penOptions = ['random', ...PEN_POOL].map((p) =>
    `<option value="${p}" ${String(settings.penMode) === String(p) ? 'selected' : ''}>${p === 'random' ? 'Random 70 to 80%' : `${Math.round(p * 100)}%`}</option>`).join('');
  const everyOptions = [[1, 'Every hand'], [3, 'Every 3 hands'], [5, 'Every 5 hands'], [0, 'Never']].map(([v, l]) =>
    `<option value="${v}" ${settings.every === v ? 'selected' : ''}>${l}</option>`).join('');
  const midRound = game.phase === 'play' || game.phase === 'insurance';
  $('settingsBody').innerHTML = `
    <label class="field">Decks per shoe<select id="setDecks">${deckOptions}</select></label>
    <label class="field">Deck penetration<select id="setPen">${penOptions}</select></label>
    <label class="field">Count check<select id="setEvery">${everyOptions}</select></label>
    <label class="field">Late surrender<input type="checkbox" id="setSurrender" ${settings.surrender ? 'checked' : ''}></label>
    <div class="row-actions">
      <button class="ghost" id="shuffleNow" ${midRound ? 'disabled' : ''}>Shuffle now</button>
      <button class="ghost" id="resetStats">Reset scores</button>
    </div>`;
}

/* ---------- events ---------- */

document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.drill) answerDrill(t.dataset.drill);
  else if (t.id === 'drillNext') nextDrill();
  else if (t.id === 'openDrill') openDrill();
  else if (t.dataset.act) play(t.dataset.act);
  else if (t.dataset.ins) insurance(t.dataset.ins === 'yes');
  else if (t.dataset.bet) { ui.bet = Number(t.dataset.bet); renderControls(); }
  else if ('deal' in t.dataset) deal();
  else if (t.dataset.step) {
    const v = Number($('guess').value) || 0;
    $('guess').value = v + Number(t.dataset.step);
  } else if ('close' in t.dataset) t.closest('dialog').close();
  else if (t.id === 'finishShoe') openShoeEnd();
  else if (t.id === 'shuffle') { $('shoeEnd').close(); shuffleNewShoe(); }
  else if (t.id === 'openLearn') { renderLearn(); $('learn').showModal(); }
  else if (t.id === 'openSettings') { renderSettings(); $('settings').showModal(); }
  else if (t.id === 'toggleCount') { settings.showCount = !settings.showCount; save(); renderTable(); }
  else if (t.id === 'shuffleNow') { $('settings').close(); shuffleNewShoe(); }
  else if (t.id === 'resetStats') {
    Object.assign(stats, blankStats());
    shoeStats = blankStats();
    save();
    renderCoach();
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.id === 'checkForm') { e.preventDefault(); submitCheck(); }
});

document.addEventListener('change', (e) => {
  const { id, value, checked } = e.target;
  if (id === 'setDecks') {
    settings.deckMode = value === 'random' ? value : Number(value);
    save();
    // A different deck count needs a fresh shoe. Mid-hand it waits for the next shuffle.
    if (game.phase !== 'play' && game.phase !== 'insurance') shuffleNewShoe();
    else pushNote({ tag: 'Settings', title: 'New deck count starts next shoe', lines: ['Finish this hand, then use Shuffle now.'] });
    renderSettings();
    return;
  }
  else if (id === 'setPen') {
    settings.penMode = value === 'random' ? value : Number(value);
    game.setPenetration(settings.penMode);
    render();
  }
  else if (id === 'setEvery') settings.every = Number(value);
  else if (id === 'setSurrender') { settings.surrender = checked; renderControls(); }
  else if (id === 'setDrillTrue') { settings.drillTrue = checked; save(); renderDrill(); return; }
  else return;
  save();
});

document.addEventListener('keydown', (e) => {
  if ($('drill').open && !e.metaKey && !e.ctrlKey && e.target.tagName !== 'INPUT') {
    const k = e.key.toLowerCase();
    const map = { h: 'hit', s: 'stand', d: 'double', p: 'split', r: 'surrender', y: 'take', n: 'decline' };
    if (drill.result && (k === 'enter' || k === ' ')) { e.preventDefault(); nextDrill(); }
    else if (map[k]) answerDrill(map[k]);
    return;
  }
  if (document.querySelector('dialog[open]') || e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey) return;
  const k = e.key.toLowerCase();
  const keyMap = { h: 'hit', s: 'stand', d: 'double', p: 'split', r: 'surrender' };
  if (keyMap[k]) play(keyMap[k]);
  else if (k === 'y') insurance(true);
  else if (k === 'n') insurance(false);
  else if (k === 'enter' && e.target.tagName !== 'BUTTON') deal();
});

render();
