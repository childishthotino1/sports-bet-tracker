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
  [/\b(ufc|mma)\b/, ["UFC"]],
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
  // NFL nicknames the feed spells out.
  [/\bbucs\b/gi, "Buccaneers"],
  [/\bniners\b/gi, "49ers"],
  [/\bpats\b/gi, "Patriots"],
  [/\bjags\b/gi, "Jaguars"],
  [/\bphins\b/gi, "Dolphins"],
  [/\b(commies|commish)\b/gi, "Commanders"],
];
// Team abbreviations, as promos and slips print them ("TB vs CHI"), to the
// city or school the feed's team names start with ("Tampa Bay", "Chicago"), so
// the usual matching finds the game. NFL, NBA and NHL; where two teams share a
// city the abbreviation keeps the nickname (NYG, LAL). Abbreviations that are
// also common words (NO, WAS, MIN, CAR...) count only in capitals.
export const ABBREVIATIONS: Record<string, string> = {
  ARI: "Arizona", ATL: "Atlanta", BAL: "Baltimore", BUF: "Buffalo", CAR: "Carolina", CHI: "Chicago", CIN: "Cincinnati",
  CLE: "Cleveland", DAL: "Dallas", DEN: "Denver", DET: "Detroit", GB: "Green Bay", HOU: "Houston", IND: "Indianapolis",
  JAX: "Jacksonville", JAC: "Jacksonville", KC: "Kansas City", LV: "Las Vegas", LAC: "Los Angeles Chargers",
  LAR: "Los Angeles Rams", MIA: "Miami", MIN: "Minnesota", NE: "New England", NO: "New Orleans", NYG: "New York Giants",
  NYJ: "New York Jets", PHI: "Philadelphia", PIT: "Pittsburgh", SF: "San Francisco", SEA: "Seattle", TB: "Tampa Bay",
  TEN: "Tennessee", WAS: "Washington", WSH: "Washington",
  BKN: "Brooklyn", BRK: "Brooklyn", BOS: "Boston", CHA: "Charlotte", GSW: "Golden State", GS: "Golden State",
  LAL: "Los Angeles Lakers", MEM: "Memphis", MIL: "Milwaukee", NOP: "New Orleans", NYK: "New York Knicks",
  OKC: "Oklahoma City", ORL: "Orlando", PHX: "Phoenix", POR: "Portland", SAC: "Sacramento", SAS: "San Antonio",
  TOR: "Toronto", UTA: "Utah", UTAH: "Utah",
  CBJ: "Columbus", NJD: "New Jersey", NYR: "New York Rangers", NYI: "New York Islanders", VGK: "Vegas", TBL: "Tampa Bay",
  LAK: "Los Angeles Kings", SJS: "San Jose", STL: "St Louis", WPG: "Winnipeg", VAN: "Vancouver", CGY: "Calgary",
  EDM: "Edmonton", MTL: "Montreal", OTT: "Ottawa", NSH: "Nashville", COL: "Colorado", FLA: "Florida",
};
const WORDLIKE = new Set(["NO", "WAS", "MIN", "CAR", "SEA", "TEN", "DEN", "IND", "MIA", "COL", "BOS", "MEM", "GS", "NE", "SF", "TOR", "VAN", "OTT", "CHA", "MIL", "UTAH", "STL", "POR"]);
function expandAbbreviations(text: string): string {
  return text.replace(/\b[A-Za-z]{2,4}\b/g, (w) => {
    const up = w.toUpperCase();
    const full = ABBREVIATIONS[up];
    if (!full) return w;
    return WORDLIKE.has(up) && w !== up ? w : full;
  });
}

export function expandTeamAliases(text: string): string {
  return expandAbbreviations(TEAM_ALIASES.reduce((t, [re, name]) => t.replace(re, name), text));
}
