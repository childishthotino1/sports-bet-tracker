// EV, Kelly, and free-bet value for a boosted single or parlay.

import { americanToDecimal } from "./odds.ts";

// Profit boost on unboosted decimal odds D: D_boost = 1 + (1 + b)(D − 1).
// b is a fraction (50% boost → 0.5).
export function boostDecimal(decimal: number, boost: number): number {
  return 1 + (1 + boost) * (decimal - 1);
}

// Fair probability of an all-legs-win parlay, assuming independent legs.
// Callers should flag same-game legs (see correlatedLegs) rather than trust it.
export function parlayProb(legProbs: number[]): number {
  return legProbs.reduce((a, b) => a * b, 1);
}

// Indices of legs that share a game with another leg.
export function correlatedLegs(games: (string | undefined)[]): number[] {
  const counts = new Map<string, number>();
  for (const g of games) if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
  return games.flatMap((g, i) => (g && counts.get(g)! > 1 ? [i] : []));
}

export function expectedValue(p: number, decimal: number): number {
  return p * decimal - 1;
}

// Full Kelly as a fraction of bankroll, floored at 0 for -EV bets.
export function kelly(p: number, decimal: number): number {
  const b = decimal - 1;
  return Math.max(0, (b * p - (1 - p)) / b);
}

// Free-bet conversion: a free bet returns only the profit, so its value per $1
// of free bet is p × (D − 1).
export function freeBetValue(p: number, decimal: number): number {
  return p * (decimal - 1);
}

export type BetEval = {
  fairProb: number;
  bookDecimal: number; // unboosted, all legs multiplied
  boostedDecimal: number;
  ev: number;
  kelly: number; // full Kelly, fraction of bankroll
  freeBet: number;
};

// legProbs: fair probability per leg. legOdds: the book's American price per
// leg, or a single entry with the combined parlay price when the book prices
// it as one (as DK's +233 does). boost: fraction, 0 for none.
export function evaluateBet(legProbs: number[], legOdds: number[], boost = 0): BetEval {
  const fairProb = parlayProb(legProbs);
  const bookDecimal = legOdds.map(americanToDecimal).reduce((a, b) => a * b, 1);
  const boostedDecimal = boostDecimal(bookDecimal, boost);
  return {
    fairProb,
    bookDecimal,
    boostedDecimal,
    ev: expectedValue(fairProb, boostedDecimal),
    kelly: kelly(fairProb, boostedDecimal),
    freeBet: freeBetValue(fairProb, boostedDecimal),
  };
}
