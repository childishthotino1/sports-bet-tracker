// Fair prices from several sharp sources: Pinnacle plus the prediction-market
// exchanges (Novig, ProphetX, Kalshi, Polymarket). Each source's line is
// devigged on its own (worst case across methods), then the fair
// probabilities are averaged. The exchanges post both sides of bets the
// sportsbooks sell one way (anytime TD "No"), and price lines Pinnacle skips.
//
// Exchanges list every resting offer, so one player can have a ladder of
// prices on the same line, many of them stale or for a few dollars. Each side
// keeps its best price with at least MIN_LIMIT behind it, and a line counts
// only when every side survives and the hold is sane: below 0 means crossed,
// stale offers; above MAX_HOLD means nobody is really making a market.

import { formatAmerican, impliedProb } from "./odds.ts";
import { worstCaseDevig } from "./devig.ts";
import type { Bookmaker, Outcome } from "./odds-api.ts";

// The Odds API keys → names shown on cards. All in one request with the book
// (up to 10 bookmakers are billed as one region), so they cost no extra credits.
export const SHARP_BOOKS: Record<string, string> = {
  pinnacle: "Pinnacle",
  novig: "Novig",
  prophetx: "ProphetX",
  kalshi: "Kalshi",
  polymarket: "Polymarket",
};
export const SHARP_KEYS = Object.keys(SHARP_BOOKS);

export const MIN_LIMIT = 50; // dollars an offer must take to count
export const MAX_HOLD = 0.1;

export type Quote = {
  source: string; // "Pinnacle"
  sides: { label: string; odds: number }[];
  betIndex: number;
  fair: number; // worst-case devigged probability of the bet's side
  hold: number; // the line's total implied probability − 1
};

// Markets that can hold the same line: alternates repeat main lines, and the
// exchanges put milestone lines ("25+ points") in the main prop market.
export function marketFamily(key: string): string[] {
  const base = key.replace(/^alternate_/, "").replace(/_alternate$/, "");
  if (base === "spreads" || base === "totals") return [base, `alternate_${base}`];
  return [base, `${base}_alternate`];
}

// Is b on the same line as a? Spreads pair Panthers +3.5 with Packers -3.5;
// everything else pairs on the same player and number.
export function sameLine(market: string, a: Outcome, b: Outcome): boolean {
  if ((a.description ?? "") !== (b.description ?? "")) return false;
  if (market.includes("spreads")) return a.name === b.name ? a.point === b.point : b.point === -(a.point ?? 0);
  return a.point === b.point;
}

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

export function sideLabel(market: string, o: Outcome): string {
  if (o.point === undefined || o.point === null) return o.name;
  return `${o.name} ${market.includes("spreads") ? signed(o.point) : o.point}`;
}

const sideId = (o: Outcome) => `${o.name}|${o.point ?? ""}`;
const usable = (o: Outcome) => o.bet_limit === undefined || o.bet_limit === null || o.bet_limit >= MIN_LIMIT;

// One source's line for the bet, each side at its best usable price; null if a
// side has nothing usable or the hold isn't believable.
export function quoteLine(market: string, outcomes: Outcome[], bet: Outcome): { sides: Outcome[]; betIndex: number; hold: number } | null {
  const all = new Set<string>();
  const best = new Map<string, Outcome>();
  for (const o of outcomes) {
    if (!sameLine(market, bet, o)) continue;
    const id = sideId(o);
    all.add(id);
    if (!usable(o)) continue;
    const seen = best.get(id);
    if (!seen || impliedProb(o.price) < impliedProb(seen.price)) best.set(id, o);
  }
  if (best.size < 2 || best.size < all.size) return null;
  const sides = [...best.values()];
  const betIndex = sides.findIndex((o) => sideId(o) === sideId(bet));
  const hold = sides.reduce((a, o) => a + impliedProb(o.price), 0) - 1;
  if (betIndex < 0 || hold < 0 || hold > MAX_HOLD) return null;
  return { sides, betIndex, hold };
}

// Every sharp source's clean quote on the bet's line.
export function sharpQuotes(bookmakers: Bookmaker[], market: string, bet: Outcome, keys: string[] = SHARP_KEYS): Quote[] {
  const family = marketFamily(market);
  const out: Quote[] = [];
  for (const key of keys) {
    const bm = bookmakers.find((b) => b.key === key);
    if (!bm) continue;
    const line = quoteLine(market, bm.markets.filter((m) => family.includes(m.key)).flatMap((m) => m.outcomes), bet);
    if (!line) continue;
    out.push({
      source: SHARP_BOOKS[key] ?? bm.title,
      sides: line.sides.map((o) => ({ label: sideLabel(market, o), odds: o.price })),
      betIndex: line.betIndex,
      fair: worstCaseDevig(line.sides.map((o) => o.price), line.betIndex).fair,
      hold: line.hold,
    });
  }
  return out;
}

export function consensus(quotes: Quote[]): number {
  return quotes.reduce((a, q) => a + q.fair, 0) / quotes.length;
}

// "Pinnacle +171/-196 (3.1%)": the bet's side first, then the hold.
export function formatQuote(q: Quote): string {
  const odds = [q.sides[q.betIndex], ...q.sides.filter((_, i) => i !== q.betIndex)].map((s) => formatAmerican(s.odds));
  return `${q.source} ${odds.join("/")} (${(q.hold * 100).toFixed(1)}%)`;
}
