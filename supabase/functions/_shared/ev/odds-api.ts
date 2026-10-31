// Client for The Odds API (v4). Uses only fetch, so it runs in Deno and Node.
// Credits: each odds call costs (markets × regions); /sports and /events are
// free. Player props need the per-event endpoint.
// Docs: https://the-odds-api.com/liveapi/guides/v4/

import { SPORTSBOOKS } from "../books/books.ts";

const BASE = "https://api.the-odds-api.com/v4";

// Our sport names → The Odds API sport keys.
export const SPORT_KEYS: Record<string, string> = {
  NFL: "americanfootball_nfl",
  NCAAF: "americanfootball_ncaaf",
  NBA: "basketball_nba",
  WNBA: "basketball_wnba",
  NCAAB: "basketball_ncaab",
  MLB: "baseball_mlb",
  NHL: "icehockey_nhl",
  EPL: "soccer_epl",
  UCL: "soccer_uefa_champs_league",
  MLS: "soccer_usa_mls",
  LALIGA: "soccer_spain_la_liga",
  SERIEA: "soccer_italy_serie_a",
  BUNDESLIGA: "soccer_germany_bundesliga",
};

// Book names as the bot shows them → The Odds API bookmaker keys, from the
// sportsbook list both bots share (_shared/books). Caesars is listed under its
// old William Hill key, theScore under ESPN Bet's.
export const BOOK_KEYS: Record<string, string> = {
  ...Object.fromEntries(SPORTSBOOKS.flatMap((b) => (b.oddsApi ? [[b.name, b.oddsApi]] : []))),
  Pinnacle: "pinnacle",
};

// Retail books on the free plan, by feed key: where line shopping looks.
export const SHOP_BOOKS: Record<string, string> = Object.fromEntries(
  SPORTSBOOKS.flatMap((b) => (b.oddsApi && b.freeFeed ? [[b.oddsApi, b.name]] : [])),
);

export type Outcome = { name: string; price: number; point?: number; description?: string; bet_limit?: number | null };
export type Market = { key: string; last_update?: string; outcomes: Outcome[] };
export type Bookmaker = { key: string; title: string; last_update?: string; markets: Market[] };
export type OddsEvent = {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: Bookmaker[];
};

export type OddsResult<T> = { data: T; remaining: number | null; used: number | null };

type Query = { markets: string[]; bookmakers: string[] };

async function get<T>(path: string, apiKey: string, q: Query): Promise<OddsResult<T>> {
  const params = new URLSearchParams({
    apiKey,
    markets: q.markets.join(","),
    bookmakers: q.bookmakers.join(","), // takes priority over regions, and is billed like one region per 10 books
    oddsFormat: "american",
    includeBetLimits: "true", // exchanges: how much each offer takes, to skip stale few-dollar offers
  });
  const res = await fetch(`${BASE}${path}?${params}`);
  if (!res.ok) throw new Error(`The Odds API ${res.status}: ${await res.text()}`);
  const num = (h: string) => (res.headers.get(h) === null ? null : Number(res.headers.get(h)));
  return { data: (await res.json()) as T, remaining: num("x-requests-remaining"), used: num("x-requests-used") };
}

const SOCCER = ["EPL", "UCL", "MLS", "LALIGA", "SERIEA", "BUNDESLIGA"];

// Player-prop markets worth pulling per sport for SGP legs (one per-game call).
export const PROP_MARKETS: Record<string, string[]> = {
  NFL: ["player_anytime_td", "player_pass_yds", "player_rush_yds", "player_reception_yds", "player_receptions"],
  NCAAF: ["player_anytime_td", "player_pass_yds", "player_rush_yds", "player_reception_yds"],
  NBA: ["player_points", "player_rebounds", "player_assists", "player_threes"],
  WNBA: ["player_points", "player_rebounds", "player_assists", "player_threes"],
  NCAAB: ["player_points", "player_rebounds", "player_assists"],
  MLB: ["batter_hits", "batter_total_bases", "batter_home_runs", "pitcher_strikeouts"],
  NHL: ["player_points", "player_shots_on_goal"],
  ...Object.fromEntries(SOCCER.map((l) => [l, ["player_goal_scorer_anytime"]])),
};

// Game markets beyond h2h/spreads/totals that a single game's call should
// pull. DraftKings posts soccer totals and both-teams-to-score only here (its
// sport-wide feed is the moneyline alone), and soccer's main totals are often
// quarter-goal lines (2.25) where the alternates have the 2.5.
export const EXTRA_MARKETS: Record<string, string[]> = {
  ...Object.fromEntries(SOCCER.map((l) => [l, ["alternate_totals", "alternate_spreads", "draw_no_bet", "btts", "alternate_totals_corners", "h2h_h1"]])),
};

// 1st-half moneyline, spread and total: every book you use posts them for
// football and basketball, and Pinnacle prices all three. Per-game calls only
// (the sport-wide feed is main lines). Hockey uses periods and baseball the
// first five innings, so they're left out.
export const HALF_MARKETS: Record<string, string[]> = Object.fromEntries(
  ["NFL", "NCAAF", "NBA", "WNBA", "NCAAB"].map((l) => [l, ["h2h_h1", "spreads_h1", "totals_h1"]]),
);

// More props for a question about one game, where one call covers them all.
// Each has a sharp price at Pinnacle or the exchanges (checked on a real NFL pull).
export const QUESTION_PROP_MARKETS: Record<string, string[]> = {
  NFL: ["player_pass_tds", "player_pass_completions", "player_pass_attempts", "player_rush_attempts", "player_reception_longest", "player_rush_reception_yds"],
};

export type EventInfo = Pick<OddsEvent, "id" | "sport_key" | "commence_time" | "home_team" | "away_team">;

// Upcoming games (no odds). Free: costs no credits.
export async function getEvents(apiKey: string, sportKey: string): Promise<EventInfo[]> {
  const res = await fetch(`${BASE}/sports/${sportKey}/events?${new URLSearchParams({ apiKey })}`);
  if (!res.ok) throw new Error(`The Odds API ${res.status}: ${await res.text()}`);
  return res.json();
}

// Main lines for every upcoming game in a sport, in one call.
export function getOdds(apiKey: string, sportKey: string, q: Query): Promise<OddsResult<OddsEvent[]>> {
  return get(`/sports/${sportKey}/odds`, apiKey, q);
}

// Any market for one game, including player props (e.g. "player_points").
export function getEventOdds(apiKey: string, sportKey: string, eventId: string, q: Query): Promise<OddsResult<OddsEvent>> {
  return get(`/sports/${sportKey}/events/${eventId}/odds`, apiKey, q);
}
