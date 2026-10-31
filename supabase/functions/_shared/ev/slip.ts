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
import { promoViolations, type BetKind, type Promo } from "./promo.ts";
import { consensus, formatQuote, marketFamily, sameLine, sharpQuotes, SHARP_KEYS, type Quote } from "./sharp.ts";
import type { Market, OddsEvent, Outcome } from "./odds-api.ts";
import { lastWord, norm, samePerson, sameTeam } from "./names.ts";
import { blockJoint, findRuleBlocks, type RuleLeg, type SgpRule } from "./sgp-rules.ts";

export { samePerson, sameTeam };

// Markets the vision call may name; they're The Odds API's market keys.
export const SLIP_MARKETS = [
  "h2h", "spreads", "totals",
  // NFL / NCAAF
  "player_anytime_td", "player_pass_yds", "player_pass_tds", "player_rush_yds", "player_reception_yds", "player_receptions",
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
};

export type Slip = {
  book: string | null;
  league: string | null;
  bet_kind: BetKind;
  total_odds: number | null; // whole slip, before any boost
  game: string | null; // "Carolina Panthers @ Green Bay Packers" when the slip shows one
  legs: SlipLeg[];
};

export const SLIP_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["book", "league", "bet_kind", "total_odds", "game", "legs"],
  properties: {
    book: { type: "string" },
    league: { type: "string" },
    bet_kind: { type: "string", enum: ["single", "parlay", "sgp"] },
    total_odds: { type: "integer" },
    game: { type: "string" },
    legs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["team_or_player", "market", "line", "side", "team", "game"],
        properties: {
          team_or_player: { type: "string" },
          team: { type: "string" },
          game: { type: "string" },
          market: { type: "string", enum: [...SLIP_MARKETS] },
          line: { type: ["number", "null"] },
          side: { type: "string" },
        },
      },
    },
  },
} as const;

export const SLIP_PROMPT = `If it's a bet slip (a bet being built or already placed), fill "slip". Use "" for unknown text and 0 for unknown numbers:
- book: the sportsbook, only if its name or logo is on screen; otherwise "".
- league: NFL, NCAAF, NBA, WNBA, NCAAB, MLB or NHL, or for soccer EPL, UCL, MLS, LALIGA, SERIEA or BUNDESLIGA, from the teams and competition.
- bet_kind: "sgp" if the slip says SGP / Same Game Parlay; "parlay" for legs from different games; "single" for one leg.
- total_odds: the slip's total odds before any boost, as American odds (+990 -> 990).
- game: "Away Team @ Home Team" as the slip shows it, for a single-game bet; else "".
- legs: one per selection.
  - team_or_player: the team (spreads, moneylines) or player (props), full name as shown; "" for game totals.
  - market: h2h for moneylines, spreads, totals, or the player prop's key (player_anytime_td for "Any Time Touchdown Scorer", player_reception_longest for "Longest Reception", player_rush_reception_yds for "Rush + Rec Yards", player_points, ... from the list; for soccer, h2h for the match result (side "Draw" for a draw), btts for Both Teams To Score, player_goal_scorer_anytime for Anytime Goalscorer); "other" if none fits.
  - line: the number with its sign for spreads (Panthers +3.5 -> 3.5), the total or prop line, null for moneylines and anytime TDs.
  - game: the matchup this leg is from, as the slip shows it above or beside the leg ("Brentford vs Nottingham Forest"); "" if none is shown.
  - team: the full team name the leg is on (for a player prop, the player's team, from the slip or the matchup); "" for game totals or if unsure.
  - side: "Over" or "Under" for totals and over/under props, "Yes" (or "No") for anytime scorer props and btts, the team name (or "Draw") for spreads and moneylines.`;

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
    return [{ team_or_player: str(o.team_or_player), market, line: num(o.line), side, team: str(o.team), game: str(o.game) }];
  });
  if (!legs.length) return null;
  const total = num(r.total_odds);
  const kind = r.bet_kind === "single" || r.bet_kind === "parlay" || r.bet_kind === "sgp" ? r.bet_kind : legs.length > 1 ? "parlay" : "single";
  return {
    book: str(r.book),
    league: str(r.league)?.toUpperCase() ?? null,
    bet_kind: kind,
    total_odds: total !== null && Math.abs(total) >= 100 ? Math.round(total) : null,
    game: str(r.game),
    legs,
  };
}

// ── Matching slip text to the feed ────────────────────────

// Does free text ("Carolina Panthers @ Green Bay Packers", "Packers ML") name this team?
function mentions(text: string, team: string): boolean {
  if (text.split(/ @ | vs\.? | at /i).some((part) => sameTeam(part, team))) return true;
  const nick = lastWord(team);
  return nick.length > 2 && ` ${norm(text)} `.includes(` ${nick} `);
}

type EventRef = Pick<OddsEvent, "id" | "home_team" | "away_team" | "commence_time">;

// Everything on a slip that might name a team.
export function slipNames(slip: Slip): string[] {
  return [slip.game, ...slip.legs.flatMap((l) => [l.team_or_player, l.side])].filter((x): x is string => !!x);
}

// The game these names point at: the event whose teams they mention most.
export function findEvent<E extends EventRef>(events: E[], texts: (string | null | undefined)[], now = new Date()): E | null {
  const names = texts.filter((x): x is string => !!x);
  let best: E | null = null, bestScore = 0;
  for (const ev of events) {
    let score = 0;
    for (const team of [ev.home_team, ev.away_team]) if (names.some((n) => mentions(n, team))) score++;
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
  if (marketKey.includes("totals")) return norm(o.name) === norm(leg.side) && o.point === leg.line;
  return !!o.description && !!leg.team_or_player && samePerson(o.description, leg.team_or_player) &&
    sideMatches(o, leg) && (leg.line === null || o.point === leg.line);
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

export type PricedSlipLeg = {
  label: string;
  bookOdds: number | null; // the book's own price for this leg, if the feed has it
  fair: number | null;
  source: "sharp" | "sharp-1way" | "book" | "book-1way" | "none";
  quotes?: Quote[]; // each sharp source's line, when source is "sharp"
};

function fairFrom(sides: Outcome[], outcome: Outcome): { fair: number; oneWay: boolean } {
  if (sides.length >= 2) return { fair: worstCaseDevig(sides.map((s) => s.price), sides.indexOf(outcome)).fair, oneWay: false };
  return { fair: impliedProb(outcome.price) / (1 + ONE_SIDED_MARGIN), oneWay: true };
}

export function legLabel(leg: SlipLeg): string {
  const stat = leg.market.replace(/^(player|batter|pitcher)_/, "").replace("anytime_td", "Anytime TD")
    .split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  const line = leg.line === null ? "" : leg.market === "spreads" && leg.line > 0 ? ` +${leg.line}` : ` ${leg.line}`;
  if (leg.market === "h2h") return `${leg.side} ML`;
  if (leg.market === "spreads") return `${leg.side}${line}`;
  if (leg.market === "totals") return `${leg.side}${line}`;
  if (leg.market === "player_anytime_td") return `${leg.team_or_player} Anytime TD`;
  if (leg.market === "player_goal_scorer_anytime") return `${leg.team_or_player} Anytime Goal`;
  if (leg.market === "btts") return `Both Teams To Score: ${leg.side}`;
  return `${leg.team_or_player ?? ""} ${leg.side}${line} ${stat}`.trim();
}

// legEvents[i] is the feed's odds for leg i's game (null if it wasn't found).
// Each sharp source that has the leg's line gives a quote; their fair prices
// are averaged. With none, a Pinnacle line posted one way only gets an assumed
// margin, and after that the book's own price is devigged.
export function priceSlipLegs(slip: Slip, legEvents: (OddsEvent | null)[], bookKey: string, sharpKeys = SHARP_KEYS): PricedSlipLeg[] {
  return slip.legs.map((leg, i) => {
    const event = legEvents[i];
    const markets = (key: string) => event?.bookmakers.find((b) => b.key === key)?.markets ?? [];
    const label = legLabel(leg);
    const b = locate(markets(bookKey), leg);
    const bookOdds = b?.outcome.price ?? null;
    const quotes = sharpKeys.filter((k) => k !== bookKey).flatMap((k) => {
      const hit = locate(markets(k), leg);
      return hit ? sharpQuotes(event!.bookmakers, hit.key, hit.outcome, [k]) : [];
    });
    if (quotes.length) return { label, bookOdds, fair: consensus(quotes), source: "sharp", quotes };
    const p = locate(markets("pinnacle"), leg);
    if (p && p.sides.length === 1) return { label, bookOdds, fair: fairFrom(p.sides, p.outcome).fair, source: "sharp-1way" };
    if (b) {
      const { fair, oneWay } = fairFrom(b.sides, b.outcome);
      return { label, bookOdds, fair, source: oneWay ? "book-1way" : "book" };
    }
    return { label, bookOdds: null, fair: null, source: "none" };
  });
}

export type RuleUse = { rule: SgpRule; legs: [number, number]; joint: number }; // fair chance both legs hit

export type SlipCheck = {
  priced: PricedSlipLeg[];
  missing: string[]; // legs with no price anywhere
  totalOdds: number;
  fairProb: number;
  method: "independent" | "correlation";
  correlation: number | null; // book SGP price vs its legs multiplied, >1 = legs win together
  eval: BetEval;
  boost: number;
  promoIssues: string[];
  rules: RuleUse[]; // redundant pairs priced exactly (sgp-rules.ts)
};

const toRuleLeg = (l: SlipLeg): RuleLeg => ({
  market: l.market, side: l.side, line: l.line,
  team: l.team ?? (l.market === "h2h" || l.market === "spreads" ? l.side : null),
  player: l.market === "h2h" || l.market === "spreads" ? null : l.team_or_player,
});

// book: the slip's book, for its SGP rules.
export function checkSlip(slip: Slip, priced: PricedSlipLeg[], promo: Promo | null, book: string | null = null): SlipCheck | null {
  const missing = priced.filter((l) => l.fair === null).map((l) => l.label);
  if (missing.length) return null;
  const fairs = priced.map((l) => l.fair!);
  const independent = fairs.reduce((a, b) => a * b, 1);
  const bookLegs = priced.map((l) => l.bookOdds);
  const totalOdds = slip.total_odds ??
    (bookLegs.every((o) => o !== null) ? Math.round(decimalToAmerican(bookLegs.reduce((d, o) => d * americanToDecimal(o!), 1))) : NaN);
  if (!Number.isFinite(totalOdds)) return null;

  let fairProb = independent, method: SlipCheck["method"] = "independent", correlation: number | null = null;
  const blocks = slip.bet_kind === "sgp" ? findRuleBlocks(slip.legs.map(toRuleLeg), book) : [];
  const rules = blocks.map((b) => ({ ...b, joint: blockJoint(b, fairs[b.legs[0]], fairs[b.legs[1]]) }));
  // Each rule pair's exact joint over what independence would say.
  const ruleLift = (p: number[]) => blocks.reduce((m, b) => {
    const [i, j] = b.legs;
    return m * blockJoint(b, p[i], p[j]) / (p[i] * p[j]);
  }, 1);
  if (slip.bet_kind === "sgp" && slip.legs.length > 1 && bookLegs.every((o) => o !== null)) {
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
  const boost = promo && !promoIssues.length ? (promo.boost_pct ?? 0) / 100 : 0;
  return { priced, missing, totalOdds, fairProb, method, correlation, eval: evaluateBet([fairProb], [totalOdds], boost), boost, promoIssues, rules };
}

const SOURCE_NOTE: Record<PricedSlipLeg["source"], string> = {
  sharp: "",
  "sharp-1way": ` (Pinnacle posts only this side; assumed ${ONE_SIDED_MARGIN * 100}% margin)`,
  book: " (no sharp line; the book's own price, devigged)",
  "book-1way": ` (no sharp line; the book's price, assumed ${ONE_SIDED_MARGIN * 100}% margin)`,
  none: "",
};

export function formatSlipCheck(slip: Slip, book: string, c: SlipCheck, promo: Promo | null): string {
  const kind = slip.bet_kind === "sgp" ? "SGP" : slip.bet_kind === "parlay" ? `${slip.legs.length}-leg parlay` : "Single";
  const out = [`🧾 ${kind} on ${book}${slip.game ? `: ${slip.game}` : ""}`];
  c.priced.forEach((l, i) => {
    const bookPart = l.bookOdds !== null ? ` ${formatAmerican(l.bookOdds)}` : "";
    const sharp = l.quotes ? ` | ${l.quotes.map(formatQuote).join(", ")}` : "";
    out.push(`${i + 1}. ${l.label}${bookPart}${sharp} -> fair ${formatAmerican(probToAmerican(l.fair!))} (${formatPct(l.fair!)})${SOURCE_NOTE[l.source]}`);
  });
  out.push("");
  const boosted = c.boost ? `, boosted ${Math.round(c.boost * 100)}% to ${formatAmerican(decimalToAmerican(c.eval.boostedDecimal))}` : "";
  out.push(`Slip: ${formatAmerican(c.totalOdds)}${boosted}`);
  if (promo && c.promoIssues.length) out.push(`⚠️ Doesn't qualify for ${promo.title}: ${c.promoIssues.join("; ")}. Priced without the boost.`);
  if (c.method === "correlation" && c.correlation !== null) {
    const legsAlone = c.priced.reduce((d, l) => d * americanToDecimal(l.bookOdds!), 1);
    out.push(`Legs alone on ${book}: ${formatAmerican(decimalToAmerican(legsAlone))}. The SGP price implies the legs ${c.correlation >= 1 ? "win together" : "work against each other"} (×${c.correlation.toFixed(2)}).`);
  }
  for (const r of c.rules) {
    const [i, j] = r.legs;
    out.push(`🧩 ${r.rule.title}: legs ${i + 1} + ${j + 1} together are worth ${formatPct(r.joint)} (FV ${formatAmerican(probToAmerican(r.joint))}), about leg ${i + 1} alone. ${r.rule.why}`);
  }
  out.push(`Fair${c.method === "correlation" ? " (est.)" : ""}: ${formatPct(c.fairProb)} -> FV ${formatAmerican(probToAmerican(c.fairProb))}`);
  out.push("");
  const e = c.eval;
  out.push(`EV: ${e.ev >= 0 ? "+" : ""}${formatPct(e.ev)}`);
  if (e.kelly > 0) {
    const u = (f: number) => `${(f * 100).toFixed(2)}u`;
    out.push(`Kelly: Full ${u(e.kelly)} | 1/2 ${u(e.kelly / 2)} | 1/4 ${u(e.kelly / 4)} (1u = 1% bankroll)`);
    out.push(wagerLine(e.kelly, c.boost ? promo?.max_stake ?? null : null)!);
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
