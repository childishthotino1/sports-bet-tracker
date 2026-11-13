// Narrowing a typed question: "Knicks game plays, not player props",
// "Brunson points", "nba spreads tonight", "Ravens 1st half total", "nfl anytime
// TD props". questionFilter reads what kind of lines the question wants (main
// lines or props, which markets, which period); questionMarkets turns that into
// the feed markets to ask for, so a narrow question costs fewer credits; and
// wantLeg keeps the priced legs that fit. What's left of the text once the
// filter, league, book and filler words are gone (questionRest) is matched
// against the legs' names (matchMust) to find a player or a team's side.

import { BOOK_ALIASES } from "../books/books.ts";
import { ABBREVIATIONS } from "./question.ts";
import { formatStart, type PricedLeg } from "./picks.ts";
import { formatAmerican, probToAmerican } from "./odds.ts";

export type Mode = "all" | "main" | "props";
export type Period = "h1" | "q1";
export type QuestionFilter = {
  mode: Mode | null;   // null: the question doesn't say (the /settings mode applies)
  main: string[];      // game-line markets named: h2h, spreads, totals, team_totals
  stats: string[];     // prop stats named, as STAT keys
  periods: Period[];   // 1st half / 1st quarter
};

// Prop stats, as people type them, and their feed markets per sport family.
const STATS: [RegExp, string, Partial<Record<Family, string[]>>][] = [
  [/\b(anytime\s+)?(td|tds|touchdowns?)\b|\btd scorers?\b/, "td", { football: ["player_anytime_td"] }],
  [/\b(1st|first)\s+(td|touchdown)( scorer)?\b/, "first_td", { football: ["player_1st_td"] }],
  [/\bpass(ing)?\s+(yds|yards)\b/, "pass_yds", { football: ["player_pass_yds"] }],
  [/\bpass(ing)?\s+(td|tds|touchdowns)\b/, "pass_tds", { football: ["player_pass_tds"] }],
  [/\brush(ing)?\s+(yds|yards)\b/, "rush_yds", { football: ["player_rush_yds"] }],
  [/\b(rec(eiving)?)\s+(yds|yards)\b/, "rec_yds", { football: ["player_reception_yds"] }],
  [/\b(receptions|catches)\b/, "receptions", { football: ["player_receptions"] }],
  [/\b(pra|points\s*(\+|and)?\s*rebounds\s*(\+|and)?\s*assists)\b/, "pra", { basketball: ["player_points_rebounds_assists"] }],
  [/\b(points|pts)\b/, "points", { basketball: ["player_points"], hockey: ["player_points"] }],
  [/\b(rebounds|rebs|boards)\b/, "rebounds", { basketball: ["player_rebounds"] }],
  [/\b(assists|asts)\b/, "assists", { basketball: ["player_assists"], hockey: ["player_assists"] }],
  [/\b(threes|3s|3pt|3-pointers|three pointers)\b/, "threes", { basketball: ["player_threes"] }],
  [/\b(blocks)\b/, "blocks", { basketball: ["player_blocks"] }],
  [/\b(steals)\b/, "steals", { basketball: ["player_steals"] }],
  [/\bdouble[- ]doubles?\b/, "double_double", { basketball: ["player_double_double"] }],
  [/\b(shots on goal|sog)\b/, "sog", { hockey: ["player_shots_on_goal"] }],
  [/\bgoals?\b(?! ?scorer)/, "goals", { hockey: ["player_goals"] }],
  [/\b(goal ?scorers?|anytime goal|to score)\b/, "goal_scorer", { soccer: ["player_goal_scorer_anytime"], hockey: ["player_goal_scorer_anytime"] }],
  [/\b(hits)\b/, "hits", { baseball: ["batter_hits"] }],
  [/\b(home runs?|hrs?|homers?)\b/, "home_runs", { baseball: ["batter_home_runs"] }],
  [/\btotal bases\b/, "total_bases", { baseball: ["batter_total_bases"] }],
  [/\b(strikeouts|ks)\b/, "strikeouts", { baseball: ["pitcher_strikeouts"] }],
];

type Family = "football" | "basketball" | "baseball" | "hockey" | "soccer";
export function sportFamily(sportKey: string): Family {
  if (sportKey.startsWith("americanfootball")) return "football";
  if (sportKey.startsWith("basketball")) return "basketball";
  if (sportKey.startsWith("baseball")) return "baseball";
  if (sportKey.startsWith("icehockey")) return "hockey";
  return "soccer";
}

const NO_PROPS = /\b(no|not|without|skip|exclude|except|but not|minus)\s+(any\s+)?(player\s+)?props?\b|\bnon[- ]?props?\b/;
const NO_MAIN = /\b(no|not|without|skip|exclude|except)\s+(main ?lines?|game lines|sides|spreads?)\b/;
const PROPS = /\b(player\s+)?props?\b/;
const MAIN = /\b(main ?lines?|game lines|sides)\b/;

export function questionFilter(text: string): QuestionFilter {
  let t = ` ${text.toLowerCase().replace(/[^a-z0-9+./\- ]/g, " ").replace(/\s+/g, " ")} `;
  const periods: Period[] = [];
  if (/\b(1st|first)[ -]?(half|h)\b|\b1h\b|\bfirst-half\b/.test(t)) periods.push("h1");
  if (/\b(1st|first)[ -]?(quarter|q)\b|\b1q\b/.test(t)) periods.push("q1");

  const main: string[] = [];
  if (/\bteam totals?\b/.test(t)) { main.push("team_totals"); t = t.replace(/\bteam totals?\b/g, " "); }
  if (/\b(moneylines?|money line|ml|to win|winners?)\b/.test(t)) main.push("h2h");
  if (/\b(spreads?|ats|point spread|handicap)\b/.test(t)) main.push("spreads");
  if (/\b(game totals?|totals?|over\/under|o\/u)\b/.test(t)) main.push("totals");

  const stats = STATS.filter(([re]) => re.test(t)).map(([, key]) => key)
    // "1st TD" isn't also an anytime TD; "PRA" isn't also points.
    .filter((k, _, all) => !(k === "td" && all.includes("first_td")) && !(k === "points" && all.includes("pra")));

  let mode: Mode | null = null;
  if (NO_PROPS.test(t)) mode = "main";
  else if (NO_MAIN.test(t)) mode = "props";
  else if ((PROPS.test(t) || stats.length) && !main.length && !MAIN.test(t)) mode = "props";
  else if ((MAIN.test(t) || main.length || periods.length) && !stats.length && !PROPS.test(t)) mode = "main";
  else if (stats.length || PROPS.test(t)) mode = "all";
  return { mode, main, stats, periods };
}

const narrow = (f: QuestionFilter) => f.main.length > 0 || f.stats.length > 0 || f.periods.length > 0;

const lookupBase = (m: string) => m.replace(/^alternate_/, "").replace(/_alternate$/, "");
const PERIOD = /_(h1|q1)$/;

// The feed markets a question needs at one game, or null to use the default set.
export function questionMarkets(f: QuestionFilter, sportKey: string): string[] | null {
  if (!narrow(f)) return null;
  const out: string[] = [];
  const lines = f.main.length ? f.main : f.periods.length && !f.stats.length ? ["h2h", "spreads", "totals"] : [];
  for (const m of lines) {
    if (f.periods.length && m !== "team_totals") {
      for (const p of f.periods) out.push(`${m}_${p}`, ...(m === "totals" && p === "h1" ? ["alternate_totals_h1"] : []));
    } else {
      out.push(m, ...(m === "spreads" || m === "totals" || m === "team_totals" ? [`alternate_${m}`] : []));
    }
  }
  // The main line rides along so the answer can still note blowout risk and teasers.
  if (f.stats.length && !out.includes("spreads")) out.push("spreads");
  const fam = sportFamily(sportKey);
  for (const [, key, markets] of STATS) if (f.stats.includes(key)) out.push(...(markets[fam] ?? []));
  return [...new Set(out)];
}

// Whether a priced leg is one the question asks for.
export function wantLeg(f: QuestionFilter, l: Pick<PricedLeg, "market" | "sportKey">): boolean {
  const m = lookupBase(l.market);
  const prop = /^(player|batter|pitcher)_/.test(m);
  if (f.mode === "main" && prop) return false;
  if (f.mode === "props" && !prop) return false;
  if (!narrow(f)) return true;
  if (prop) {
    const fam = sportFamily(l.sportKey);
    return STATS.some(([, key, markets]) => f.stats.includes(key) && (markets[fam] ?? []).includes(m));
  }
  if (!f.main.length && !f.periods.length) return false; // only props named
  const period = m.match(PERIOD)?.[1] as Period | undefined;
  if (f.periods.length ? !period || !f.periods.includes(period) : !!period) return false;
  return !f.main.length || f.main.includes(m.replace(PERIOD, ""));
}

// The text without the words the filter, league and book already read, or
// filler ("good bets on", "tonight"): what's left names a team or a player.
const FILLER = new Set([
  "what", "whats", "what's", "are", "is", "the", "a", "an", "any", "anything", "good", "best", "top", "great", "bet", "bets", "betting",
  "play", "plays", "pick", "picks", "lean", "leans", "on", "for", "in", "at", "vs", "v", "@", "and", "or", "with", "to", "of",
  "tonight", "today", "tomorrow", "this", "week", "weekend", "now", "game", "games", "match", "matches", "slate", "lines", "line",
  "main", "mainlines", "mainline", "props", "prop", "player", "players", "not", "no", "only", "just", "without", "skip", "except",
  "show", "me", "give", "find", "look", "lookup", "up", "get", "odds", "price", "prices", "value", "edge", "ev", "+ev", "please",
  "how", "about", "there", "some", "i", "want", "like", "should", "can", "you", "do", "sides", "markets", "market", "events",
  "nfl", "nba", "wnba", "ncaaf", "ncaab", "cfb", "cbb", "mlb", "nhl", "epl", "ucl", "mls", "soccer", "football", "basketball", "baseball", "hockey", "college",
  "laliga", "liga", "serie", "bundesliga", "premier", "league", "champions",
  "ufc", "mma", "fight", "fights", "card", "fighter", "fighters", "bout",
]);
export function questionRest(text: string): string {
  const books = new Set(Object.keys(BOOK_ALIASES).map((k) => k.toLowerCase()));
  return text.replace(/[?!,;:]/g, " ").split(/\s+/).map((w) => w.replace(/\.+$/, ""))
    .filter((w) => w && (!FILLER.has(w.toLowerCase()) || (w === w.toUpperCase() && w in ABBREVIATIONS)) && !books.has(w.toLowerCase().replace(/[^a-z0-9]/g, "")))
    .join(" ").trim();
}

// The rest without market words ("Ja'Marr Chase TD" -> "Ja'Marr Chase"): the
// names a question gives, to say which one wasn't found.
export function questionNames(text: string): string {
  let t = ` ${questionRest(text)} `;
  for (const [re] of STATS) t = t.replace(new RegExp(re.source, "gi"), " ");
  for (const re of [/\bteam totals?\b/gi, /\b(moneylines?|money line|ml|to win|spreads?|ats|totals?|over|under|o\/u|alt(ernate)?)\b/gi,
    /\b(1st|first)[ -]?(half|quarter|h|q)\b|\b(1h|1q)\b/gi, /\b(player\s+)?props?\b/gi, /(^|\s)[+-]?\d+(\.\d+)?(?=\s|$)/g]) t = t.replace(re, " ");
  return t.replace(/\s+/g, " ").trim();
}

// What the filter narrowed to, for the answer's first line ("main lines",
// "1st half spreads", "points and rebounds props").
export function filterLabel(f: QuestionFilter): string | null {
  const names: Record<string, string> = { h2h: "moneylines", spreads: "spreads", totals: "totals", team_totals: "team totals" };
  const period = f.periods.map((p) => (p === "h1" ? "1st half" : "1st quarter")).join(" and ");
  const parts = [
    ...f.main.map((m) => names[m]),
    ...(f.periods.length && !f.main.length && !f.stats.length ? ["lines"] : []),
    ...(f.stats.length ? [`${f.stats.map((s) => s.replace(/_/g, " ").replace("td", "TD").replace("pra", "PRA").replace("sog", "shots on goal")).join(" / ")} props`] : []),
  ];
  if (parts.length) return [period, parts.join(", ")].filter(Boolean).join(" ");
  return f.mode === "main" ? "main lines (no props)" : f.mode === "props" ? "player props" : null;
}

// A whole league's best prices ("nba spreads tonight", "nfl TD props"): every
// leg across the slate at its best book against the sharp price, best edge first.
export function formatSlate(league: string, legs: (PricedLeg & { book: string })[], label: string | null, games: number, top = 8): string {
  const head = `🔎 ${league}${label ? ` ${label}` : ""}: best prices across ${games} upcoming game${games === 1 ? "" : "s"}`;
  if (!legs.length) return `${head}\nThe sharp sources (Pinnacle and the exchanges) don't price ${label ? "those" : "these"} lines yet. Try closer to game time, or name a game.`;
  const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
  const lines = legs.slice(0, top).map((l, i) =>
    `${i + 1}. ${l.edge > 0 ? "✅ " : ""}${l.selection} ${formatAmerican(l.bookOdds)} at ${l.book} (fair ${formatAmerican(probToAmerican(l.fair))}, ${pct(l.edge)}) | ${l.game}, ${formatStart(l.start)}`);
  const plus = legs.filter((l) => l.edge > 0).length;
  return [
    head,
    ...lines,
    "",
    plus
      ? `✅ ${plus} line${plus === 1 ? " beats" : "s beat"} the fair price as is${plus > top ? ` (the top ${top} are shown)` : ""}. Name a game for its full list.`
      : "Nothing beats the fair price as is. These are the closest; a boost may flip them +EV.",
  ].join("\n");
}
