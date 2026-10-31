import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { anchors, cardLegs, consensus, formatBet, MAX_HOLD, sourceWeight, priceLegs, quoteLine, sharpQuotes, type OddsEvent, type Pick } from "./mod.ts";

// Real pull of Panthers @ Packers (Thursday night) with Pinnacle and the four
// exchanges, a few hours before kickoff.
const CAR_GB: OddsEvent = JSON.parse(readFileSync(new URL("./samples/nfl-2026-10-29-car-gb.json", import.meta.url), "utf8"));
const PULLED = new Date("2026-10-29T23:55:00Z");
const leg = (book: string, selection: string) =>
  priceLegs([CAR_GB], book, { now: PULLED }).find((l) => l.selection === selection)!;

test("moneyline: Pinnacle is half the fair price, the exchanges share the rest by hold", () => {
  const packers = leg("betmgm", "Green Bay Packers ML");
  assert.deepEqual(packers.quotes.map((q) => q.source), ["Pinnacle", "Novig", "ProphetX", "Kalshi", "Polymarket"]);
  const [pin, ...ex] = packers.quotes;
  assert.ok(pin.anchor && !ex.some((q) => q.anchor));
  const w = (h: number) => 1 / Math.max(h, 0.01);
  const exMean = ex.reduce((a, q) => a + q.fair * w(q.hold), 0) / ex.reduce((a, q) => a + w(q.hold), 0);
  assert.ok(Math.abs(packers.fair - (0.5 * pin.fair + 0.5 * exMean)) < 1e-12);
  // The exchanges' holds are a fraction of a sportsbook's.
  const kalshi = packers.quotes.find((q) => q.source === "Kalshi")!;
  assert.ok(kalshi.hold > 0 && kalshi.hold < 0.015);
  assert.ok(packers.fair > 0.63 && packers.fair < 0.66);
});

test("only sources on the same line count", () => {
  // BetMGM and Pinnacle hang +4; the exchanges are at +3.5.
  assert.deepEqual(leg("betmgm", "Carolina Panthers +4").quotes.map((q) => q.source), ["Pinnacle"]);
  // DraftKings is at +3.5: priced by the exchanges alone.
  assert.deepEqual(leg("draftkings", "Carolina Panthers +3.5").quotes.map((q) => q.source), ["Novig", "ProphetX", "Kalshi", "Polymarket"]);
  // Polymarket's total is 46.5, everyone else's 47.5.
  assert.ok(!leg("draftkings", "Over 47.5").quotes.some((q) => q.source === "Polymarket"));
});

test("anytime TD: the exchanges price both sides the sportsbooks sell one way", () => {
  const jacobs = leg("betmgm", "Josh Jacobs Anytime TD");
  assert.deepEqual(jacobs.quotes.map((q) => q.source), ["Novig", "ProphetX", "Polymarket"]);
  // ProphetX's ladder: the best Yes and No with $50+ behind them (-132, +115),
  // not the $23 offer at +117 or the $7 one.
  const px = jacobs.quotes.find((q) => q.source === "ProphetX")!;
  assert.deepEqual(px.sides.map((s) => s.odds).sort((a, b) => a - b), [-132, 115]);
  assert.equal(px.sides[px.betIndex].odds, -132);
  // BetMGM's -155 is well short of the ~55% fair price.
  assert.ok(jacobs.fair > 0.54 && jacobs.fair < 0.57);
  assert.ok(jacobs.edge < -0.05);
});

test("thin or crossed exchange offers are ignored", () => {
  // Novig's 74.5 Over has $12 behind it, so only Pinnacle prices McMillan's 74.5.
  assert.deepEqual(leg("betmgm", "Tetairoa McMillan Over 74.5 Reception Yds").quotes.map((q) => q.source), ["Pinnacle"]);
  const novig = CAR_GB.bookmakers.find((b) => b.key === "novig")!.markets.find((m) => m.key === "player_reception_yds")!;
  const at = (point: number, name = "Over") => novig.outcomes.find((o) => o.point === point && o.name === name)!;
  assert.equal(quoteLine("player_reception_yds", novig.outcomes, at(74.5)), null);
  // 75.5 at -120 / -217 adds up to a 23% hold: stale, not a market.
  assert.equal(quoteLine("player_reception_yds", [{ ...at(75.5), bet_limit: 500 }, { ...at(75.5, "Under"), bet_limit: 500 }], at(75.5)), null);
  assert.ok(MAX_HOLD < 0.23);
  // A crossed line (both sides add up to under 100%) is stale too.
  assert.equal(quoteLine("h2h", [{ name: "A", price: 120 }, { name: "B", price: 110 }], { name: "A", price: 120 }), null);
  assert.deepEqual(sharpQuotes(CAR_GB.bookmakers, "player_reception_yds", at(71.5)).map((q) => q.source), ["Novig"]);
});

test("the card lists every source with its hold", () => {
  const legs = [leg("betmgm", "Green Bay Packers ML")];
  const pick = { kind: "single", legs, americanOdds: -200 } as unknown as Pick;
  const { text } = formatBet({ book: "BetMGM", bookOdds: -200, boost: 0.25, legs: cardLegs(pick) });
  assert.match(text, /^DEVIG \(sharp source: Pinnacle, Novig, ProphetX, Kalshi, Polymarket\)$/m);
  // Each leg shows its own price on the book next to the selection.
  assert.match(text, /^1\. Green Bay Packers ML -\d{3} \| Carolina Panthers @ Green Bay Packers, /m);
  assert.match(text, /^Leg 1: Pinnacle -196\/\+171 \(\d\.\d%\), Novig -186\/\+178 \(\d\.\d%\), .* -> fair -1\d\d \(6\d\.\d%\)$/m);
  assert.match(text, /^Method: worst-case of .* per source; Pinnacle is half on game lines/m);
});

test("source weights: tighter holds count more; Pinnacle anchors game lines only", () => {
  assert.equal(sourceWeight(0.02), 50);
  assert.equal(sourceWeight(0.002), 100); // near-crossed lines are floored at 1%
  assert.ok(anchors("pinnacle", "h2h") && anchors("pinnacle", "alternate_spreads"));
  assert.ok(!anchors("pinnacle", "player_reception_yds") && !anchors("novig", "h2h"));
  const q = (fair: number, hold: number, anchor = false) => ({ source: "x", sides: [], betIndex: 0, fair, hold, weight: sourceWeight(hold), anchor });
  // A 2% line outweighs a 6% one three to one.
  assert.ok(Math.abs(consensus([q(0.6, 0.02), q(0.5, 0.06)]) - 0.575) < 1e-12);
  // Pinnacle on a game line is half, however tight the exchanges are.
  assert.ok(Math.abs(consensus([q(0.6, 0.03, true), q(0.5, 0.01), q(0.5, 0.01)]) - 0.55) < 1e-12);
  // Alone, it's the whole price.
  assert.equal(consensus([q(0.6, 0.03, true)]), 0.6);
  // Real prop: Pinnacle's 74.5 has no anchor, it's one source by hold.
  assert.ok(!leg("betmgm", "Tetairoa McMillan Over 74.5 Reception Yds").quotes[0].anchor);
});
