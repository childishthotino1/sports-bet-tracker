// node:test runs under both Node (22.6+, TS type stripping) and Deno.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  additive,
  americanToDecimal,
  boostDecimal,
  correlatedLegs,
  decimalToAmerican,
  devig,
  DEVIG_METHODS,
  evaluateBet,
  formatAmerican,
  formatBet,
  impliedProb,
  multiplicative,
  power,
  probToAmerican,
  shin,
  worstCaseDevig,
  wagerLine,
} from "./mod.ts";

const close = (actual: number, expected: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ""} expected ${expected} ±${tol}, got ${actual}`);

test("odds conversions round-trip", () => {
  assert.equal(americanToDecimal(100), 2);
  assert.equal(americanToDecimal(-200), 1.5);
  close(americanToDecimal(233), 3.33, 1e-12);
  for (const a of [-450, -135, -108, 105, 233, 1200]) close(decimalToAmerican(americanToDecimal(a)), a, 1e-9);
  close(impliedProb(-135), 135 / 235, 1e-12);
  assert.equal(formatAmerican(probToAmerican(135 / 235)), "-135");
  assert.equal(formatAmerican(349.5), "+350");
  assert.throws(() => americanToDecimal(50));
});

test("every devig method returns probabilities summing to 1", () => {
  const q = [-150, 122].map(impliedProb);
  for (const m of DEVIG_METHODS) {
    const p = devig(q, m);
    close(p[0] + p[1], 1, 1e-9, m);
    assert.ok(p[0] > p[1], `${m} keeps the favorite the favorite`);
  }
  const q3 = [150, 220, 260].map(impliedProb); // three-way market
  for (const m of DEVIG_METHODS) close(devig(q3, m).reduce((a, b) => a + b, 0), 1, 1e-9, m);
});

test("devig methods match hand-computed values", () => {
  // -110 / -110: every method gives 50/50.
  const even = [-110, -110].map(impliedProb);
  for (const m of DEVIG_METHODS) close(devig(even, m)[0], 0.5, 1e-9, m);

  const q = [0.6, 0.45]; // overround 5%
  close(multiplicative(q)[0], 0.6 / 1.05, 1e-12);
  close(additive(q)[0], 0.575, 1e-12);
  const p = power(q);
  close(p[0] + p[1], 1, 1e-9);
  close(Math.log(p[0]) / Math.log(0.6), Math.log(p[1]) / Math.log(0.45), 1e-9, "single exponent k");
  // Power and Shin both shift vig toward the longshot, so they credit the
  // favorite more than multiplicative does.
  assert.ok(p[0] > multiplicative(q)[0]);
  assert.ok(shin(q)[0] > multiplicative(q)[0]);
});

test("worst-case devig keeps the lowest fair probability for the bet side", () => {
  const over = worstCaseDevig([-150, 122], 0);
  const under = worstCaseDevig([-150, 122], 1);
  assert.equal(over.fair, Math.min(...Object.values(over.byMethod)));
  assert.equal(under.fair, Math.min(...Object.values(under.byMethod)));
  assert.equal(over.byMethod[over.method], over.fair);
});

test("boost formula", () => {
  close(boostDecimal(americanToDecimal(233), 0.5), 4.495, 1e-12);
  assert.equal(formatAmerican(decimalToAmerican(4.495)), "+350");
  assert.equal(boostDecimal(3, 0), 3);
});

test("same-game legs are flagged", () => {
  assert.deepEqual(correlatedLegs(["DET @ NYK", "POR @ LAL"]), []);
  assert.deepEqual(correlatedLegs(["DET @ NYK", "POR @ LAL", "DET @ NYK", undefined]), [0, 2]);
});

// Worked example from the handoff brief (DK 50% NBA profit boost, matches the
// Crazy Ninja Odds calculator): fair legs -135 and -108, DK +233 boosted 50%.
test("worked example: DK 50% boost on Collins o6.5 Reb + Morant o15.5 Pts", () => {
  const legs = [probToAmerican(135 / 235), probToAmerican(108 / 208)].map(impliedProb);
  close(legs[0], 0.5745, 5e-5);
  close(legs[1], 0.5192, 5e-5);

  const ev = evaluateBet(legs, [233], 0.5);
  close(ev.fairProb, 0.2983, 5e-5, "parlay p");
  assert.equal(formatAmerican(probToAmerican(ev.fairProb)), "+235");
  assert.equal(formatAmerican(decimalToAmerican(ev.boostedDecimal)), "+350");
  close(ev.ev, 0.341, 0.002, "EV (CNO 34.1%)");
  close(ev.kelly * 100, 9.75, 0.03, "full Kelly units");
  close(ev.freeBet, 1.042, 0.002, "FB (CNO 104.2%)");
  // -EV bets size to zero.
  assert.equal(evaluateBet(legs, [150], 0).kelly, 0);
});

test("worked example renders in the brief's output format", () => {
  const { text, correlated } = formatBet({
    title: "DK 50% NBA Profit Boost",
    book: "DraftKings",
    bookOdds: 233,
    boost: 0.5,
    legs: [
      { selection: "John Collins Over 6.5 Rebounds (7+)", game: "DET @ NYK", start: "8:10 PM", fairProb: 135 / 235 },
      { selection: "Ja Morant Over 15.5 Points (16+)", game: "POR @ LAL", start: "11:10 PM", fairProb: 108 / 208 },
    ],
  });
  assert.deepEqual(correlated, []);
  assert.equal(
    text,
    [
      "@DK 50% NBA Profit Boost",
      "",
      "BET TO BUILD: 2-leg parlay on DraftKings",
      "1. John Collins Over 6.5 Rebounds (7+) | DET @ NYK, 8:10 PM",
      "2. Ja Morant Over 15.5 Points (16+) | POR @ LAL, 11:10 PM",
      "Book odds: +233, boosted to +350",
      "",
      "DEVIG",
      "Leg 1: fair -135 (57.4%)",
      "Leg 2: fair -108 (51.9%)",
      "Parlay fair: 29.8% -> FV +235",
      "",
      "EV: +34.1%",
      "Kelly: Full 9.75u | 1/2 4.88u | 1/4 2.44u (1u = 1% bankroll)",
      "FB: 104.2%",
      "Wager (¼ Kelly): $500 bank: $12 · $1K bank: $24 · $5K bank: $122 · $10K bank: $244",
    ].join("\n"),
  );
});

test("card with raw sharp odds shows the devig lines and flags same-game legs", () => {
  const { text, correlated } = formatBet({
    book: "DraftKings",
    bookOdds: 260,
    boost: 0.25,
    sharpSource: "Pinnacle",
    legs: [
      { selection: "A Over 6.5", game: "DET @ NYK", sharp: { sides: [{ label: "Over", odds: -150 }, { label: "Under", odds: 122 }] } },
      { selection: "B Under 20.5", game: "DET @ NYK", sharp: { sides: [{ label: "Over", odds: -118 }, { label: "Under", odds: -102 }], betIndex: 1 } },
    ],
  });
  assert.deepEqual(correlated, [0, 1]);
  assert.match(text, /^DEVIG \(sharp source: Pinnacle\)$/m);
  assert.match(text, /^Leg 1: Over -150 \/ Under \+122 -> fair -1\d\d \(5\d\.\d%\)$/m);
  assert.match(text, /^Method: worst-case of multiplicative, additive, power, Shin$/m);
  assert.match(text, /Legs 1, 2 share a game/);
});

test("suggested wagers cover four bankrolls and stop at the promo's max", () => {
  assert.equal(wagerLine(0.0975, 50), "Wager (¼ Kelly, max $50): $500 bank: $12 · $1K bank: $24 · $5K bank: $50 · $10K bank: $50");
  assert.equal(wagerLine(0.004), "Wager (¼ Kelly): $500 bank: <$1 · $1K bank: $1 · $5K bank: $5 · $10K bank: $10");
  assert.equal(wagerLine(0.001), "Wager (¼ Kelly): $500 bank: <$1 · $1K bank: <$1 · $5K bank: $1.5 · $10K bank: $2.5");
  assert.equal(wagerLine(0), null, "no stake on a -EV bet");
});
