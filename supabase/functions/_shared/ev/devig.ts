// Devig methods: turn a market's vigged implied probabilities into fair
// probabilities. Each takes every side's implied probability (summing to more
// than 1) and returns fair probabilities summing to 1, in the same order.

import { impliedProb } from "./odds.ts";

export type DevigMethod = "multiplicative" | "additive" | "power" | "shin";

export const DEVIG_METHODS: DevigMethod[] = ["multiplicative", "additive", "power", "shin"];

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

// Bisection for a decreasing-or-increasing f with a sign change on [lo, hi].
function solve(f: (x: number) => number, lo: number, hi: number): number {
  let flo = f(lo);
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fmid = f(mid);
    if (Math.abs(fmid) < 1e-13) return mid;
    if ((fmid > 0) === (flo > 0)) { lo = mid; flo = fmid; } else hi = mid;
  }
  return (lo + hi) / 2;
}

export function multiplicative(q: number[]): number[] {
  const total = sum(q);
  return q.map((x) => x / total);
}

// Subtracts an equal share of the overround from each side. Clamped at 0 so a
// heavy longshot can't go negative.
export function additive(q: number[]): number[] {
  const share = (sum(q) - 1) / q.length;
  return q.map((x) => Math.max(0, x - share));
}

// Solves k so that Σ q^k = 1, then p = q^k.
export function power(q: number[]): number[] {
  if (sum(q) <= 1) return multiplicative(q);
  let hi = 2;
  while (sum(q.map((x) => x ** hi)) > 1) hi *= 2;
  const k = solve((k) => sum(q.map((x) => x ** k)) - 1, 1, hi);
  return q.map((x) => x ** k);
}

// Shin (1993): solves for the insider share z so the implied fair
// probabilities sum to 1.
export function shin(q: number[]): number[] {
  const total = sum(q);
  if (total <= 1) return multiplicative(q);
  const probs = (z: number) =>
    q.map((x) => (Math.sqrt(z * z + 4 * (1 - z) * (x * x) / total) - z) / (2 * (1 - z)));
  const z = solve((z) => sum(probs(z)) - 1, 0, 0.999);
  return probs(z);
}

const IMPLS: Record<DevigMethod, (q: number[]) => number[]> = { multiplicative, additive, power, shin };

export function devig(q: number[], method: DevigMethod): number[] {
  if (q.length < 2) throw new Error("A market needs at least two sides to devig");
  return IMPLS[method](q);
}

export type DevigResult = {
  fair: number; // fair probability of the side being bet
  method: DevigMethod; // method that produced it
  byMethod: Record<DevigMethod, number>;
};

// Runs every method and keeps the lowest fair probability for the side being
// bet — the conservative "worst-case" number the output reports.
export function worstCaseDevig(americanOdds: number[], sideIndex = 0): DevigResult {
  const q = americanOdds.map(impliedProb);
  const byMethod = {} as Record<DevigMethod, number>;
  let method: DevigMethod = DEVIG_METHODS[0];
  for (const m of DEVIG_METHODS) {
    byMethod[m] = devig(q, m)[sideIndex];
    if (byMethod[m] < byMethod[method]) method = m;
  }
  return { fair: byMethod[method], method, byMethod };
}
