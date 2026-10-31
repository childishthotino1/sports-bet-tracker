// Redundant-leg SGP rules: pairs of legs where one all but guarantees the
// other, so the pair is worth about the stronger leg alone. Books that price
// the pair that way hand out a free leg toward a promo's leg minimum; books
// that don't correlate it at all leave an edge. Either way the pair's fair
// price is known exactly, which the odds feed can't tell us for SGPs in
// general.
//
// Books patch these, so each rule records the book it was seen on and when.
// To add one: a new entry here, and a new `kind` (with its pairing and joint
// probability below) only if the pattern is new.

import { samePerson, sameTeam } from "./names.ts";

export type SgpRuleKind = "spread_with_moneyline" | "qb_td_with_teammate_td";

export type SgpRule = {
  id: string;
  kind: SgpRuleKind;
  books: string[]; // book names as the bot shows them
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
];

// Chance the QB throws at least one TD given a teammate scores. Below 1 for
// rushing TDs by the "receiver", trick plays and a backup QB.
export const QB_TD_GIVEN_TEAMMATE_TD = 0.9;

// The parts of a leg the rules look at; both slip legs and the bot's own
// priced legs map onto this.
export type RuleLeg = {
  market: string;
  side: string; // "Over" / "Yes" / a team name
  line: number | null;
  team: string | null; // the team the leg is on, if known
  player: string | null;
};

export type RuleBlock = { rule: SgpRule; legs: [number, number] }; // [the leg that implies the other, the implied leg]

const isSpread = (l: RuleLeg) => l.market === "spreads" || l.market === "alternate_spreads";
const isMoneyline = (l: RuleLeg) => l.market === "h2h";
const isQbTd = (l: RuleLeg) => l.market === "player_pass_tds" && l.side.toLowerCase() === "over" && l.line === 0.5;
const isTd = (l: RuleLeg) => l.market === "player_anytime_td" && l.side.toLowerCase() === "yes";

// Pairs on this book that a rule covers. Each leg is used once.
export function findRuleBlocks(legs: RuleLeg[], book: string | null): RuleBlock[] {
  const rules = SGP_RULES.filter((r) => book && r.books.some((b) => b.toLowerCase() === book.toLowerCase()));
  const used = new Set<number>();
  const blocks: RuleBlock[] = [];
  const take = (rule: SgpRule, a: number, b: number) => { blocks.push({ rule, legs: [a, b] }); used.add(a); used.add(b); };
  for (const rule of rules) {
    legs.forEach((x, i) => {
      if (used.has(i)) return;
      const j = legs.findIndex((y, k) => !used.has(k) && k !== i && pairs(rule.kind, x, y));
      if (j < 0) return;
      // The implying leg comes first: the favorite's spread, the underdog's
      // moneyline, the teammate's TD.
      if (rule.kind === "spread_with_moneyline") take(rule, (x.line ?? 0) < 0 ? i : j, (x.line ?? 0) < 0 ? j : i);
      else take(rule, j, i);
    });
  }
  return blocks;
}

function pairs(kind: SgpRuleKind, x: RuleLeg, y: RuleLeg): boolean {
  if (kind === "spread_with_moneyline") {
    return isSpread(x) && x.line !== null && x.line !== 0 && isMoneyline(y) && sameTeam(x.side, y.side);
  }
  // x is the QB's passing TD, y a different player's anytime TD on his team.
  return isQbTd(x) && isTd(y) && !!x.team && !!y.team && sameTeam(x.team, y.team) &&
    !(x.player && y.player && samePerson(x.player, y.player));
}

// Chance both legs of a block hit, from each leg's own chance.
export function blockJoint(block: RuleBlock, implying: number, implied: number): number {
  if (block.rule.kind === "spread_with_moneyline") return Math.min(implying, implied);
  return Math.min(implied, implying * QB_TD_GIVEN_TEAMMATE_TD);
}
