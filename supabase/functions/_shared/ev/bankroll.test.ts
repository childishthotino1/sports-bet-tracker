import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBet, normalizePromo, parseBankroll, startFlow, step, wagerLine } from "./mod.ts";

test("/bankroll reads dollars, thousands and off", () => {
  assert.equal(parseBankroll("4000"), 4000);
  assert.equal(parseBankroll("$4,000"), 4000);
  assert.equal(parseBankroll("4k"), 4000);
  assert.equal(parseBankroll("2.5K"), 2500);
  assert.equal(parseBankroll("off"), null);
  assert.equal(parseBankroll("0"), null);
  assert.equal(parseBankroll("lots"), undefined);
  assert.equal(parseBankroll("10"), undefined, "too small to be a bankroll");
});

test("with a bankroll, one stake: quarter Kelly, capped at 3% and the promo's max", () => {
  // Quarter Kelly 2.4% of $4,000 = $97.50 -> $98.
  assert.equal(wagerLine(0.0975, null, 4000), "💵 Bet $98 (¼ Kelly on your $4K bankroll)");
  // A big edge stops at 3%: $120.
  assert.equal(wagerLine(0.2, null, 4000), "💵 Bet $120 (¼ Kelly on your $4K bankroll, capped at 3%)");
  // A $10-max promo stops at $10.
  assert.equal(wagerLine(0.0975, 10, 4000), "💵 Bet $10 (¼ Kelly on your $4K bankroll, max $10)");
  assert.equal(wagerLine(0.004, null, 2500), "💵 Bet $2.5 (¼ Kelly on your $2.5K bankroll)");
  assert.equal(wagerLine(0, null, 4000), null, "no stake on a -EV bet");
  // No bankroll: the four-bankroll line, as before.
  assert.match(wagerLine(0.0975)!, /^Wager \(¼ Kelly\): \$500 bank/);
});

test("pick cards and typed-price checks use the bankroll", () => {
  const card = formatBet({ book: "BetMGM", bookOdds: 100, boost: 0.5, legs: [{ selection: "Falcons ML", fairProb: 0.5 }], bankroll: 4000 });
  assert.match(card.text, /💵 Bet \$\d+ \(¼ Kelly on your \$4K bankroll/);
  assert.doesNotMatch(card.text, /\$500 bank/);
  const promo = normalizePromo({ book: "BetMGM", title: "50% Boost", type: "profit_boost", boost_pct: 50, max_stake: 25, leagues: ["NFL"] });
  let s = step(startFlow(promo), "check").state;
  s = step({ ...s, bankroll: 4000 }, "+100").state;
  const r = step({ ...s, bankroll: 4000 }, "m4");
  assert.match(r.reply!, /💵 Bet \$25 \(¼ Kelly on your \$4K bankroll, max \$25\)/);
});
