# Promo examples

Real promo screenshots and how to read them. The promo bot sends this whole
file to Claude along with every new promo screenshot, so new ones are read the
same way. To teach it a new kind of promo, add a section: what the screenshot
shows, the gotcha if there is one, and the JSON it should produce. The tests
check that every JSON block here is a valid promo.

## BetMGM: MLB World Series 10% SGP Boost Token

Shows: BetMGM logo, "MLB® World Series™ 10% SGP Boost Token", expires
10/29/26 08:07 AM, max stake $25, "Receive a 10% boost increase paid in Cash",
league MLB, live and pre-game, valid bets Same Game Parlay, minimum total odds
+400.

Gotcha: a "boost token" is a profit boost. "Paid in Cash" is `paid_in: "cash"`.
The World Series limit isn't a league, so it goes in `notes`.

```json
{
  "book": "BetMGM",
  "title": "MLB World Series 10% SGP Boost Token",
  "type": "profit_boost",
  "boost_pct": 10,
  "max_stake": 25,
  "min_total_odds": 400,
  "min_legs": null,
  "max_legs": null,
  "legs_apply_to": [],
  "bet_kinds": ["sgp"],
  "leagues": ["MLB"],
  "live": true,
  "pregame": true,
  "paid_in": "cash",
  "expires_at": "2026-10-29T08:07",
  "notes": "World Series games only"
}
```

## Unknown book: 33% MLB Same Game Parlay Profit Boost

Shows: MLB logo, "33% MLB Same Game Parlay Profit Boost", "6h left", expires
10/29/2026 3:00 AM EDT, eligible events All MLB Games, eligible bet types Same
Game Parlay, minimum odds +300, max wager $50.

Gotcha: no book name or logo anywhere, so `book` is null; the bot asks. Don't
guess the book from the colors or layout. Nothing says how winnings are paid,
so `paid_in` is null. Live and pre-game aren't mentioned, so both are true.

```json
{
  "book": null,
  "title": "33% MLB Same Game Parlay Profit Boost",
  "type": "profit_boost",
  "boost_pct": 33,
  "max_stake": 50,
  "min_total_odds": 300,
  "min_legs": null,
  "max_legs": null,
  "legs_apply_to": [],
  "bet_kinds": ["sgp"],
  "leagues": ["MLB"],
  "live": true,
  "pregame": true,
  "paid_in": null,
  "expires_at": "2026-10-29T03:00",
  "notes": null
}
```

## Unknown book: 30% NFL Parlay Profit Boost

Shows: football icon, "30% NFL Parlay Profit Boost", "12h left", expires
10/29/2026 9:29 AM EDT, eligible events All NFL Games, eligible bet types Same
Game Parlay / Super Parlays / 4-25 Leg Parlays, minimum odds +300, max wager
$25.

Gotcha: the 4-25 leg limit covers regular parlays only, so `legs_apply_to` is
`["parlay"]`; a 2-leg SGP still qualifies. "Super Parlays" isn't one of the
bet kinds, so it goes in `notes`.

```json
{
  "book": null,
  "title": "30% NFL Parlay Profit Boost",
  "type": "profit_boost",
  "boost_pct": 30,
  "max_stake": 25,
  "min_total_odds": 300,
  "min_legs": 4,
  "max_legs": 25,
  "legs_apply_to": ["parlay"],
  "bet_kinds": ["sgp", "parlay"],
  "leagues": ["NFL"],
  "live": true,
  "pregame": true,
  "paid_in": null,
  "expires_at": "2026-10-29T09:29",
  "notes": "Super Parlays also qualify"
}
```

## BetMGM: NBA 10% Parlay Boost Token (cut-off screenshot)

Shows: "NBA 10% Parlay Boost Token", "Odds Boost", expires 10/29/26 09:52 AM,
"Choose your NBA parlay bet with a max stake of $25", "Receive a 10% boost
increase paid in Cash", applicable sport Basketball, league NBA, and a last
line cut off mid-word: "Bet on: Pre-Game, Live". Buttons "View Full Details"
and "Bet Now" cover the rest.

Gotcha: the screenshot is cut off, so rules below it (minimum odds, whether
SGPs count) aren't visible: leave them null and say so in `notes`, rather than
reading "no minimum". No book name or logo is on screen; the user said BetMGM
(the "boost token paid in Cash" layout matches BetMGM's other tokens).

```json
{
  "book": "BetMGM",
  "title": "NBA 10% Parlay Boost Token",
  "type": "profit_boost",
  "boost_pct": 10,
  "max_stake": 25,
  "min_total_odds": null,
  "min_legs": null,
  "max_legs": null,
  "legs_apply_to": [],
  "bet_kinds": ["parlay"],
  "leagues": ["NBA"],
  "live": true,
  "pregame": true,
  "paid_in": "cash",
  "expires_at": "2026-10-29T09:52",
  "notes": "Screenshot cut off below 'Bet on'; other rules (min odds, SGP) not visible"
}
```
