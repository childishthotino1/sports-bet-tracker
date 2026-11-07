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

// ── Group chats ───────────────────────────────────────────
// With Telegram's privacy mode off, a group's every message reaches the bot,
// so there it answers only what's meant for it: commands, messages that name
// it or reply to it, screenshots it can read, and short typed answers to the
// question it just asked.

// "@Bmorepromobot" anywhere in the text (Telegram usernames ignore case).
export function mentionsBot(text: string, username: string): boolean {
  return !!username && new RegExp(`@${username}\\b`, "i").test(text);
}

// The text without the bot's @mention, so it isn't read as part of the question.
export function stripMention(text: string, username: string): string {
  return username ? text.replace(new RegExp(`@${username}\\b`, "gi"), " ").replace(/\s+/g, " ").trim() : text.trim();
}

// A short typed answer to one of the bot's questions: a price or range (+350,
// +300-500), a dollar or % amount, or a word answer like "any" or "no boost".
export function looksLikeAnswer(text: string): boolean {
  return /^\s*([+-]?\$?\d[\d.,]*\s*[%k]?(\s*(-|–|to)\s*[+-]?\d[\d.,]*)?|any|any odds|none|no|no boost|no max)\s*$/i.test(text);
}

// Short names people type for teams whose feed names are longer: "man city" for
// Manchester City. Expanded before the game is matched.
const TEAM_ALIASES: [RegExp, string][] = [
  [/\bman(chester)? ?city\b/gi, "Manchester City"],
  [/\bman(chester)? ?(utd|united|u)\b/gi, "Manchester United"],
  [/\bspurs\b/gi, "Tottenham Hotspur"],
  [/\bwolves\b/gi, "Wolverhampton Wanderers"],
  [/\bnott(ingham|'?m)? ?forest\b/gi, "Nottingham Forest"],
  [/\b(newcastle|toon)\b(?! united)/gi, "Newcastle United"],
  [/\bwest ham\b(?! united)/gi, "West Ham United"],
  [/\bbrighton\b(?! and hove albion)/gi, "Brighton and Hove Albion"],
  [/\bpalace\b/gi, "Crystal Palace"],
  [/\bvilla\b/gi, "Aston Villa"],
  [/\bbarca\b/gi, "Barcelona"],
  [/\b(psg|paris sg)\b/gi, "Paris Saint Germain"],
  [/\binter miami\b/gi, "Inter Miami CF"],
];
export function expandTeamAliases(text: string): string {
  return TEAM_ALIASES.reduce((t, [re, name]) => t.replace(re, name), text);
}
