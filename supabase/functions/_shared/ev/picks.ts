// Bot picks: price every leg the promo's book offers against the sharp sources'
// devigged lines, then build the singles and parlays that qualify for the promo
// and rank them by boosted EV.

import { americanToDecimal, decimalToAmerican, formatAmerican, probToAmerican } from "./odds.ts";
import { evaluateBet, type BetEval } from "./bet.ts";
import { marketAllowed, promoViolations, type BetKind, type Promo } from "./promo.ts";
import { consensus, sharpQuotes, SHARP_KEYS, sideLabel, type Quote } from "./sharp.ts";
import { deriveAlt, derivedNote } from "./alt-lines.ts";
import { findRuleBlocks, NEAR_IMPLIED, tdCount, TEAM_TOTAL_GIVEN_TDS, type SgpRule } from "./sgp-rules.ts";
import type { Leg as CardLeg } from "./format.ts";
import type { OddsEvent, Outcome } from "./odds-api.ts";
import { blowoutNote, formatWongLeg, isPropOver, WONG_NOTE, wongLegs, type WongLeg } from "./guide.ts";

export type PricedLeg = {
  eventId: string;
  sportKey: string; // the feed's sport key, for grading the leg later
  game: string; // "DET @ NYK" style, as The Odds API names teams
  start: string; // ISO
  market: string; // "h2h", "totals", "player_points", ...
  selection: string; // "Ja Morant Over 15.5 Points"
  side: string; // the outcome's name: a team, "Over", "Yes"
  point?: number;
  description?: string; // the player (props) or team (team totals) the outcome is about
  bookOdds: number;
  fair: number; // average of the sharp sources' worst-case devigged probabilities
  quotes: Quote[]; // each sharp source's line
  edge: number; // fair × book decimal − 1, before any promo
  derived?: string; // how the fair price was worked out when no sharp posts this number (alt-lines.ts)
};

function statLabel(market: string): string {
  return market.replace(/^player_/, "").replace(/_alternate$/, "").split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

export function selectionLabel(market: string, o: Outcome): string {
  if (market === "h2h") return `${o.name} ML`;
  if (market === "h2h_h1") return o.name === "Draw" ? "1st Half Draw" : `${o.name} 1st Half ML`;
  if (market === "draw_no_bet") return `${o.name} Draw No Bet`;
  if (market.includes("corners")) return `${sideLabel(market, o)} Corners`;
  if (market.includes("team_totals")) return `${o.description} Team Total ${sideLabel(market, o)}`;
  if (/_(h1|q1)$/.test(market)) {
    const period = market.endsWith("_h1") ? "1st Half" : "1st Quarter";
    return market.startsWith("h2h") ? (o.name === "Draw" ? `${period} Draw` : `${o.name} ${period} ML`) : `${period} ${sideLabel(market, o)}`;
  }
  if (market.includes("spreads") || market.includes("totals")) return sideLabel(market, o);
  // Player props: name is Over/Under (or Yes/No), description is the player.
  if (market === "player_anytime_td") return `${o.description} ${o.name === "No" ? "No " : ""}Anytime TD`;
  if (market === "player_1st_td") return `${o.description} ${o.name === "No" ? "No " : ""}1st TD`;
  if (market === "player_last_td") return `${o.description} ${o.name === "No" ? "No " : ""}Last TD`;
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
        let quotes = sharpQuotes(ev.bookmakers, m.key, o, sharps);
        let fair: number, derived: string | undefined;
        if (quotes.length) fair = consensus(quotes);
        else {
          // An alternate number no sharp posts: carried over from the nearest sharp number.
          const d = deriveAlt(ev.bookmakers, ev.sport_key, m.key, o, bookKey, sharps);
          if (!d) continue;
          ({ fair, quotes } = d);
          derived = derivedNote(d, m.key, book.title);
        }
        seen.add(`${ev.id}|${selection}`);
        legs.push({
          eventId: ev.id,
          sportKey: ev.sport_key,
          game: `${ev.away_team} @ ${ev.home_team}`,
          start: ev.commence_time,
          market: m.key,
          selection,
          side: o.name,
          point: o.point,
          description: o.description,
          bookOdds: o.price,
          fair,
          quotes,
          edge: fair * americanToDecimal(o.price) - 1,
          ...(derived ? { derived } : {}),
        });
      }
    }
  }
  return legs.sort((a, b) => b.edge - a.edge);
}

// free: legs that ride along at no price with another leg of the same game
// (theScore's spread + moneyline pair, sgp-rules.ts).
export type Pick = { kind: BetKind; legs: PricedLeg[]; americanOdds: number; eval: BetEval; free?: { leg: number; with: number; rule: SgpRule }[] };

// Which markets picks may use: everything (the default), or one of the two
// toggles. Main lines are healthier for an account: books limit prop bettors
// sooner.
export type MarketMode = "all" | "main" | "props";

export const isPropMarket = (market: string) => /^(player|batter|pitcher)_/.test(market);

export function filterMode<L extends { market: string }>(legs: L[], mode: MarketMode): L[] {
  if (mode === "all") return legs;
  return legs.filter((l) => isPropMarket(l.market) === (mode === "props"));
}

// Odds the bet should land in, both ends inclusive (American odds).
export type OddsRange = { min: number; max: number };

const inRange = (odds: number, r: OddsRange) =>
  americanToDecimal(odds) >= americanToDecimal(r.min) && americanToDecimal(odds) <= americanToDecimal(r.max);

function* combos<T>(items: T[], size: number, start = 0, acc: T[] = []): Generator<T[]> {
  if (acc.length === size) { yield acc; return; }
  for (let i = start; i < items.length; i++) yield* combos(items, size, i + 1, [...acc, items[i]]);
}

export type PickOptions = { league?: string; top?: number; pool?: number; maxLegs?: number; target?: OddsRange; book?: string };

// Best qualifying bets for a promo. Parlays only combine legs from different
// games, so independence holds; same-game parlays aren't auto-picked (the
// book's SGP price includes correlation the feed doesn't give us).
// SGPx (DraftKings) and SGP+ (FanDuel) combine same-game parlays from
// different games, so an SGP-only promo that allows them takes a parlay of
// one leg per game. Those legs don't move together, so it's priced like any
// parlay: the legs multiplied.
export function allowsSgpx(promo: Promo): boolean {
  return /\bsgp\s*\(?x\)?|\bsgp\+/i.test(`${promo.title} ${promo.notes ?? ""}`);
}

export function bestBets(allLegs: PricedLeg[], promo: Promo, opts: PickOptions = {}): Pick[] {
  const legs = allLegs.filter((l) => marketAllowed(promo, l.market)); // a TD boost takes TD scorer legs only
  const { league, top = 3, pool = 15, target } = opts;
  const maxLegs = Math.max(opts.maxLegs ?? 4, promo.min_legs ?? 0);
  const boost = (promo.boost_pct ?? 0) / 100;
  const allows = (k: BetKind) => !promo.bet_kinds.length || promo.bet_kinds.includes(k);
  const candidates: Pick[] = [];

  // A unit is one game's part of a bet: one leg, or a pair whose second leg
  // rides free (priced and won with the first).
  type Unit = { legs: PricedLeg[]; rule?: SgpRule };
  const consider = (kind: BetKind, units: Unit[]) => {
    const priced = units.map((u) => u.legs[0]);
    const chosen = units.flatMap((u) => u.legs);
    const decimal = priced.reduce((d, l) => d * americanToDecimal(l.bookOdds), 1);
    const americanOdds = Math.round(decimalToAmerican(decimal));
    if (promoViolations(promo, { americanOdds, legs: chosen.length, kind, league }).length) return;
    if (target && !inRange(americanOdds, target)) return;
    const e = evaluateBet(priced.map((l) => l.fair), priced.map((l) => l.bookOdds), boost);
    const free = units.flatMap((u) => (u.rule ? [{ leg: chosen.indexOf(u.legs[1]), with: chosen.indexOf(u.legs[0]), rule: u.rule }] : []));
    if (e.ev > 0) candidates.push({ kind, legs: chosen, americanOdds, eval: e, ...(free.length ? { free } : {}) });
  };

  if (allows("single")) for (const l of legs) consider("single", [{ legs: [l] }]);
  // A cross-game parlay, or an SGPx of one leg per game.
  const multi: BetKind | null = allows("parlay") ? "parlay" : allows("sgp") && allowsSgpx(promo) ? "sgp" : null;
  if (multi) {
    // The pool takes the best leg per game first, so every game gets a look.
    const perGame = new Map<string, PricedLeg>();
    for (const l of legs) if (!perGame.has(l.eventId)) perGame.set(l.eventId, l);
    const best: Unit[] = [...new Set([...perGame.values(), ...legs])].slice(0, pool).map((l) => ({ legs: [l] }));
    // On a book that prices a favorite's spread + its moneyline as one line
    // (theScore), each such pair is two legs for the price of the spread:
    // chained across games, they fill a leg minimum with half the games.
    const pairs = freePairs(legs, opts.book).slice(0, pool);
    const units = [...best, ...pairs];
    const lo = Math.max(2, promo.min_legs ?? 2);
    const hi = Math.min(maxLegs, promo.max_legs ?? maxLegs);
    for (let n = 1; n <= hi; n++) {
      for (const c of combos(units, n)) {
        const size = c.reduce((a, u) => a + u.legs.length, 0);
        if (size < lo || size > hi) continue;
        // One game's pair on its own is a same-game parlay.
        if (n === 1) { if (size > 1 && allows("sgp")) consider("sgp", c); continue; }
        if (new Set(c.map((u) => u.legs[0].eventId)).size === c.length) consider(multi, c);
      }
    }
  }
  return candidates.sort((a, b) => b.eval.ev - a.eval.ev).slice(0, top);
}

// Eastern wall-clock time, "YYYY-MM-DDTHH:MM", the way promo expiries are read.
function easternStamp(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

// Whether a game is one the promo can still be used on: it hasn't started, and
// it starts by the promo's expiry. A date-only expiry ("all NBA games on
// 10/29") covers that day's games (Eastern), not tomorrow's.
export function promoCovers(promo: Promo, commence: string, now = new Date()): boolean {
  if (new Date(commence).getTime() <= now.getTime()) return false;
  if (!promo.expires_at) return true;
  const start = easternStamp(commence);
  return promo.expires_at.length === 10 ? start.slice(0, 10) <= promo.expires_at : start <= promo.expires_at;
}

// Games ordered by their best leg against the sharp price: where to look
// first for SGP legs. One leg is enough to rank on: the sport-wide call can
// carry a single market for a book (DraftKings soccer: the moneyline only),
// and the game's own call fills in the rest.
export function rankSgpGames(legs: PricedLeg[]): string[] {
  const best = new Map<string, number>();
  for (const l of legs) best.set(l.eventId, Math.max(best.get(l.eventId) ?? -Infinity, l.edge));
  return [...best].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

export function formatStart(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit",
  }) + " ET";
}

// A pick's legs in the shape formatBet() prints.
export function cardLegs(p: Pick): CardLeg[] {
  return p.legs.map((l, i) => {
    const f = p.free?.find((x) => x.leg === i);
    return {
      selection: l.selection, bookOdds: l.bookOdds, game: l.game, start: formatStart(l.start), fairProb: l.fair, quotes: l.quotes,
      ...(f ? { freeWith: f.with } : {}), ...(l.derived ? { derived: l.derived } : {}),
    };
  });
}

// Why bestBets() came back empty, in words the bot can send.
export function noPicksReason(legs: PricedLeg[], promo: Promo, target?: OddsRange): string {
  if (!legs.length) return "No games on this book have sharp lines yet (Pinnacle or the exchanges). Try closer to game time.";
  const games = new Set(legs.map((l) => l.eventId)).size;
  const parlayOnly = promo.bet_kinds.length > 0 && !promo.bet_kinds.includes("single");
  const minLegs = Math.max(parlayOnly ? 2 : 1, promo.min_legs ?? 0);
  if (promo.bet_kinds.length === 1 && promo.bet_kinds[0] === "sgp" && !allowsSgpx(promo)) {
    return "This promo is same-game parlays only. Build one and send me a screenshot of the slip, and I'll price it.";
  }
  if (games < minLegs) {
    return `This promo needs ${minLegs}+ legs, but only ${games} game${games === 1 ? " has" : "s have"} sharp lines right now, and I only combine legs from different games. Try closer to game time.`;
  }
  if (target && bestBets(legs, promo).length) {
    return `Nothing +EV lands between ${formatAmerican(target.min)} and ${formatAmerican(target.max)} right now. Widen the target, or clear it to see the best bets at any price.`;
  }
  return "No bet that qualifies for this promo is +EV right now: the boost doesn't cover the book's margin. Skip it, or use it on a bet you already like.";
}

// Markets that each say who wins: an SGP takes at most one, so it never bets
// both sides of the game.
const RESULT_MARKETS = ["h2h", "spreads", "alternate_spreads", "draw_no_bet"];

export type SgpSuggestion = {
  game: string;
  eventId: string;
  legs: PricedLeg[];
  free: { leg: number; with: number; rule: SgpRule }[]; // legs a rule makes free: indexes into legs
};

// SGP-only promos can't be auto-priced (no SGP prices in the feed), so suggest
// the best-priced legs vs the sharp price in one game for the user to build.
// At most one game-result leg (moneyline or spread), one total, and one per
// player prop, so it never bets both sides of the game.
export function suggestSgpLegs(legs: PricedLeg[], count: number, eventId?: string, book?: string): SgpSuggestion | null {
  const byEvent = new Map<string, PricedLeg[]>();
  for (const l of legs) if (!eventId || l.eventId === eventId) byEvent.set(l.eventId, [...(byEvent.get(l.eventId) ?? []), l]);
  let best: SgpSuggestion | null = null, bestScore = -Infinity;
  for (const [id, evLegs] of byEvent) {
    const seen = new Set<string>();
    const picked = evLegs.filter((l) => {
      // One leg per game result, per player and stat, and per other market
      // (one corners total, not Over 9.5 and Under 10.5).
      const key = RESULT_MARKETS.includes(l.market) ? "result"
        : isPropMarket(l.market) ? `${l.market}|${l.selection.split(" ").slice(0, 2).join(" ")}`
        : l.market.replace(/^alternate_/, "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, count);
    // A free leg counts toward the leg count: it takes the place of the
    // weakest other leg.
    const free = freeLeg(picked, evLegs, book);
    if (free) picked.splice(picked.indexOf(free.with) + 1, 0, free.leg);
    const chosen = [...picked];
    for (let k = chosen.length - 1; chosen.length > count && k >= 0; k--) {
      if (chosen[k] !== free?.leg && chosen[k] !== free?.with) chosen.splice(k, 1);
    }
    if (chosen.length < count) continue;
    const score = chosen.filter((l) => l !== free?.leg).reduce((a, l) => a + l.edge, 0);
    if (score > bestScore) {
      const freeInfo = free && chosen.includes(free.leg) && chosen.includes(free.with)
        ? [{ leg: chosen.indexOf(free.leg), with: chosen.indexOf(free.with), rule: free.rule }] : [];
      best = { game: chosen[0].game, eventId: id, legs: chosen, free: freeInfo };
      bestScore = score;
    }
  }
  return best;
}

// Every favorite's spread with its moneyline, as a unit, on a book with the
// spread + moneyline rule; none elsewhere. Best spread edge first.
function freePairs(legs: PricedLeg[], book?: string): { legs: PricedLeg[]; rule: SgpRule }[] {
  if (!book) return [];
  return legs.filter((l) => l.market === "spreads" && (l.point ?? 0) < 0).flatMap((spread) => {
    const ml = legs.find((l) => l.market === "h2h" && l.eventId === spread.eventId && l.side === spread.side);
    const [block] = ml ? findRuleBlocks([ruleLeg(spread), ruleLeg(ml)], book) : [];
    return block ? [{ legs: [spread, ml!], rule: block.rule }] : [];
  }).sort((a, b) => b.legs[0].edge - a.legs[0].edge);
}

// A favorite's spread the book lets you pair with the same team's moneyline:
// covering means winning, so the moneyline rides along for free
// (sgp-rules.ts). An underdog's pair is worth its moneyline, not a free leg.
function freeLeg(picked: PricedLeg[], evLegs: PricedLeg[], book?: string) {
  for (const spread of picked.filter((l) => l.market === "spreads" && (l.point ?? 0) < 0)) {
    const ml = evLegs.find((l) => l.market === "h2h" && l.side === spread.side);
    if (!ml) continue;
    const [block] = findRuleBlocks([ruleLeg(spread), ruleLeg(ml)], book ?? null);
    if (block) return { leg: ml, with: spread, rule: block.rule };
  }
  return null;
}

const ruleLeg = (l: PricedLeg) => ({ market: l.market, side: l.side, line: l.point ?? null, team: null, player: null });

// Forcing legs to fill a leg minimum (sgp-rules.ts): for a scorer or a
// double-double in the suggestion, the legs it all but guarantees. The feed
// can't price these (no player's team, no low alternate lines), so they're
// ideas to add to the slip, which then gets priced with the rule's joint.
export function forcingIdeas(legs: { market: string; side: string; point?: number; description?: string }[]): string[] {
  const pct = (p: number) => `${Math.round(p * 100)}%`;
  return legs.flatMap((l) => {
    const who = l.description;
    if (!who) return [];
    const k = tdCount({ market: l.market, side: l.side, line: l.point ?? null });
    if (k) {
      const tds = k > 1 ? `${k}+ TDs` : "a TD";
      return [`➕ With ${who} ${tds}: his team's total Over ${6 * k - 0.5} can't lose if he gets there (Over ${6 * k + 1.5} about ${pct(TEAM_TOTAL_GIVEN_TDS)}), and his own yards over a low line (10+ receiving, 25+ rushing) about ${pct(NEAR_IMPLIED)}.`];
    }
    if (l.market === "player_double_double" && l.side === "Yes") {
      return [`➕ With ${who}'s double-double: his rebounds (or points) Over 9.5 come with it about ${pct(NEAR_IMPLIED)} of the time.`];
    }
    if (l.market === "player_triple_double" && l.side === "Yes") {
      return [`➕ With ${who}'s triple-double: his double-double and points, rebounds and assists Over 9.5 all come with it.`];
    }
    return [];
  });
}

export function formatSgpSuggestion(sg: SgpSuggestion, book: string): string {
  const lines = sg.legs.map((l, i) => {
    const f = sg.free.find((x) => x.leg === i);
    if (f) return `${i + 1}. ${l.selection} ${formatAmerican(l.bookOdds)} (free with leg ${f.with + 1}: ${f.rule.title})`;
    return `${i + 1}. ${l.selection} ${formatAmerican(l.bookOdds)} (fair ${formatAmerican(probToAmerican(l.fair))}, ${l.edge >= 0 ? "+" : ""}${(l.edge * 100).toFixed(1)}% vs sharp)`;
  });
  const why = sg.free.map((f) => `🧩 ${f.rule.why}`);
  const ideas = forcingIdeas(sg.legs);
  return [
    `🧩 SGP legs to build on ${book}: ${sg.game}`,
    ...lines,
    ...(why.length ? ["", ...why] : []),
    ...(ideas.length ? ["", "Need more legs? Add ones these legs all but force: the book often charges for them as if they weren't tied, which adds price for little risk.", ...ideas] : []),
    "",
    `These are the best-priced legs in this game against the sharp price (Pinnacle and the exchanges). ${book}'s SGP price depends on how the legs move together, which the odds feed doesn't show, so build the SGP (swap legs if you like) and send me a screenshot of the slip. I'll price the whole thing.`,
  ].join("\n");
}

// ── Questions about a game ────────────────────────────────

export type ShopLeg = PricedLeg & { book: string };

// Every leg in one game at its best price across the books (key → name),
// against the sharp price, best edge first: line shopping for "good bets on
// the Ravens game?".
export function shopLegs(event: OddsEvent, books: Record<string, string>, opts: PriceOptions = {}): ShopLeg[] {
  const best = new Map<string, ShopLeg>();
  for (const [key, name] of Object.entries(books)) {
    for (const l of priceLegs([event], key, { ...opts, sharpKeys: SHARP_KEYS })) {
      const seen = best.get(l.selection);
      if (!seen || l.edge > seen.edge) best.set(l.selection, { ...l, book: name });
    }
  }
  return [...best.values()].sort((a, b) => b.edge - a.edge);
}

// The guide's checks for one game: blowout risk on the listed player Overs, and
// any Wong teaser leg. Needs the game's main spread among the event's markets.
export function guideNotes(event: OddsEvent, legs: { market: string; side: string }[]): string[] {
  const notes: string[] = [];
  const blowout = blowoutNote(event);
  if (blowout && legs.some((l) => isPropOver(l.market, l.side))) notes.push(blowout);
  for (const w of wongLegs(event)) notes.push(`🧠 ${formatWongLeg(w)}. ${WONG_NOTE}`);
  return notes;
}

export function formatShop(event: OddsEvent, legs: ShopLeg[], top = 6): string {
  const head = `🔎 ${event.away_team} @ ${event.home_team}, ${formatStart(event.commence_time)}`;
  if (!legs.length) return `${head}\nThe sharp sources (Pinnacle and the exchanges) don't price this game's lines yet. Try closer to kickoff.`;
  const lines = legs.slice(0, top).map((l, i) =>
    `${i + 1}. ${l.edge > 0 ? "✅ " : ""}${l.selection} ${formatAmerican(l.bookOdds)} at ${l.book} (fair ${formatAmerican(probToAmerican(l.fair))}, ${l.edge >= 0 ? "+" : ""}${(l.edge * 100).toFixed(1)}%)`);
  const plus = legs.filter((l) => l.edge > 0).length;
  return [
    head,
    "Best prices across your books against the sharp price (Pinnacle + exchanges):",
    ...lines,
    "",
    plus
      ? `✅ ${plus} line${plus === 1 ? " beats" : "s beat"} the fair price as is. Bet those at that book; the rest only make sense with a boost.`
      : "Nothing beats the fair price as is: every book's margin wins. These are the closest; send a promo screenshot and the boost may flip them +EV.",
    ...guideNotes(event, legs.slice(0, top)).flatMap((n) => ["", n]),
  ].join("\n");
}

// Every Wong teaser leg on the slate, soonest first.
export function formatWongSlate(events: OddsEvent[]): string {
  const legs: WongLeg[] = events.flatMap(wongLegs).sort((a, b) => a.start.localeCompare(b.start));
  if (!legs.length) return "No NFL lines fit a Wong teaser right now (favorites of -7.5 to -8.5, underdogs of +1.5 to +2.5). Lines move during the week; check again.";
  return [
    "🧠 Wong teaser legs (6-point tease through 3 and 7):",
    ...legs.map((w, i) => `${i + 1}. ${formatWongLeg(w)} | ${w.game}, ${formatStart(w.start)}`),
    "",
    "Pair any two in a 6-point teaser; two Wong legs usually price around -110 to -120. Spreads are Pinnacle's where it posts them.",
  ].join("\n");
}
