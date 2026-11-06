// Plays the real engine headless. Known answer for this game with flat bets and basic strategy
// is a player edge near -0.4%, so a big miss here would mean a payout or strategy bug.
import { Game, recommend, recommendedBet, basicAction } from '../public/engine.js';

function run({ rounds, deviations, ramp, decks = 6 }) {
  const g = new Game({ deckMode: decks });
  let net = 0, wagered = 0;
  for (let i = 0; i < rounds; i += 1) {
    if (g.needsShuffle) g.newShoe();
    const tcBet = g.trueCount;
    const bet = ramp ? recommendedBet(tcBet) : 1;
    g.deal(bet);
    if (g.phase === 'insurance') g.insurance(deviations && g.trueCount >= 3);
    while (g.phase === 'play') {
      const ctx = g.context();
      g.act(deviations ? recommend(ctx, g.trueCount).action : basicAction(ctx));
    }
    net += g.roundNet;
    wagered += bet;
  }
  return { net, wagered, edge: (net / wagered) * 100, perRound: net / rounds };
}

const rounds = Number(process.argv[2] ?? 4000000);
for (const [name, o] of [
  ['basic, flat bet', { deviations: false, ramp: false }],
  ['deviations, flat bet', { deviations: true, ramp: false }],
  ['deviations + bet ramp', { deviations: true, ramp: true }],
]) {
  const r = run({ rounds, ...o });
  console.log(`${name.padEnd(24)} edge ${r.edge.toFixed(3)}% of money bet, ${r.perRound.toFixed(4)} units/round`);
}
