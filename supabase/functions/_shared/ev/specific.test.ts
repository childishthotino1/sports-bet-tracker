import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { bestBets, legKey, matchMust, normalizePromo, priceLegs, prompt, startFlow, step, type FlowState, type OddsEvent } from "./mod.ts";

// Real CIN @ ATL pull (2026-11-08): DraftKings' priced legs are both MLs, both
// spreads (3), the total (52.5) and Bijan Robinson anytime TD.
const GAME: OddsEvent = JSON.parse(readFileSync(new URL("./samples/nfl-2026-11-08-cin-atl-links.json", import.meta.url), "utf8"));
const LEGS = priceLegs([GAME], "draftkings", { now: new Date("2026-11-08T12:00:00Z") });
const picked = (text: string) => { const m = matchMust(LEGS, text); return m ? LEGS.filter(m.match).map((l) => l.selection).sort() : null; };

test("Be specific: a game means any leg from it; more than that means the legs that name it", () => {
  const game = matchMust(LEGS, "Falcons game")!;
  assert.equal(game.game, true);
  assert.equal(LEGS.filter(game.match).length, LEGS.length);
  assert.deepEqual(picked("falcons ml"), ["Atlanta Falcons ML"], "not the Bengals' moneyline, though it's in the Falcons' game");
  assert.deepEqual(picked("Bengals -3"), ["Cincinnati Bengals -3"]);
  assert.deepEqual(picked("over 52.5"), ["Over 52.5"]);
  assert.deepEqual(picked("include a Bijan touchdown"), ["Bijan Robinson Anytime TD"]);
  assert.equal(matchMust(LEGS, "Ja'Marr Chase TD"), null, "a leg the book doesn't post (or the sharps don't price)");
  assert.equal(matchMust(LEGS, "the game"), null, "nothing to go on");
});

test("Be specific: every pick includes the leg, even when nothing with it is +EV", async () => {
  const promo = normalizePromo({ book: "DraftKings", title: "No boost", boost_pct: 0, bet_kinds: ["single"] });
  const bijan = matchMust(LEGS, "Bijan TD")!;
  const picks = bestBets(LEGS, promo, { must: bijan.match });
  assert.ok(picks.length >= 1);
  assert.ok(picks.every((p) => p.legs.some(bijan.match)));
  assert.equal(legKey(picks[0].legs[0]), `${GAME.id}|Bijan Robinson Anytime TD`);
  const { whyNote } = await import("./mod.ts");
  const boosted = bestBets(LEGS, { ...promo, boost_pct: 30 }, { must: bijan.match })[0];
  assert.ok(boosted.eval.ev < 0);
  assert.match(whyNote(boosted, 0.3, "DraftKings"), /Even with the 30% boost it's -/, "never 'the boost is the edge' on a -EV card");
});

test("Try something different and Be specific in the promo flow", () => {
  const promo = normalizePromo({ book: "DraftKings", title: "NBA 30% Boost", boost_pct: 30, max_stake: 25, leagues: ["NBA"] });
  let s: FlowState = { ...startFlow(promo), sport: "NBA", rangeAsked: true };
  const labels = (st: FlowState) => prompt(st).buttons.flat().map((b) => b.label);
  assert.ok(!labels(s).some((l) => l.includes("different")), "nothing shown yet, so nothing to differ from");
  assert.ok(labels(s).includes("✍️ Be specific"));

  s = { ...s, shown: ["e1|Knicks ML"] };
  assert.ok(labels(s).includes("🔄 Try something different"));
  const diff = step(s, "different");
  assert.equal(diff.action, "picks");
  assert.deepEqual(diff.state.shown, ["e1|Knicks ML"], "the shown legs stay, so the search leaves them out");
  assert.equal(step(s, "picks").state.shown, undefined, "Find the best bets starts over");

  const ask = step(s, "specific");
  assert.equal(ask.state.step, "specific");
  const set = step(ask.state, "Jalen Brunson points");
  assert.equal(set.action, "picks");
  assert.equal(set.state.must, "Jalen Brunson points");
  assert.match(prompt(set.state).text, /📌 Must include: Jalen Brunson points/);
  assert.ok(labels(set.state).includes("✍️ Change what to include"));
  const cleared = step({ ...set.state, step: "specific" }, "clear");
  assert.equal(cleared.state.must, undefined);
  assert.equal(cleared.state.step, "action");

  // After SGP leg ideas the bot waits for a slip; both buttons work from there.
  const waiting: FlowState = { ...s, step: "slip" };
  assert.ok(prompt(waiting).buttons.flat().some((b) => b.value === "different"));
  assert.equal(step(waiting, "different").action, "picks");
  assert.equal(step(waiting, "specific").state.step, "specific");
});

// "TB vs CHI Pro Football SGP Profit Boost" (DraftKings, 2026-11-08): the bot read
// the game as "TB vs CHI" and couldn't match it; "Bucs" in a Be specific didn't
// match either.
test("team abbreviations and nicknames find the game", async () => {
  const { findEvent, expandTeamAliases } = await import("./mod.ts");
  const ev = [
    { id: "tbchi", home_team: "Chicago Bears", away_team: "Tampa Bay Buccaneers", commence_time: "2026-11-09T01:20:00Z" },
    { id: "phigb", home_team: "Green Bay Packers", away_team: "Philadelphia Eagles", commence_time: "2026-11-10T01:15:00Z" },
    { id: "nolar", home_team: "Los Angeles Rams", away_team: "New Orleans Saints", commence_time: "2026-11-09T21:05:00Z" },
  ];
  const find = (t: string) => findEvent(ev, [expandTeamAliases(t)], new Date("2026-11-09T00:50:00Z"))?.id ?? null;
  assert.equal(find("TB vs CHI"), "tbchi");
  assert.equal(find("tb @ chi"), "tbchi", "lower case too");
  assert.equal(find("Chicago bears and Tampa bay Bucs game"), "tbchi");
  assert.equal(find("PHI @ GB"), "phigb");
  assert.equal(find("NO @ LAR"), "nolar");
  assert.equal(expandTeamAliases("no boost on the car"), "no boost on the car", "common words stay words in lower case");
  const legs = [{ eventId: "tbchi", game: "Tampa Bay Buccaneers @ Chicago Bears", market: "h2h", selection: "Chicago Bears ML", side: "Chicago Bears" }] as any;
  assert.equal(matchMust(legs, "Chicago bears and Tampa bay Bucs game")?.game, true);
  assert.deepEqual(legs.filter(matchMust(legs, "CHI ML")!.match).map((l: any) => l.selection), ["Chicago Bears ML"]);
});
