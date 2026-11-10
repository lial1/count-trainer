# Changelog

## 2026-11-10
- Home game connection fixes: a player whose network blocks the direct link now sees "Can't reach the bank" instead of spinning forever; a second tab of the same table in the bank's browser says "Already open" instead of fighting over the table. Found that PeerJS's free relay (TURN) is dead, so players on cell data or strict Wi-Fi cannot connect; added a TURN_CREDENTIALS_URL hook in table.js for a Metered free relay.
- Changing decks per shoe now shuffles a new shoe right away (or after the current hand), and the shoe label shows the cut point when penetration is fixed. Before, a deck change waited for the next shuffle, so 90% on "8 decks" could still be playing out an older shoe.
- Deck penetration now takes effect right away: changing it moves the cut card in the shoe you are playing, instead of waiting for the next shuffle.
- Added Home game (table.html, "Play online" in the header): private online blackjack with friends. The host is the bank and sets min bet, max bet, stop loss, decks, penetration and late surrender. Friends open the invite link, enter a name and buy-in, and the bank approves each seat and each rebuy. Players cash out between hands whenever they want. A ledger shows in, out, chips and net, plus who pays whom; the table closes itself when the bank hits the stop loss. Money never goes through the app, settle on Zelle.
- No server of ours: the bank's browser runs the table and friends connect peer to peer (PeerJS's free broker introduces them). Clients never get the shoe or the hole card. The bank's table is saved in its browser, so a refresh picks the game back up and players reconnect on their own.
- Added `npm run dev` (static server on 127.0.0.1:4173).
- Added a Deck penetration setting: Random 70 to 80% (the old behavior, still the default) or a fixed 50, 60, 65, 70, 75, 80, 85 or 90%. Takes effect on the next shuffle, same as decks per shoe.
- Lowered the minimum cards behind the cut from 20 to 10, so 90% on a 2 deck shoe really is 90%.

## 2026-11-07
- Fixed the score bar labels (Plays, Deviations, Count, Bets, Units) getting cut off once the coach feed filled up; the feed now scrolls under a full-size score bar.
- Added a deviation drill (Drill button): a hand, a dealer upcard, and a running count with decks left, never within 0.5 of the index so each answer is clear. Covers the Illustrious 18, plus the Fab 4 when late surrender is on.
- Spots you miss come up more often. Per-spot results are saved in the browser, and the three weakest show under the drill.

## 2026-11-06
- Built True Count: solo Hi-Lo blackjack trainer, static site in public/, no dependencies.
- Shoes are random 2, 4, 6 or 8 decks. Single deck is left out because the chart and indices are for multi-deck S17.
- Rules fixed at S17, DAS, 3:2. Illustrious 18 always on, Fab 4 only with late surrender on.
- Hands within 0.5 of an index accept either play, since real players estimate decks by eye.
- Deployed on Vercel at https://count-trainer-six.vercel.app.
- Added scripts/index-check.mjs, which measures where each deviation really flips. Insurance reading about +3 is its calibration check.
