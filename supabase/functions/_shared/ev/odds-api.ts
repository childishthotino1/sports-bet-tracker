// Client for The Odds API (v4). Uses only fetch, so it runs in Deno and Node.
// Credits: each odds call costs (markets × regions); /sports and /events are
// free. Player props need the per-event endpoint.
// Docs: https://the-odds-api.com/liveapi/guides/v4/

const BASE = "https://api.the-odds-api.com/v4";

// Our sport names → The Odds API sport keys.
export const SPORT_KEYS: Record<string, string> = {
  NFL: "americanfootball_nfl",
  NCAAF: "americanfootball_ncaaf",
  NBA: "basketball_nba",
  NCAAB: "basketball_ncaab",
  MLB: "baseball_mlb",
  NHL: "icehockey_nhl",
};

// Book names as the bot shows them → The Odds API bookmaker keys. Caesars is
// listed under its old William Hill key.
export const BOOK_KEYS: Record<string, string> = {
  BetMGM: "betmgm",
  DraftKings: "draftkings",
  FanDuel: "fanduel",
  Caesars: "williamhill_us",
  Fanatics: "fanatics",
  Pinnacle: "pinnacle",
};

export type Outcome = { name: string; price: number; point?: number; description?: string };
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
  });
  const res = await fetch(`${BASE}${path}?${params}`);
  if (!res.ok) throw new Error(`The Odds API ${res.status}: ${await res.text()}`);
  const num = (h: string) => (res.headers.get(h) === null ? null : Number(res.headers.get(h)));
  return { data: (await res.json()) as T, remaining: num("x-requests-remaining"), used: num("x-requests-used") };
}

// Player-prop markets worth pulling per sport for SGP legs (one per-game call).
export const PROP_MARKETS: Record<string, string[]> = {
  NFL: ["player_anytime_td", "player_pass_yds", "player_rush_yds", "player_reception_yds", "player_receptions"],
  NCAAF: ["player_anytime_td", "player_pass_yds", "player_rush_yds", "player_reception_yds"],
  NBA: ["player_points", "player_rebounds", "player_assists", "player_threes"],
  NCAAB: ["player_points", "player_rebounds", "player_assists"],
  MLB: ["batter_hits", "batter_total_bases", "batter_home_runs", "pitcher_strikeouts"],
  NHL: ["player_points", "player_shots_on_goal"],
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
