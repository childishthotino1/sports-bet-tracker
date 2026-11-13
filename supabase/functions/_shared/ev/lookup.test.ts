import { test } from "node:test";
import assert from "node:assert/strict";
import { matchMust, questionFilter, questionNames, questionMarkets, questionRest, wantLeg, filterLabel, type PricedLeg } from "./mod.ts";

const NBA = "basketball_nba", NFL = "americanfootball_nfl";
const leg = (market: string, selection: string, sportKey = NBA): PricedLeg => ({
  eventId: "e", sportKey, game: "Cleveland Cavaliers @ New York Knicks", start: "2026-11-12T00:10:00Z",
  market, selection, side: selection, bookOdds: -110, fair: 0.5, quotes: [], edge: 0,
} as PricedLeg);
const LEGS = [
  leg("h2h", "New York Knicks ML"), leg("h2h", "Cleveland Cavaliers ML"),
  leg("spreads", "New York Knicks -3.5"), leg("alternate_spreads", "New York Knicks -6.5"), leg("spreads", "Cleveland Cavaliers +3.5"),
  leg("totals", "Over 224.5"), leg("team_totals", "New York Knicks Team Total Over 114.5"),
  leg("spreads_h1", "1st Half New York Knicks -2"), leg("totals_h1", "1st Half Over 112.5"),
  leg("player_points", "Jalen Brunson Over 26.5 Points"), leg("player_rebounds", "Jarrett Allen Under 11.5 Rebounds"),
  leg("player_assists", "OG Anunoby Under 2.5 Assists"),
];
const kept = (text: string) => LEGS.filter((l) => wantLeg(questionFilter(text), l)).map((l) => l.selection);

test("Knicks game plays, not player props: main lines only (the 2026-11-11 ask)", () => {
  const f = questionFilter("Knicks game plays. Not player props");
  assert.equal(f.mode, "main");
  assert.equal(questionMarkets(f, NBA), null, "the full set of game lines, minus props");
  assert.ok(kept("Knicks game plays. Not player props").every((s) => !/Points|Rebounds|Assists/.test(s)));
  assert.equal(kept("Knicks game plays. Not player props").length, 9);
  assert.equal(filterLabel(f), "main lines (no props)");
});

test("props, a stat, or a market narrow the lines and the markets requested", () => {
  assert.deepEqual(kept("knicks props"), ["Jalen Brunson Over 26.5 Points", "Jarrett Allen Under 11.5 Rebounds", "OG Anunoby Under 2.5 Assists"]);
  assert.deepEqual(kept("brunson points"), ["Jalen Brunson Over 26.5 Points"]);
  assert.deepEqual(questionMarkets(questionFilter("brunson points"), NBA), ["spreads", "player_points"]);
  assert.deepEqual(kept("knicks spread"), ["New York Knicks -3.5", "New York Knicks -6.5", "Cleveland Cavaliers +3.5"]);
  assert.deepEqual(kept("knicks moneyline"), ["New York Knicks ML", "Cleveland Cavaliers ML"]);
  assert.deepEqual(kept("team total"), ["New York Knicks Team Total Over 114.5"]);
  assert.deepEqual(kept("1st half lines"), ["1st Half New York Knicks -2", "1st Half Over 112.5"]);
  assert.deepEqual(kept("first half total"), ["1st Half Over 112.5"]);
  assert.deepEqual(questionMarkets(questionFilter("first half total"), NBA), ["totals_h1", "alternate_totals_h1"]);
  assert.deepEqual(kept("spread and brunson points"), ["New York Knicks -3.5", "New York Knicks -6.5", "Cleveland Cavaliers +3.5", "Jalen Brunson Over 26.5 Points"]);
  assert.equal(kept("good bets on the Knicks game?").length, LEGS.length, "nothing named: everything");
  assert.deepEqual(questionMarkets(questionFilter("nfl anytime td props"), NFL), ["spreads", "player_anytime_td"]);
  assert.deepEqual(questionFilter("1st td scorer").stats, ["first_td"]);
  assert.equal(questionFilter("no main lines, props only").mode, "props");
});

test("what's left of the question names a player or a team's side", () => {
  assert.equal(questionRest("Knicks game plays. Not player props"), "Knicks");
  assert.equal(questionRest("best nba plays on fanduel tonight"), "");
  assert.equal(questionRest("Jalen Brunson points"), "Jalen Brunson points");
  assert.equal(questionRest("NO @ LAR spread"), "NO LAR spread", "capitals kept, so NO is still New Orleans");
  assert.deepEqual(questionFilter("TB vs CHI").stats, [], "TB is Tampa Bay, not total bases");
  const props = LEGS.filter((l) => wantLeg(questionFilter("Jalen Brunson points"), l));
  const m = matchMust(props, questionRest("Jalen Brunson points"))!;
  assert.deepEqual(props.filter(m.match).map((l) => l.selection), ["Jalen Brunson Over 26.5 Points"]);
  const sides = LEGS.filter((l) => wantLeg(questionFilter("knicks spread"), l));
  assert.deepEqual(sides.filter(matchMust(sides, questionRest("knicks spread"))!.match).map((l) => l.selection), ["New York Knicks -3.5", "New York Knicks -6.5"]);
  assert.equal(matchMust(LEGS, questionRest("Knicks game plays. Not player props"))?.game, true, "a team alone is the whole game");
  assert.equal(questionNames("Falcons game Ja'Marr Chase TD"), "Falcons Ja'Marr Chase");
  assert.equal(questionNames("Brunson over 26.5 points"), "Brunson");
});
