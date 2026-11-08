// Game results from ESPN's public site API (no key): final scores with
// period-by-period scoring from the scoreboard, and player box scores from a
// game's summary. The grader settles game lines and most player props from
// these, and asks Claude with web search only for what they don't cover
// (1st / last TD scorer, soccer and MLB / NHL props, a game ESPN doesn't list).
//
// ESPN's site API is unofficial: a change on their side shows up as games or
// players not found, which falls back to the web research. Pure, so it's tested
// under Node; the grader does the fetching.

import { norm, lastWord, samePerson } from "./names.ts";
import { gradeFromScore, type LegResult, type Score, type TrackedLeg } from "./track.ts";

// Odds API sport key -> ESPN path, plus scoreboard query extras (college
// scoreboards list only ranked games unless asked for the whole division).
export const ESPN_SPORTS: Record<string, { path: string; extra?: string; periods: "quarters" | "halves" | "none" }> = {
  americanfootball_nfl: { path: "football/nfl", periods: "quarters" },
  americanfootball_ncaaf: { path: "football/college-football", extra: "groups=80&limit=400", periods: "quarters" },
  basketball_nba: { path: "basketball/nba", periods: "quarters" },
  basketball_wnba: { path: "basketball/wnba", periods: "quarters" },
  basketball_ncaab: { path: "basketball/mens-college-basketball", extra: "groups=50&limit=400", periods: "halves" },
  baseball_mlb: { path: "baseball/mlb", periods: "none" },
  icehockey_nhl: { path: "hockey/nhl", periods: "none" },
  soccer_epl: { path: "soccer/eng.1", periods: "none" },
  soccer_uefa_champs_league: { path: "soccer/uefa.champions", periods: "none" },
  soccer_usa_mls: { path: "soccer/usa.1", periods: "none" },
  soccer_spain_la_liga: { path: "soccer/esp.1", periods: "none" },
  soccer_italy_serie_a: { path: "soccer/ita.1", periods: "none" },
  soccer_germany_bundesliga: { path: "soccer/ger.1", periods: "none" },
};

const BASE = "https://site.api.espn.com/apis/site/v2/sports";

// ESPN's scoreboard day is the US Eastern date.
export function easternDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso)).replaceAll("-", "");
}

export function scoreboardUrl(sportKey: string, day: string): string | null {
  const s = ESPN_SPORTS[sportKey];
  return s ? `${BASE}/${s.path}/scoreboard?dates=${day}${s.extra ? `&${s.extra}` : ""}` : null;
}

export function summaryUrl(sportKey: string, espnId: string): string | null {
  const s = ESPN_SPORTS[sportKey];
  return s ? `${BASE}/${s.path}/summary?event=${encodeURIComponent(espnId)}` : null;
}

export type EspnStatus = "final" | "live" | "scheduled" | "postponed" | "canceled";

export type EspnGame = {
  id: string;
  start: string;
  status: EspnStatus;
  home: { name: string; score: number; periods: number[] };
  away: { name: string; score: number; periods: number[] };
};

function status(name: string, completed: boolean): EspnStatus {
  if (/POSTPONED|SUSPENDED|DELAYED/.test(name)) return "postponed";
  if (/CANCEL|FORFEIT|ABANDON/.test(name)) return "canceled";
  if (completed || /FINAL|FULL_TIME|END_OF_GAME/.test(name)) return "final";
  if (/SCHEDULED/.test(name)) return "scheduled";
  return "live";
}

type Json = Record<string, any>; // ESPN's shapes, read defensively

export function parseScoreboard(json: unknown): EspnGame[] {
  const events = Array.isArray((json as Json)?.events) ? (json as Json).events : [];
  return events.flatMap((e: Json) => {
    const c = e?.competitions?.[0];
    const teams = Array.isArray(c?.competitors) ? c.competitors : [];
    const side = (ha: string) => {
      const t = teams.find((x: Json) => x?.homeAway === ha);
      if (!t?.team?.displayName) return null;
      return {
        name: String(t.team.displayName),
        score: Number(t.score ?? 0),
        periods: (Array.isArray(t.linescores) ? t.linescores : []).map((l: Json) => Number(l?.value ?? 0)),
      };
    };
    const home = side("home"), away = side("away");
    if (!home || !away || !e.id) return [];
    const st = c?.status?.type ?? e?.status?.type ?? {};
    return [{ id: String(e.id), start: String(e.date ?? ""), status: status(String(st.name ?? ""), st.completed === true), home, away }];
  });
}

// How sure a team name names an ESPN team: the full name, one inside the other
// ("LA Clippers" / "Los Angeles Clippers" share the nickname), or the nickname
// alone where it isn't one clubs share ("United", "City").
const SHARED = new Set(["city", "united", "town", "county", "athletic", "rovers", "wanderers", "albion", "fc", "afc", "sc", "cf", "state"]);
function teamScore(a: string, b: string): number {
  const x = norm(a.replace(/&/g, "and")), y = norm(b.replace(/&/g, "and"));
  if (x === y) return 3;
  if (` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `)) return 2;
  const lx = lastWord(x);
  return lx.length > 2 && !SHARED.has(lx) && lx === lastWord(y) ? 1 : 0;
}

// The ESPN game for an Odds API game ("Away @ Home"), its start within 12 hours.
export function matchGame(games: EspnGame[], game: string, startIso: string): EspnGame | null {
  const [away, home] = game.split(" @ ");
  if (!away || !home) return null;
  const t = new Date(startIso).getTime();
  let best: EspnGame | null = null, bestScore = 0;
  for (const g of games) {
    if (g.start && Math.abs(new Date(g.start).getTime() - t) > 12 * 3600e3) continue;
    const h = teamScore(home, g.home.name), a = teamScore(away, g.away.name);
    if (!h || !a) continue; // a neutral-site game listed the other way round isn't worth the risk
    if (h + a > bestScore) { best = g; bestScore = h + a; }
  }
  return best;
}

// The final as the grader's Score, with the 1st half and 1st quarter where the
// sport's periods give them (soccer, MLB, NHL: full game only).
export function toScore(g: EspnGame, sportKey: string, teams: { home_team: string; away_team: string }): Score {
  const kind = ESPN_SPORTS[sportKey]?.periods ?? "none";
  const sum = (p: number[], n: number) => (p.length >= n ? p.slice(0, n).reduce((a, b) => a + b, 0) : null);
  const h1 = kind === "quarters" ? 2 : kind === "halves" ? 1 : 0;
  return {
    ...teams,
    home: g.home.score,
    away: g.away.score,
    home_h1: h1 ? sum(g.home.periods, h1) : null,
    away_h1: h1 ? sum(g.away.periods, h1) : null,
    home_q1: kind === "quarters" ? sum(g.home.periods, 1) : null,
    away_q1: kind === "quarters" ? sum(g.away.periods, 1) : null,
  };
}

// ── Box scores ──────────────────────────────────────────────

export type BoxPlayer = { name: string; played: boolean; stats: Record<string, number> };
export type Box = { sport: "basketball" | "football"; players: BoxPlayer[] };

// "5-13" / "24/34" -> made and attempted.
const pair = (v: string) => v.split(/[-/]/).map(Number);

const FOOTBALL_KEYS: Record<string, Record<string, (v: string) => Record<string, number>>> = {
  passing: {
    "completions/passingAttempts": (v) => ({ completions: pair(v)[0], passAttempts: pair(v)[1] }),
    passingYards: (v) => ({ passYds: Number(v) }),
    passingTouchdowns: (v) => ({ passTds: Number(v) }),
    interceptions: (v) => ({ passInts: Number(v) }),
  },
  rushing: {
    rushingAttempts: (v) => ({ rushAttempts: Number(v) }),
    rushingYards: (v) => ({ rushYds: Number(v) }),
    rushingTouchdowns: (v) => ({ rushTds: Number(v) }),
    longRushing: (v) => ({ rushLong: Number(v) }),
  },
  receiving: {
    receptions: (v) => ({ receptions: Number(v) }),
    receivingYards: (v) => ({ recYds: Number(v) }),
    receivingTouchdowns: (v) => ({ recTds: Number(v) }),
    longReception: (v) => ({ recLong: Number(v) }),
  },
  kickReturns: { kickReturnTouchdowns: (v) => ({ returnTds: Number(v) }) },
  puntReturns: { puntReturnTouchdowns: (v) => ({ returnTds: Number(v) }) },
  defensive: {
    defensiveTouchdowns: (v) => ({ defTds: Number(v) }),
    soloTackles: (v) => ({ soloTackles: Number(v) }),
    totalTackles: (v) => ({ tackles: Number(v) }),
    sacks: (v) => ({ sacks: Number(v) }),
  },
  kicking: {
    "fieldGoalsMade/fieldGoalAttempts": (v) => ({ fieldGoals: pair(v)[0] }),
    totalKickingPoints: (v) => ({ kickingPoints: Number(v) }),
  },
};

const BASKETBALL_KEYS: Record<string, (v: string) => Record<string, number>> = {
  points: (v) => ({ points: Number(v) }),
  rebounds: (v) => ({ rebounds: Number(v) }),
  assists: (v) => ({ assists: Number(v) }),
  steals: (v) => ({ steals: Number(v) }),
  blocks: (v) => ({ blocks: Number(v) }),
  turnovers: (v) => ({ turnovers: Number(v) }),
  "threePointFieldGoalsMade-threePointFieldGoalsAttempted": (v) => ({ threes: pair(v)[0] }),
};

// A game summary's box score: every player's counting stats. Basketball lists
// every player (didNotPlay or no stats = didn't play). Football lists a player
// only in the categories he has a stat in, so a missing stat there is 0, and a
// player in no category is unknown, not "didn't play".
export function parseBox(json: unknown, sportKey: string): Box | null {
  const sport = sportKey.startsWith("basketball_") ? "basketball" : sportKey.startsWith("americanfootball_") ? "football" : null;
  const teams = (json as Json)?.boxscore?.players;
  if (!sport || !Array.isArray(teams) || !teams.length) return null;
  const byName = new Map<string, BoxPlayer>();
  for (const team of teams) {
    for (const cat of Array.isArray(team?.statistics) ? team.statistics : []) {
      const keys: string[] = Array.isArray(cat?.keys) ? cat.keys : [];
      const readers = sport === "basketball" ? BASKETBALL_KEYS : FOOTBALL_KEYS[String(cat?.name)] ?? {};
      for (const a of Array.isArray(cat?.athletes) ? cat.athletes : []) {
        const name = a?.athlete?.displayName;
        if (!name) continue;
        const p: BoxPlayer = byName.get(name) ?? { name, played: false, stats: {} };
        const values: string[] = Array.isArray(a.stats) ? a.stats : [];
        if (values.length && a.didNotPlay !== true) p.played = true;
        keys.forEach((k, i) => {
          const read = readers[k];
          if (!read || values[i] === undefined || values[i] === "--") return;
          for (const [stat, n] of Object.entries(read(values[i]))) if (Number.isFinite(n)) p.stats[stat] = (p.stats[stat] ?? 0) + n;
        });
        byName.set(name, p);
      }
    }
  }
  return { sport, players: [...byName.values()] };
}

// Each market's stat, from a player's line (missing football stats are 0).
const STAT: Record<string, (s: (k: string) => number) => number> = {
  player_points: (s) => s("points"),
  player_rebounds: (s) => s("rebounds"),
  player_assists: (s) => s("assists"),
  player_threes: (s) => s("threes"),
  player_blocks: (s) => s("blocks"),
  player_steals: (s) => s("steals"),
  player_turnovers: (s) => s("turnovers"),
  player_points_rebounds_assists: (s) => s("points") + s("rebounds") + s("assists"),
  player_points_rebounds: (s) => s("points") + s("rebounds"),
  player_points_assists: (s) => s("points") + s("assists"),
  player_rebounds_assists: (s) => s("rebounds") + s("assists"),
  player_blocks_steals: (s) => s("blocks") + s("steals"),
  player_double_double: (s) => (["points", "rebounds", "assists", "steals", "blocks"].filter((k) => s(k) >= 10).length >= 2 ? 1 : 0),
  player_triple_double: (s) => (["points", "rebounds", "assists", "steals", "blocks"].filter((k) => s(k) >= 10).length >= 3 ? 1 : 0),
  player_pass_yds: (s) => s("passYds"),
  player_pass_tds: (s) => s("passTds"),
  player_pass_completions: (s) => s("completions"),
  player_pass_attempts: (s) => s("passAttempts"),
  player_pass_interceptions: (s) => s("passInts"),
  player_rush_yds: (s) => s("rushYds"),
  player_rush_attempts: (s) => s("rushAttempts"),
  player_rush_longest: (s) => s("rushLong"),
  player_rush_tds: (s) => s("rushTds"),
  player_reception_yds: (s) => s("recYds"),
  player_receptions: (s) => s("receptions"),
  player_reception_longest: (s) => s("recLong"),
  player_reception_tds: (s) => s("recTds"),
  player_rush_reception_yds: (s) => s("rushYds") + s("recYds"),
  player_pass_rush_yds: (s) => s("passYds") + s("rushYds"),
  // A TD scorer bet counts rushing, receiving, return and defensive TDs, not passing ones.
  player_anytime_td: (s) => s("rushTds") + s("recTds") + s("returnTds") + s("defTds"),
  player_tds_over: (s) => s("rushTds") + s("recTds") + s("returnTds") + s("defTds"),
  player_sacks: (s) => s("sacks"),
  player_solo_tackles: (s) => s("soloTackles"),
  player_tackles_assists: (s) => s("tackles"),
  player_field_goals: (s) => s("fieldGoals"),
  player_kicking_points: (s) => s("kickingPoints"),
};

export type PropLeg = { market: string; side: string; point: number | null; player: string | null };

// A player prop's result from the box score, with the stat it used; null when
// the box can't settle it (a market it doesn't carry, a player it doesn't list
// or lists twice). A player who didn't play voids his prop.
export function gradeProp(leg: PropLeg, box: Box): { result: "won" | "lost" | "push" | "void"; why: string } | null {
  const market = leg.market.replace(/_alternate$/, "");
  const stat = STAT[market];
  if (!stat || !leg.player) return null;
  const found = box.players.filter((p) => samePerson(p.name, leg.player!));
  if (found.length !== 1) return null;
  const p = found[0];
  if (!p.played) return box.sport === "basketball" ? { result: "void", why: `${p.name} didn't play` } : null;
  const value = stat((k) => p.stats[k] ?? 0);
  const yesNo = /^(yes|no)$/i.test(leg.side);
  const why = `${p.name}: ${value} (box score)`;
  if (yesNo) {
    const hit = value >= 1;
    return { result: (/^yes$/i.test(leg.side) ? hit : !hit) ? "won" : "lost", why };
  }
  if (leg.point === null) return null;
  const over = value > leg.point ? "won" : value < leg.point ? "lost" : "push";
  if (/^over$/i.test(leg.side)) return { result: over, why };
  if (/^under$/i.test(leg.side)) return { result: over === "push" ? "push" : over === "won" ? "lost" : "won", why };
  return null;
}

// Each leg's result from ESPN, or null where ESPN can't settle it (the grader
// then asks the web research for those). A postponed or cancelled game voids
// every leg; one not final yet settles nothing.
export function espnResults(
  legs: TrackedLeg[], g: EspnGame, sportKey: string, teams: { home_team: string; away_team: string }, box: Box | null,
): ({ result: LegResult; why: string } | null)[] {
  if (g.status === "postponed" || g.status === "canceled") return legs.map(() => ({ result: "void", why: `game ${g.status} (ESPN)` }));
  if (g.status !== "final") return legs.map(() => null);
  const score = toScore(g, sportKey, teams);
  const final = `${teams.away_team} ${score.away}, ${teams.home_team} ${score.home} (ESPN)`;
  return legs.map((leg) => {
    const fromScore = gradeFromScore(leg, score);
    if (fromScore) {
      const period = leg.market.endsWith("_h1") ? ` (1st half ${score.away_h1}-${score.home_h1})` : leg.market.endsWith("_q1") ? ` (1st quarter ${score.away_q1}-${score.home_q1})` : "";
      return { result: fromScore, why: `final: ${final}${period}` };
    }
    return box ? gradeProp({ market: leg.market, side: leg.side, point: leg.point, player: leg.player }, box) : null;
  });
}
