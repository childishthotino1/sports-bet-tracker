import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  allowsSgpx, forcingIdeas, NEAR_IMPLIED, TEAM_TOTAL_GIVEN_TDS, formatShop, shopLegs, americanToDecimal, bestBets, cardLegs, checkSlip, formatBet, filterMode, findRuleBlocks, formatRange, formatSgpSuggestion, formatSlipCheck,
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
  assert.deepEqual(findRuleBlocks(legs, "BetMGM"), [], "free-leg rules are per book");
  assert.equal(findRuleBlocks(legs, "any")[0].rule.id, "thescore-spread-ml", "the joint holds at every book");
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
  // The pair's joint is a fact about the game: it applies on any book.
  assert.equal(checkSlip(SCORE_SLIP, priced, null, "BetMGM")!.rules.length, 1);
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

// Real La Liga game: DraftKings' per-game soccer markets, priced by Pinnacle.
// The sport-wide feed gave DraftKings' moneyline only, which used to stop SGP
// suggestions cold.
test("a soccer SGP finds four legs in one game's own markets", () => {
  const game: OddsEvent = JSON.parse(readFileSync(new URL("./samples/laliga-2026-10-31-mal-bet.json", import.meta.url), "utf8"));
  const legs = priceLegs([game], "draftkings", { now: new Date("2026-10-31T14:30:00Z") });
  const sg = suggestSgpLegs(legs, 4, game.id, "DraftKings")!;
  assert.ok(sg, legs.map((l) => l.selection).join(", "));
  const markets = sg.legs.map((l) => l.market.replace(/^alternate_/, ""));
  assert.equal(new Set(markets).size, 4, "four different markets");
  assert.ok(markets.filter((m) => ["h2h", "spreads", "draw_no_bet"].includes(m)).length <= 1, "one result leg");
  assert.equal(sg.legs.filter((l) => l.market === "alternate_totals_corners").length <= 1, true, "one corners total");
});

test("SGPx builds one leg per game for an SGP-only promo", () => {
  const promo = normalizePromo({ book: "DraftKings", title: "Soccer 20% SGP(x) Boost", type: "profit_boost", boost_pct: 20, max_stake: 100,
    min_total_odds: 100, min_legs: 2, bet_kinds: ["sgp"], leagues: ["SOCCER"], notes: "SGPx (multi-game same-game parlays) also qualifies" });
  assert.equal(allowsSgpx(promo), true);
  assert.equal(allowsSgpx({ ...promo, title: "NFL SGP Boost", notes: null }), false);
  const game = (id: string, book: number, sharp: [number, number]): OddsEvent => ({
    id, sport_key: "soccer_epl", commence_time: "2026-11-01T15:00:00Z", home_team: `${id} H`, away_team: `${id} A`,
    bookmakers: [
      { key: "draftkings", title: "DraftKings", markets: [{ key: "btts", outcomes: [{ name: "Yes", price: book }, { name: "No", price: -book }] }] },
      { key: "pinnacle", title: "Pinnacle", markets: [{ key: "btts", outcomes: [{ name: "Yes", price: sharp[0] }, { name: "No", price: sharp[1] }] }] },
    ],
  });
  const legs = priceLegs([game("a", 110, [105, -115]), game("b", 115, [108, -118])], "draftkings", { now: PULLED });
  const [pick] = bestBets(legs, promo);
  assert.equal(pick.kind, "sgp");
  assert.deepEqual(pick.legs.map((l) => l.eventId).sort(), ["a", "b"], "one leg per game");
  assert.ok(pick.eval.ev > 0);
  assert.match(formatBet({ book: "DraftKings", bookOdds: pick.americanOdds, boost: 0.2, legs: cardLegs(pick), kindLabel: "2-leg SGPx, one leg per game" }).text,
    /^BET TO BUILD: 2-leg SGPx, one leg per game on DraftKings$/m);
});

test("a question about a game shops each leg across the books", () => {
  const legs = shopLegs(CAR_GB, { betmgm: "BetMGM", draftkings: "DraftKings" }, { now: PULLED });
  // Panthers +3.5 is only at DraftKings; Panthers +4 only at BetMGM.
  assert.equal(legs.find((l) => l.selection === "Carolina Panthers +3.5")!.book, "DraftKings");
  assert.equal(legs.find((l) => l.selection === "Carolina Panthers +4")!.book, "BetMGM");
  assert.equal(new Set(legs.map((l) => l.selection)).size, legs.length, "each leg once, at its best book");
  for (let i = 1; i < legs.length; i++) assert.ok(legs[i - 1].edge >= legs[i].edge);
  const text = formatShop(CAR_GB, legs);
  assert.match(text, /^🔎 Carolina Panthers @ Green Bay Packers, /);
  assert.match(text, /^1\. .* at (BetMGM|DraftKings) \(fair /m);
});

test("forcing rules: TDs carry a low team total, a ladder, low yards, a double-double's stats", () => {
  const henry = (market: string, side: string, line: number | null) => leg(market, side, line, "Baltimore Ravens", "Derrick Henry");
  const blocks = (legs: ReturnType<typeof leg>[]) => findRuleBlocks(legs, "any").map((b) => [b.rule.id, b.legs, b.cond]);
  // noliver's: Henry 2+ TDs + 25+ rush yards + BAL team total Over 13.5.
  const legs = [henry("player_tds_over", "Over", 1.5), henry("player_rush_yds_alternate", "Over", 24.5), leg("team_totals", "Over", 13.5, "Baltimore Ravens", null)];
  assert.deepEqual(blocks(legs), [["td-team-total", [0, 2], TEAM_TOTAL_GIVEN_TDS]], "each leg used once");
  assert.deepEqual(blocks([legs[0], legs[1]]), [["td-own-yards", [0, 1], NEAR_IMPLIED]]);
  assert.deepEqual(blocks([legs[0], { ...legs[2], line: 11.5 }]), [["td-team-total", [0, 1], 1]], "12 points clear 11.5");
  assert.deepEqual(blocks([legs[0], { ...legs[2], line: 20.5 }]), [], "too high to be forced");
  assert.deepEqual(blocks([legs[0], { ...legs[2], team: "Pittsburgh Steelers" }]), [], "the other team");
  assert.deepEqual(blocks([henry("player_anytime_td", "Yes", null), legs[0]]), [["stat-ladder", [1, 0], 1]], "2+ TDs implies a TD");
  assert.deepEqual(blocks([henry("player_rush_yds", "Over", 59.5), henry("player_rush_yds_alternate", "Over", 79.5)]), [["stat-ladder", [1, 0], 1]]);
  assert.deepEqual(blocks([henry("player_anytime_td", "Yes", null), henry("player_reception_yds", "Over", 34.5)]), [], "not a low line");
  const giannis = (market: string, side: string, line: number | null) => leg(market, side, line, "Milwaukee Bucks", "Giannis Antetokounmpo");
  assert.deepEqual(blocks([giannis("player_rebounds", "Over", 9.5), giannis("player_double_double", "Yes", null)]), [["double-double-stat", [1, 0], NEAR_IMPLIED]]);
  assert.deepEqual(blocks([giannis("player_triple_double", "Yes", null), giannis("player_assists", "Over", 7.5)]), [["double-double-stat", [0, 1], 1]]);
});

test("an SGP made only of rule pairs is priced from the joints, not the book's correlation", () => {
  const slip = normalizeSlip({
    book: "BetMGM", league: "NFL", bet_kind: "sgp", total_odds: 400, game: "",
    legs: [
      { team_or_player: "Derrick Henry", market: "player_tds_over", line: 1.5, side: "Over", team: "Baltimore Ravens" },
      { team_or_player: "Baltimore Ravens", market: "team_totals", line: 13.5, side: "Over", team: "" },
    ],
  })!;
  assert.equal(slip.legs[1].team, null);
  const priced = [
    { label: "Henry 2+ TDs", bookOdds: 300, fair: 0.24, source: "sharp" as const },
    { label: "BAL Over 13.5", bookOdds: -1000, fair: 0.88, source: "sharp" as const },
  ];
  const c = checkSlip(slip, priced, null, "BetMGM")!;
  assert.equal(c.rules.length, 1);
  assert.ok(Math.abs(c.fairProb - 0.24 * TEAM_TOTAL_GIVEN_TDS) < 1e-12, String(c.fairProb));
  assert.match(formatSlipCheck(slip, "BetMGM", c, null), /about 90% of leg 1 alone/);
});

test("SGP suggestions with a scorer offer the legs it forces", () => {
  const ideas = forcingIdeas([
    { market: "player_anytime_td", side: "Yes", description: "Zay Flowers" },
    { market: "player_tds_over", side: "Over", point: 1.5, description: "Derrick Henry" },
    { market: "player_double_double", side: "Yes", description: "Giannis Antetokounmpo" },
    { market: "h2h", side: "Baltimore Ravens" },
  ]);
  assert.equal(ideas.length, 3);
  assert.match(ideas[0], /Zay Flowers a TD: his team's total Over 5\.5 can't lose/);
  assert.match(ideas[1], /Derrick Henry 2\+ TDs: his team's total Over 11\.5 can't lose/);
  assert.match(ideas[2], /rebounds \(or points\) Over 9\.5/);
});
