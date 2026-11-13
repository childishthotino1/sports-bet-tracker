import { test } from "node:test";
import assert from "node:assert/strict";
import { formatStats, gradeFromScore, legResults, parseGradeReply, pickRow, settle, type StoredPick, type TrackedLeg } from "./mod.ts";

const leg = (o: Partial<TrackedLeg>): TrackedLeg => ({
  event_id: "e1", sport_key: "americanfootball_nfl", game: "Baltimore Ravens @ Buffalo Bills", start: "2026-11-01T18:00:00Z",
  market: "h2h", selection: "x", side: "Baltimore Ravens", point: null, player: null, book_odds: -110, fair: 0.5, ...o,
});
// Ravens 24, Bills 20; 1st half Ravens 10, Bills 14.
const SCORE = { home_team: "Buffalo Bills", away_team: "Baltimore Ravens", home: 20, away: 24, home_h1: 14, away_h1: 10 };

test("game lines grade from the final score", () => {
  assert.equal(gradeFromScore(leg({}), SCORE), "won");
  assert.equal(gradeFromScore(leg({ side: "Buffalo Bills" }), SCORE), "lost");
  assert.equal(gradeFromScore(leg({ market: "spreads", side: "Buffalo Bills", point: 4 }), SCORE), "push");
  assert.equal(gradeFromScore(leg({ market: "alternate_spreads", side: "Baltimore Ravens", point: -3.5 }), SCORE), "won");
  assert.equal(gradeFromScore(leg({ market: "totals", side: "Over", point: 44.5 }), SCORE), "lost");
  assert.equal(gradeFromScore(leg({ market: "totals", side: "Under", point: 44 }), SCORE), "push");
  assert.equal(gradeFromScore(leg({ market: "team_totals", side: "Over", point: 21.5, player: "Baltimore Ravens" }), SCORE), "won");
  assert.equal(gradeFromScore(leg({ market: "team_totals", side: "Over", point: 21.5, player: "Buffalo Bills" }), SCORE), "lost");
  assert.equal(gradeFromScore(leg({ market: "h2h_h1" }), SCORE), "lost", "the 1st half uses the halftime score");
  assert.equal(gradeFromScore(leg({ market: "totals_h1", side: "Under", point: 24.5 }), SCORE), "won");
  assert.equal(gradeFromScore(leg({ market: "player_anytime_td", side: "Yes" }), SCORE), null, "props need the research");
  assert.equal(gradeFromScore(leg({ market: "spreads_q1", point: 0.5 }), SCORE), null);
  assert.equal(gradeFromScore(leg({ market: "h2h_h1" }), { ...SCORE, home_h1: null }), null);
});

test("soccer: a draw loses a 3-way moneyline, pushes draw no bet; BTTS", () => {
  const s = { home_team: "Real Betis", away_team: "Mallorca", home: 1, away: 1 };
  const sl = (o: Partial<TrackedLeg>) => leg({ sport_key: "soccer_spain_la_liga", side: "Real Betis", ...o });
  assert.equal(gradeFromScore(sl({}), s), "lost");
  assert.equal(gradeFromScore(sl({ side: "Draw" }), s), "won");
  assert.equal(gradeFromScore(sl({ market: "draw_no_bet" }), s), "push");
  assert.equal(gradeFromScore(sl({ market: "btts", side: "Yes" }), s), "won");
  assert.equal(gradeFromScore(sl({ market: "spreads", point: -0.25 }), s), null, "quarter lines go to the research");
});

test("settles at a flat unit: boost on profit, pushed legs drop out, lost legs lose", () => {
  const two = (a: TrackedLeg["result"], b: TrackedLeg["result"]) => ({
    legs: [leg({ book_odds: 100, result: a }), leg({ book_odds: 150, result: b })], book_odds: 400, boost_pct: 50,
  });
  assert.deepEqual(settle(two("won", "won")), { status: "won", profit: 6 }); // +400 → 4u, boosted 50% → 6u
  assert.deepEqual(settle(two("won", "push")), { status: "won", profit: 1.5 }); // +100 leg alone, boosted
  assert.deepEqual(settle(two("lost", null)), { status: "lost", profit: -1 }, "a lost leg settles it early");
  assert.deepEqual(settle(two("won", null)), { status: "pending", profit: null });
  assert.deepEqual(settle(two("void", "push")), { status: "push", profit: 0 });
  assert.deepEqual(settle(two("won", "unknown")), { status: "ungraded", profit: null });
  assert.deepEqual(settle({ ...two("won", "won"), book_odds: null }), { status: "won", profit: null }, "SGP leg ideas have no price");
});

test("parses the research reply and lets the score overrule it on game lines", () => {
  const g = parseGradeReply(`Here you go: {"status":"final","final":{"away":24,"home":20},"first_half":{"away":10,"home":14},
    "bets":[{"n":1,"result":"lost","why":"wrong"},{"n":2,"result":"won","why":"Henry 2 rush TD"},{"n":3,"result":"unknown","why":"no box score"}]}`)!;
  assert.equal(g.status, "final");
  const legs = [leg({}), leg({ market: "player_anytime_td", side: "Yes", player: "Derrick Henry" }), leg({ market: "player_receptions", side: "Over", point: 4.5 })];
  const r = legResults(legs, g, SCORE);
  assert.equal(r[0].result, "won", "the score wins over the model's read");
  assert.match(r[0].why!, /Baltimore Ravens 24, Buffalo Bills 20/);
  assert.deepEqual(r[1], { result: "won", why: "Henry 2 rush TD" });
  assert.equal(r[2].result, null, "unknown waits for another try");
  assert.deepEqual(legResults(legs, { ...g, status: "postponed" }, SCORE).map((x) => x.result), ["void", "void", "void"]);
  assert.deepEqual(legResults(legs, { ...g, status: "not_final" }, SCORE).map((x) => x.result), [null, null, null]);
  assert.equal(parseGradeReply("no json"), null);
  assert.equal(parseGradeReply('{"status":"maybe"}'), null);
});

test("the same suggestion twice in a day is one row", () => {
  const base = { chat_id: "1", source: "pick" as const, book: "DraftKings", league: "NFL", kind: "single" as const, promo_title: "TD", boost_pct: 30,
    book_odds: 120, fair_prob: 0.46, ev: 0.18, verdict: "plus_ev" as const, legs: [leg({ market: "player_anytime_td", selection: "CeeDee Lamb Anytime TD" })] };
  const a = pickRow(base, new Date("2026-11-01T15:00:00Z"));
  assert.equal(a.dedup_key, pickRow(base, new Date("2026-11-01T16:00:00Z")).dedup_key);
  assert.notEqual(a.dedup_key, pickRow(base, new Date("2026-11-02T16:00:00Z")).dedup_key);
  assert.equal(a.first_start, "2026-11-01T18:00:00Z");
});

test("the report: record, units, ROI vs the bot's EV, and leg hit rates vs fair", () => {
  const row = (o: Partial<StoredPick>): StoredPick => ({
    id: 1, created_at: "2026-11-01T12:00:00Z", chat_id: "1", source: "pick", dedup_key: "k", book: "DraftKings", league: "NFL", kind: "single",
    promo_title: null, boost_pct: 30, book_odds: 120, fair_prob: 0.46, ev: 0.18, verdict: "plus_ev", first_start: null, last_start: null,
    legs: [leg({ market: "player_anytime_td", selection: "A Anytime TD", fair: 0.46, result: "won" })], status: "won", profit: 1.56, ...o,
  });
  const rows = [
    row({}),
    row({ id: 2, created_at: "2026-11-01T13:00:00Z", status: "lost", profit: -1, legs: [leg({ market: "player_anytime_td", selection: "B Anytime TD", fair: 0.4, result: "lost" })] }),
    row({ id: 3, source: "slip", verdict: "minus_ev", ev: -0.05, status: "lost", profit: -1, book: "BetMGM", legs: [leg({ market: "player_anytime_td", selection: "A Anytime TD", fair: 0.46, result: "won" })] }),
    row({ id: 4, status: "pending", profit: null, legs: [leg({ result: null })] }),
  ];
  const text = formatStats(rows, null, new Date("2026-11-02T00:00:00Z"));
  assert.match(text, /per bet: 1 unit flat/);
  assert.match(text, /^🎯 Promo picks, the best card per promo \(2 promos\): 1-1, \+0\.56u, ROI \+28\.0% \(bot expected \+18\.0%\)$/m);
  assert.match(text, /^🧾 Slips checked: called -EV: 0-1, -1\.00u/m);
  assert.match(text, /^🦵 Every leg suggested, once each: hit 1\/2 \(50%\) vs the bot's fair 43%$/m);
  assert.match(text, /^⏳ 1 waiting on games\.$/m);
  assert.doesNotMatch(text, /By book/, "the breakdowns are /stats full");
  const full = formatStats(rows, null, new Date("2026-11-02T00:00:00Z"), null, true);
  assert.match(full, /^• DraftKings: 1-1/m);
  assert.match(full, /^• Anytime TD: hit 1\/2 \(50%\) vs fair 43%$/m);
  assert.match(formatStats(rows, 1, new Date("2026-12-01T00:00:00Z")), /No suggestions logged \(last 1 day\)/);
});

test("/stats is this chat's by default; /stats all is everyone's", async () => {
  const { parseStatsArgs } = await import("./mod.ts");
  assert.deepEqual(parseStatsArgs("/stats"), { all: false, days: null, full: false });
  assert.deepEqual(parseStatsArgs("/stats 7"), { all: false, days: 7, full: false });
  assert.deepEqual(parseStatsArgs("/stats all"), { all: true, days: null, full: false });
  assert.deepEqual(parseStatsArgs("/stats@Bmorepromobot all 7"), { all: true, days: 7, full: false });
  assert.deepEqual(parseStatsArgs("/stats 7 all full"), { all: true, days: 7, full: true });
  const empty = formatStats([], 7, new Date("2026-11-07T00:00:00Z"), "mine");
  assert.match(empty, /No suggestions logged \(this chat, last 7 days\)/);
  assert.match(empty, /\/stats 7 full for the breakdown · \/stats all 7 for everyone's$/);
  assert.match(formatStats([], null, new Date(), "all"), /\(everyone, all time\)[\s\S]*\/stats all full for the breakdown · \/stats for just this chat's$/);
});

// One promo request sent 3 cards sharing 2 legs: the record counts the best one.
test("/stats counts the best card per promo, and SGP leg ideas only as legs", () => {
  const at = "2026-11-08T03:11:35Z";
  const row = (o: Partial<StoredPick>): StoredPick => ({
    id: 149, created_at: at, chat_id: "1", source: "pick", dedup_key: "k", book: "BetMGM", league: "NBA", kind: "parlay",
    promo_title: "25% Parlay Boost Token", boost_pct: 25, book_odds: 462, fair_prob: 0.15, ev: 0.06, verdict: "plus_ev", first_start: null, last_start: null,
    legs: [leg({ selection: "Camara Under 2.5 Threes", fair: 0.6, result: "lost" })], status: "lost", profit: -1, ...o,
  });
  const rows = [
    row({}), row({ id: 150, book_odds: 486 }), row({ id: 151, book_odds: 481, status: "won", profit: 5, legs: [leg({ selection: "Other", fair: 0.5, result: "won" })] }),
    row({ id: 152, created_at: "2026-11-08T05:00:00Z", source: "sgp_legs", book_odds: null, profit: null, ev: null, verdict: null }),
  ];
  const text = formatStats(rows, null, new Date("2026-11-09T00:00:00Z"));
  assert.match(text, /best card per promo \(1 promo\): 0-1, -1\.00u/);
  assert.match(text, /Every card sent \(3\): 1-2, \+3\.00u/);
  assert.doesNotMatch(text, /0-2|1-3/, "the SGP idea isn't in any record");
});
