// The promo conversation: after a screenshot is read, ask for whatever it
// didn't show (buttons where the answers are a short list), then find picks or
// check a bet. A bet is checked from a slip screenshot (the bot handles that);
// typing its price is the fallback. Stateless — the bot stores FlowState per
// chat between messages and calls step() with each button tap or text reply.
// Button values stay short: Telegram caps callback_data at 64 bytes.

import { americanToDecimal, decimalToAmerican, formatAmerican, impliedProb, probToAmerican } from "./odds.ts";
import { evaluateBet } from "./bet.ts";
import { eligibleLeagues, legLimitsApply, normalizePromo, promoViolations, type BetKind, type Promo } from "./promo.ts";
import { SPORT_KEYS } from "./odds-api.ts";
import type { Slip } from "./slip.ts";
import type { OddsRange } from "./picks.ts";

export type Button = { label: string; value: string };
export type Prompt = { text: string; buttons: Button[][] }; // rows of buttons; [] = expects typed text

export type FlowState = {
  promo: Promo;
  step: "book" | "max_stake" | "action" | "sport" | "target" | "slip" | "fair" | "end";
  sport?: string; // league to search for picks, e.g. "NBA", or "ALL" for every one the promo covers
  target?: OddsRange; // odds the picks should land in; unset = any price that qualifies
  bookOdds?: number; // a typed price being checked, pre-boost; cleared after the verdict
  slip?: Slip; // a slip screenshot waiting to be priced (only while asking which book)
  noPromo?: boolean; // a slip sent with no promo in play: priced without a boost
};

// BetMGM first: nearly all shared bets are there.
export const BOOKS = ["BetMGM", "DraftKings", "FanDuel", "Caesars", "Fanatics", "bet365", "theScore Bet"];
const MARGINS = [15, 20, 25, 30];
const TARGETS = [200, 300, 400, 600, 1000];
const KIND_LABELS: Record<BetKind, string> = { sgp: "Same Game Parlay", parlay: "Parlay", single: "Straight bet" };

// State for a slip sent with no promo in play.
export function slipOnly(slip: Slip): FlowState {
  return { promo: normalizePromo({ title: "No promo" }), step: "action", slip, noPromo: true };
}

export function startFlow(promo: Promo): FlowState {
  return advance({ promo, step: "book" });
}

// Skips steps whose answer the screenshot already gave.
function advance(s: FlowState): FlowState {
  if (s.step === "book" && s.promo.book) s = { ...s, step: "max_stake" };
  if (s.step === "max_stake" && s.promo.max_stake !== null) s = { ...s, step: "action" };
  return s;
}

export function prompt(s: FlowState): Prompt {
  switch (s.step) {
    case "book":
      return {
        text: "Which sportsbook is this promo on?",
        buttons: [BOOKS.slice(0, 3), BOOKS.slice(3, 5), BOOKS.slice(5)].map((row) => row.map((b) => ({ label: b, value: b }))),
      };
    case "max_stake":
      return {
        text: "The screenshot doesn't show a max wager. What is it?",
        buttons: [["10", "25", "50", "100"].map((v) => ({ label: `$${v}`, value: v })), [{ label: "No max", value: "none" }]],
      };
    case "action":
      return {
        text: `${summary(s.promo)}${s.target ? `\n🎚 Target ${formatRange(s.target)}` : ""}\n\nWhat do you want to do?`,
        buttons: [
          [{ label: "🎯 Find the best bets", value: "picks" }],
          [{ label: "🔍 Check a bet I'm building", value: "check" }],
          [{ label: s.target ? "🎚 Change target odds" : "🎚 Set target odds", value: "target" }, { label: "✅ Done", value: "done" }],
        ],
      };
    case "sport": {
      const options = searchable(s.promo);
      const list = options.length ? options : Object.keys(SPORT_KEYS);
      const rows: Button[][] = [];
      for (let i = 0; i < list.length; i += 3) rows.push(list.slice(i, i + 3).map((l) => ({ label: LEAGUE_LABELS[l] ?? l, value: l })));
      rows.push([{ label: options.length ? "🌐 All of them" : "🌐 All sports", value: "ALL" }]);
      return { text: options.length > 1 ? "Which league should I search?" : "Which sport should I search?", buttons: rows };
    }
    case "target":
      return {
        text: "What odds should the picks add up to? Tap one, or type a price or a range (e.g. +450, or +400-600).",
        buttons: [
          TARGETS.slice(0, 3).map((t) => ({ label: `${formatAmerican(t)}+`, value: String(t) })),
          [...TARGETS.slice(3).map((t) => ({ label: `${formatAmerican(t)}+`, value: String(t) })), { label: "Any", value: "any" }],
        ],
      };
    case "slip":
      return { text: `Send a screenshot of the bet slip on ${s.promo.book ?? "the book"}. (Or type its total price before the boost, e.g. +350.)`, buttons: [] };
    case "fair":
      return {
        text: "How should I price it fairly? Pick the book's likely margin on this bet, or type a fair price (e.g. +425).",
        buttons: [MARGINS.map((m) => ({ label: `${m}% margin`, value: `m${m}` }))],
      };
    case "end":
      return { text: "👍 Send another promo screenshot anytime.", buttons: [] };
  }
}

export function summary(p: Promo): string {
  const rules = [
    p.boost_pct !== null ? `${p.boost_pct}% boost` : null,
    p.bet_kinds.length
      ? p.bet_kinds.map((k) => (legLimitsApply(p, k) ? `${KIND_LABELS[k]} (${legRange(p)})` : KIND_LABELS[k])).join(" / ")
      : null,
    p.leagues.length ? p.leagues.map((l) => (l === "SOCCER" ? "Soccer" : l)).join(", ") : null,
    p.min_total_odds !== null ? `min ${formatAmerican(p.min_total_odds)}` : null,
    p.max_stake !== null ? `max $${p.max_stake}` : "no max wager",
  ].filter(Boolean);
  return `📋 ${p.title}${p.book ? ` · ${p.book}` : ""}\n${rules.join(" · ")}${p.notes ? `\nℹ️ ${p.notes}` : ""}`;
}

// The leagues a search covers: the one picked, or for "ALL" every league the
// promo covers (every league the feed has, for a promo that names none).
export function leaguesToSearch(s: FlowState): string[] {
  if (s.sport && s.sport !== "ALL") return [s.sport];
  const options = searchable(s.promo);
  return s.sport === "ALL" ? (options.length ? options : Object.keys(SPORT_KEYS)) : options.slice(0, 1);
}

// The promo's leagues that the odds feed covers.
function searchable(p: Promo): string[] {
  return eligibleLeagues(p).filter((l) => SPORT_KEYS[l]);
}

// Button text for a league key.
const LEAGUE_LABELS: Record<string, string> = {
  EPL: "Premier League", UCL: "Champions League", LALIGA: "La Liga", SERIEA: "Serie A", BUNDESLIGA: "Bundesliga",
};

function legRange(p: Promo): string {
  return p.max_legs !== null ? `${p.min_legs ?? 2}-${p.max_legs} legs` : `${p.min_legs ?? 2}+ legs`;
}

// American odds from "+350", "350", "-120". Null for anything else.
export function parseAmerican(text: string): number | null {
  const m = text.trim().match(/^([+-]?)(\d{3,5})$/);
  if (!m) return null;
  const n = Number(m[2]) * (m[1] === "-" ? -1 : 1);
  return Math.abs(n) >= 100 ? n : null;
}

// "+400" means +400 up to +600 (profit no more than 1.5x the target's), so the
// picks land near the number rather than anywhere above it. "+400-600" or
// "+400 to +600" is an exact range. Null for anything else.
export function parseTarget(text: string): OddsRange | null {
  const parts = text.trim().replace(/(?<=\d)\s*(?:to|-|–)\s*(?=[+-]?\d)/i, " ").split(/\s+/);
  const min = parseAmerican(parts[0] ?? "");
  if (min === null || parts.length > 2) return null;
  if (parts.length === 2) {
    const max = parseAmerican(parts[1]);
    return max !== null && americanToDecimal(max) >= americanToDecimal(min) ? { min, max } : null;
  }
  const max = Math.round(decimalToAmerican(1 + 1.5 * (americanToDecimal(min) - 1)));
  return { min, max };
}

export function formatRange(r: OddsRange): string {
  return `${formatAmerican(r.min)} to ${formatAmerican(r.max)}`;
}

// action: work step() can't do itself (it's pure); the bot runs it and replies.
export type StepResult = { state: FlowState; reply?: string; action?: "picks" | "slip" };

// One user input: a tapped button's value, or typed text.
export function step(s: FlowState, input: string): StepResult {
  const v = input.trim();
  switch (s.step) {
    case "book": {
      const book = BOOKS.find((b) => b.toLowerCase() === v.toLowerCase());
      if (!book) return { state: s, reply: "Pick one of the books above." };
      const next = advance({ ...s, promo: { ...s.promo, book }, step: "max_stake" });
      // A slip was waiting on the book: price it now.
      if (s.slip) return { state: { ...next, step: "action" }, action: "slip" };
      return { state: next };
    }
    case "max_stake": {
      const max = v === "none" ? null : Number(v.replace("$", ""));
      if (max !== null && !(max > 0)) return { state: s, reply: "Pick a max wager above." };
      return { state: { ...s, promo: { ...s.promo, max_stake: max }, step: "action" } };
    }
    case "action":
      if (v === "check") return { state: { ...s, step: "slip" } };
      if (v === "picks") {
        // One searchable league: go. None named ("Any event") or several: ask.
        const leagues = searchable(s.promo);
        if (s.promo.leagues.length && !leagues.length) {
          // A league the odds feed isn't wired up for: say so rather than offer other sports.
          return { state: s, reply: `I don't have odds for ${s.promo.leagues.join(", ")} yet, so I can't search for picks. Build a bet and send me the slip screenshot instead.` };
        }
        if (leagues.length === 1) return { state: { ...s, sport: leagues[0] }, action: "picks" };
        return { state: { ...s, step: "sport" } };
      }
      if (v === "target") return { state: { ...s, step: "target" } };
      if (v === "done") return { state: { ...s, step: "end" } };
      return { state: s, reply: "Pick an option above." };
    case "target": {
      if (v.toLowerCase() === "any") return { state: { ...s, step: "action", target: undefined } };
      const target = parseTarget(v);
      if (!target) return { state: s, reply: "Tap a target, or type a price like +450 or a range like +400-600." };
      return { state: { ...s, step: "action", target } };
    }
    case "sport": {
      const sport = v.toUpperCase();
      if (sport === "ALL" || sport === "ANY") return { state: { ...s, step: "action", sport: "ALL" }, action: "picks" };
      const options = searchable(s.promo);
      if (!SPORT_KEYS[sport] || (options.length && !options.includes(sport))) return { state: s, reply: "Pick a sport above." };
      return { state: { ...s, step: "action", sport }, action: "picks" };
    }
    case "slip": {
      const odds = parseAmerican(v);
      if (odds === null) return { state: s, reply: "Send a bet slip screenshot, or a price like +350." };
      // Only the price is known here, so check the rules that don't need the legs.
      const kind = s.promo.bet_kinds.length === 1 ? s.promo.bet_kinds[0] : "parlay";
      const broken = promoViolations(s.promo, { americanOdds: odds, kind });
      if (broken.length) return { state: s, reply: `❌ Doesn't qualify: ${broken.join("; ")}. Send a different price.` };
      return { state: { ...s, step: "fair", bookOdds: odds } };
    }
    case "fair": {
      const margin = v.startsWith("m") ? Number(v.slice(1)) : null;
      const typed = margin === null ? parseAmerican(v) : null;
      if (margin === null && typed === null) return { state: s, reply: "Pick a margin or type a fair price like +425." };
      const bookOdds = s.bookOdds!;
      const fairP = margin !== null ? impliedProb(bookOdds) / (1 + margin / 100) : impliedProb(typed!);
      const basis = margin !== null ? `assumes a ${margin}% book margin` : "your price";
      const next: FlowState = { ...s, step: "action", bookOdds: undefined };
      return { state: next, reply: verdict(s.promo, bookOdds, fairP, basis) };
    }
    case "end":
      return { state: s };
  }
}

export function verdict(p: Promo, bookOdds: number, fairP: number, basis: string): string {
  const e = evaluateBet([fairP], [bookOdds], (p.boost_pct ?? 0) / 100);
  const units = (f: number) => `${(f * 100).toFixed(2)}u`;
  const lines = [
    `${p.book ?? "Book"}: ${formatAmerican(bookOdds)}, boosted to ${formatAmerican(decimalToAmerican(e.boostedDecimal))}`,
    `Fair: ${formatAmerican(probToAmerican(fairP))} (${(fairP * 100).toFixed(1)}%, ${basis})`,
    `EV: ${e.ev >= 0 ? "+" : ""}${(e.ev * 100).toFixed(1)}%`,
  ];
  if (e.kelly > 0) {
    lines.push(`Kelly: Full ${units(e.kelly)} | 1/2 ${units(e.kelly / 2)} | 1/4 ${units(e.kelly / 4)} (1u = 1% bankroll)`);
    if (p.max_stake !== null) lines.push(`Max wager $${p.max_stake}`);
  }
  lines.push(e.ev > 0 ? "✅ +EV — worth it at this price." : "❌ -EV — skip it, or find a better price.");
  return lines.join("\n");
}
