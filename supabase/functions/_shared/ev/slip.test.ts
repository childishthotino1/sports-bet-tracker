import { test } from "node:test";
import assert from "node:assert/strict";
import { example } from "./examples.test-helper.ts";
import {
  checkSlip, findEvent, formatSlipCheck, IMAGE_JSON_SCHEMA, imagePrompt, legEventIds, marketsFor, normalizePromo,
  normalizeSlip, priceLegs, priceSlipLegs, readImageJson, sameTeam, samePerson, suggestSgpLegs, type OddsEvent,
} from "./mod.ts";

// What the vision call should return for the FanDuel slip screenshot:
// SGP, Carolina Panthers @ Green Bay Packers, +990, 3 selections.
const SLIP_JSON = {
  book: null,
  league: "NFL",
  bet_kind: "sgp",
  total_odds: 990,
  game: "Carolina Panthers @ Green Bay Packers",
  legs: [
    { team_or_player: "Carolina Panthers", market: "spreads", line: 3.5, side: "Carolina Panthers" },
    { team_or_player: "Green Bay Packers", market: "h2h", line: null, side: "Green Bay Packers" },
    { team_or_player: "Josh Jacobs", market: "player_anytime_td", line: null, side: "Yes" },
  ],
};

// Sample feed for that game (made-up prices, real shape). FanDuel has the +3.5
// alt line; Pinnacle only the main +3, so that leg falls back to FanDuel's own
// two-way price. FanDuel posts only "Yes" on Jacobs; Pinnacle has both sides.
const GAME: OddsEvent = {
  id: "cargb", sport_key: "americanfootball_nfl", commence_time: "2026-10-30T00:15:00Z",
  home_team: "Green Bay Packers", away_team: "Carolina Panthers",
  bookmakers: [
    { key: "fanduel", title: "FanDuel", markets: [
      { key: "h2h", outcomes: [{ name: "Green Bay Packers", price: -175 }, { name: "Carolina Panthers", price: 150 }] },
      { key: "spreads", outcomes: [{ name: "Green Bay Packers", price: -110, point: -3 }, { name: "Carolina Panthers", price: -110, point: 3 }] },
      { key: "alternate_spreads", outcomes: [
        { name: "Green Bay Packers", price: 105, point: -3.5 }, { name: "Carolina Panthers", price: -125, point: 3.5 },
      ] },
      { key: "player_anytime_td", outcomes: [{ name: "Yes", description: "Josh Jacobs", price: -145 }] },
      { key: "totals", outcomes: [{ name: "Over", price: -110, point: 44.5 }, { name: "Under", price: -110, point: 44.5 }] },
    ] },
    { key: "pinnacle", title: "Pinnacle", markets: [
      { key: "h2h", outcomes: [{ name: "Green Bay Packers", price: -165 }, { name: "Carolina Panthers", price: 150 }] },
      { key: "spreads", outcomes: [{ name: "Green Bay Packers", price: -105, point: -3 }, { name: "Carolina Panthers", price: -105, point: 3 }] },
      { key: "player_anytime_td", outcomes: [
        { name: "Yes", description: "Josh Jacobs", price: -135 }, { name: "No", description: "Josh Jacobs", price: 105 },
      ] },
      { key: "totals", outcomes: [{ name: "Over", price: -112, point: 44.5 }, { name: "Under", price: -104, point: 44.5 }] },
    ] },
  ],
};
const OTHER = { id: "detmin", commence_time: "2026-11-02T18:00:00Z", home_team: "Minnesota Vikings", away_team: "Detroit Lions" };
const NOW = new Date("2026-10-29T03:00:00Z");

const fdSgpBoost = () => normalizePromo(example("Unknown book: 30% Profit Boost on one NFL game (SGP only)"));

test("the vision schema holds promo, slip, or neither", () => {
  assert.deepEqual(IMAGE_JSON_SCHEMA.required, ["kind", "promo", "slip"]);
  assert.match(imagePrompt(""), /fill the matching object/);
  assert.match(imagePrompt(""), /player_anytime_td for "Any Time Touchdown Scorer"/);
  assert.equal(readImageJson({ kind: "other", promo: null, slip: null }).kind, "other");
  assert.equal(readImageJson({ kind: "slip", promo: null, slip: { legs: [] } }).kind, "other", "a slip with no legs isn't usable");
  const r = readImageJson({ kind: "slip", promo: null, slip: SLIP_JSON });
  assert.equal(r.kind, "slip");
});

test("normalizes the slip", () => {
  const slip = normalizeSlip(SLIP_JSON)!;
  assert.equal(slip.bet_kind, "sgp");
  assert.equal(slip.total_odds, 990);
  assert.equal(slip.legs.length, 3);
  assert.equal(normalizeSlip({ ...SLIP_JSON, legs: [{ market: "made_up", side: "Over", line: 1.5, team_or_player: "X" }] })!.legs[0].market, "other");
});

test("matches names the way slips and the feed write them", () => {
  assert.ok(sameTeam("Packers", "Green Bay Packers"));
  assert.ok(sameTeam("GB Packers", "Green Bay Packers"));
  assert.ok(!sameTeam("Green Bay Packers", "Carolina Panthers"));
  assert.ok(samePerson("J. Jacobs", "Josh Jacobs"));
  assert.ok(samePerson("Josh Jacobs Jr.", "Josh Jacobs"));
  assert.ok(!samePerson("Josh Allen", "Josh Jacobs"));
});

test("finds the slip's game and the markets to request", () => {
  const slip = normalizeSlip(SLIP_JSON)!;
  assert.equal(findEvent([OTHER, GAME], [slip.game], NOW)?.id, "cargb");
  assert.deepEqual(legEventIds(slip, [OTHER, GAME], NOW), ["cargb", "cargb", "cargb"]);
  assert.deepEqual(marketsFor(slip), ["spreads", "alternate_spreads", "h2h", "player_anytime_td"]);
  // A promo naming the matchup in its notes points at the same game.
  assert.equal(findEvent([OTHER, GAME], [fdSgpBoost().notes, fdSgpBoost().title], NOW)?.id, "cargb");
});

test("prices each leg: Pinnacle where it has the line, the book's own price where not", () => {
  const slip = normalizeSlip(SLIP_JSON)!;
  const priced = priceSlipLegs(slip, [GAME, GAME, GAME], "fanduel");
  assert.deepEqual(priced.map((l) => [l.label, l.bookOdds, l.source]), [
    ["Carolina Panthers +3.5", -125, "book"], // Pinnacle has only +3
    ["Green Bay Packers ML", -175, "sharp"],
    ["Josh Jacobs Anytime TD", -145, "sharp"],
  ]);
  assert.ok(priced.every((l) => l.fair! > 0 && l.fair! < 1));
});

test("SGP: keeps FanDuel's correlation, swaps in fair leg prices, applies the 30% boost", () => {
  const slip = normalizeSlip(SLIP_JSON)!;
  const priced = priceSlipLegs(slip, [GAME, GAME, GAME], "fanduel");
  const c = checkSlip(slip, priced, fdSgpBoost())!;
  assert.equal(c.method, "correlation");
  assert.deepEqual(c.promoIssues, []);
  assert.equal(c.boost, 0.3);
  // +990 implies 9.2%; FanDuel's legs alone multiply to about 21%, so the SGP
  // price says Panthers +3.5 and Packers ML mostly work against each other.
  assert.ok(c.correlation! > 0.4 && c.correlation! < 0.5);
  const fairIndependent = priced.reduce((p, l) => p * l.fair!, 1);
  assert.ok(Math.abs(c.fairProb - fairIndependent * c.correlation!) < 1e-12);

  const text = formatSlipCheck(slip, "FanDuel", c, fdSgpBoost());
  assert.match(text, /^🧾 SGP on FanDuel: Carolina Panthers @ Green Bay Packers$/m);
  assert.match(text, /^1\. Carolina Panthers \+3\.5 -125 -> fair .* \(no sharp line; the book's own price, devigged\)$/m);
  assert.match(text, /^2\. Green Bay Packers ML -175 \| Pinnacle -165\/\+150 \(\d\.\d%\) -> fair/m);
  assert.match(text, /^Slip: \+990, boosted 30% to \+1287$/m);
  assert.match(text, /work against each other \(×0\.4\d\)/);
  assert.match(text, /^Fair \(est\.\): /m);
  assert.match(text, /^EV: [+-]\d+\.\d%$/m);
});

test("a slip that breaks the promo's rules is priced without the boost", () => {
  const slip = normalizeSlip({ ...SLIP_JSON, legs: SLIP_JSON.legs.slice(0, 2) })!;
  const c = checkSlip(slip, priceSlipLegs(slip, [GAME, GAME], "fanduel"), fdSgpBoost())!;
  assert.deepEqual(c.promoIssues, ["sgp needs 3+ legs, not 2"]);
  assert.equal(c.boost, 0);
  assert.match(formatSlipCheck(slip, "FanDuel", c, fdSgpBoost()), /Doesn't qualify for 30% Profit Boost: sgp needs 3\+ legs, not 2\. Priced without the boost\./);
});

test("a leg the feed doesn't have stops the check and names the leg", () => {
  const slip = normalizeSlip({ ...SLIP_JSON, legs: [...SLIP_JSON.legs, { team_or_player: "Bryce Young", market: "player_pass_yds", line: 199.5, side: "Over" }] })!;
  const priced = priceSlipLegs(slip, [GAME, GAME, GAME, GAME], "fanduel");
  assert.equal(priced[3].source, "none");
  assert.equal(checkSlip(slip, priced, fdSgpBoost()), null);
});

test("suggests one leg per market for an SGP promo, never both sides", () => {
  const legs = priceLegs([GAME], "fanduel", { now: NOW });
  const sg = suggestSgpLegs(legs, 3, "cargb")!;
  assert.equal(sg.game, "Carolina Panthers @ Green Bay Packers");
  // One game-result leg at most: never Panthers ML with Packers -3.
  assert.equal(sg.legs.filter((l) => l.market === "h2h" || l.market === "spreads").length, 1);
  assert.ok(sg.legs.some((l) => l.selection === "Josh Jacobs Anytime TD"));
  assert.equal(suggestSgpLegs(legs, 4, "cargb"), null, "only 3 compatible legs in this sample");
});

// Soccer: 3-way result, both teams to score, anytime goalscorer. Made-up prices.
const MATCH: OddsEvent = {
  id: "arsche", sport_key: "soccer_epl", commence_time: "2026-11-01T15:00:00Z",
  home_team: "Arsenal", away_team: "Chelsea",
  bookmakers: [
    { key: "draftkings", title: "DraftKings", markets: [
      { key: "h2h", outcomes: [{ name: "Arsenal", price: -120 }, { name: "Chelsea", price: 320 }, { name: "Draw", price: 270 }] },
      { key: "btts", outcomes: [{ name: "Yes", price: -140 }, { name: "No", price: 110 }] },
      { key: "player_goal_scorer_anytime", outcomes: [{ name: "Yes", description: "Bukayo Saka", price: 175 }] },
    ] },
    { key: "pinnacle", title: "Pinnacle", markets: [
      { key: "h2h", outcomes: [{ name: "Arsenal", price: -112 }, { name: "Chelsea", price: 330 }, { name: "Draw", price: 285 }] },
      { key: "btts", outcomes: [{ name: "Yes", price: -135 }, { name: "No", price: 118 }] },
    ] },
  ],
};

test("soccer: 3-way results devig across home, draw and away", () => {
  const legs = priceLegs([MATCH], "draftkings", { now: NOW });
  const draw = legs.find((l) => l.selection === "Draw ML")!;
  assert.equal(draw.quotes[0].sides.length, 3);
  const total = legs.filter((l) => l.market === "h2h").reduce((a, l) => a + l.fair, 0);
  assert.ok(total <= 1 + 1e-9, "worst-case fair prices never sum past 100%");
  assert.ok(legs.some((l) => l.selection === "Both Teams To Score: Yes"));
});

test("soccer: a DraftKings SGP slip prices draw, BTTS and a goalscorer", () => {
  const slip = normalizeSlip({
    book: "", league: "EPL", bet_kind: "sgp", total_odds: 1150, game: "Chelsea @ Arsenal",
    legs: [
      { team_or_player: "", market: "h2h", line: null, side: "Draw" },
      { team_or_player: "", market: "btts", line: null, side: "Yes" },
      { team_or_player: "Bukayo Saka", market: "player_goal_scorer_anytime", line: null, side: "Yes" },
    ],
  })!;
  assert.equal(slip.book, null);
  assert.deepEqual(legEventIds(slip, [MATCH], NOW), ["arsche", "arsche", "arsche"]);
  const priced = priceSlipLegs(slip, [MATCH, MATCH, MATCH], "draftkings");
  assert.deepEqual(priced.map((l) => [l.label, l.bookOdds, l.source]), [
    ["Draw ML", 270, "sharp"],
    ["Both Teams To Score: Yes", -140, "sharp"],
    ["Bukayo Saka Anytime Goal", 175, "book-1way"], // no Pinnacle line, DraftKings posts only Yes
  ]);
  const soccer = normalizePromo(example("Unknown book: Soccer 20% SGP(x) Boost"));
  const c = checkSlip(slip, priced, soccer)!;
  assert.deepEqual(c.promoIssues, ["sgp needs 4+ legs, not 3"], "an EPL slip counts as Soccer; only the leg count fails");
});

// The DraftKings EPL slip: a 4-pick parlay with a draw. A draw names no team,
// so it used to match no game ("couldn't find the game for 1 of the legs").
test("a parlay leg is placed by the matchup the slip prints with it", () => {
  const slip = normalizeSlip({
    book: "DraftKings", league: "EPL", bet_kind: "parlay", total_odds: 2662, game: "",
    legs: [
      { team_or_player: "Man City", market: "h2h", line: null, side: "Man City", team: "Manchester City", game: "Man City vs Brighton" },
      { team_or_player: "", market: "h2h", line: null, side: "Draw", team: "", game: "Brentford vs Nottingham Forest" },
      { team_or_player: "Bournemouth", market: "h2h", line: null, side: "Bournemouth", team: "AFC Bournemouth", game: "Bournemouth vs Leeds" },
      { team_or_player: "Aston Villa", market: "h2h", line: null, side: "Aston Villa", team: "Aston Villa", game: "Aston Villa vs Fulham" },
    ],
  })!;
  const at = "2026-10-31T15:00:00Z";
  const events = [
    { id: "mci", home_team: "Manchester City", away_team: "Brighton and Hove Albion", commence_time: at },
    { id: "bre", home_team: "Brentford", away_team: "Nottingham Forest", commence_time: at },
    { id: "bou", home_team: "Bournemouth", away_team: "Leeds United", commence_time: at },
    { id: "avl", home_team: "Aston Villa", away_team: "Fulham", commence_time: "2026-10-31T20:00:00Z" },
    { id: "hul", home_team: "Hull City", away_team: "Ipswich Town", commence_time: at },
  ];
  assert.deepEqual(legEventIds(slip, events, new Date("2026-10-31T14:25:00Z")), ["mci", "bre", "bou", "avl"]);
  // Without the matchup, the draw can't be placed in a parlay.
  const bare = { ...slip, legs: slip.legs.map((l) => ({ ...l, game: null })) };
  assert.deepEqual(legEventIds(bare, events, new Date("2026-10-31T14:25:00Z")), ["mci", null, "bou", "avl"]);
});
