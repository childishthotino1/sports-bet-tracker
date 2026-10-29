import { test } from "node:test";
import assert from "node:assert/strict";
import { example, EXAMPLES } from "./examples.test-helper.ts";
import { readFileSync } from "node:fs";
import { PROMO_EXAMPLES_MD } from "./promo-examples.ts";
import { americanToDecimal, breakEvenProb, IMAGE_JSON_SCHEMA, normalizePromo, PROMO_JSON_SCHEMA, promoPrompt, promoStake, promoViolations } from "./mod.ts";

const BETMGM_WS_SGP_BOOST = example("BetMGM: MLB World Series 10% SGP Boost Token");
const MLB_33_SGP_BOOST = example("Unknown book: 33% MLB Same Game Parlay Profit Boost");
const NFL_30_PARLAY_BOOST = example("Unknown book: 30% NFL Parlay Profit Boost");

test("every example in promo-examples.md is a promo that reads back unchanged", () => {
  assert.ok(EXAMPLES.length >= 3);
  for (const { title, json } of EXAMPLES) assert.deepEqual(normalizePromo(json), json, title);
});

test("the vision prompt carries the examples", () => {
  const p = promoPrompt("## X\n```json\n{}\n```");
  assert.match(p, /Promos already read correctly/);
  assert.match(p, /## X/);
  assert.doesNotMatch(promoPrompt("  "), /already read/);
});

// What the vision call should return for the BetMGM "MLB World Series 10% SGP
// Boost Token" screenshot (max stake $25, SGP only, min total odds +400, paid
// in cash, live or pre-game, expires 10/29/26 08:07 AM).

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

test("promo-examples.ts is regenerated from promo-examples.md", () => {
  const md = readFileSync(new URL("./promo-examples.md", import.meta.url), "utf8");
  assert.equal(PROMO_EXAMPLES_MD, md, "run: node supabase/functions/_shared/ev/gen-examples.mjs");
});

// The API rejected "Enum value 'cash' does not match declared type ['string', 'null']":
// with type as a list, enum values must not mix in null. Check every enum's values
// fit a single declared type.
test("the vision schema's enums match their declared types", () => {
  const typeOf = (v: unknown) => (v === null ? "null" : typeof v);
  for (const [name, prop] of Object.entries(PROMO_JSON_SCHEMA.properties) as [string, any][]) {
    const branches = prop.anyOf ?? [prop];
    for (const b of branches) {
      if (!b.enum) continue;
      assert.equal(typeof b.type, "string", `${name}: enum needs a single type`);
      for (const v of b.enum) assert.equal(typeOf(v), b.type, `${name}: ${v}`);
    }
    if (prop.items?.enum) for (const v of prop.items.enum) assert.equal(typeOf(v), prop.items.type, name);
  }
});

// The API caps structured-output schemas at 16 union-typed parameters (type
// lists like ["string", "null"], or anyOf); the combined promo + slip schema
// hit 17. Count them across everything the vision call sends.
test("the vision schema stays under the API's union-type limit", () => {
  let unions = 0;
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.type) || node.anyOf) unions++;
    for (const v of Object.values(node)) walk(v);
  };
  walk(IMAGE_JSON_SCHEMA);
  assert.ok(unions <= 16, `${unions} union-typed parameters`);
});

test("the vision call's 0 and \"\" placeholders read back as unknown", () => {
  const p = normalizePromo({ book: "", title: "X", type: "profit_boost", boost_pct: 0, max_stake: 0, min_total_odds: 0,
    min_legs: 0, max_legs: 0, legs_apply_to: [], bet_kinds: [], leagues: [], live: true, pregame: true, paid_in: "unknown",
    expires_at: "", notes: "" });
  assert.deepEqual([p.book, p.boost_pct, p.max_stake, p.min_total_odds, p.min_legs, p.max_legs, p.paid_in, p.expires_at, p.notes],
    [null, null, null, null, null, null, null, null, null]);
});

test("a Soccer promo covers each soccer league", () => {
  const soccer = normalizePromo(example("Unknown book: Soccer 20% SGP(x) Boost"));
  assert.deepEqual(promoViolations(soccer, { americanOdds: 600, legs: 4, kind: "sgp", league: "EPL" }), []);
  assert.deepEqual(promoViolations(soccer, { americanOdds: 600, legs: 4, kind: "sgp", league: "NBA" }), ["NBA not eligible (SOCCER only)"]);
});
