import { test } from "node:test";
import assert from "node:assert/strict";
import { espnResults, easternDay, gradeProp, matchGame, parseBox, parseScoreboard, scoreboardUrl, toScore, type TrackedLeg } from "./mod.ts";

// Trimmed from ESPN's real NBA scoreboard for 2026-11-07 (shape as returned).
const competitor = (homeAway: string, name: string, score: string, lines: number[] | null) => ({
  homeAway, score, team: { displayName: name }, ...(lines ? { linescores: lines.map((value) => ({ value })) } : {}),
});
const SCOREBOARD = {
  events: [
    { id: "401909938", date: "2026-11-07T22:00Z", competitions: [{ status: { type: { name: "STATUS_FINAL", completed: true } }, competitors: [
      competitor("home", "Indiana Pacers", "102", [19, 22, 37, 24]), competitor("away", "Denver Nuggets", "114", [27, 37, 26, 24])] }] },
    { id: "401909942", date: "2026-11-08T01:30Z", competitions: [{ status: { type: { name: "STATUS_IN_PROGRESS", completed: false } }, competitors: [
      competitor("home", "Golden State Warriors", "41", [31, 10]), competitor("away", "Orlando Magic", "34", [19, 15])] }] },
    { id: "401909950", date: "2026-11-08T03:30Z", competitions: [{ status: { type: { name: "STATUS_FINAL", completed: true } }, competitors: [
      competitor("home", "LA Clippers", "110", [30, 25, 30, 25]), competitor("away", "New Orleans Pelicans", "99", [20, 25, 30, 24])] }] },
    { id: "401909960", date: "2026-11-08T03:00Z", competitions: [{ status: { type: { name: "STATUS_POSTPONED", completed: false } }, competitors: [
      competitor("home", "Portland Trail Blazers", "0", null), competitor("away", "San Antonio Spurs", "0", null)] }] },
  ],
};

test("ESPN scoreboard: games, status and period scores", () => {
  const games = parseScoreboard(SCOREBOARD);
  assert.equal(games.length, 4);
  assert.deepEqual(games.map((g) => g.status), ["final", "live", "final", "postponed"]);
  assert.deepEqual(games[0].away, { name: "Denver Nuggets", score: 114, periods: [27, 37, 26, 24] });
  assert.equal(scoreboardUrl("basketball_nba", easternDay("2026-11-08T03:30:00Z")), "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261107", "a late tip is still the 7th in Eastern");
  assert.match(scoreboardUrl("americanfootball_ncaaf", "20261107")!, /groups=80/);
  assert.equal(scoreboardUrl("tennis_atp", "20261107"), null);
});

test("an Odds API game finds its ESPN game, even when ESPN shortens the name", () => {
  const games = parseScoreboard(SCOREBOARD);
  assert.equal(matchGame(games, "Denver Nuggets @ Indiana Pacers", "2026-11-07T22:10:00Z")?.id, "401909938");
  assert.equal(matchGame(games, "New Orleans Pelicans @ Los Angeles Clippers", "2026-11-08T03:30:00Z")?.id, "401909950");
  assert.equal(matchGame(games, "Indiana Pacers @ Denver Nuggets", "2026-11-07T22:10:00Z"), null, "home and away must line up");
  assert.equal(matchGame(games, "Denver Nuggets @ Indiana Pacers", "2026-11-10T22:10:00Z"), null, "another day's game");
  const soccer = parseScoreboard({ events: [{ id: "1", date: "2026-11-07T15:00Z", competitions: [{ status: { type: { name: "STATUS_FULL_TIME" } }, competitors: [
    competitor("home", "Leeds United", "1", null), competitor("away", "Tottenham Hotspur", "0", null)] }] }] });
  assert.equal(matchGame(soccer, "Tottenham Hotspur @ Newcastle United", "2026-11-07T15:00:00Z"), null, "'United' alone isn't Leeds");
  assert.equal(matchGame(soccer, "Tottenham Hotspur @ Leeds United", "2026-11-07T15:00:00Z")?.status, "final");
});

test("the final grades game lines, 1st half and 1st quarter included", () => {
  const g = parseScoreboard(SCOREBOARD)[0];
  const teams = { home_team: "Indiana Pacers", away_team: "Denver Nuggets" };
  assert.deepEqual(toScore(g, "basketball_nba", teams), { ...teams, home: 102, away: 114, home_h1: 41, away_h1: 64, home_q1: 19, away_q1: 27 });
  const leg = (o: Partial<TrackedLeg>): TrackedLeg => ({ event_id: "e", sport_key: "basketball_nba", game: "Denver Nuggets @ Indiana Pacers", start: g.start,
    market: "h2h", selection: "x", side: "Denver Nuggets", point: null, player: null, book_odds: -150, fair: 0.6, ...o });
  const r = espnResults([
    leg({}),
    leg({ market: "spreads", side: "Indiana Pacers", point: 11.5 }),
    leg({ market: "totals_h1", side: "Over", point: 104.5 }),
    leg({ market: "spreads_q1", side: "Denver Nuggets", point: -7.5 }),
    leg({ market: "player_points", side: "Over", point: 20.5, player: "Nikola Jokic" }),
  ], g, "basketball_nba", teams, null);
  assert.deepEqual(r.slice(0, 4).map((x) => x?.result), ["won", "lost", "won", "won"], "Pacers lost by 12; Denver won the 1st quarter 27-19");
  assert.match(r[0]!.why, /Denver Nuggets 114, Indiana Pacers 102 \(ESPN\)/);
  assert.equal(r[4], null, "a prop with no box score goes to the research");
  const soon = espnResults([leg({})], parseScoreboard(SCOREBOARD)[1], "basketball_nba", teams, null);
  assert.deepEqual(soon, [null], "not final yet: nothing settles");
  const off = espnResults([leg({}), leg({ market: "player_points", side: "Over", point: 20.5, player: "Victor Wembanyama" })], parseScoreboard(SCOREBOARD)[3], "basketball_nba", teams, null);
  assert.deepEqual(off.map((x) => x?.result), ["void", "void"]);
});

// Trimmed from ESPN's real summary for Nuggets @ Pacers, 2026-11-07.
const NBA_KEYS = ["minutes", "points", "fieldGoalsMade-fieldGoalsAttempted", "threePointFieldGoalsMade-threePointFieldGoalsAttempted", "freeThrowsMade-freeThrowsAttempted", "rebounds", "assists", "turnovers", "steals", "blocks", "offensiveRebounds", "defensiveRebounds", "fouls", "plusMinus"];
const NBA_BOX = { boxscore: { players: [
  { team: { displayName: "Denver Nuggets" }, statistics: [{ name: null, keys: NBA_KEYS, athletes: [
    { athlete: { displayName: "Nikola Jokic" }, active: true, didNotPlay: false, stats: ["36", "19", "7-20", "1-3", "4-4", "13", "8", "1", "1", "1", "6", "7", "1", "+4"] },
    { athlete: { displayName: "Jamal Murray" }, active: false, didNotPlay: false, stats: ["34", "16", "6-13", "2-6", "2-2", "6", "8", "1", "0", "0", "0", "6", "1", "+5"] },
    { athlete: { displayName: "Julian Strawther" }, active: false, didNotPlay: true, stats: [] },
  ] }] },
  { team: { displayName: "Indiana Pacers" }, statistics: [{ name: null, keys: NBA_KEYS, athletes: [
    { athlete: { displayName: "Pascal Siakam" }, active: true, didNotPlay: false, stats: ["32", "23", "10-18", "2-7", "1-2", "2", "5", "0", "0", "0", "0", "2", "3", "0"] },
    { athlete: { displayName: "Larry Nance Jr." }, active: false, didNotPlay: false, stats: ["13", "15", "5-7", "5-7", "0-0", "2", "1", "1", "0", "0", "0", "2", "0", "+1"] },
  ] }] },
] } };

test("NBA box score settles points, threes, combos and double-doubles; DNP voids", () => {
  const box = parseBox(NBA_BOX, "basketball_nba")!;
  const g = (market: string, side: string, point: number | null, player: string) => gradeProp({ market, side, point, player }, box);
  assert.equal(g("player_points", "Over", 18.5, "Nikola Jokic")?.result, "won");
  assert.equal(g("player_points", "Under", 19, "Nikola Jokic")?.result, "push");
  assert.equal(g("player_rebounds_alternate", "Over", 14.5, "Nikola Jokic")?.result, "lost");
  assert.equal(g("player_points_rebounds_assists", "Over", 39.5, "Nikola Jokic")?.result, "won", "19 + 13 + 8 = 40");
  assert.equal(g("player_double_double", "Yes", null, "Nikola Jokic")?.result, "won");
  assert.equal(g("player_threes", "Over", 1.5, "Larry Nance Jr")?.result, "won", "5 threes; suffix ignored");
  assert.equal(g("player_assists", "Over", 4.5, "Jamal Murray")?.result, "won", "a bench player (active: false) still played");
  assert.deepEqual(g("player_points", "Over", 8.5, "Julian Strawther"), { result: "void", why: "Julian Strawther didn't play" });
  assert.equal(g("player_points", "Over", 8.5, "Tyrese Haliburton"), null, "not in the box: research");
  assert.match(g("player_points", "Over", 18.5, "Nikola Jokic")!.why, /19/);
});

// Shape from ESPN's real summary for Bears @ Seahawks, 2026-11-02.
const NFL_BOX = { boxscore: { players: [{ team: { displayName: "Chicago Bears" }, statistics: [
  { name: "passing", keys: ["completions/passingAttempts", "passingYards", "yardsPerPassAttempt", "passingTouchdowns", "interceptions", "sacks-sackYardsLost", "adjQBR", "QBRating"],
    athletes: [{ athlete: { displayName: "Caleb Williams" }, stats: ["24/34", "247", "7.3", "1", "0", "1-10", "68.1", "101.0"] }] },
  { name: "rushing", keys: ["rushingAttempts", "rushingYards", "yardsPerRushAttempt", "rushingTouchdowns", "longRushing"],
    athletes: [{ athlete: { displayName: "D'Andre Swift" }, stats: ["27", "69", "2.6", "3", "7"] }, { athlete: { displayName: "Caleb Williams" }, stats: ["4", "21", "5.3", "0", "11"] }] },
  { name: "receiving", keys: ["receptions", "receivingYards", "yardsPerReception", "receivingTouchdowns", "longReception", "receivingTargets"],
    athletes: [{ athlete: { displayName: "Rome Odunze" }, stats: ["4", "87", "21.8", "0", "24", "6"] }, { athlete: { displayName: "D'Andre Swift" }, stats: ["2", "11", "5.5", "0", "8", "3"] },
      { athlete: { displayName: "Luther Burden III" }, stats: ["3", "20", "6.7", "1", "9", "4"] }] },
  { name: "kickReturns", keys: ["kickReturns", "kickReturnYards", "yardsPerKickReturn", "longKickReturn", "kickReturnTouchdowns"],
    athletes: [{ athlete: { displayName: "Zavion Thomas" }, stats: ["4", "88", "22.0", "27", "0"] }] },
] }] } };

test("NFL box score settles yards, attempts, longest and anytime TDs", () => {
  const box = parseBox(NFL_BOX, "americanfootball_nfl")!;
  const g = (market: string, side: string, point: number | null, player: string) => gradeProp({ market, side, point, player }, box)?.result ?? null;
  assert.equal(g("player_pass_yds", "Over", 239.5, "Caleb Williams"), "won");
  assert.equal(g("player_pass_completions", "Under", 22.5, "Caleb Williams"), "lost");
  assert.equal(g("player_pass_attempts", "Under", 34.5, "Caleb Williams"), "won");
  assert.equal(g("player_pass_rush_yds", "Over", 265.5, "Caleb Williams"), "won", "247 + 21");
  assert.equal(g("player_anytime_td", "Yes", null, "D'Andre Swift"), "won");
  assert.equal(g("player_tds_over", "Over", 2.5, "D'Andre Swift"), "won", "3 rushing TDs");
  assert.equal(g("player_anytime_td", "Yes", null, "Rome Odunze"), "lost");
  assert.equal(g("player_anytime_td", "Yes", null, "Caleb Williams"), "lost", "a passing TD isn't his TD");
  assert.equal(g("player_rush_reception_yds", "Over", 79.5, "D'Andre Swift"), "won", "69 + 11");
  assert.equal(g("player_reception_longest", "Over", 22.5, "Rome Odunze"), "won");
  assert.equal(g("player_receptions", "Over", 0.5, "Zavion Thomas"), "lost", "listed only as a returner: 0 catches");
  assert.equal(g("player_reception_yds", "Over", 30.5, "Cole Kmet"), null, "in no category: can't tell 0 from inactive");
  assert.equal(g("player_1st_td", "Yes", null, "Luther Burden III"), null, "1st TD needs the scoring order: research");
  assert.equal(parseBox(NFL_BOX, "icehockey_nhl"), null);
});
