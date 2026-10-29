// The promo conversation: after a screenshot is read, ask for whatever it
// didn't show (buttons where the answers are a short list), then check a bet
// against the promo and price it. Stateless — the bot stores FlowState per
// chat between messages and calls step() with each button tap or text reply.
// Button values stay short: Telegram caps callback_data at 64 bytes.

import { decimalToAmerican, formatAmerican, impliedProb, probToAmerican } from "./odds.ts";
import { evaluateBet } from "./bet.ts";
import { legLimitsApply, promoViolations, type BetKind, type Promo } from "./promo.ts";

export type Button = { label: string; value: string };
export type Prompt = { text: string; buttons: Button[][] }; // rows of buttons; [] = expects typed text

export type FlowState = {
  promo: Promo;
  step: "book" | "max_stake" | "action" | "kind" | "legs" | "odds" | "fair" | "end";
  // The bet being checked; cleared after each verdict.
  kind?: BetKind;
  legs?: number;
  bookOdds?: number; // pre-boost
};

// BetMGM first: nearly all shared bets are there.
export const BOOKS = ["BetMGM", "DraftKings", "FanDuel", "Caesars", "Fanatics", "bet365", "theScore Bet"];
const MARGINS = [15, 20, 25, 30];
const KIND_LABELS: Record<BetKind, string> = { sgp: "Same Game Parlay", parlay: "Parlay", single: "Straight bet" };

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
        text: `${summary(s.promo)}\n\nWhat do you want to do?`,
        buttons: [[{ label: "🔍 Check a bet I'm building", value: "check" }], [{ label: "✅ Done", value: "done" }]],
      };
    case "kind":
      return {
        text: "What kind of bet?",
        buttons: [s.promo.bet_kinds.map((k) => ({ label: KIND_LABELS[k], value: k }))],
      };
    case "legs": {
      const min = s.promo.min_legs ?? 2;
      return {
        text: `How many legs? (${legRange(s.promo)} to qualify)`,
        buttons: [[0, 1, 2, 3, 4].map((i) => ({ label: `${min + i}`, value: `${min + i}` }))],
      };
    }
    case "odds":
      return { text: `Send the price for the whole bet on ${s.promo.book ?? "the book"}, before the boost (e.g. +350).`, buttons: [] };
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
    p.leagues.length ? p.leagues.join(", ") : null,
    p.min_total_odds !== null ? `min ${formatAmerican(p.min_total_odds)}` : null,
    p.max_stake !== null ? `max $${p.max_stake}` : "no max wager",
  ].filter(Boolean);
  return `📋 ${p.title}${p.book ? ` · ${p.book}` : ""}\n${rules.join(" · ")}${p.notes ? `\nℹ️ ${p.notes}` : ""}`;
}

function legRange(p: Promo): string {
  return p.max_legs !== null ? `${p.min_legs ?? 2}-${p.max_legs} legs` : `${p.min_legs ?? 2}+ legs`;
}

// After the bet kind is known: ask legs only when a leg limit covers it.
function afterKind(s: FlowState, kind: BetKind): FlowState {
  return { ...s, kind, step: legLimitsApply(s.promo, kind) ? "legs" : "odds" };
}

// American odds from "+350", "350", "-120". Null for anything else.
export function parseAmerican(text: string): number | null {
  const m = text.trim().match(/^([+-]?)(\d{3,5})$/);
  if (!m) return null;
  const n = Number(m[2]) * (m[1] === "-" ? -1 : 1);
  return Math.abs(n) >= 100 ? n : null;
}

export type StepResult = { state: FlowState; reply?: string };

// One user input: a tapped button's value, or typed text.
export function step(s: FlowState, input: string): StepResult {
  const v = input.trim();
  switch (s.step) {
    case "book": {
      const book = BOOKS.find((b) => b.toLowerCase() === v.toLowerCase());
      if (!book) return { state: s, reply: "Pick one of the books above." };
      return { state: advance({ ...s, promo: { ...s.promo, book }, step: "max_stake" }) };
    }
    case "max_stake": {
      const max = v === "none" ? null : Number(v.replace("$", ""));
      if (max !== null && !(max > 0)) return { state: s, reply: "Pick a max wager above." };
      return { state: { ...s, promo: { ...s.promo, max_stake: max }, step: "action" } };
    }
    case "action":
      if (v === "check") {
        if (s.promo.bet_kinds.length > 1) return { state: { ...s, step: "kind" } };
        return { state: afterKind(s, s.promo.bet_kinds[0] ?? "parlay") };
      }
      if (v === "done") return { state: { ...s, step: "end" } };
      return { state: s, reply: "Pick an option above." };
    case "kind": {
      const kind = s.promo.bet_kinds.find((k) => k === v);
      if (!kind) return { state: s, reply: "Pick a bet type above." };
      return { state: afterKind(s, kind) };
    }
    case "legs": {
      const legs = Number(v);
      if (!Number.isInteger(legs) || legs < 1) return { state: s, reply: "Send the number of legs, like 4." };
      const broken = promoViolations(s.promo, { kind: s.kind!, legs });
      if (broken.length) return { state: s, reply: `❌ Doesn't qualify: ${broken.join("; ")}. How many legs?` };
      return { state: { ...s, legs, step: "odds" } };
    }
    case "odds": {
      const odds = parseAmerican(v);
      if (odds === null) return { state: s, reply: "I need American odds like +350." };
      const broken = promoViolations(s.promo, { americanOdds: odds, kind: s.kind!, legs: s.legs });
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
      const next: FlowState = { ...s, step: "action", kind: undefined, legs: undefined, bookOdds: undefined };
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
