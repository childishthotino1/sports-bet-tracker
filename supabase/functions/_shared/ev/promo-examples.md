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

## BetMGM: NBA 10% Parlay Boost Token (full rules)

Shows: the same token scrolled down: "Choose your NBA parlay bet with a max
stake of $25", "Receive a 10% boost increase paid in Cash", applicable sport
Basketball, league NBA, bet on Pre-Game, Live, valid bets Parlay, Same Game
Parlay, minimum legs 3, minimum total odds +400.

Gotcha: "Minimum legs: 3" covers both parlays and SGPs, so `legs_apply_to` is
empty. The expiry isn't on this part of the screen; the earlier screenshot of
the same token showed 10/29/26 09:52 AM, so `expires_at` is null here.

```json
{
  "book": "BetMGM",
  "title": "NBA 10% Parlay Boost Token",
  "type": "profit_boost",
  "boost_pct": 10,
  "max_stake": 25,
  "min_total_odds": 400,
  "min_legs": 3,
  "max_legs": null,
  "legs_apply_to": [],
  "bet_kinds": ["parlay", "sgp"],
  "leagues": ["NBA"],
  "live": true,
  "pregame": true,
  "paid_in": "cash",
  "expires_at": null,
  "notes": null
}
```

## Unknown book: 25% Profit Boost (any event, any bet)

Shows: "25% Profit Boost", lightning-bolt icon, Exp 11/02/2026, "Any event",
"Any bet type", "Pre-game or Live bets", "No Min | $25 Max Wager", "-200 Min |
+200000 Max Odds", and a "Find bet" button.

Gotcha: "Any event" and "Any bet type" mean no limits, so `leagues` and
`bet_kinds` are empty (the bot asks which sport to search). "-200 Min" is a
minimum *odds* of -200, so `min_total_odds` is -200; "No Min" is about the
wager. The +200000 maximum doesn't limit any real bet, so it's left out. Only a date is
shown for the expiry, so `expires_at` has no time. No book name or logo is shown.

```json
{
  "book": null,
  "title": "25% Profit Boost",
  "type": "profit_boost",
  "boost_pct": 25,
  "max_stake": 25,
  "min_total_odds": -200,
  "min_legs": null,
  "max_legs": null,
  "legs_apply_to": [],
  "bet_kinds": [],
  "leagues": [],
  "live": true,
  "pregame": true,
  "paid_in": null,
  "expires_at": "2026-11-02",
  "notes": null
}
```

## Unknown book: 30% Profit Boost on one NFL game (SGP only)

Shows: "Reward Restrictions", "30% Profit Boost", Exp 10/30/2026, "Carolina
Panthers @ Green Bay Packers", "3+ leg SGP/SGP+", "Pre-game or Live bets", "No
Min | $10 Max Wager", "+100 Min | +200000 Max Odds", and a "Go to event" button.

Gotcha: the promo is for one game, so the matchup goes in `notes` and the league
comes from the teams (NFL). "SGP+" is still a same-game parlay, so `bet_kinds` is
`["sgp"]` with `min_legs` 3. "+100 Min" is the minimum odds; "No Min" is the
wager. No book name or logo is on screen.

```json
{
  "book": null,
  "title": "30% Profit Boost",
  "type": "profit_boost",
  "boost_pct": 30,
  "max_stake": 10,
  "min_total_odds": 100,
  "min_legs": 3,
  "max_legs": null,
  "legs_apply_to": [],
  "bet_kinds": ["sgp"],
  "leagues": ["NFL"],
  "live": true,
  "pregame": true,
  "paid_in": null,
  "expires_at": "2026-10-30",
  "notes": "Carolina Panthers @ Green Bay Packers only; SGP+ also qualifies"
}
```

## Unknown book: Soccer 20% SGP(x) Boost

Shows: "SOCCER" banner, "Reward Claimed", "ID: 425172", "Expires 5h", "Soccer
20% SGP(x) Boost", tiles "$100 Max Bet", "+400 Min. Odds", "4 Min. Legs", a
"Soccer" tag, and "Eligible Bet Types: SGP, SGPx".

Gotcha: the rules sit in tiles, not a list: "Max Bet" is `max_stake`, "Min.
Odds" is `min_total_odds`, "Min. Legs" is `min_legs`. "SGPx" (same-game parlays
across several games) is still SGP-style pricing, so `bet_kinds` is `["sgp"]`
and SGPx goes in `notes`. Soccer has no single league here, so `leagues` is
`["SOCCER"]`. "Expires 5h" is relative, so `expires_at` is null.

```json
{
  "book": null,
  "title": "Soccer 20% SGP(x) Boost",
  "type": "profit_boost",
  "boost_pct": 20,
  "max_stake": 100,
  "min_total_odds": 400,
  "min_legs": 4,
  "max_legs": null,
  "legs_apply_to": [],
  "bet_kinds": ["sgp"],
  "leagues": ["SOCCER"],
  "live": true,
  "pregame": true,
  "paid_in": null,
  "expires_at": null,
  "notes": "SGPx (multi-game same-game parlays) also qualifies"
}
```
