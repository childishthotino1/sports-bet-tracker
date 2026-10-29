import { test } from "node:test";
import assert from "node:assert/strict";
import { example } from "./examples.test-helper.ts";
const NFL_30_PARLAY_BOOST = example("Unknown book: 30% NFL Parlay Profit Boost");
import { normalizePromo, parseAmerican, prompt, startFlow, step, type FlowState } from "./mod.ts";

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

test("checks a bet and prices it with an assumed margin", () => {
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

test("multi-kind promo asks the bet kind, and legs only where a limit applies", () => {
  const nfl = normalizePromo(NFL_30_PARLAY_BOOST);
  let s = tap(startFlow(nfl), "DraftKings", "check").s;
  assert.equal(s.step, "kind");
  assert.deepEqual(prompt(s).buttons.flat().map((b) => b.value), ["sgp", "parlay"]);

  // SGP: no leg question, straight to the price.
  assert.equal(tap(s, "sgp").s.step, "odds");

  // Parlay: legs asked; 3 is rejected, 4 moves on.
  const r = tap(s, "parlay", "3", "4", "+1228", "+1500");
  assert.equal(r.replies[0], "❌ Doesn't qualify: parlay needs 4-25 legs, not 3. How many legs?");
  // Four -110 legs: book +1228, no-vig fair +1500; boosted +1596 beats it.
  assert.match(r.replies[1], /^DraftKings: \+1228, boosted to \+1596$/m);
  assert.match(r.replies[1], /^EV: \+6\.0%$/m);
  assert.equal(r.s.step, "action");
  assert.equal(r.s.kind, undefined);
});

test("Find the best bets hands the odds lookup to the bot", () => {
  const s = startFlow({ ...promo(), book: "BetMGM" });
  assert.deepEqual(prompt(s).buttons.flat().map((b) => b.value), ["picks", "check", "done"]);
  const r = step(s, "picks");
  assert.equal(r.action, "picks");
  assert.equal(r.state.step, "action");
});

test("a price typed at the legs question isn't taken as a leg count", () => {
  const nfl = normalizePromo(NFL_30_PARLAY_BOOST);
  const r = tap(startFlow(nfl), "DraftKings", "check", "parlay", "+1228");
  assert.equal(r.s.step, "legs");
  assert.equal(r.replies[0], "Send the number of legs, like 4.");
  assert.equal(tap(r.s, "99").s.step, "legs");
  assert.equal(tap(r.s, "5").s.step, "odds");
});
