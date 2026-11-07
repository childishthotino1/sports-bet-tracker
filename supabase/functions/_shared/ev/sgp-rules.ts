// Redundant-leg SGP rules: pairs of legs where one all but guarantees the
// other, so the pair is worth about the stronger leg alone. Books that price
// the pair that way hand out a free leg toward a promo's leg minimum; books
// that don't correlate it at all leave an edge. Either way the pair's fair
// price is known exactly, which the odds feed can't tell us for SGPs in
// general.
//
// Two sorts of rule:
// - Book rules (`books` listed): a book that lets you pair the legs, seen there
//   on `verified`. They drive the free legs in SGP suggestions. Books patch
//   these, so each records the book and when.
// - Forcing rules (`books` empty): pairs where one leg all but forces the
//   other (a TD and his team scoring 6), from noliver's #promos channel. They
//   hold at every book, so pricing applies every rule's joint at every book.
// To add one: a new entry here, and a new `kind` (with its pairing and joint
// probability below) only if the pattern is new.

import { samePerson, sameTeam } from "./names.ts";

export type SgpRuleKind =
  | "spread_with_moneyline" | "qb_td_with_teammate_td"
  | "stat_ladder" | "td_with_team_total" | "td_with_own_yards" | "double_double_with_stat";

export type SgpRule = {
  id: string;
  kind: SgpRuleKind;
  books: string[]; // book names as the bot shows them; empty for a forcing rule (every book)
  title: string;
  why: string;
  verified: string; // when this was last seen to hold
};

export const SGP_RULES: SgpRule[] = [
  {
    id: "thescore-spread-ml",
    kind: "spread_with_moneyline",
    books: ["theScore Bet"],
    title: "Spread + the same team's moneyline",
    why: "A favorite that covers -3.5 also won, and an underdog that wins outright also covered +3.5, so the pair is worth the stronger leg alone. theScore (formerly ESPN Bet) prices the pair as one line, so the extra leg counts toward the leg minimum for free.",
    verified: "2026-10-29",
  },
  {
    id: "dk-qb-receiver-td",
    kind: "qb_td_with_teammate_td",
    books: ["DraftKings"],
    title: "Receiver TD + his QB's passing TD",
    why: "When a pass-catcher scores, his QB has almost always thrown a TD, so the QB leg adds a leg (and price) for little extra risk.",
    verified: "2026-10-29",
  },
  {
    id: "stat-ladder",
    kind: "stat_ladder",
    books: [],
    title: "Two lines on the same stat",
    why: "Over the higher line is also over the lower one (2+ TDs means he scored), so the pair is worth the higher line alone.",
    verified: "2026-11-07",
  },
  {
    id: "td-team-total",
    kind: "td_with_team_total",
    books: [],
    title: "A TD + his team's total",
    why: "Each TD is 6 points for his team, so his TDs carry a low team-total Over with them (2+ TDs and Over 11.5 can't split; Over 13.5 needs one more point, a kick or a field goal).",
    verified: "2026-11-07",
  },
  {
    id: "td-own-yards",
    kind: "td_with_own_yards",
    books: [],
    title: "A TD + a low line on his own yards",
    why: "A player who scores almost always clears a low yardage line too (10+ receiving, 25+ rushing), so the yards leg adds a leg for little risk.",
    verified: "2026-11-07",
  },
  {
    id: "double-double-stat",
    kind: "double_double_with_stat",
    books: [],
    title: "Double-double + one of its stats",
    why: "A double-double is 10+ in two of points, rebounds and assists, so a big man's double-double carries his rebounds Over 9.5 (and a triple-double carries all three).",
    verified: "2026-11-07",
  },
];

// Chance the QB throws at least one TD given a teammate scores. Below 1 for
// rushing TDs by the "receiver", trick plays and a backup QB.
export const QB_TD_GIVEN_TEAMMATE_TD = 0.9;
// Chance his team clears a team total up to 2 points above his TDs' (2 TDs =
// 12, Over 13.5) given he scores: the extra points or any other score.
// Conservative; anything higher isn't forced.
export const TEAM_TOTAL_GIVEN_TDS = 0.9;
// Chance a scorer clears a low line on his own yards, or a double-double
// includes the stat named. Conservative: the TD can be a 1-yard plunge, the
// double-double points + assists.
export const NEAR_IMPLIED = 0.85;
// The lines a forcing rule takes as "low".
const LOW_YARDS: Record<string, number> = {
  player_reception_yds: 19.5, player_rush_yds: 29.5, player_rush_reception_yds: 29.5,
};
const DD_STATS = ["player_points", "player_rebounds", "player_assists"];

// The parts of a leg the rules look at; both slip legs and the bot's own
// priced legs map onto this.
export type RuleLeg = {
  market: string;
  side: string; // "Over" / "Yes" / a team name
  line: number | null;
  team: string | null; // the team the leg is on, if known
  player: string | null;
};

// [the leg that implies the other, the implied leg]; cond is the chance of the
// implied leg given the implying one (1 when it's certain).
export type RuleBlock = { rule: SgpRule; legs: [number, number]; cond: number };

const base = (m: string) => m.replace(/^alternate_/, "").replace(/_alternate$/, "");
const isSpread = (l: RuleLeg) => base(l.market) === "spreads";
const isMoneyline = (l: RuleLeg) => l.market === "h2h";
const over = (l: RuleLeg) => l.side.toLowerCase() === "over";
const yes = (l: RuleLeg) => l.side.toLowerCase() === "yes";
const isQbTd = (l: RuleLeg) => base(l.market) === "player_pass_tds" && over(l) && l.line === 0.5;
const samePlayer = (x: RuleLeg, y: RuleLeg) => !!x.player && !!y.player && samePerson(x.player, y.player);

// How many TDs the leg needs from its player: 1 for anytime, 2 for "2+ TDs".
export function tdCount(l: Pick<RuleLeg, "market" | "side" | "line">): number {
  if (l.market === "player_anytime_td" && l.side.toLowerCase() === "yes") return 1;
  if (base(l.market) === "player_tds_over" && l.side.toLowerCase() === "over" && l.line !== null) return Math.floor(l.line) + 1;
  return 0;
}

// Whether x implies y under this kind of rule, and the chance of y given x.
function implies(kind: SgpRuleKind, x: RuleLeg, y: RuleLeg): number | null {
  switch (kind) {
    case "spread_with_moneyline":
      // The favorite covering means it won; the underdog winning means it covered.
      if (!x.line && isSpread(x) || !y.line && isSpread(y)) return null;
      if (isSpread(x) && isMoneyline(y) && x.line! < 0 && sameTeam(x.side, y.side)) return 1;
      if (isMoneyline(x) && isSpread(y) && y.line! > 0 && sameTeam(x.side, y.side)) return 1;
      return null;
    case "qb_td_with_teammate_td":
      // x is a teammate's anytime TD, y the QB's passing TD.
      return tdCount(x) === 1 && isQbTd(y) && !!x.team && !!y.team && sameTeam(x.team, y.team) && !samePlayer(x, y)
        ? QB_TD_GIVEN_TEAMMATE_TD : null;
    case "stat_ladder": {
      if (!samePlayer(x, y)) return null;
      if (tdCount(x) > tdCount(y) && tdCount(y) > 0) return 1;
      const same = base(x.market) === base(y.market) && x.market.startsWith("player_") && !tdCount(x);
      return same && over(x) && over(y) && x.line !== null && y.line !== null && x.line > y.line ? 1 : null;
    }
    case "td_with_team_total": {
      const k = tdCount(x);
      if (!k || base(y.market) !== "team_totals" || !over(y) || y.line === null || !x.team || !y.team || !sameTeam(x.team, y.team)) return null;
      return y.line < 6 * k ? 1 : y.line < 6 * k + 2 ? TEAM_TOTAL_GIVEN_TDS : null;
    }
    case "td_with_own_yards": {
      const cap = LOW_YARDS[base(y.market)];
      return tdCount(x) && cap !== undefined && over(y) && y.line !== null && y.line <= cap && samePlayer(x, y) ? NEAR_IMPLIED : null;
    }
    case "double_double_with_stat": {
      if (!samePlayer(x, y) || !yes(x)) return null;
      const triple = x.market === "player_triple_double";
      if (!triple && x.market !== "player_double_double") return null;
      if (triple && y.market === "player_double_double" && yes(y)) return 1;
      if (!DD_STATS.includes(base(y.market)) || !over(y) || y.line === null || y.line > 9.5) return null;
      return triple ? 1 : NEAR_IMPLIED;
    }
  }
}

// Pairs a rule covers, each leg used once. `book` "any" applies every rule (a
// joint probability holds at every book); a book name applies only the rules
// seen on that book (free legs).
export function findRuleBlocks(legs: RuleLeg[], book: string | "any" | null): RuleBlock[] {
  const rules = book === "any" ? SGP_RULES
    : SGP_RULES.filter((r) => book && r.books.some((b) => b.toLowerCase() === book.toLowerCase()));
  const used = new Set<number>();
  const blocks: RuleBlock[] = [];
  for (const rule of rules) {
    legs.forEach((x, i) => {
      for (let j = 0; j < legs.length && !used.has(i); j++) {
        if (j === i || used.has(j)) continue;
        const cond = implies(rule.kind, x, legs[j]);
        if (cond === null) continue;
        blocks.push({ rule, legs: [i, j], cond });
        used.add(i); used.add(j);
      }
    });
  }
  return blocks;
}

// Chance both legs of a block hit, from each leg's own chance.
export function blockJoint(block: RuleBlock, implying: number, implied: number): number {
  return Math.min(implied, implying * block.cond);
}
