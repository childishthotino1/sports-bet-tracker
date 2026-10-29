// Bot picks: price every leg the promo's book offers against the sharp sources'
// devigged lines, then build the singles and parlays that qualify for the promo
// and rank them by boosted EV.

import { americanToDecimal, decimalToAmerican, formatAmerican, probToAmerican } from "./odds.ts";
import { evaluateBet, type BetEval } from "./bet.ts";
import { promoViolations, type BetKind, type Promo } from "./promo.ts";
import { consensus, sharpQuotes, SHARP_KEYS, sideLabel, type Quote } from "./sharp.ts";
import type { Leg as CardLeg } from "./format.ts";
import type { OddsEvent, Outcome } from "./odds-api.ts";

export type PricedLeg = {
  eventId: string;
  game: string; // "DET @ NYK" style, as The Odds API names teams
  start: string; // ISO
  market: string; // "h2h", "totals", "player_points", ...
  selection: string; // "Ja Morant Over 15.5 Points"
  bookOdds: number;
  fair: number; // average of the sharp sources' worst-case devigged probabilities
  quotes: Quote[]; // each sharp source's line
  edge: number; // fair × book decimal − 1, before any promo
};

function statLabel(market: string): string {
  return market.replace(/^player_/, "").replace(/_alternate$/, "").split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

export function selectionLabel(market: string, o: Outcome): string {
  if (market === "h2h") return `${o.name} ML`;
  if (market.includes("spreads") || market.includes("totals")) return sideLabel(market, o);
  // Player props: name is Over/Under (or Yes/No), description is the player.
  if (market === "player_anytime_td") return `${o.description} ${o.name === "No" ? "No " : ""}Anytime TD`;
  if (market === "player_goal_scorer_anytime") return `${o.description} ${o.name === "No" ? "No " : ""}Anytime Goal`;
  if (market === "btts") return `Both Teams To Score: ${o.name}`;
  return [o.description, o.name, o.point, statLabel(market)].filter((x) => x !== undefined && x !== "").join(" ");
}

export type PriceOptions = { sharpKeys?: string[]; now?: Date; includeStarted?: boolean };

// Every leg the book offers that at least one sharp source prices on the same
// line. Games that have started are skipped unless asked for: live lines from
// two books are captured at different moments, so comparing them shows false
// edges (and a suspended live market can sit at +1400).
export function priceLegs(events: OddsEvent[], bookKey: string, opts: PriceOptions = {}): PricedLeg[] {
  const { sharpKeys = SHARP_KEYS, now = new Date(), includeStarted = false } = opts;
  const sharps = sharpKeys.filter((k) => k !== bookKey);
  const legs: PricedLeg[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    if (!includeStarted && new Date(ev.commence_time).getTime() <= now.getTime()) continue;
    const book = ev.bookmakers.find((b) => b.key === bookKey);
    if (!book) continue;
    for (const m of book.markets) {
      for (const o of m.outcomes) {
        const selection = selectionLabel(m.key, o);
        if (seen.has(`${ev.id}|${selection}`)) continue; // the same line in a main and an alternate market
        const quotes = sharpQuotes(ev.bookmakers, m.key, o, sharps);
        if (!quotes.length) continue;
        seen.add(`${ev.id}|${selection}`);
        const fair = consensus(quotes);
        legs.push({
          eventId: ev.id,
          game: `${ev.away_team} @ ${ev.home_team}`,
          start: ev.commence_time,
          market: m.key,
          selection,
          bookOdds: o.price,
          fair,
          quotes,
          edge: fair * americanToDecimal(o.price) - 1,
        });
      }
    }
  }
  return legs.sort((a, b) => b.edge - a.edge);
}

export type Pick = { kind: BetKind; legs: PricedLeg[]; americanOdds: number; eval: BetEval };

function* combos<T>(items: T[], size: number, start = 0, acc: T[] = []): Generator<T[]> {
  if (acc.length === size) { yield acc; return; }
  for (let i = start; i < items.length; i++) yield* combos(items, size, i + 1, [...acc, items[i]]);
}

export type PickOptions = { league?: string; top?: number; pool?: number; maxLegs?: number };

// Best qualifying bets for a promo. Parlays only combine legs from different
// games, so independence holds; same-game parlays aren't auto-picked (the
// book's SGP price includes correlation the feed doesn't give us).
export function bestBets(legs: PricedLeg[], promo: Promo, opts: PickOptions = {}): Pick[] {
  const { league, top = 3, pool = 15, maxLegs = 4 } = opts;
  const boost = (promo.boost_pct ?? 0) / 100;
  const allows = (k: BetKind) => !promo.bet_kinds.length || promo.bet_kinds.includes(k);
  const candidates: Pick[] = [];

  const consider = (kind: BetKind, chosen: PricedLeg[]) => {
    const decimal = chosen.reduce((d, l) => d * americanToDecimal(l.bookOdds), 1);
    const americanOdds = Math.round(decimalToAmerican(decimal));
    if (promoViolations(promo, { americanOdds, legs: chosen.length, kind, league }).length) return;
    const e = evaluateBet(chosen.map((l) => l.fair), chosen.map((l) => l.bookOdds), boost);
    if (e.ev > 0) candidates.push({ kind, legs: chosen, americanOdds, eval: e });
  };

  if (allows("single")) for (const l of legs) consider("single", [l]);
  if (allows("parlay")) {
    const best = legs.slice(0, pool);
    const lo = Math.max(2, promo.min_legs ?? 2);
    const hi = Math.min(maxLegs, promo.max_legs ?? maxLegs);
    for (let n = lo; n <= hi; n++) {
      for (const c of combos(best, n)) {
        if (new Set(c.map((l) => l.eventId)).size === c.length) consider("parlay", c);
      }
    }
  }
  return candidates.sort((a, b) => b.eval.ev - a.eval.ev).slice(0, top);
}

export function formatStart(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit",
  }) + " ET";
}

// A pick's legs in the shape formatBet() prints.
export function cardLegs(p: Pick): CardLeg[] {
  return p.legs.map((l) => ({ selection: l.selection, game: l.game, start: formatStart(l.start), fairProb: l.fair, quotes: l.quotes }));
}

// Why bestBets() came back empty, in words the bot can send.
export function noPicksReason(legs: PricedLeg[], promo: Promo): string {
  if (!legs.length) return "No games on this book have sharp lines yet (Pinnacle or the exchanges). Try closer to game time.";
  const games = new Set(legs.map((l) => l.eventId)).size;
  const parlayOnly = promo.bet_kinds.length > 0 && !promo.bet_kinds.includes("single");
  const minLegs = Math.max(parlayOnly ? 2 : 1, promo.min_legs ?? 0);
  if (promo.bet_kinds.length === 1 && promo.bet_kinds[0] === "sgp") {
    return "This promo is same-game parlays only. Build one and send me a screenshot of the slip, and I'll price it.";
  }
  if (games < minLegs) {
    return `This promo needs ${minLegs}+ legs, but only ${games} game${games === 1 ? " has" : "s have"} sharp lines right now, and I only combine legs from different games. Try closer to game time.`;
  }
  return "No bet that qualifies for this promo is +EV right now: the boost doesn't cover the book's margin. Skip it, or use it on a bet you already like.";
}

export type SgpSuggestion = { game: string; eventId: string; legs: PricedLeg[] };

// SGP-only promos can't be auto-priced (no SGP prices in the feed), so suggest
// the best-priced legs vs the sharp price in one game for the user to build.
// At most one game-result leg (moneyline or spread), one total, and one per
// player prop, so it never bets both sides of the game.
export function suggestSgpLegs(legs: PricedLeg[], count: number, eventId?: string): SgpSuggestion | null {
  const byEvent = new Map<string, PricedLeg[]>();
  for (const l of legs) if (!eventId || l.eventId === eventId) byEvent.set(l.eventId, [...(byEvent.get(l.eventId) ?? []), l]);
  let best: SgpSuggestion | null = null, bestScore = -Infinity;
  for (const [id, evLegs] of byEvent) {
    const seen = new Set<string>();
    const picked = evLegs.filter((l) => {
      const key = l.market === "h2h" || l.market === "spreads" ? "result" : l.market === "totals" ? "total"
        : `${l.market}|${l.selection.split(" ").slice(0, 2).join(" ")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, count);
    if (picked.length < count) continue;
    const score = picked.reduce((a, l) => a + l.edge, 0);
    if (score > bestScore) { best = { game: picked[0].game, eventId: id, legs: picked }; bestScore = score; }
  }
  return best;
}

export function formatSgpSuggestion(sg: SgpSuggestion, book: string): string {
  const lines = sg.legs.map((l, i) =>
    `${i + 1}. ${l.selection} ${formatAmerican(l.bookOdds)} (fair ${formatAmerican(probToAmerican(l.fair))}, ${l.edge >= 0 ? "+" : ""}${(l.edge * 100).toFixed(1)}% vs sharp)`);
  return [
    `🧩 SGP legs to build on ${book}: ${sg.game}`,
    ...lines,
    "",
    `These are the best-priced legs in this game against the sharp price (Pinnacle and the exchanges). ${book}'s SGP price depends on how the legs move together, which the odds feed doesn't show, so build the SGP (swap legs if you like) and send me a screenshot of the slip. I'll price the whole thing.`,
  ].join("\n");
}
