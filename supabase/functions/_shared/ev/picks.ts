// Bot picks: price every leg the promo's book offers against the sharp book's
// devigged line, then build the singles and parlays that qualify for the promo
// and rank them by boosted EV.

import { americanToDecimal, decimalToAmerican } from "./odds.ts";
import { worstCaseDevig } from "./devig.ts";
import { evaluateBet, type BetEval } from "./bet.ts";
import { promoViolations, type BetKind, type Promo } from "./promo.ts";
import type { Leg as CardLeg, SharpSide } from "./format.ts";
import type { Market, OddsEvent, Outcome } from "./odds-api.ts";

export type PricedLeg = {
  eventId: string;
  game: string; // "DET @ NYK" style, as The Odds API names teams
  start: string; // ISO
  market: string; // "h2h", "totals", "player_points", ...
  selection: string; // "Ja Morant Over 15.5 Points"
  bookOdds: number;
  fair: number; // worst-case devigged probability from the sharp book
  sharp: { sides: SharpSide[]; betIndex: number };
  edge: number; // fair × book decimal − 1, before any promo
};

// Outcomes that make up one two-way (or n-way) line: the same player and the
// same line. Spreads pair -3.5 with +3.5, so they group on the absolute point.
function lineKey(market: string, o: Outcome): string {
  const point = o.point === undefined ? "" : market === "spreads" ? Math.abs(o.point) : o.point;
  return `${o.description ?? ""}|${point}`;
}

function groups(m: Market): Map<string, Outcome[]> {
  const out = new Map<string, Outcome[]>();
  for (const o of m.outcomes) {
    const k = lineKey(m.key, o);
    out.set(k, [...(out.get(k) ?? []), o]);
  }
  return out;
}

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

function sideLabel(market: string, o: Outcome): string {
  if (o.point === undefined) return o.name;
  return `${o.name} ${market === "spreads" ? signed(o.point) : o.point}`;
}

function statLabel(market: string): string {
  return market.replace(/^player_/, "").split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

export function selectionLabel(market: string, o: Outcome): string {
  if (market === "h2h") return `${o.name} ML`;
  if (market === "spreads") return `${o.name} ${signed(o.point!)}`;
  if (market === "totals") return `${o.name} ${o.point}`;
  // Player props: name is Over/Under (or Yes/No), description is the player.
  return [o.description, o.name, o.point, statLabel(market)].filter((x) => x !== undefined && x !== "").join(" ");
}

export type PriceOptions = { sharpKey?: string; now?: Date; includeStarted?: boolean };

// Every leg the book offers that the sharp book also prices on the same line.
// Games that have started are skipped unless asked for: live lines from two
// books are captured at different moments, so comparing them shows false
// edges (and a suspended live market can sit at +1400).
export function priceLegs(events: OddsEvent[], bookKey: string, opts: PriceOptions = {}): PricedLeg[] {
  const { sharpKey = "pinnacle", now = new Date(), includeStarted = false } = opts;
  const legs: PricedLeg[] = [];
  for (const ev of events) {
    if (!includeStarted && new Date(ev.commence_time).getTime() <= now.getTime()) continue;
    const book = ev.bookmakers.find((b) => b.key === bookKey);
    const sharp = ev.bookmakers.find((b) => b.key === sharpKey);
    if (!book || !sharp) continue;
    for (const m of book.markets) {
      const sm = sharp.markets.find((x) => x.key === m.key);
      if (!sm) continue;
      const sharpGroups = groups(sm);
      for (const o of m.outcomes) {
        const sides = sharpGroups.get(lineKey(m.key, o));
        if (!sides || sides.length < 2) continue;
        const betIndex = sides.findIndex((s) => s.name === o.name && s.point === o.point);
        if (betIndex < 0) continue;
        const { fair } = worstCaseDevig(sides.map((s) => s.price), betIndex);
        legs.push({
          eventId: ev.id,
          game: `${ev.away_team} @ ${ev.home_team}`,
          start: ev.commence_time,
          market: m.key,
          selection: selectionLabel(m.key, o),
          bookOdds: o.price,
          fair,
          sharp: { sides: sides.map((s) => ({ label: sideLabel(m.key, s), odds: s.price })), betIndex },
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
  return p.legs.map((l) => ({ selection: l.selection, game: l.game, start: formatStart(l.start), sharp: l.sharp }));
}

// Why bestBets() came back empty, in words the bot can send.
export function noPicksReason(legs: PricedLeg[], promo: Promo): string {
  if (!legs.length) return "No games on this book have sharp (Pinnacle) lines yet. Try closer to game time.";
  const games = new Set(legs.map((l) => l.eventId)).size;
  const parlayOnly = promo.bet_kinds.length > 0 && !promo.bet_kinds.includes("single");
  const minLegs = Math.max(parlayOnly ? 2 : 1, promo.min_legs ?? 0);
  if (promo.bet_kinds.length === 1 && promo.bet_kinds[0] === "sgp") {
    return "This promo is same-game parlays only, and I can't price SGPs from the odds feed. Build one and send me its price to check it.";
  }
  if (games < minLegs) {
    return `This promo needs ${minLegs}+ legs, but only ${games} game${games === 1 ? " has" : "s have"} sharp lines right now, and I only combine legs from different games. Try closer to game time.`;
  }
  return "No bet that qualifies for this promo is +EV right now: the boost doesn't cover the book's margin. Skip it, or use it on a bet you already like.";
}
