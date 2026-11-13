// "Be specific": the user names a leg, a line or a game ("Lamar Jackson anytime
// TD", "Ravens -3.5", "over 220.5", "Ravens game") and every pick has to
// include it. This finds the priced legs the text means.

import type { PricedLeg } from "./picks.ts";
import { expandTeamAliases } from "./question.ts";

// "event|selection": one leg, as "Try something different" remembers it.
export function legKey(l: Pick<PricedLeg, "eventId" | "selection">): string {
  return `${l.eventId}|${l.selection}`;
}

const STOP = new Set([
  "a", "an", "the", "and", "or", "of", "to", "for", "in", "on", "at", "vs", "with", "include", "including", "add", "use",
  "leg", "legs", "bet", "bets", "game", "match", "me", "give", "want", "i", "some", "any", "please", "pick", "picks",
  "line", "lines", "prop", "props", "must", "have", "should", "be", "in", "it", "my", "one", "get", "put",
]);

// Words people type for a market, as the words its legs carry.
const SYNONYMS: Record<string, string> = {
  touchdown: "td", touchdowns: "td", tds: "td", scorer: "td", score: "td", scores: "td",
  moneyline: "ml", win: "ml", wins: "ml", o: "over", u: "under",
  pts: "points", point: "points", rebs: "rebounds", reb: "rebounds", boards: "rebounds", rebound: "rebounds",
  ast: "assists", asts: "assists", assist: "assists", "3s": "threes", "3pt": "threes", three: "threes", "3pm": "threes",
  yds: "yds", yards: "yds", yard: "yds", receptions: "receptions", catches: "receptions",
  spread: "spread", spreads: "spread", total: "total", totals: "total",
  half: "1st", "1h": "1st", first: "1st",
};

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9.+\- ]/g, " ").split(/\s+/).filter(Boolean);
const isNum = (w: string) => /^[+-]?\d+(\.\d+)?$/.test(w);
const canon = (w: string) => SYNONYMS[w] ?? w;

// The words a leg answers to: its selection and its market, and separately its game.
function legWords(l: PricedLeg): { sel: Set<string>; game: Set<string> } {
  const market = l.market.replace(/^alternate_/, "");
  const extra = [
    market.startsWith("h2h") ? "ml" : "",
    market.includes("spreads") ? "spread" : "",
    market.includes("totals") ? "total" : "",
    /_td$/.test(market) ? "td" : "",
    ...market.replace(/^(player|batter|pitcher)_/, "").split("_"),
  ];
  return {
    sel: new Set([...words(l.selection).map(canon), ...extra.filter(Boolean)]),
    game: new Set(words(l.game)),
  };
}

const has = (set: Set<string>, w: string) =>
  set.has(w) || (w.length >= 4 && [...set].some((x) => x.length >= 4 && (x.startsWith(w) || w.startsWith(x))));

export type MustMatch = { match: (l: PricedLeg) => boolean; label: string; game: boolean };

// The legs the text means, or null when nothing matches. A game alone ("Ravens
// game") means any leg from that game; anything more (a player, a market, a
// number) means legs that name it, preferring legs that name the team over
// legs that are only in its game (so "Ravens ML" isn't the other side's ML).
export function matchMust(legs: PricedLeg[], text: string): MustMatch | null {
  const all = words(expandTeamAliases(text)).filter((w) => !STOP.has(w)).map(canon);
  const nums = all.filter(isNum).map((n) => Math.abs(Number(n)));
  const toks = all.filter((w) => !isNum(w));
  if (!toks.length && !nums.length) return null;

  const scored = legs.flatMap((l) => {
    const w = legWords(l);
    if (!toks.every((t) => has(w.sel, t) || has(w.game, t))) return [];
    if (nums.length && (l.point === undefined || l.point === null || !nums.some((n) => Math.abs(Math.abs(l.point!) - n) < 1e-9))) return [];
    return [{ l, inGameOnly: toks.every((t) => has(w.game, t)), sel: toks.filter((t) => has(w.sel, t)).length }];
  });
  if (!scored.length) return null;

  // Only team words, no number: a game.
  if (!nums.length && scored.every((x) => x.inGameOnly)) {
    const ids = new Set(scored.map((x) => x.l.eventId));
    const games = [...new Set(scored.map((x) => x.l.game))];
    return { match: (l) => ids.has(l.eventId), label: games.length === 1 ? `a leg from ${games[0]}` : `a leg from ${games.join(" or ")}`, game: true };
  }
  const best = Math.max(...scored.map((x) => x.sel));
  const keys = new Set(scored.filter((x) => x.sel === best).map((x) => legKey(x.l)));
  const names = [...new Set(scored.filter((x) => x.sel === best).map((x) => x.l.selection))];
  return {
    match: (l) => keys.has(legKey(l)),
    label: names.length <= 2 ? names.join(" or ") : `${names.slice(0, 2).join(", ")} or ${names.length - 2} more like it`,
    game: false,
  };
}
