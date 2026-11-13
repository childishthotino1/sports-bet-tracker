import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveAlt, normCdf, normInv, priceLegs, type OddsEvent } from "./mod.ts";

test("normal CDF and its inverse", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-9);
  assert.ok(Math.abs(normCdf(1.959964) - 0.975) < 1e-6);
  for (const p of [0.01, 0.2, 0.5, 0.73, 0.999]) assert.ok(Math.abs(normCdf(normInv(p)) - p) < 1e-6, String(p));
});

const game = (sport: string, book: OddsEvent["bookmakers"][number]["markets"], pin: OddsEvent["bookmakers"][number]["markets"]): OddsEvent => ({
  id: "g", sport_key: sport, commence_time: "2026-11-09T18:00:00Z", home_team: "Baltimore Ravens", away_team: "Cleveland Browns",
  bookmakers: [{ key: "fanduel", title: "FanDuel", markets: book }, { key: "pinnacle", title: "Pinnacle", markets: pin }],
});

test("ladder: the book's own move across a key number, applied to the sharp price", () => {
  // Pinnacle: Ravens -3 at -105/-105 (50%). FanDuel's ladder: -3 at -110/-110,
  // -2.5 at -140/+118: crossing 3 is worth a lot more than the normal model says.
  const e = game("americanfootball_nfl", [
    { key: "spreads", outcomes: [{ name: "Baltimore Ravens", point: -3, price: -110 }, { name: "Cleveland Browns", point: 3, price: -110 }] },
    { key: "alternate_spreads", outcomes: [{ name: "Baltimore Ravens", point: -2.5, price: -140 }, { name: "Cleveland Browns", point: 2.5, price: 118 }] },
  ], [
    { key: "spreads", outcomes: [{ name: "Baltimore Ravens", point: -3, price: -105 }, { name: "Cleveland Browns", point: 3, price: -105 }] },
  ]);
  const d = deriveAlt(e.bookmakers, e.sport_key, "alternate_spreads", { name: "Baltimore Ravens", point: -2.5 }, "fanduel", ["pinnacle"])!;
  assert.equal(d.method, "ladder");
  assert.equal(d.from, -3);
  // Same z move as FanDuel's own: its -3 is 50% fair, its -2.5 about 56.5%.
  assert.ok(d.fair > 0.55 && d.fair < 0.58, String(d.fair));
  // The Browns at +2.5 move the other way.
  const dog = deriveAlt(e.bookmakers, e.sport_key, "alternate_spreads", { name: "Cleveland Browns", point: 2.5 }, "fanduel", ["pinnacle"])!;
  assert.ok(Math.abs(d.fair + dog.fair - 1) < 0.02);
  // Football spreads have no normal model: no ladder, no price.
  assert.equal(deriveAlt(e.bookmakers, e.sport_key, "alternate_spreads", { name: "Baltimore Ravens", point: -2.5 }, null, ["pinnacle"]), null);
});

test("normal model: basketball, and football totals, half-point numbers only", () => {
  const e = game("basketball_nba", [
    { key: "alternate_totals_h1", outcomes: [{ name: "Over", point: 110.5, price: 150 }] },
  ], [
    { key: "totals_h1", outcomes: [{ name: "Over", point: 115.5, price: -105 }, { name: "Under", point: 115.5, price: -105 }] },
  ]);
  const d = deriveAlt(e.bookmakers, e.sport_key, "alternate_totals_h1", { name: "Over", point: 110.5 }, "fanduel", ["pinnacle"])!;
  assert.equal(d.method, "normal");
  // 5 points lower with a half's SD of 18 × 0.7 = 12.6: z +0.397.
  assert.ok(Math.abs(d.fair - normCdf(5 / 12.6)) < 1e-6, String(d.fair));
  const under = deriveAlt(e.bookmakers, e.sport_key, "alternate_totals_h1", { name: "Under", point: 110.5 }, null, ["pinnacle"])!;
  assert.ok(Math.abs(under.fair - (1 - d.fair)) < 1e-9);
  assert.equal(deriveAlt(e.bookmakers, e.sport_key, "alternate_totals_h1", { name: "Over", point: 111 }, null, ["pinnacle"]), null, "a whole number can push");
  assert.equal(deriveAlt(e.bookmakers, e.sport_key, "alternate_totals_h1", { name: "Over", point: 100.5 }, null, ["pinnacle"]), null, "too far from the sharp number");
  // A pick from it: FanDuel's 1st-half alternate Over at +150 vs fair ~65%.
  const [leg] = priceLegs([e], "fanduel", { now: new Date("2026-11-08T00:00:00Z") });
  assert.equal(leg.selection, "1st Half Over 110.5");
  assert.ok(leg.edge > 0.5);
  assert.equal(leg.derived, "derived from the sharp 115.5, normal model");
});
