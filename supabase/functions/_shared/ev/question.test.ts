import { test } from "node:test";
import assert from "node:assert/strict";
import { findEvent, questionBook, questionLeagues } from "./mod.ts";

const NOW = new Date("2026-11-07T15:00:00Z");
const ev = (id: string, away: string, home: string) => ({ id, away_team: away, home_team: home, commence_time: "2026-11-07T20:00:00Z" });

test("a question names its game by school, not just nickname", () => {
  const games = [
    ev("nd", "Navy Midshipmen", "Notre Dame Fighting Irish"),
    ev("bal", "Cincinnati Bengals", "Baltimore Ravens"),
    ev("fsu", "Florida State Seminoles", "Clemson Tigers"),
    ev("uf", "Florida Gators", "Georgia Bulldogs"),
    ev("nyg", "New York Giants", "Dallas Cowboys"),
  ];
  const q = (text: string) => findEvent(games, [text], NOW)?.id ?? null;
  assert.equal(q("Whats a good bet on fanduel for the Notre Dame ncaaf game"), "nd");
  assert.equal(q("good bets on the Ravens game?"), "bal");
  assert.equal(q("anything on Florida State tonight"), "fsu");
  assert.equal(q("anything on Florida tonight"), "uf");
  assert.equal(q("what's new today"), null, "one generic word isn't a team");
  assert.equal(q("hi"), null);
});

test("a question's league and book", () => {
  assert.deepEqual(questionLeagues("the Notre Dame ncaaf game"), ["NCAAF"]);
  assert.deepEqual(questionLeagues("college football tonight"), ["NCAAF"]);
  assert.deepEqual(questionLeagues("wnba finals"), ["WNBA"]);
  assert.deepEqual(questionLeagues("Ravens game"), []);
  assert.equal(questionBook("Whats a good bet on fanduel for the Notre Dame game"), "FanDuel");
  assert.equal(questionBook("best line on draft kings"), "DraftKings");
  assert.equal(questionBook("DK price on the Ravens?"), "DraftKings");
  assert.equal(questionBook("what's the score of the Ravens game"), null);
  assert.equal(questionBook("Ravens game"), null);
});
