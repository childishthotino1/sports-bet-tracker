import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  americanToDecimal, bestBets, checkSlip, filterMode, findRuleBlocks, formatRange, formatSgpSuggestion, formatSlipCheck,
  impliedProb, normalizePromo, normalizeSlip, parseTarget, priceLegs, priceSlipLegs, prompt, QB_TD_GIVEN_TEAMMATE_TD,
  startFlow, step, suggestSgpLegs, type OddsEvent, type RuleLeg,
} from "./mod.ts";

const CAR_GB: OddsEvent = JSON.parse(readFileSync(new URL("./samples/nfl-2026-10-29-car-gb.json", import.meta.url), "utf8"));
const PULLED = new Date("2026-10-29T23:55:00Z");

// ── Market toggles ────────────────────────────────────────

test("main lines only / props only keep just those legs", () => {
  const legs = priceLegs([CAR_GB], "betmgm", { now: PULLED });
  const main = filterMode(legs, "main"), props = filterMode(legs, "props");
  assert.ok(main.length && props.length);
  assert.ok(main.every((l) => ["h2h", "spreads", "totals"].includes(l.market)));
  assert.ok(props.every((l) => l.market.startsWith("player_")));
  assert.equal(filterMode(legs, "all").length, main.length + props.length);
});

// ── Target odds ───────────────────────────────────────────

test("a target price means that price up to 1.5x its profit; a range is exact", () => {
  assert.deepEqual(parseTarget("+400"), { min: 400, max: 600 });
  assert.deepEqual(parseTarget("400"), { min: 400, max: 600 });
  assert.deepEqual(parseTarget("+400-600"), { min: 400, max: 600 });
  assert.deepEqual(parseTarget("+400 to +700"), { min: 400, max: 700 });
  assert.deepEqual(parseTarget("-200"), { min: -200, max: -133 });
  assert.equal(parseTarget("+600-400"), null, "max below min");
  assert.equal(parseTarget("soon"), null);
  assert.equal(formatRange({ min: 400, max: 600 }), "+400 to +600");
});

test("the promo menu sets and clears a target", () => {
  const promo = normalizePromo({ book: "BetMGM", title: "NBA 25% Parlay Boost", type: "profit_boost", boost_pct: 25, max_stake: 25,
    bet_kinds: ["parlay"], leagues: ["NBA"] });
  let s = startFlow(promo);
  s = step(s, "target").state;
  assert.equal(s.step, "target");
  assert.ok(prompt(s).buttons.flat().some((b) => b.value === "any"));
  assert.match(step(s, "soon").reply!, /type a price/);
  s = step(s, "+400").state;
  assert.equal(s.step, "action");
  assert.deepEqual(s.target, { min: 400, max: 600 });
  assert.match(prompt(s).text, /🎚 Target \+400 to \+600/);
  assert.ok(prompt(s).buttons.flat().some((b) => b.label === "🎚 Change target odds"));
  s = step(step(s, "target").state, "any").state;
  assert.equal(s.target, undefined);
});

test("picks stay inside the target", () => {
  // Two games with near-fair legs at a range of prices.
  const game = (id: string, start: string, legs: [string, number, number][]): OddsEvent => ({
    id, sport_key: "basketball_nba", commence_time: start, home_team: `${id} Home`, away_team: `${id} Away`,
    bookmakers: [
      { key: "draftkings", title: "DraftKings", markets: [{ key: "h2h", outcomes: legs.map(([name, book]) => ({ name, price: book })) }] },
      { key: "pinnacle", title: "Pinnacle", markets: [{ key: "h2h", outcomes: legs.map(([name, , sharp]) => ({ name, price: sharp })) }] },
    ],
  });
  const events = [
    game("a", "2026-11-01T00:00:00Z", [["A fav", -150, -160], ["A dog", 135, 140]]),
    game("b", "2026-11-01T00:00:00Z", [["B fav", -200, -210], ["B dog", 180, 185]]),
    game("c", "2026-11-01T00:00:00Z", [["C fav", -120, -125], ["C dog", 110, 108]]),
  ];
  const promo = normalizePromo({ book: "DraftKings", title: "50% boost", type: "profit_boost", boost_pct: 50, bet_kinds: ["parlay"] });
  const legs = priceLegs(events, "draftkings", { now: PULLED });
  const any = bestBets(legs, promo, { top: 50 });
  assert.ok(any.some((p) => americanToDecimal(p.americanOdds) > 7), "without a target, long parlays qualify");
  const picks = bestBets(legs, promo, { top: 50, target: { min: 300, max: 450 } });
  assert.ok(picks.length > 0);
  for (const p of picks) assert.ok(p.americanOdds >= 300 && p.americanOdds <= 450, `${p.americanOdds}`);
});

// ── Redundant-leg rules ───────────────────────────────────

const leg = (market: string, side: string, line: number | null, team: string | null = null, player: string | null = null): RuleLeg =>
  ({ market, side, line, team, player });

test("spread + the same team's moneyline is a theScore rule", () => {
  const legs = [leg("player_points", "Over", 24.5), leg("h2h", "Green Bay Packers", null), leg("spreads", "Green Bay Packers", -3.5)];
  const [b] = findRuleBlocks(legs, "theScore Bet");
  assert.equal(b.rule.id, "thescore-spread-ml");
  assert.deepEqual(b.legs, [2, 1], "the favorite's spread implies its moneyline");
  // An underdog's moneyline implies its spread.
  const [dog] = findRuleBlocks([leg("spreads", "Carolina Panthers", 3.5), leg("h2h", "Panthers", null)], "theScore Bet");
  assert.deepEqual(dog.legs, [1, 0]);
  assert.deepEqual(findRuleBlocks(legs, "BetMGM"), [], "rules are per book");
  assert.deepEqual(findRuleBlocks([leg("spreads", "Packers", -3.5), leg("h2h", "Panthers", null)], "theScore Bet"), [], "opposite teams");
});

test("a QB's passing TD + a teammate's anytime TD is a DraftKings rule", () => {
  const legs = [
    leg("player_pass_tds", "Over", 0.5, "Green Bay Packers", "Jordan Love"),
    leg("player_anytime_td", "Yes", null, "Green Bay Packers", "Tucker Kraft"),
    leg("player_anytime_td", "Yes", null, "Carolina Panthers", "Tetairoa McMillan"),
  ];
  const [b] = findRuleBlocks(legs, "DraftKings");
  assert.equal(b.rule.id, "dk-qb-receiver-td");
  assert.deepEqual(b.legs, [1, 0], "Kraft's TD implies Love threw one");
  assert.deepEqual(findRuleBlocks([legs[0], legs[2]], "DraftKings"), [], "a TD on the other team doesn't");
  assert.deepEqual(findRuleBlocks([{ ...legs[0], line: 1.5 }, legs[1]], "DraftKings"), [], "2+ passing TDs isn't implied");
});

// A theScore slip: Packers -3.5 + Packers ML + Over 47.5, priced as one line
// for the pair (the SGP = spread × total, the moneyline adds nothing).
const SCORE_GAME: OddsEvent = {
  ...CAR_GB,
  bookmakers: [
    { key: "espnbet", title: "theScore Bet", markets: [
      { key: "h2h", outcomes: [{ name: "Carolina Panthers", price: 165 }, { name: "Green Bay Packers", price: -200 }] },
      { key: "spreads", outcomes: [{ name: "Carolina Panthers", point: 3.5, price: -110 }, { name: "Green Bay Packers", point: -3.5, price: -110 }] },
      { key: "totals", outcomes: [{ name: "Over", point: 47.5, price: -110 }, { name: "Under", point: 47.5, price: -110 }] },
    ] },
    ...CAR_GB.bookmakers.filter((b) => b.key !== "betmgm" && b.key !== "draftkings"),
  ],
};
const SCORE_SLIP = normalizeSlip({
  book: "theScore Bet", league: "NFL", bet_kind: "sgp", game: "Carolina Panthers @ Green Bay Packers",
  total_odds: Math.round((americanToDecimal(-110) ** 2 - 1) * 100), // +264
  legs: [
    { team_or_player: "Green Bay Packers", market: "spreads", line: -3.5, side: "Green Bay Packers", team: "Green Bay Packers" },
    { team_or_player: "Green Bay Packers", market: "h2h", line: null, side: "Green Bay Packers", team: "Green Bay Packers" },
    { team_or_player: "", market: "totals", line: 47.5, side: "Over", team: "" },
  ],
})!;

test("a slip with a rule pair prices the pair as the spread alone", () => {
  assert.equal(SCORE_SLIP.legs[0].team, "Green Bay Packers");
  const priced = priceSlipLegs(SCORE_SLIP, [SCORE_GAME, SCORE_GAME, SCORE_GAME], "espnbet");
  const c = checkSlip(SCORE_SLIP, priced, null, "theScore Bet")!;
  assert.equal(c.rules.length, 1);
  const [spread, , over] = priced.map((l) => l.fair!);
  assert.ok(Math.abs(c.rules[0].joint - spread) < 1e-12);
  // The book priced the pair as one line and the total independently, so the
  // fair estimate is spread × total: the moneyline drops out.
  assert.ok(Math.abs(c.fairProb - spread * over) < 1e-3, `${c.fairProb} vs ${spread * over}`); // the slip's price is rounded
  const text = formatSlipCheck(SCORE_SLIP, "theScore Bet", c, null);
  assert.match(text, /^🧩 Spread \+ the same team's moneyline: legs 1 \+ 2 together are worth/m);
  // Without the rule (another book), the moneyline's vig and the book's
  // correlation still go into the estimate.
  assert.equal(checkSlip(SCORE_SLIP, priced, null, "BetMGM")!.rules.length, 0);
});

test("the QB rule caps the pair at the teammate's TD x 90%", () => {
  const slip = normalizeSlip({
    book: "DraftKings", league: "NFL", bet_kind: "sgp", total_odds: 0, game: "",
    legs: [
      { team_or_player: "Jordan Love", market: "player_pass_tds", line: 0.5, side: "Over", team: "Green Bay Packers" },
      { team_or_player: "Josh Jacobs", market: "player_anytime_td", line: null, side: "Yes", team: "Green Bay Packers" },
    ],
  })!;
  const priced = [
    { label: "Love Over 0.5", bookOdds: null, fair: 0.8, source: "sharp" as const },
    { label: "Jacobs TD", bookOdds: null, fair: 0.55, source: "sharp" as const },
  ];
  const c = checkSlip({ ...slip, total_odds: 120 }, priced, null, "DraftKings")!;
  assert.ok(Math.abs(c.rules[0].joint - Math.min(0.8, 0.55 * QB_TD_GIVEN_TEAMMATE_TD)) < 1e-12);
  assert.ok(Math.abs(c.fairProb - 0.55 * QB_TD_GIVEN_TEAMMATE_TD) < 1e-12, "no book leg prices: the rule's joint alone");
});

test("SGP suggestions on theScore add the favorite's moneyline as a free leg", () => {
  const legs = priceLegs([SCORE_GAME], "espnbet", { now: PULLED });
  const sg = suggestSgpLegs(legs.filter((l) => l.selection !== "Carolina Panthers +3.5"), 2, CAR_GB.id, "theScore Bet")!;
  const spread = sg.legs.findIndex((l) => l.selection === "Green Bay Packers -3.5");
  assert.ok(spread >= 0, sg.legs.map((l) => l.selection).join(", "));
  assert.equal(sg.legs[spread + 1].selection, "Green Bay Packers ML");
  assert.deepEqual(sg.free.map((f) => [f.leg, f.with]), [[spread + 1, spread]]);
  assert.match(formatSgpSuggestion(sg, "theScore Bet"), /Green Bay Packers ML -200 \(free with leg \d: Spread \+ the same team's moneyline\)/);
  // Another book: no free leg, one result leg only.
  const mgm = suggestSgpLegs(legs.filter((l) => l.selection !== "Carolina Panthers +3.5"), 2, CAR_GB.id, "BetMGM")!;
  assert.deepEqual(mgm.free, []);
  assert.ok(impliedProb(-200) > 0.6);
});
