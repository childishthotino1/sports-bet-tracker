// Promo rules: the JSON shape a promo screenshot is read into, the check that a
// candidate bet qualifies, and what a boost needs to be +EV. Pure — the vision
// call that fills this shape lives in promo-vision.ts.

import { americanToDecimal, formatAmerican } from "./odds.ts";
import { boostDecimal } from "./bet.ts";

export type PromoType = "profit_boost" | "free_bet" | "no_sweat" | "other";
export type BetKind = "single" | "parlay" | "sgp";

export type Promo = {
  book: string | null; // "BetMGM"; null when the screenshot doesn't show it — ask or use the chat's default
  title: string; // "MLB World Series 10% SGP Boost Token"
  type: PromoType;
  boost_pct: number | null; // 10 for a 10% profit boost
  max_stake: number | null; // dollars
  min_total_odds: number | null; // American, on the whole bet before the boost
  min_legs: number | null;
  max_legs: number | null;
  legs_apply_to: BetKind[]; // which bet kinds the leg limits cover; empty = all
  bet_kinds: BetKind[]; // empty = any
  leagues: string[]; // empty = any
  live: boolean;
  pregame: boolean;
  paid_in: "cash" | "bonus" | null; // how the boosted part of the win is paid
  expires_at: string | null; // as shown, "2026-10-29T08:07" (book's local time)
  notes: string | null;
};

// JSON schema for structured outputs. Every field is required (nullable where
// the screenshot may not say) so the model can't silently drop one.
export const PROMO_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "is_promo", "book", "title", "type", "boost_pct", "max_stake", "min_total_odds", "min_legs",
    "max_legs", "legs_apply_to", "bet_kinds", "leagues", "live", "pregame", "paid_in", "expires_at", "notes",
  ],
  properties: {
    is_promo: { type: "boolean" },
    book: { type: ["string", "null"] },
    title: { type: "string" },
    type: { type: "string", enum: ["profit_boost", "free_bet", "no_sweat", "other"] },
    boost_pct: { type: ["number", "null"] },
    max_stake: { type: ["number", "null"] },
    min_total_odds: { type: ["integer", "null"] },
    min_legs: { type: ["integer", "null"] },
    max_legs: { type: ["integer", "null"] },
    legs_apply_to: { type: "array", items: { type: "string", enum: ["single", "parlay", "sgp"] } },
    bet_kinds: { type: "array", items: { type: "string", enum: ["single", "parlay", "sgp"] } },
    leagues: { type: "array", items: { type: "string" } },
    live: { type: "boolean" },
    pregame: { type: "boolean" },
    // anyOf, not type: [..., "null"] + enum: the API rejects a null inside enum.
    paid_in: { anyOf: [{ type: "string", enum: ["cash", "bonus"] }, { type: "null" }] },
    expires_at: { type: ["string", "null"] },
    notes: { type: ["string", "null"] },
  },
} as const;

export const PROMO_PROMPT = `This is a screenshot of a sportsbook promotion. Read its rules into the JSON schema.

- book: the sportsbook's name as it brands itself (e.g. "BetMGM", "DraftKings"), only if its name or logo appears in the screenshot; otherwise null. Don't infer it from colors or layout.
- type: profit_boost for odds/profit boosts and boost tokens; free_bet for bonus bets; no_sweat for refunds on a loss.
- boost_pct: the boost percentage as a number (10 for "10%").
- max_stake: the maximum wager in dollars.
- min_total_odds: the minimum total odds in American format (+400 -> 400).
- bet_kinds: "sgp" for same game parlays, "parlay" for regular parlays, "single" for straight bets. Empty if any bet qualifies.
- min_legs / max_legs: leg-count limits, e.g. "4-25 Leg Parlays" -> 4 and 25.
- legs_apply_to: the bet_kinds those leg limits cover. "Same Game Parlay, 4-25 Leg Parlays" -> ["parlay"] (the SGP has no leg limit). Empty if the limits cover every eligible bet.
- leagues: league abbreviations such as "MLB" or "NBA". Empty if any league qualifies.
- live / pregame: whether live and pre-game bets qualify. If the promo doesn't say, both are true.
- paid_in: "cash" or "bonus", for how the boosted winnings are paid.
- expires_at: the expiry as YYYY-MM-DDTHH:MM in the time shown, or YYYY-MM-DD if only a date is shown; null if none is shown.
- notes: any other rule that limits which bets qualify (a specific event, a required market); null if none.

Use null for anything the screenshot doesn't state. Don't guess.

Set is_promo to false if the image isn't a sportsbook promotion (a bet slip, a scoreboard, anything else); the other fields don't matter then.`;

// PROMO_PROMPT plus the worked examples from promo-examples.md, so new
// screenshots are read the same way as the ones already checked.
export function promoPrompt(examplesMd: string): string {
  return examplesMd.trim() ? `${PROMO_PROMPT}\n\nPromos already read correctly, for reference:\n\n${examplesMd.trim()}` : PROMO_PROMPT;
}

// Each "## " section's title and its ```json block from promo-examples.md.
export function parseExamples(md: string): { title: string; json: unknown }[] {
  return md.split(/^## /m).slice(1).flatMap((section) => {
    const block = section.match(/```json\n([\s\S]*?)```/);
    return block ? [{ title: section.split("\n")[0].trim(), json: JSON.parse(block[1]) }] : [];
  });
}

// Validates and coerces the model's JSON. Throws on a shape that can't be a promo.
export function normalizePromo(raw: unknown): Promo {
  if (!raw || typeof raw !== "object") throw new Error("Promo JSON is not an object");
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const kinds = (v: unknown) => list(v).filter((k): k is BetKind => k === "single" || k === "parlay" || k === "sgp");

  const book = str(r.book);
  const type = (["profit_boost", "free_bet", "no_sweat", "other"] as const).find((t) => t === r.type) ?? "other";
  const minOdds = num(r.min_total_odds);

  return {
    book,
    title: str(r.title) ?? book ?? "Promo",
    type,
    boost_pct: num(r.boost_pct),
    max_stake: num(r.max_stake),
    min_total_odds: minOdds !== null && Math.abs(minOdds) >= 100 ? Math.round(minOdds) : null,
    min_legs: num(r.min_legs),
    max_legs: num(r.max_legs),
    legs_apply_to: kinds(r.legs_apply_to),
    bet_kinds: kinds(r.bet_kinds),
    leagues: list(r.leagues).map((l) => l.toUpperCase()),
    live: r.live !== false,
    pregame: r.pregame !== false,
    paid_in: r.paid_in === "cash" || r.paid_in === "bonus" ? r.paid_in : null,
    expires_at: str(r.expires_at),
    notes: str(r.notes),
  };
}

export type CandidateBet = {
  americanOdds?: number; // whole bet, pre-boost
  legs?: number;
  kind: BetKind;
  league?: string;
  live?: boolean;
  stake?: number;
};

// Every promo rule the bet breaks, as short reasons. Empty means it qualifies.
export function promoViolations(promo: Promo, bet: CandidateBet): string[] {
  const out: string[] = [];
  if (promo.bet_kinds.length && !promo.bet_kinds.includes(bet.kind)) {
    out.push(`must be ${promo.bet_kinds.join(" or ")}, not ${bet.kind}`);
  }
  if (bet.americanOdds !== undefined && promo.min_total_odds !== null && americanToDecimal(bet.americanOdds) < americanToDecimal(promo.min_total_odds)) {
    out.push(`odds ${formatAmerican(bet.americanOdds)} below minimum ${formatAmerican(promo.min_total_odds)}`);
  }
  if (bet.legs !== undefined && legLimitsApply(promo, bet.kind)) {
    const { min_legs: min, max_legs: max } = promo;
    if ((min !== null && bet.legs < min) || (max !== null && bet.legs > max)) {
      out.push(`${bet.kind} needs ${min ?? 1}${max !== null ? `-${max}` : "+"} legs, not ${bet.legs}`);
    }
  }
  if (bet.league && promo.leagues.length && !promo.leagues.includes(bet.league.toUpperCase())) {
    out.push(`${bet.league} not eligible (${promo.leagues.join(", ")} only)`);
  }
  if (bet.live === true && !promo.live) out.push("live bets not eligible");
  if (bet.live === false && !promo.pregame) out.push("pre-game bets not eligible");
  if (bet.stake !== undefined && promo.max_stake !== null && bet.stake > promo.max_stake) {
    out.push(`stake $${bet.stake} over max $${promo.max_stake}`);
  }
  return out;
}

export function legLimitsApply(promo: Promo, kind: BetKind): boolean {
  if (promo.min_legs === null && promo.max_legs === null) return false;
  return !promo.legs_apply_to.length || promo.legs_apply_to.includes(kind);
}

// The lowest fair win probability at which a boosted bet at these odds is
// break-even. Compare with the book's own implied probability (1 / decimal):
// the boost only beats the book's hold if fair p is above this.
export function breakEvenProb(americanOdds: number, boostPct: number): number {
  return 1 / boostDecimal(americanToDecimal(americanOdds), boostPct / 100);
}

// Largest stake to put on the promo: the Kelly amount, capped at the promo's
// max stake. Returns 0 for a -EV bet.
export function promoStake(promo: Promo, kellyFraction: number, bankroll: number): number {
  const kellyDollars = Math.max(0, kellyFraction) * bankroll;
  return promo.max_stake === null ? kellyDollars : Math.min(kellyDollars, promo.max_stake);
}
