// Fair prices for alternate spreads and totals that no sharp source posts,
// worked out from the sharp line at the nearest number (the way Crazy Ninja
// Odds prices alternates): Pinnacle and the exchanges post main lines, the
// books sell whole ladders around them.
//
// Two ways, best first:
// - ladder: the book's own two-way ladder says how much the chance moves from
//   the sharp number to the alternate (it knows the key numbers, 3 and 7 in
//   football). That move, in probit (z) units, is applied to the sharp fair
//   price at the sharp number.
// - normal: with no two-way ladder, the final margin or total is taken as
//   normal around the sharp line, with a standard deviation per sport. Only
//   where scores are smooth enough for that: basketball, and football totals
//   (football margins cluster on 3 and 7, so football spreads need the ladder).
//
// Either way it's a model, so it's capped at MAX_SHIFT standard deviations
// from the sharp number, and cards say the price was derived.

import { consensus, marketFamily, sharpQuotes, type Quote } from "./sharp.ts";
import type { Bookmaker, Outcome } from "./odds-api.ts";

// Standard deviation of the final margin and the game total, full game. A half
// is about 0.7 of the game (√½: half the scoring, independent halves).
const SD: Record<string, { spreads?: number; totals: number }> = {
  basketball_nba: { spreads: 12.5, totals: 18 },
  basketball_wnba: { spreads: 11, totals: 15 },
  basketball_ncaab: { spreads: 11, totals: 15 },
  americanfootball_nfl: { totals: 13.5 },
  americanfootball_ncaaf: { totals: 17 },
};
const HALF_SD = 0.7;
// How far from the sharp number a derived price goes, in standard deviations
// (NFL totals: about 7 points either way). For the ladder, the same distance
// in points with football's spread SD (13.5) when the sport has none listed.
export const MAX_SHIFT = 0.5;
const LADDER_SD = 13.5;

const DERIVABLE = ["spreads", "totals", "spreads_h1", "totals_h1"];

export type Derived = {
  fair: number;
  quotes: Quote[]; // the sharp sources at the sharp number
  from: number; // the sharp number it was derived from (the bet side's point)
  method: "ladder" | "normal";
};

// Standard normal CDF (Abramowitz-Stegun 7.1.26 erf, |error| < 1.5e-7).
export function normCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

// Its inverse (Acklam's rational approximation, relative error < 1.2e-9).
export function normInv(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const q = Math.min(Math.max(p, 1e-12), 1 - 1e-12);
  if (q < 0.02425) {
    const r = Math.sqrt(-2 * Math.log(q));
    return (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1);
  }
  if (q > 1 - 0.02425) return -normInv(1 - q);
  const r = q - 0.5, s = r * r;
  return (((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r / (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1);
}

// How many points the bet's side "gains" moving from one number to another:
// a spread side is better with a bigger point (+7.5 beats +6.5), an Over with
// a smaller one, an Under with a bigger one.
function gain(market: string, side: string, from: number, to: number): number {
  return market.includes("spreads") || side.toLowerCase() === "under" ? to - from : from - to;
}

// The fair chance of an alternate line from the sharp line nearest it.
// bookKey null: a book the feed doesn't carry, so only the normal model.
export function deriveAlt(
  bookmakers: Bookmaker[], sportKey: string, market: string, bet: Pick<Outcome, "name" | "point" | "description">,
  bookKey: string | null, sharps: string[],
): Derived | null {
  const base = market.replace(/^alternate_/, "");
  if (!DERIVABLE.includes(base) || bet.point === undefined || bet.point === null) return null;
  const half = base.endsWith("_h1");
  const sd = SD[sportKey]?.[base.startsWith("spreads") ? "spreads" : "totals"];
  const scale = (sd ?? LADDER_SD) * (half ? HALF_SD : 1);
  const family = marketFamily(market);
  const outcome = (point: number): Outcome => ({ name: bet.name, point, price: 0, ...(bet.description ? { description: bet.description } : {}) });

  // The sharp numbers for this side, nearest first.
  const points = new Set<number>();
  for (const bm of bookmakers) {
    if (!sharps.includes(bm.key)) continue;
    for (const m of bm.markets) {
      if (!family.includes(m.key)) continue;
      for (const o of m.outcomes) if (o.name === bet.name && (o.description ?? "") === (bet.description ?? "") && o.point !== undefined) points.add(o.point);
    }
  }
  const near = [...points].filter((p) => p !== bet.point && Math.abs(p - bet.point!) <= MAX_SHIFT * scale)
    .sort((a, b) => Math.abs(a - bet.point!) - Math.abs(b - bet.point!));

  // The book's own two-way price at a number, devigged.
  const bookFair = (point: number): number | null =>
    bookKey ? sharpQuotes(bookmakers, market, outcome(point), [bookKey])[0]?.fair ?? null : null;

  for (const from of near) {
    const quotes = sharpQuotes(bookmakers, market, outcome(from), sharps);
    if (!quotes.length) continue;
    const sharp = consensus(quotes);
    const bookAt = bookFair(from), bookAlt = bookFair(bet.point);
    if (bookAt !== null && bookAlt !== null) {
      return { fair: normCdf(normInv(sharp) + normInv(bookAlt) - normInv(bookAt)), quotes, from, method: "ladder" };
    }
    // The normal model has no pushes, so it takes half-point numbers only.
    if (sd !== undefined && bet.point % 1 !== 0) {
      return { fair: normCdf(normInv(sharp) + gain(market, bet.name, from, bet.point) / scale), quotes, from, method: "normal" };
    }
    return null; // the nearest sharp number can't be carried over; a farther one won't do better
  }
  return null;
}

// "derived from the sharp -3 (BetMGM's ladder)" for cards.
export function derivedNote(d: Pick<Derived, "from" | "method">, market: string, book: string | null): string {
  const n = market.includes("spreads") && d.from > 0 ? `+${d.from}` : `${d.from}`;
  return `derived from the sharp ${n}, ${d.method === "ladder" ? `moved along ${book ?? "the book"}'s own ladder` : "normal model"}`;
}
