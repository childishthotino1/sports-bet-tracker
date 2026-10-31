# Betting guide: what the promo bot applies

Source: The Betting Insider, "Betting Guide" (thebettinginsider.com/betting-guide),
read 2026-10-31. Its seven chapters, and where each one lives in the bot.

## I. Betting with units

- A unit is 1-3% of bankroll. Units are sized by what you risk, not what you win.
- Never risk more than 7% of bankroll in one day.
- Bet fractions of a unit (quarter, half, three-quarter, full) by confidence:
  three full-unit bets at even odds already put almost 10% at risk.
- Track units and dollars at risk, odds, result and payout; ROI = profit /
  amount wagered x 100.

**Applied:** every verdict's wager line is quarter Kelly capped at a full unit,
3% of bankroll (`MAX_BET_SHARE` in `bet.ts`). The help text gives the 7% daily
limit (`MAX_DAY_SHARE` in `guide.ts`); the bot doesn't see your day's other
bets, so it can't enforce it. ROI tracking is the bet tracker's job (the
Baltimore Bets app).

## II. Line shopping

- Have at least three books; keep similar money in each.
- Finding +5 to +10 better odds on the same bet adds up over time.

**Applied:** a question about a game (`answerQuestion`) prices every leg at
BetMGM, DraftKings, FanDuel and theScore and shows the best book for each. A slip
check without a boost also lists any leg that's priced better at one of your
other books (`betterPrices` in `slip.ts`). Those books ride in the same odds
request, so this costs no extra credits. A boosted slip isn't shopped: the boost
belongs to its book.

## III. Implied odds

- Favorite: implied probability = odds / (odds + 100), so -150 is 60%.
  Underdog: 100 / (odds + 100), so +150 is 40%.
- Break-even win rates: +100 50%, -110 52.4%, -120 54.5%, -150 60%. (The guide
  rounds these up to 50.5%, 53%, 55% and 60.5%: "win rate for profit".)
- Hedging: for a -200 to -150 bet, hedge once the other side lets you lock in
  2-2.5x the original profit while risking no more than 75% of it; for -150 or
  shorter, once it's 1.5x.

**Applied:** `impliedProb` in `odds.ts`; every no-boost verdict prints the
break-even rate. The bot never sees a bet after it's placed, so it doesn't
suggest hedges.

## IV. Reverse line movement

- When the line moves against the side the public is betting (Chiefs -7 to
  -5.5 with most bets on the Chiefs), sharp money is on the other side.

**Not applied:** spotting it needs opening lines and betting splits. The Odds
API's history is a paid add-on, and it has no betting splits at all. The bot's
sharp price (Pinnacle and the exchanges) already reflects where sharp money went.

## VI. Insider's checklist

- Spreads, moneylines and totals: records against the spread, home and away
  form, pace, injuries, referees, trends.
- Player props: is the game expected to be a blowout (starters play less)? A
  high or low total? Who's injured? The opponent's pace and ratings, the
  player's averages and recent form.
- The guide calls Pinnacle and FanDuel sharp books, and DraftKings, bet365 and
  ESPN Bet retail books.

**Applied:** a big spread flags player Overs in that game ("Blowout risk") on
pick cards and game answers. That applies to NBA and WNBA at 10+ points and
NCAAB at 15+ (`BLOWOUT_SPREAD` and `blowoutNote` in `guide.ts`). The odds feed
has no injuries, team or player stats, so the rest of the checklist is yours to
run. The bot's sharp price is Pinnacle plus four exchanges, weighted in
`sharp.ts`. FanDuel is priced as a retail book, since its prices carry its own
margin.

## VII. Profitable parlays: Wong teasers

- Most NFL games are decided by 3 to 7 points, so a 6-point tease that moves a
  line through both 3 and 7 is the one parlay worth making.
- Favorites of -7.5 to -8.5 tease down to -1.5 to -2.5. Underdogs of +1.5 to
  +2.5 tease up to +7.5 to +8.5. Two such legs in a 6-point teaser usually price
  at -110 to -120.

**Applied:** `wongLegs` in `guide.ts` (NFL only, Pinnacle's spread when it posts
one). A game answer notes its Wong leg. Asking for "teasers" lists every Wong leg
on the slate from one spreads-only call. The feed has no teaser prices, so the
bot finds the legs and you check the teaser's price at the book.
