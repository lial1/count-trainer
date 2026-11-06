# Changelog

## 2026-11-06
- Built True Count: solo Hi-Lo blackjack trainer, static site in public/, no dependencies.
- Shoes are random 2, 4, 6 or 8 decks. Single deck is left out because the chart and indices are for multi-deck S17.
- Rules fixed at S17, DAS, 3:2. Illustrious 18 always on, Fab 4 only with late surrender on.
- Hands within 0.5 of an index accept either play, since real players estimate decks by eye.
- Deployed to the personal Vercel account (lial1) at https://count-trainer-six.vercel.app. Deploy with --global-config ~/.vercel-personal --scope lia-li-s-projects; the default CLI login is the Volume UGC business account.
- Added scripts/index-check.mjs, which measures where each deviation really flips. Insurance reading about +3 is its calibration check.
