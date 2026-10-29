// Builds the plain-text bet card (the paid-Discord format from the handoff
// brief). Platform-agnostic: Telegram and Discord adapters send it as-is.

import { DEVIG_METHODS, worstCaseDevig } from "./devig.ts";
import { correlatedLegs, evaluateBet, type BetEval } from "./bet.ts";
import { decimalToAmerican, formatAmerican, formatPct, probToAmerican } from "./odds.ts";

export type SharpSide = { label: string; odds: number };

export type Leg = {
  selection: string; // "John Collins Over 6.5 Rebounds (7+)"
  game?: string; // "DET @ NYK" — also used to flag same-game legs
  start?: string; // "8:10 PM"
  sharp?: { sides: SharpSide[]; betIndex?: number }; // raw sharp market to devig
  fairProb?: number; // or a fair probability supplied directly
};

export type BetCard = {
  title?: string; // "DK 50% NBA Profit Boost"
  book: string;
  legs: Leg[];
  bookOdds: number; // the book's American price for the whole bet (pre-boost)
  boost?: number; // fraction
  sharpSource?: string;
};

export type FormattedBet = { text: string; eval: BetEval; correlated: number[] };

function legFair(leg: Leg): number {
  if (leg.fairProb !== undefined) return leg.fairProb;
  if (!leg.sharp) throw new Error(`Leg "${leg.selection}" needs sharp odds or a fair probability`);
  return worstCaseDevig(leg.sharp.sides.map((s) => s.odds), leg.sharp.betIndex ?? 0).fair;
}

export function formatBet(card: BetCard): FormattedBet {
  const boost = card.boost ?? 0;
  const probs = card.legs.map(legFair);
  const ev = evaluateBet(probs, [card.bookOdds], boost);
  const correlated = correlatedLegs(card.legs.map((l) => l.game));
  const n = card.legs.length;

  const out: string[] = [];
  if (card.title) out.push(`@${card.title}`, "");

  out.push(`BET TO BUILD: ${n === 1 ? "Single" : `${n}-leg parlay`} on ${card.book}`);
  card.legs.forEach((leg, i) => {
    const where = [leg.game, leg.start].filter(Boolean).join(", ");
    out.push(`${i + 1}. ${leg.selection}${where ? ` | ${where}` : ""}`);
  });
  const bookLine = `Book odds: ${formatAmerican(card.bookOdds)}`;
  out.push(boost ? `${bookLine}, boosted to ${formatAmerican(decimalToAmerican(ev.boostedDecimal))}` : bookLine);
  out.push("");

  out.push(card.sharpSource ? `DEVIG (sharp source: ${card.sharpSource})` : "DEVIG");
  card.legs.forEach((leg, i) => {
    const fair = `fair ${formatAmerican(probToAmerican(probs[i]))} (${formatPct(probs[i])})`;
    const raw = leg.sharp
      ? leg.sharp.sides.map((s) => `${s.label} ${formatAmerican(s.odds)}`).join(" / ") + " -> "
      : "";
    out.push(`Leg ${i + 1}: ${raw}${fair}`);
  });
  if (card.legs.some((l) => l.sharp)) out.push(`Method: worst-case of ${DEVIG_METHODS.join(", ").replace("shin", "Shin")}`);
  if (n > 1) {
    out.push(`Parlay fair: ${formatPct(ev.fairProb)} -> FV ${formatAmerican(probToAmerican(ev.fairProb))}`);
    if (correlated.length) {
      out.push(`⚠️ Legs ${correlated.map((i) => i + 1).join(", ")} share a game and may be correlated; fair value assumes independence.`);
    }
  }
  out.push("");

  const units = (f: number) => `${(f * 100).toFixed(2)}u`;
  out.push(`EV: ${ev.ev >= 0 ? "+" : ""}${formatPct(ev.ev)}`);
  out.push(`Kelly: Full ${units(ev.kelly)} | 1/2 ${units(ev.kelly / 2)} | 1/4 ${units(ev.kelly / 4)} (1u = 1% bankroll)`);
  out.push(`FB: ${formatPct(ev.freeBet)}`);

  return { text: out.join("\n"), eval: ev, correlated };
}
