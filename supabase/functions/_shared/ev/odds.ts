// Odds conversions. American odds are integers like -150 / +122; decimal odds
// include the stake (+100 → 2.0).

export function americanToDecimal(american: number): number {
  if (american >= 100) return 1 + american / 100;
  if (american <= -100) return 1 + 100 / -american;
  throw new Error(`Invalid American odds: ${american}`);
}

export function decimalToAmerican(decimal: number): number {
  if (decimal <= 1) throw new Error(`Invalid decimal odds: ${decimal}`);
  return decimal >= 2 ? (decimal - 1) * 100 : -100 / (decimal - 1);
}

export function impliedProb(american: number): number {
  return 1 / americanToDecimal(american);
}

export function probToAmerican(p: number): number {
  if (p <= 0 || p >= 1) throw new Error(`Probability out of range: ${p}`);
  return decimalToAmerican(1 / p);
}

// "+350" / "-135". Rounds to the nearest whole number, so +349.5 shows as +350.
export function formatAmerican(american: number): string {
  const r = Math.round(american);
  return r > 0 ? `+${r}` : `${r}`;
}

export function formatPct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}
