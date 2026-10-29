import { test } from "node:test";
import assert from "node:assert/strict";
import { NFL_30_PARLAY_BOOST } from "./fixtures.ts";
import { americanToDecimal, breakEvenProb, normalizePromo, promoStake, promoViolations } from "./mod.ts";

// What the vision call should return for the BetMGM "MLB World Series 10% SGP
// Boost Token" screenshot (max stake $25, SGP only, min total odds +400, paid
// in cash, live or pre-game, expires 10/29/26 08:07 AM).
const BETMGM_WS_SGP_BOOST = {
  book: "BetMGM",
  title: "MLB World Series 10% SGP Boost Token",
  type: "profit_boost",
  boost_pct: 10,
  max_stake: 25,
  min_total_odds: 400,
  min_legs: null,
  max_legs: null,
  legs_apply_to: [],
  bet_kinds: ["sgp"],
  leagues: ["MLB"],
  live: true,
  pregame: true,
  paid_in: "cash",
  expires_at: "2026-10-29T08:07",
  notes: "World Series games only",
};

test("normalizes the BetMGM World Series SGP boost", () => {
  const promo = normalizePromo(BETMGM_WS_SGP_BOOST);
  assert.deepEqual(promo, BETMGM_WS_SGP_BOOST);
});

test("normalizePromo coerces sloppy model output", () => {
  const promo = normalizePromo({
    book: " BetMGM ", type: "odds_boost", boost_pct: "10", min_total_odds: 4,
    bet_kinds: ["sgp", "teaser"], leagues: ["mlb"], live: null, paid_in: "Cash", notes: "",
  });
  assert.equal(promo.book, "BetMGM");
  assert.equal(promo.title, "BetMGM");
  assert.equal(promo.type, "other");
  assert.equal(promo.boost_pct, null); // a string isn't trusted as a number
  assert.equal(promo.min_total_odds, null); // 4 isn't valid American odds
  assert.deepEqual(promo.bet_kinds, ["sgp"]);
  assert.deepEqual(promo.leagues, ["MLB"]);
  assert.equal(promo.live, true);
  assert.equal(promo.paid_in, null);
  assert.equal(promo.notes, null);
  assert.equal(normalizePromo({ title: "33% boost" }).book, null);
  assert.throws(() => normalizePromo("not json"));
});

test("checks a bet against the SGP boost's rules", () => {
  const promo = normalizePromo(BETMGM_WS_SGP_BOOST);
  assert.deepEqual(promoViolations(promo, { americanOdds: 450, legs: 3, kind: "sgp", league: "MLB", stake: 25 }), []);
  assert.deepEqual(promoViolations(promo, { americanOdds: 400, legs: 2, kind: "sgp" }), [], "exactly +400 qualifies");
  assert.deepEqual(
    promoViolations(promo, { americanOdds: 350, legs: 3, kind: "parlay", league: "NBA", stake: 50 }),
    ["must be sgp, not parlay", "odds +350 below minimum +400", "NBA not eligible (MLB only)", "stake $50 over max $25"],
  );
  // A favorite can never clear a +400 minimum.
  assert.deepEqual(promoViolations(promo, { americanOdds: -120, legs: 2, kind: "sgp" }), ["odds -120 below minimum +400"]);
});

test("a 10% boost at +400 needs the book's hold on the SGP under 8%", () => {
  const p = breakEvenProb(400, 10);
  assert.ok(Math.abs(p - 1 / 5.4) < 1e-12); // +400 boosted 10% pays +440
  const bookImplied = 1 / americanToDecimal(400);
  assert.ok(Math.abs(bookImplied / p - 1 - 0.08) < 1e-12);
});

test("stake is Kelly capped at the promo max", () => {
  const promo = normalizePromo(BETMGM_WS_SGP_BOOST);
  assert.equal(promoStake(promo, 0.02, 4000), 25);
  assert.equal(promoStake(promo, 0.002, 4000), 8);
  assert.equal(promoStake(promo, -0.05, 4000), 0);
  assert.equal(promoStake({ ...promo, max_stake: null }, 0.02, 4000), 80);
});

// Second real screenshot: "33% MLB Same Game Parlay Profit Boost". It never
// names the book (no logo or name on screen), so book must come back null
// rather than the promo being rejected.
const MLB_33_SGP_BOOST = {
  book: null,
  title: "33% MLB Same Game Parlay Profit Boost",
  type: "profit_boost",
  boost_pct: 33,
  max_stake: 50,
  min_total_odds: 300,
  min_legs: null,
  max_legs: null,
  legs_apply_to: [],
  bet_kinds: ["sgp"],
  leagues: ["MLB"],
  live: true,
  pregame: true,
  paid_in: null,
  expires_at: "2026-10-29T03:00",
  notes: null,
};

test("normalizes a promo whose screenshot doesn't show the book", () => {
  const promo = normalizePromo(MLB_33_SGP_BOOST);
  assert.deepEqual(promo, MLB_33_SGP_BOOST);
  assert.deepEqual(promoViolations(promo, { americanOdds: 300, legs: 2, kind: "sgp", league: "MLB", stake: 50 }), []);
  assert.deepEqual(promoViolations(promo, { americanOdds: 280, legs: 2, kind: "sgp", stake: 60 }), [
    "odds +280 below minimum +300",
    "stake $60 over max $50",
  ]);
});

test("a 33% boost at +300 beats a hold of up to 24.75%", () => {
  const p = breakEvenProb(300, 33); // +300 boosted 33% pays +399
  assert.ok(Math.abs(1 / p - 4.99) < 1e-12);
  assert.ok(Math.abs((1 / americanToDecimal(300)) / p - 1 - 0.2475) < 1e-12);
});

test("leg limits only cover the bet kinds they name", () => {
  const promo = normalizePromo(NFL_30_PARLAY_BOOST);
  assert.deepEqual(promo, NFL_30_PARLAY_BOOST);
  assert.deepEqual(promoViolations(promo, { americanOdds: 350, legs: 2, kind: "sgp", league: "NFL" }), []);
  assert.deepEqual(promoViolations(promo, { americanOdds: 600, legs: 3, kind: "parlay" }), ["parlay needs 4-25 legs, not 3"]);
  assert.deepEqual(promoViolations(promo, { americanOdds: 600, legs: 26, kind: "parlay" }), ["parlay needs 4-25 legs, not 26"]);
  assert.deepEqual(promoViolations(promo, { americanOdds: 1200, legs: 4, kind: "parlay" }), []);
  // Limits with no legs_apply_to cover every kind.
  assert.deepEqual(promoViolations({ ...promo, legs_apply_to: [] }, { legs: 2, kind: "sgp" }), ["sgp needs 4-25 legs, not 2"]);
});
