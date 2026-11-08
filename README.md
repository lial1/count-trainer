# True Count

A Hi-Lo card counting trainer for blackjack. Play solo hands from a random 2, 4, 6 or 8 deck shoe, keep the running and true count, and get coached on the Illustrious 18 (plus the Fab 4 with late surrender on).

Live: https://count-trainer-six.vercel.app

## What it does
- Deals a real shoe and checks your count when asked.
- Bet ramp tied to the true count.
- Deviation drill that quizzes index plays and repeats the ones you miss.
- Rules: dealer stands on soft 17, double after split, blackjack pays 3:2.

## How it was checked
- `npm run sim` plays millions of hands. Over 3M hands, flat-betting basic strategy loses about 0.43%, close to the expected 0.4%; deviations and the bet ramp move it positive.
- `npm run index-check` measures where each deviation actually flips, so the indices are tested, not just copied from a table.
- `npm test` runs the engine tests.

Plain HTML, CSS and JavaScript in `public/`, no dependencies.
