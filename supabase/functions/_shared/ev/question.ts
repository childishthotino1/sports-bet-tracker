// Reading a typed question ("what's a good bet on FanDuel for the Notre Dame
// ncaaf game"): which league and which book it names, if any. The game itself
// is found by findEvent (slip.ts), which matches nicknames and school names.

import { BOOK_ALIASES } from "../books/books.ts";

// League words, as people type them. Soccer words cover every soccer league.
const LEAGUE_WORDS: [RegExp, string[]][] = [
  [/\b(ncaaf|cfb|college football)\b/, ["NCAAF"]],
  [/\b(ncaab|cbb|college basketball|march madness)\b/, ["NCAAB"]],
  [/\bwnba\b/, ["WNBA"]],
  [/\bnba\b/, ["NBA"]],
  [/\bnfl\b/, ["NFL"]],
  [/\b(mlb|baseball)\b/, ["MLB"]],
  [/\b(nhl|hockey)\b/, ["NHL"]],
  [/\b(epl|premier league)\b/, ["EPL"]],
  [/\b(ucl|champions league)\b/, ["UCL"]],
  [/\bmls\b/, ["MLS"]],
  [/\bla ?liga\b/, ["LALIGA"]],
  [/\bserie a\b/, ["SERIEA"]],
  [/\bbundesliga\b/, ["BUNDESLIGA"]],
  [/\bsoccer\b/, ["EPL", "UCL", "MLS", "LALIGA", "SERIEA", "BUNDESLIGA"]],
];

// The leagues a question names; empty when it names none (search them all).
export function questionLeagues(text: string): string[] {
  const t = text.toLowerCase();
  return [...new Set(LEAGUE_WORDS.flatMap(([re, leagues]) => (re.test(t) ? leagues : [])))];
}

// Aliases too common as plain words to read as a book ("what's the score").
const NOT_A_BOOK = new Set(["SCORE", "CS"]);

// The sportsbook a question names ("on fanduel", "DK", "draft kings"), or null.
export function questionBook(text: string): string | null {
  const words = text.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    for (const key of [words[i] + (words[i + 1] ?? ""), words[i]]) {
      // "the score" is theScore only as "the score bet".
      if (key === "THESCORE" && words[i] === "THE" && words[i + 2] !== "BET") continue;
      if (!NOT_A_BOOK.has(key) && BOOK_ALIASES[key]) return BOOK_ALIASES[key];
    }
  }
  return null;
}
