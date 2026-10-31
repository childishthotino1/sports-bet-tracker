// Builds the plain-text bet card (the paid-Discord format from the handoff
// brief). Platform-agnostic: Telegram and Discord adapters send it as-is.

import { DEVIG_METHODS, worstCaseDevig } from "./devig.ts";
import { correlatedLegs, evaluateBet, wagerLine, type BetEval } from "./bet.ts";
import { decimalToAmerican, formatAmerican, formatPct, probToAmerican } from "./odds.ts";
import { formatQuote, type Quote } from "./sharp.ts";

export type SharpSide = { label: string; odds: number };

export type Leg = {
  selection: string; // "John Collins Over 6.5 Rebounds (7+)"
  bookOdds?: number; // the book's price on this leg alone, shown next to it
  game?: string; // "DET @ NYK" — also used to flag same-game legs
  start?: string; // "8:10 PM"
  sharp?: { sides: SharpSide[]; betIndex?: number }; // raw sharp market to devig
  fairProb?: number; // or a fair probability supplied directly
  quotes?: Quote[]; // the sharp sources behind fairProb, shown on the card
};

export type BetCard = {
  title?: string; // "DK 50% NBA Profit Boost"
  book: string;
  legs: Leg[];
  bookOdds: number; // the book's American price for the whole bet (pre-boost)
  boost?: number; // fraction
  sharpSource?: string; // defaults to the sources in the legs' quotes
  maxStake?: number | null; // the promo's max wager, to cap the suggested stakes
  kindLabel?: string; // "SGPx (one leg per game)"; default "Single" / "n-leg parlay"
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

  out.push(`BET TO BUILD: ${card.kindLabel ?? (n === 1 ? "Single" : `${n}-leg parlay`)} on ${card.book}`);
  card.legs.forEach((leg, i) => {
    const where = [leg.game, leg.start].filter(Boolean).join(", ");
    const price = leg.bookOdds !== undefined ? ` ${formatAmerican(leg.bookOdds)}` : "";
    out.push(`${i + 1}. ${leg.selection}${price}${where ? ` | ${where}` : ""}`);
  });
  const bookLine = `Book odds: ${formatAmerican(card.bookOdds)}`;
  out.push(boost ? `${bookLine}, boosted to ${formatAmerican(decimalToAmerican(ev.boostedDecimal))}` : bookLine);
  out.push("");

  const sources = card.sharpSource ?? [...new Set(card.legs.flatMap((l) => l.quotes?.map((q) => q.source) ?? []))].join(", ");
  out.push(sources ? `DEVIG (sharp source: ${sources})` : "DEVIG");
  card.legs.forEach((leg, i) => {
    const fair = `fair ${formatAmerican(probToAmerican(probs[i]))} (${formatPct(probs[i])})`;
    const raw = leg.quotes?.length
      ? leg.quotes.map(formatQuote).join(", ") + " -> "
      : leg.sharp
      ? leg.sharp.sides.map((s) => `${s.label} ${formatAmerican(s.odds)}`).join(" / ") + " -> "
      : "";
    out.push(`Leg ${i + 1}: ${raw}${fair}`);
  });
  const methods = DEVIG_METHODS.join(", ").replace("shin", "Shin");
  if (card.legs.some((l) => (l.quotes?.length ?? 0) > 1)) out.push(`Method: worst-case of ${methods} per source; Pinnacle is half on game lines, the rest weighted to the tighter holds (% = hold)`);
  else if (card.legs.some((l) => l.sharp || l.quotes?.length)) out.push(`Method: worst-case of ${methods}`);
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
  const wager = wagerLine(ev.kelly, card.maxStake ?? null);
  if (wager) out.push(wager);

  return { text: out.join("\n"), eval: ev, correlated };
}
