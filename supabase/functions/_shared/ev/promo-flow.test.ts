import { test } from "node:test";
import assert from "node:assert/strict";
import { example } from "./examples.test-helper.ts";
const NFL_30_PARLAY_BOOST = example("Unknown book: 30% NFL Parlay Profit Boost");
import { normalizePromo, parseAmerican, prompt, slipOnly, startFlow, step, type FlowState } from "./mod.ts";

// The 33% MLB SGP boost screenshot: no book shown, max $50, min +300.
const promo = () => normalizePromo({
  book: null, title: "33% MLB Same Game Parlay Profit Boost", type: "profit_boost", boost_pct: 33,
  max_stake: 50, min_total_odds: 300, min_legs: null, max_legs: null, legs_apply_to: [], bet_kinds: ["sgp"], leagues: ["MLB"],
  live: true, pregame: true, paid_in: null, expires_at: "2026-10-29T03:00", notes: null,
});

const tap = (s: FlowState, ...inputs: string[]) => {
  const replies: string[] = [];
  for (const i of inputs) {
    const r = step(s, i);
    s = r.state;
    if (r.reply) replies.push(r.reply);
  }
  return { s, replies };
};

test("asks only for what the screenshot didn't show", () => {
  let s = startFlow(promo());
  assert.equal(s.step, "book"); // no book on screen
  assert.equal(prompt(s).buttons.flat()[0].value, "BetMGM");
  s = tap(s, "DraftKings").s;
  assert.equal(s.step, "action"); // max wager was shown, so it isn't asked
  assert.match(prompt(s).text, /33% boost · Same Game Parlay · MLB · min \+300 · max \$50/);

  const noMax = startFlow({ ...promo(), book: "BetMGM", max_stake: null });
  assert.equal(noMax.step, "max_stake");
  const after = tap(noMax, "none").s;
  assert.equal(after.step, "action");
  assert.equal(after.promo.max_stake, null);
});

test("Check a bet waits for a slip screenshot; a typed price still works", () => {
  const waiting = tap(startFlow(promo()), "DraftKings", "check").s;
  assert.equal(waiting.step, "slip");
  assert.match(prompt(waiting).text, /^Send a screenshot of the bet slip on DraftKings/);
  assert.deepEqual(prompt(waiting).buttons, []); // no follow-up questions
  assert.equal(step(waiting, "Jacobs TD").reply, "Send a bet slip screenshot, or a price like +350.");
});

test("checks a typed price with an assumed margin", () => {
  const { s, replies } = tap(startFlow(promo()), "DraftKings", "check", "+250", "+320", "m20");
  assert.equal(replies[0], "❌ Doesn't qualify: odds +250 below minimum +300. Send a different price.");
  assert.match(replies[1], /^DraftKings: \+320, boosted to \+426$/m);
  assert.match(replies[1], /^Fair: \+404 \(19\.8%, assumes a 20% book margin\)$/m);
  assert.match(replies[1], /^EV: \+4\.3%$/m);
  assert.match(replies[1], /✅ \+EV/);
  assert.equal(s.step, "action"); // back to the menu for another check
});

test("a typed fair price works, and -EV says skip", () => {
  const { replies } = tap(startFlow(promo()), "FanDuel", "check", "320", "+450");
  assert.match(replies[0], /EV: -/);
  assert.match(replies[0], /❌ -EV/);
  assert.doesNotMatch(replies[0], /Kelly/);
});

test("bad input re-asks instead of moving on", () => {
  const { s, replies } = tap(startFlow(promo()), "Bovada");
  assert.equal(s.step, "book");
  assert.equal(replies[0], "Pick one of the books above.");
  assert.equal(parseAmerican("+3.5"), null);
  assert.equal(parseAmerican("-120"), -120);
  assert.equal(parseAmerican("99"), null);
});

test("button values fit Telegram's 64-byte callback_data", () => {
  const states: FlowState[] = [
    startFlow(promo()),
    startFlow({ ...promo(), book: "BetMGM", max_stake: null }),
    { promo: promo(), step: "action" },
    { promo: promo(), step: "fair", bookOdds: 320 },
  ];
  for (const s of states) for (const b of prompt(s).buttons.flat()) assert.ok(new TextEncoder().encode(`pf:${b.value}`).length <= 64);
});


test("Find the best bets hands the odds lookup to the bot", () => {
  const s = startFlow({ ...promo(), book: "BetMGM" });
  assert.deepEqual(prompt(s).buttons.flat().map((b) => b.value), ["picks", "check", "target", "done"]);
  const r = step(s, "picks");
  assert.equal(r.action, "picks");
  assert.equal(r.state.step, "action");
  assert.equal(r.state.sport, "MLB"); // the promo's one league, no question
});


test("picks ask for the sport when the promo names none", () => {
  const any = normalizePromo({ book: "DraftKings", title: "25% Profit Boost", type: "profit_boost", boost_pct: 25, max_stake: 25,
    min_total_odds: -200, bet_kinds: [], leagues: [] });
  let r = step(startFlow(any), "picks");
  assert.equal(r.action, undefined);
  assert.equal(r.state.step, "sport");
  const values = prompt(r.state).buttons.flat().map((b) => b.value);
  assert.deepEqual(values.slice(0, 6), ["NFL", "NCAAF", "NBA", "WNBA", "NCAAB", "MLB"]);
  assert.ok(values.includes("EPL"));
  assert.equal(step(r.state, "Soccer").reply, "Pick a sport above.");
  r = step(r.state, "NBA");
  assert.equal(r.action, "picks");
  assert.equal(r.state.sport, "NBA");
  assert.equal(r.state.step, "action");
});

test("a slip waiting on its book is priced once the book is tapped", () => {
  const slip = { book: null, league: "NFL", bet_kind: "sgp" as const, total_odds: 990, game: null,
    legs: [{ team_or_player: "Green Bay Packers", market: "h2h", line: null, side: "Green Bay Packers" }] };
  const s = { ...slipOnly(slip), step: "book" as const };
  assert.equal(prompt(s).buttons.flat()[0].value, "BetMGM");
  const r = step(s, "FanDuel");
  assert.equal(r.action, "slip");
  assert.equal(r.state.promo.book, "FanDuel");
  assert.ok(r.state.noPromo);
});

test("a Soccer promo asks which league, with readable names", () => {
  const soccer = normalizePromo(example("Unknown book: Soccer 20% SGP(x) Boost"));
  let r = step(startFlow({ ...soccer, book: "DraftKings" }), "picks");
  assert.equal(r.state.step, "sport");
  const p = prompt(r.state);
  assert.equal(p.text, "Which league should I search?");
  assert.deepEqual(p.buttons.flat().map((b) => b.label), ["Premier League", "Champions League", "MLS", "La Liga", "Serie A", "Bundesliga"]);
  assert.equal(step(r.state, "NBA").reply, "Pick a sport above.", "a soccer promo can't search the NBA");
  r = step(r.state, "EPL");
  assert.equal(r.action, "picks");
  assert.equal(r.state.sport, "EPL");
  assert.match(prompt({ ...r.state, step: "action" }).text, /Same Game Parlay \(4\+ legs\) · Soccer · min \+400 · max \$100/);
});

test("a league the feed doesn't cover says so instead of offering other sports", () => {
  const cfl = normalizePromo({ book: "DraftKings", title: "CFL 20% SGP Boost", type: "profit_boost", boost_pct: 20, max_stake: 50, bet_kinds: ["sgp"], leagues: ["CFL"] });
  const r = step(startFlow(cfl), "picks");
  assert.equal(r.action, undefined);
  assert.equal(r.state.step, "action");
  assert.match(r.reply!, /don't have odds for CFL/);
});

test("WNBA promos search the WNBA", () => {
  const wnba = normalizePromo({ book: "DraftKings", title: "WNBA 20% SGP Boost", type: "profit_boost", boost_pct: 20, max_stake: 50,
    min_total_odds: 400, min_legs: 4, bet_kinds: ["sgp"], leagues: ["WNBA"] });
  const r = step(startFlow(wnba), "picks");
  assert.equal(r.action, "picks");
  assert.equal(r.state.sport, "WNBA");
});
