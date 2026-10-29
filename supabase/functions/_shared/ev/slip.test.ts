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
  assert.match(text, /^1\. Carolina Panthers \+3\.5 -125 -> fair .* \(no Pinnacle line; the book's own price, devigged\)$/m);
  assert.match(text, /^2\. Green Bay Packers ML -175 \| Pinnacle Green Bay Packers -165 \/ Carolina Panthers \+150 -> fair/m);
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
