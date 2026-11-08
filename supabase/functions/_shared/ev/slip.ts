// A bet slip screenshot (built, not yet placed) → each leg priced against the
// sharp sources → fair value and EV, with the promo's boost if one applies.
//
// Same-game parlays: the book's SGP price already includes how the legs move
// together (Packers ML and Jacobs TD win together; Panthers +3.5 and Packers ML
// rarely both lose). The feed has no SGP prices, so the fair estimate keeps the
// book's own correlation adjustment — its SGP price ÷ its legs multiplied — and
// swaps each leg's vig for the sharp fair price. That still carries any extra
// margin the book adds to SGPs, so the result says how big that margin can be
// before the bet turns -EV.

import { americanToDecimal, decimalToAmerican, formatAmerican, formatPct, impliedProb, probToAmerican } from "./odds.ts";
import { worstCaseDevig } from "./devig.ts";
import { evaluateBet, wagerLine, type BetEval } from "./bet.ts";
import { marketAllowed, marketsLabel, promoViolations, type BetKind, type Promo } from "./promo.ts";
import { consensus, formatQuote, marketFamily, sameLine, sharpQuotes, SHARP_KEYS, type Quote } from "./sharp.ts";
import type { Market, OddsEvent, Outcome } from "./odds-api.ts";
import { lastWord, norm, samePerson, sameTeam } from "./names.ts";
import { blockJoint, findRuleBlocks, type RuleLeg, type SgpRule } from "./sgp-rules.ts";
import { deriveAlt, derivedNote } from "./alt-lines.ts";
import { BOOK_ID_RULES, MARKET_READING_RULES, ODDS_READING_RULES, boostFromPrices, canonicalBook } from "../books/books.ts";

export { samePerson, sameTeam };

// Markets the vision call may name; they're The Odds API's market keys.
export const SLIP_MARKETS = [
  "h2h", "spreads", "totals",
  // Team totals and period lines (the feed has them per game only).
  "team_totals", "h2h_h1", "spreads_h1", "totals_h1", "h2h_q1", "spreads_q1", "totals_q1",
  // NFL / NCAAF
  "player_anytime_td", "player_1st_td", "player_last_td", "player_pass_yds", "player_pass_tds", "player_rush_yds", "player_reception_yds", "player_receptions",
  "player_pass_completions", "player_pass_attempts", "player_pass_interceptions", "player_pass_longest_completion",
  "player_rush_attempts", "player_rush_longest", "player_reception_longest", "player_rush_reception_yds",
  "player_pass_rush_yds", "player_reception_tds", "player_rush_tds", "player_tds_over", "player_sacks",
  "player_solo_tackles", "player_tackles_assists", "player_field_goals", "player_kicking_points",
  // NBA / WNBA / NCAAB
  "player_points", "player_rebounds", "player_assists", "player_threes", "player_points_rebounds_assists",
  "player_points_rebounds", "player_points_assists", "player_rebounds_assists", "player_blocks", "player_steals",
  "player_turnovers", "player_double_double",
  // MLB
  "batter_hits", "batter_home_runs", "batter_total_bases", "batter_rbis", "batter_runs_scored", "batter_hits_runs_rbis",
  "batter_stolen_bases", "pitcher_strikeouts", "pitcher_hits_allowed", "pitcher_outs", "pitcher_earned_runs",
  // NHL
  "player_goals", "player_shots_on_goal", "player_power_play_points", "player_blocked_shots", "player_total_saves",
  // soccer
  "btts", "player_goal_scorer_anytime", "player_shots_on_target",
  "other",
] as const;

export type SlipLeg = {
  team_or_player: string | null; // team for spreads/moneylines, player for props, null for game totals
  market: string; // one of SLIP_MARKETS
  line: number | null; // signed for spreads (+3.5 → 3.5, -3.5 → -3.5)
  side: string; // "Over" / "Under" / "Yes" / a team name
  team: string | null; // the team the leg is on (a player's team for props), for the SGP rules
  game: string | null; // the leg's matchup as the slip shows it ("Brentford vs Nottingham Forest")
  odds: number | null; // the leg's own price if the slip prints one (Caesars, Fanatics and bet365 do), else null
};

export type Slip = {
  book: string | null;
  league: string | null;
  bet_kind: BetKind;
  total_odds: number | null; // whole slip, before any boost
  boosted_odds: number | null; // the boosted price the slip shows, if a boost is applied
  boost_pct: number | null; // that boost, printed or worked out from the two prices
  boost_entered?: boolean; // the boost was typed or tapped in the chat, not read off the slip
  game: string | null; // "Carolina Panthers @ Green Bay Packers" when the slip shows one
  legs: SlipLeg[];
};

export const SLIP_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["book", "league", "bet_kind", "total_odds", "boosted_odds", "boost_pct", "game", "legs"],
  properties: {
    book: { type: "string" },
    league: { type: "string" },
    bet_kind: { type: "string", enum: ["single", "parlay", "sgp"] },
    total_odds: { type: "integer" },
    boosted_odds: { type: "integer" },
    boost_pct: { type: "number" },
    game: { type: "string" },
    legs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["team_or_player", "market", "line", "side", "team", "game", "odds"],
        properties: {
          team_or_player: { type: "string" },
          team: { type: "string" },
          game: { type: "string" },
          market: { type: "string", enum: [...SLIP_MARKETS] },
          line: { type: ["number", "null"] },
          side: { type: "string" },
          odds: { type: "number" },
        },
      },
    },
  },
} as const;

export const SLIP_PROMPT = `If it's a bet slip (a bet being built or already placed), fill "slip". Use "" for unknown text and 0 for unknown numbers:
- book: the sportsbook's code (MGM, DK, FD, CZR, FAN, B365, SCORE). ${BOOK_ID_RULES}
  If none of these rules fits, "".
- league: NFL, NCAAF, NBA, WNBA, NCAAB, MLB or NHL, or for soccer EPL, UCL, MLS, LALIGA, SERIEA or BUNDESLIGA, from the teams and competition.
- bet_kind: "sgp" if the slip says SGP / Same Game Parlay; "parlay" for legs from different games; "single" for one leg.
- total_odds: the slip's total odds before any boost (the struck-through price when boosted), as American odds (+990 -> 990).
- boosted_odds: the boosted total odds if the slip shows a boost, else 0.
- boost_pct: the boost % if printed (15 for "15%"), else 0.
- game: "Away Team @ Home Team" as the slip shows it, for a single-game bet; else "".
- legs: one per selection.
  - team_or_player: the team (spreads, moneylines) or player (props), full name as shown; "" for game totals.
  - market: h2h for moneylines, spreads, totals for the game total, team_totals for one team's total (team_or_player is that team), h2h_h1 / spreads_h1 / totals_h1 for 1st-half lines and h2h_q1 / spreads_q1 / totals_q1 for 1st-quarter lines, or the player prop's key (player_anytime_td for "Any Time Touchdown Scorer", player_1st_td for "First Touchdown Scorer", player_last_td for "Last Touchdown Scorer", player_reception_longest for "Longest Reception", player_rush_reception_yds for "Rush + Rec Yards", player_points, ... from the list; for soccer, h2h for the match result (side "Draw" for a draw), btts for Both Teams To Score, player_goal_scorer_anytime for Anytime Goalscorer); "other" if none fits.
  - line: the number with its sign for spreads (Panthers +3.5 -> 3.5), the total or prop line, null for moneylines and anytime TDs.
  - game: the matchup this leg is from, as the slip shows it above or beside the leg ("Brentford vs Nottingham Forest"); "" if none is shown.
  - team: the full team name the leg is on (for a player prop, the player's team, from the slip or the matchup); "" for game totals or if unsure.
  - side: "Over" or "Under" for totals and over/under props, "Yes" (or "No") for anytime scorer props and btts, the team name (or "Draw") for spreads and moneylines.
  - odds: the leg's own price as American odds if the slip prints one next to the leg (-110 -> -110, +250 -> 250), else 0. On a single, the bet's price.

${ODDS_READING_RULES}

${MARKET_READING_RULES}`;

export function normalizeSlip(raw: unknown): Slip | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const legs = (Array.isArray(r.legs) ? r.legs : []).flatMap((l): SlipLeg[] => {
    if (!l || typeof l !== "object") return [];
    const o = l as Record<string, unknown>;
    const side = str(o.side);
    if (!side) return [];
    const market = (SLIP_MARKETS as readonly string[]).includes(String(o.market)) ? String(o.market) : "other";
    const odds = num(o.odds);
    return [{ team_or_player: str(o.team_or_player), market, line: num(o.line), side, team: str(o.team), game: str(o.game), odds: odds !== null && Math.abs(odds) >= 100 ? Math.round(odds) : null }];
  });
  if (!legs.length) return null;
  const total = num(r.total_odds);
  const odds = (v: number | null) => (v !== null && Math.abs(v) >= 100 ? Math.round(v) : null);
  const boosted = odds(num(r.boosted_odds));
  // A single's leg price and total are the same number: fill whichever is missing.
  const base = odds(total) ?? (legs.length === 1 ? legs[0].odds : null);
  if (legs.length === 1 && legs[0].odds === null) legs[0].odds = base;
  const printed = num(r.boost_pct);
  // A boost counts when the slip shows one: its printed %, or the % its two prices imply.
  const boost = boosted !== null && base !== null && boosted !== base
    ? (printed && printed > 0 ? printed : boostFromPrices(base, boosted))
    : printed && printed > 0 ? printed : null;
  const kind = r.bet_kind === "single" || r.bet_kind === "parlay" || r.bet_kind === "sgp" ? r.bet_kind : legs.length > 1 ? "parlay" : "single";
  return {
    book: canonicalBook(str(r.book)),
    league: str(r.league)?.toUpperCase() ?? null,
    bet_kind: kind,
    total_odds: base,
    boosted_odds: boost ? boosted : null,
    boost_pct: boost,
    game: str(r.game),
    legs,
  };
}

// ── Matching slip text to the feed ────────────────────────

// How well free text ("Carolina Panthers @ Green Bay Packers", "Packers ML")
// names this team: 0 for not at all. Among matches, more of the team's name
// matched in order wins, so "Florida" is the Florida Gators before Florida State.
function mentions(text: string, team: string): number {
  const tw = norm(team).split(" ");
  let best = 0;
  for (const part of text.split(/ @ | vs\.? | at /i)) {
    if (!wholeWords(part, team)) continue;
    // The whole name anywhere in the text ("best bets for manchester city") is the strongest match.
    if (` ${norm(part)} `.includes(` ${tw.join(" ")} `)) { best = Math.max(best, 1 + 0.1 * tw.length); continue; }
    const pw = norm(part).split(" ");
    let k = 0;
    while (k < pw.length && k < tw.length && pw[k] === tw[k]) k++;
    best = Math.max(best, 1 + 0.1 * k - 0.01 * (tw.length - k));
  }
  if (best) return best;
  const padded = ` ${norm(text)} `;
  const nick = lastWord(team);
  if (nick.length > 2 && !GENERIC_NICK.has(nick) && padded.includes(` ${nick} `)) return 1;
  // A school or city named inside a sentence ("the Notre Dame game"): the
  // longest run of the team's first words that the text holds, scored below a
  // full match so "Florida State" beats "Florida". One generic word ("New",
  // "San") isn't enough.
  for (let k = tw.length - 1; k >= 1; k--) {
    if (k === 1 && (tw[0].length < 4 || GENERIC_FIRST.has(tw[0]))) continue;
    if (padded.includes(` ${tw.slice(0, k).join(" ")} `)) return 0.9 + 0.1 * k - 0.01 * (tw.length - k);
  }
  return 0;
}

// sameTeam, but on whole words: "hi" is in "Fighting", not a team.
function wholeWords(a: string, b: string): boolean {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  const lx = lastWord(x);
  return ` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `) || (lx.length > 2 && !GENERIC_NICK.has(lx) && lx === lastWord(y));
}

// Last words many clubs share ("Manchester City", "Coventry City"): not a team on their own.
const GENERIC_NICK = new Set(["city", "united", "town", "county", "athletic", "rovers", "wanderers", "albion", "fc", "afc", "sc", "cf", "real", "sporting", "club"]);

// First words of team names too common to identify a team alone.
const GENERIC_FIRST = new Set(["new", "north", "south", "east", "west", "central", "northern", "southern", "eastern", "western", "green", "golden", "saint", "little", "good", "game"]);

type EventRef = Pick<OddsEvent, "id" | "home_team" | "away_team" | "commence_time">;

// Everything on a slip that might name a team.
export function slipNames(slip: Slip): string[] {
  return [slip.game, ...slip.legs.flatMap((l) => [l.team_or_player, l.side])].filter((x): x is string => !!x);
}

// The game these names point at: the event whose teams they mention most, and best.
export function findEvent<E extends EventRef>(events: E[], texts: (string | null | undefined)[], now = new Date()): E | null {
  const names = texts.filter((x): x is string => !!x);
  let best: E | null = null, bestScore = 0;
  for (const ev of events) {
    let score = 0;
    for (const team of [ev.home_team, ev.away_team]) score += Math.max(0, ...names.map((n) => mentions(n, team)));
    // Prefer games that haven't started when two match equally.
    const upcoming = new Date(ev.commence_time).getTime() > now.getTime() ? 0.5 : 0;
    if (score && score + upcoming > bestScore) { best = ev; bestScore = score + upcoming; }
  }
  return best;
}

// Feed markets to request for a slip: each leg's market, plus the alternate
// lines a book's slip often uses (+3.5 when the main spread is +3).
export function marketsFor(slip: Slip): string[] {
  const out = new Set<string>();
  for (const l of slip.legs) {
    if (l.market === "other") continue;
    out.add(l.market);
    if (l.market === "spreads") out.add("alternate_spreads");
    if (l.market === "totals") out.add("alternate_totals");
    if (l.market === "team_totals") out.add("alternate_team_totals");
    if (l.market === "spreads_h1") out.add("alternate_spreads_h1");
    if (l.market === "totals_h1") out.add("alternate_totals_h1");
  }
  return [...out];
}

function sideMatches(o: Outcome, leg: SlipLeg): boolean {
  if (norm(o.name) === norm(leg.side)) return true;
  // Some feeds list anytime scorer as Over 0.5 rather than Yes.
  return norm(leg.side) === "yes" && norm(o.name) === "over" && o.point === 0.5;
}

function matches(marketKey: string, o: Outcome, leg: SlipLeg): boolean {
  if (marketKey.includes("h2h")) return norm(o.name) === "draw" || norm(leg.side) === "draw" ? norm(o.name) === norm(leg.side) : sameTeam(o.name, leg.side);
  if (marketKey === "btts") return norm(o.name) === norm(leg.side);
  if (marketKey.includes("spreads")) return sameTeam(o.name, leg.side) && o.point === leg.line;
  // Team totals carry the team in description: Oregon State's 31.5 isn't Fresno State's.
  if (marketKey.includes("team_totals")) {
    const team = leg.team_or_player ?? leg.team;
    return !!o.description && !!team && sameTeam(o.description, team) && norm(o.name) === norm(leg.side) && o.point === leg.line;
  }
  if (marketKey.includes("totals")) return norm(o.name) === norm(leg.side) && o.point === leg.line;
  return !!o.description && !!leg.team_or_player && samePerson(o.description, leg.team_or_player) &&
    sideMatches(o, leg) && (leg.line === null || o.point === leg.line);
}

// The leg's side as the feed names it: the team's feed name for a spread, else as read.
function feedSide(event: OddsEvent, leg: SlipLeg): string {
  if (!leg.market.includes("spreads")) return leg.side[0].toUpperCase() + leg.side.slice(1).toLowerCase();
  return [event.home_team, event.away_team].find((t) => sameTeam(t, leg.side)) ?? leg.side;
}

// The outcome for a leg in one bookmaker's markets, and the other side(s) of that line.
function locate(markets: Market[], leg: SlipLeg): { key: string; outcome: Outcome; sides: Outcome[] } | null {
  for (const key of marketFamily(leg.market)) {
    const m = markets.find((x) => x.key === key);
    const outcome = m?.outcomes.find((o) => matches(key, o, leg));
    if (!m || !outcome) continue;
    return { key, outcome, sides: m.outcomes.filter((o) => sameLine(key, outcome, o)) };
  }
  return null;
}

// One-sided markets (only "Yes" posted) can't be devigged; assume this margin.
export const ONE_SIDED_MARGIN = 0.06;

// Markets with one price per player and one winner (or none): a TD scorer field.
export const FIELD_MARKETS = ["player_1st_td", "player_last_td"];

export type PricedSlipLeg = {
  label: string;
  bookOdds: number | null; // the book's own price for this leg, if the feed has it
  fair: number | null;
  source: "sharp" | "sharp-1way" | "derived" | "book" | "book-1way" | "book-field" | "slip-1way" | "none";
  quotes?: Quote[]; // each sharp source's line, when source is "sharp" (or "derived": at the sharp number)
  derived?: string; // how, when source is "derived"
};

function fairFrom(sides: Outcome[], outcome: Outcome): { fair: number; oneWay: boolean } {
  if (sides.length >= 2) return { fair: worstCaseDevig(sides.map((s) => s.price), sides.indexOf(outcome)).fair, oneWay: false };
  return { fair: impliedProb(outcome.price) / (1 + ONE_SIDED_MARGIN), oneWay: true };
}

export function legLabel(leg: SlipLeg): string {
  const stat = leg.market.replace(/^(player|batter|pitcher)_/, "").replace("anytime_td", "Anytime TD")
    .split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  const line = leg.line === null ? "" : leg.market === "spreads" && leg.line > 0 ? ` +${leg.line}` : ` ${leg.line}`;
  const period = leg.market.endsWith("_h1") ? "1st Half " : leg.market.endsWith("_q1") ? "1st Quarter " : "";
  const base = leg.market.replace(/_(h1|q1)$/, "");
  const signed = leg.line !== null && base === "spreads" && leg.line > 0 ? ` +${leg.line}` : line;
  if (base === "h2h") return `${leg.side} ${period}ML`;
  if (base === "spreads") return `${leg.side} ${period}${signed.trim()}`.replace(/  +/g, " ");
  if (base === "totals") return `${period}${leg.side}${line}`;
  if (leg.market === "team_totals") return `${leg.team_or_player ?? leg.team ?? ""} Team Total ${leg.side}${line}`.trim();
  if (leg.market === "player_anytime_td") return `${leg.team_or_player} Anytime TD`;
  if (leg.market === "player_1st_td") return `${leg.team_or_player} 1st TD`;
  if (leg.market === "player_last_td") return `${leg.team_or_player} Last TD`;
  if (leg.market === "player_goal_scorer_anytime") return `${leg.team_or_player} Anytime Goal`;
  if (leg.market === "btts") return `Both Teams To Score: ${leg.side}`;
  return `${leg.team_or_player ?? ""} ${leg.side}${line} ${stat}`.trim();
}

// legEvents[i] is the feed's odds for leg i's game (null if it wasn't found).
// Each sharp source that has the leg's line gives a quote; their fair prices
// are combined (see consensus in sharp.ts). With none, a Pinnacle line posted one way only gets an assumed
// margin, and after that the book's own price is devigged.
// bookKey is null for a book the feed doesn't carry (bet365): then the slip's own leg prices are the book's prices.
export function priceSlipLegs(slip: Slip, legEvents: (OddsEvent | null)[], bookKey: string | null, sharpKeys = SHARP_KEYS): PricedSlipLeg[] {
  return slip.legs.map((leg, i) => {
    const event = legEvents[i];
    const markets = (key: string | null) => (key && event?.bookmakers.find((b) => b.key === key)?.markets) || [];
    const label = legLabel(leg);
    const b = locate(markets(bookKey), leg);
    // A price printed on the slip is what the book is offering now; the feed's can lag.
    const bookOdds = leg.odds ?? b?.outcome.price ?? null;
    const quotes = sharpKeys.filter((k) => k !== bookKey).flatMap((k) => {
      const hit = locate(markets(k), leg);
      return hit ? sharpQuotes(event!.bookmakers, hit.key, hit.outcome, [k]) : [];
    });
    if (quotes.length) return { label, bookOdds, fair: consensus(quotes), source: "sharp", quotes };
    // An alternate number no sharp posts: carried over from the nearest sharp number.
    const alt = event && leg.line !== null ? deriveAlt(event.bookmakers, event.sport_key, b?.key ?? leg.market,
      b?.outcome ?? { name: feedSide(event, leg), point: leg.line }, b ? bookKey : null, sharpKeys.filter((k) => k !== bookKey)) : null;
    if (alt) return { label, bookOdds, fair: alt.fair, source: "derived", quotes: alt.quotes, derived: derivedNote(alt, b?.key ?? leg.market, null) };
    const p = locate(markets("pinnacle"), leg);
    if (p && p.sides.length === 1) return { label, bookOdds, fair: fairFrom(p.sides, p.outcome).fair, source: "sharp-1way" };
    // First/last TD scorer is one market with a price on every player: with no
    // sharp line, devig the book's whole field rather than assume a small margin.
    if (b && FIELD_MARKETS.includes(leg.market)) {
      const field = markets(bookKey).find((m) => m.key === b.key)?.outcomes.filter((o) => o.name !== "No") ?? [];
      const total = field.reduce((a, o) => a + impliedProb(o.price), 0);
      if (field.length > 2 && total > 1) return { label, bookOdds, fair: impliedProb(b.outcome.price) / total, source: "book-field" };
    }
    if (b) {
      const { fair, oneWay } = fairFrom(b.sides, b.outcome);
      return { label, bookOdds, fair, source: oneWay ? "book-1way" : "book" };
    }
    if (leg.odds != null) return { label, bookOdds, fair: impliedProb(leg.odds) / (1 + ONE_SIDED_MARGIN), source: "slip-1way" };
    return { label, bookOdds: null, fair: null, source: "none" };
  });
}

export type RuleUse = { rule: SgpRule; legs: [number, number]; cond: number; joint: number }; // fair chance both legs hit

export type SlipCheck = {
  priced: PricedSlipLeg[];
  missing: string[]; // legs with no price anywhere
  totalOdds: number;
  fairProb: number;
  method: "independent" | "correlation";
  correlation: number | null; // book SGP price vs its legs multiplied, >1 = legs win together
  eval: BetEval;
  boost: number;
  boostSource: "slip" | "promo" | null; // a boost the slip shows is what the book pays, so it wins over the promo's
  promoIssues: string[];
  rules: RuleUse[]; // redundant pairs priced exactly (sgp-rules.ts)
};

// Line shopping (the betting guide: a few cents better on the same bet adds up):
// for each leg, a better price on the same line at another of your books, or null.
// books: feed key -> name. Compares each book's price on the leg itself.
export function betterPrices(
  slip: Slip, legEvents: (OddsEvent | null)[], bookKey: string | null, books: Record<string, string>,
): ({ book: string; odds: number; mine: number; link?: string } | null)[] {
  return slip.legs.map((leg, i) => {
    const event = legEvents[i];
    const outcome = (key: string) => {
      const markets = event?.bookmakers.find((b) => b.key === key)?.markets ?? [];
      return locate(markets, leg)?.outcome ?? null;
    };
    const mine = leg.odds ?? (bookKey ? outcome(bookKey)?.price ?? null : null);
    if (mine === null) return null;
    let best: { book: string; odds: number; mine: number; link?: string } | null = null;
    for (const [key, name] of Object.entries(books)) {
      if (key === bookKey) continue;
      const o = outcome(key);
      if (o && americanToDecimal(o.price) > americanToDecimal(best?.odds ?? mine)) {
        // That book's own slip link (or its game link) for the 🛒 button.
        const link = o.link ?? event?.bookmakers.find((b) => b.key === key)?.link ?? undefined;
        best = { book: name, odds: o.price, mine, ...(link ? { link } : {}) };
      }
    }
    return best;
  });
}

// A slip someone shared: the same bet at each of your books, so the bot can ask
// "which book?" and hand back a link that puts it in that book's slip. A book
// is offered only when it posts every leg. odds is the legs multiplied (null on
// an SGP: the book's SGP price includes its correlation, which the feed lacks).
export type SlipOffer = { key: string; book: string; odds: number | null; legs: { selection: string; link: string | null; eventLink: string | null; start?: string | null }[] };

export function slipOffers(slip: Slip, legEvents: (OddsEvent | null)[], books: Record<string, string>): SlipOffer[] {
  const out: SlipOffer[] = [];
  for (const [key, book] of Object.entries(books)) {
    const legs: SlipOffer["legs"] = [];
    let decimal = 1;
    for (const [i, leg] of slip.legs.entries()) {
      const bm = legEvents[i]?.bookmakers.find((b) => b.key === key);
      const o = bm ? locate(bm.markets, leg)?.outcome : undefined;
      if (!o) break;
      decimal *= americanToDecimal(o.price);
      legs.push({ selection: legLabel(leg), link: o.link ?? null, eventLink: bm?.link ?? null, start: legEvents[i]?.commence_time ?? null });
    }
    if (legs.length < slip.legs.length || !legs.some((l) => l.link || l.eventLink)) continue;
    out.push({ key, book, odds: slip.bet_kind === "sgp" ? null : Math.round(decimalToAmerican(decimal)), legs });
  }
  // Best price first.
  return out.sort((a, b) => (b.odds === null || a.odds === null ? 0 : americanToDecimal(b.odds) - americanToDecimal(a.odds)));
}

export function formatBetterPrices(slip: Slip, book: string, better: ({ book: string; odds: number; mine: number } | null)[]): string | null {
  const lines = better.flatMap((b, i) => (b ? [`${legLabel(slip.legs[i])}: ${b.book} ${formatAmerican(b.odds)} vs ${book} ${formatAmerican(b.mine)}`] : []));
  if (!lines.length) return null;
  return [`💲 Better price elsewhere${slip.legs.length > 1 ? " (leg by leg, before any boost)" : ""}:`, ...lines].join("\n");
}

const toRuleLeg = (l: SlipLeg): RuleLeg => {
  const teamLeg = l.market === "h2h" || l.market === "spreads" || l.market === "team_totals";
  return {
    market: l.market, side: l.side, line: l.line,
    team: l.team ?? (l.market === "team_totals" ? l.team_or_player : teamLeg ? l.side : null),
    player: teamLeg ? null : l.team_or_player,
  };
};

// book: the slip's book, for its SGP rules.
// otherGame: true when a leg isn't from the one game the promo is for;
// offDate: true when a leg's game isn't on the promo's game_date.
export function checkSlip(slip: Slip, priced: PricedSlipLeg[], promo: Promo | null, book: string | null = null, otherGame = false, offDate = false): SlipCheck | null {
  const missing = priced.filter((l) => l.fair === null).map((l) => l.label);
  if (missing.length) return null;
  const fairs = priced.map((l) => l.fair!);
  const independent = fairs.reduce((a, b) => a * b, 1);
  const bookLegs = priced.map((l) => l.bookOdds);
  const totalOdds = slip.total_odds ??
    (bookLegs.every((o) => o !== null) ? Math.round(decimalToAmerican(bookLegs.reduce((d, o) => d * americanToDecimal(o!), 1))) : NaN);
  if (!Number.isFinite(totalOdds)) return null;

  let fairProb = independent, method: SlipCheck["method"] = "independent", correlation: number | null = null;
  // A rule's joint is a fact about the game, so it applies at every book.
  const blocks = slip.bet_kind === "sgp" ? findRuleBlocks(slip.legs.map(toRuleLeg), "any") : [];
  const covered = new Set(blocks.flatMap((b) => b.legs));
  const rules = blocks.map((b) => ({ ...b, joint: blockJoint(b, fairs[b.legs[0]], fairs[b.legs[1]]) }));
  // Each rule pair's exact joint over what independence would say.
  const ruleLift = (p: number[]) => blocks.reduce((m, b) => {
    const [i, j] = b.legs;
    return m * blockJoint(b, p[i], p[j]) / (p[i] * p[j]);
  }, 1);
  // Every leg in a rule pair: the pairs' joints are the whole story, and the
  // book's correlation (whatever it charges for them) doesn't come into it.
  if (blocks.length && covered.size === slip.legs.length) {
    fairProb = independent * ruleLift(fairs);
  } else if (slip.bet_kind === "sgp" && slip.legs.length > 1 && bookLegs.every((o) => o !== null)) {
    correlation = impliedProb(totalOdds) / bookLegs.reduce((p, o) => p * impliedProb(o!), 1);
    // The book's correlation is kept for the legs no rule covers; each rule
    // pair swaps the book's view of it (the same rule on the book's own
    // prices) for its exact fair joint.
    const bookP = bookLegs.map((o) => impliedProb(o!));
    fairProb = Math.min(0.99, independent * correlation * ruleLift(fairs) / ruleLift(bookP));
    method = "correlation";
  } else if (rules.length) {
    fairProb = independent * ruleLift(fairs);
  }

  const promoIssues = promo ? promoViolations(promo, { americanOdds: totalOdds, legs: slip.legs.length, kind: slip.bet_kind, league: slip.league ?? undefined }) : [];
  if (promo?.game && otherGame) promoIssues.push(`only ${promo.game} qualifies`);
  if (promo?.game_date && offDate) promoIssues.push(`only games on ${promo.game_date} qualify`);
  if (promo && slip.legs.some((l) => !marketAllowed(promo, l.market))) promoIssues.push(`only ${marketsLabel(promo)} bets qualify`);
  const promoBoost = promo && !promoIssues.length ? (promo.boost_pct ?? 0) / 100 : 0;
  const boostSource = slip.boost_pct ? "slip" : promoBoost ? "promo" : null;
  // Books round the boosted price down, so a price on the slip is what it pays: price from it, not the %.
  const shownBoost = slip.boosted_odds !== null ? americanToDecimal(slip.boosted_odds) - 1 : null;
  const boost = slip.boost_pct ? (shownBoost !== null ? shownBoost / (americanToDecimal(totalOdds) - 1) - 1 : slip.boost_pct / 100) : promoBoost;
  return { priced, missing, totalOdds, fairProb, method, correlation, eval: evaluateBet([fairProb], [totalOdds], boost), boost, boostSource, promoIssues, rules };
}

const SOURCE_NOTE: Record<PricedSlipLeg["source"], string> = {
  sharp: "",
  "sharp-1way": ` (Pinnacle posts only this side; assumed ${ONE_SIDED_MARGIN * 100}% margin)`,
  derived: "",
  book: " (no sharp line; the book's own price, devigged)",
  "book-1way": ` (no sharp line; the book's price, assumed ${ONE_SIDED_MARGIN * 100}% margin)`,
  "book-field": " (no sharp line; the book's whole scorer list devigged)",
  "slip-1way": ` (no sharp line; the slip's price, assumed ${ONE_SIDED_MARGIN * 100}% margin)`,
  none: "",
};

export function formatSlipCheck(slip: Slip, book: string, c: SlipCheck, promo: Promo | null, bankroll: number | null = null): string {
  const kind = slip.bet_kind === "sgp" ? "SGP" : slip.bet_kind === "parlay" ? `${slip.legs.length}-leg parlay` : "Single";
  const out = [`🧾 ${kind} on ${book}${slip.game ? `: ${slip.game}` : ""}`];
  c.priced.forEach((l, i) => {
    const bookPart = l.bookOdds !== null ? ` ${formatAmerican(l.bookOdds)}` : "";
    const sharp = l.quotes ? ` | ${l.quotes.map(formatQuote).join(", ")}` : "";
    const how = l.derived ? ` (${l.derived})` : SOURCE_NOTE[l.source];
    out.push(`${i + 1}. ${l.label}${bookPart}${sharp} -> fair ${formatAmerican(probToAmerican(l.fair!))} (${formatPct(l.fair!)})${how}`);
  });
  out.push("");
  const shown = c.boostSource === "slip" && slip.boosted_odds !== null ? formatAmerican(slip.boosted_odds) : formatAmerican(decimalToAmerican(c.eval.boostedDecimal));
  const pct = c.boostSource === "slip" ? slip.boost_pct! : Math.round(c.boost * 100);
  const whose = c.boostSource !== "slip" ? "" : slip.boost_entered ? " (your boost)" : " (the boost on the slip)";
  const boosted = c.boost ? `, boosted ${pct}% to ${shown}${whose}` : "";
  out.push(`Slip: ${formatAmerican(c.totalOdds)}${boosted}`);
  if (promo && c.promoIssues.length) out.push(`⚠️ Doesn't qualify for ${promo.title}: ${c.promoIssues.join("; ")}.${c.boostSource === "slip" ? "" : " Priced without the boost."}`);
  if (c.method === "correlation" && c.correlation !== null) {
    const legsAlone = c.priced.reduce((d, l) => d * americanToDecimal(l.bookOdds!), 1);
    out.push(`Legs alone on ${book}: ${formatAmerican(decimalToAmerican(legsAlone))}. The SGP price implies the legs ${c.correlation >= 1 ? "win together" : "work against each other"} (×${c.correlation.toFixed(2)}).`);
  }
  for (const r of c.rules) {
    const [i, j] = r.legs;
    const alone = r.cond === 1 ? `the same as leg ${i + 1} alone` : `about ${Math.round(r.cond * 100)}% of leg ${i + 1} alone`;
    out.push(`🧩 ${r.rule.title}: legs ${i + 1} + ${j + 1} together are worth ${formatPct(r.joint)} (FV ${formatAmerican(probToAmerican(r.joint))}), ${alone}. ${r.rule.why}`);
  }
  out.push(`Fair${c.method === "correlation" ? " (est.)" : ""}: ${formatPct(c.fairProb)} -> FV ${formatAmerican(probToAmerican(c.fairProb))}`);
  out.push("");
  const e = c.eval;
  out.push(`EV: ${e.ev >= 0 ? "+" : ""}${formatPct(e.ev)}`);
  if (e.kelly > 0) {
    const u = (f: number) => `${(f * 100).toFixed(2)}u`;
    out.push(`Kelly: Full ${u(e.kelly)} | 1/2 ${u(e.kelly / 2)} | 1/4 ${u(e.kelly / 4)} (1u = 1% bankroll)`);
    out.push(wagerLine(e.kelly, c.boost ? promo?.max_stake ?? null : null, bankroll)!);
  }
  if (c.method === "correlation") {
    out.push(e.ev > 0
      ? `Estimate trusts ${book}'s correlation pricing. It stays +EV unless ${book} adds more than ${formatPct(e.ev)} of extra SGP margin.`
      : `Estimate trusts ${book}'s correlation pricing, so any extra SGP margin makes it worse.`);
  }
  out.push(e.ev > 0 ? "✅ +EV — worth it at this price." : "❌ -EV — skip it, or try different legs.");
  return out.join("\n");
}

// Which game each leg is on: the matchup the slip prints with the leg, else
// the team it names (a draw or a game total names none), else, outside a
// parlay, the game the whole slip is on.
export function legEventIds<E extends EventRef>(slip: Slip, events: E[], now = new Date()): (string | null)[] {
  const whole = findEvent(events, slipNames(slip), now);
  return slip.legs.map((leg) => {
    const teams = leg.market === "h2h" || leg.market === "spreads" ? [leg.side, leg.team_or_player, leg.team] : [leg.team];
    const own = (leg.game ? findEvent(events, [leg.game], now) : null) ?? findEvent(events, teams, now);
    return (own ?? (slip.bet_kind === "parlay" ? null : whole))?.id ?? null;
  });
}
