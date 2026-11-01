import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  americanToDecimal, bestBets, noPicksReason, cardLegs, formatBet, formatStart, getOdds, normalizePromo, priceLegs,
  promoCovers, rankSgpGames, suggestSgpLegs, type OddsEvent,
} from "./mod.ts";

const BEFORE = new Date("2026-10-31T00:00:00Z"); // before every sample game

// Shaped like The Odds API v4 /odds and /events/{id}/odds responses.
const EVENTS: OddsEvent[] = [
  {
    id: "e1", sport_key: "basketball_nba", commence_time: "2026-11-01T00:10:00Z",
    home_team: "New York Knicks", away_team: "Detroit Pistons",
    bookmakers: [
      { key: "draftkings", title: "DraftKings", markets: [
        { key: "totals", outcomes: [{ name: "Over", price: -110, point: 220.5 }, { name: "Under", price: -110, point: 220.5 }] },
        { key: "totals", outcomes: [] },
        { key: "player_rebounds", outcomes: [
          { name: "Over", description: "John Collins", price: -110, point: 6.5 },
          { name: "Under", description: "John Collins", price: -120, point: 6.5 },
          { name: "Over", description: "John Collins", price: 150, point: 8.5 }, // alt line Pinnacle doesn't have
        ] },
      ] },
      { key: "pinnacle", title: "Pinnacle", markets: [
        { key: "totals", outcomes: [{ name: "Over", price: -125, point: 220.5 }, { name: "Under", price: 105, point: 220.5 }] },
        { key: "player_rebounds", outcomes: [
          { name: "Over", description: "John Collins", price: -150, point: 6.5 },
          { name: "Under", description: "John Collins", price: 122, point: 6.5 },
        ] },
      ] },
    ],
  },
  {
    id: "e2", sport_key: "basketball_nba", commence_time: "2026-11-01T03:10:00Z",
    home_team: "Los Angeles Lakers", away_team: "Portland Trail Blazers",
    bookmakers: [
      { key: "draftkings", title: "DraftKings", markets: [
        { key: "spreads", outcomes: [{ name: "Los Angeles Lakers", price: -110, point: -6.5 }, { name: "Portland Trail Blazers", price: -110, point: 6.5 }] },
        { key: "player_points", outcomes: [
          { name: "Over", description: "Ja Morant", price: 100, point: 15.5 },
          { name: "Under", description: "Ja Morant", price: -130, point: 15.5 },
        ] },
      ] },
      { key: "pinnacle", title: "Pinnacle", markets: [
        { key: "spreads", outcomes: [{ name: "Los Angeles Lakers", price: -104, point: -6.5 }, { name: "Portland Trail Blazers", price: -108, point: 6.5 }] },
        { key: "player_points", outcomes: [
          { name: "Over", description: "Ja Morant", price: -118, point: 15.5 },
          { name: "Under", description: "Ja Morant", price: -102, point: 15.5 },
        ] },
      ] },
    ],
  },
  {
    id: "e3", sport_key: "basketball_nba", commence_time: "2026-11-01T00:40:00Z",
    home_team: "Miami Heat", away_team: "Boston Celtics",
    bookmakers: [ // no Pinnacle here: nothing from this game can be priced
      { key: "draftkings", title: "DraftKings", markets: [
        { key: "h2h", outcomes: [{ name: "Boston Celtics", price: -200 }, { name: "Miami Heat", price: 170 }] },
      ] },
    ],
  },
];

const nbaParlayBoost = (over: Record<string, unknown> = {}) => normalizePromo({
  book: "DraftKings", title: "DK 50% NBA Profit Boost", type: "profit_boost", boost_pct: 50, max_stake: 25,
  min_total_odds: 200, min_legs: null, max_legs: null, legs_apply_to: [], bet_kinds: ["parlay"], leagues: ["NBA"],
  live: true, pregame: true, paid_in: null, expires_at: null, notes: null, ...over,
});

test("prices only legs the sharp book has on the same line", () => {
  const legs = priceLegs(EVENTS, "draftkings", { now: BEFORE });
  const labels = legs.map((l) => l.selection).sort();
  assert.deepEqual(labels, [
    "Ja Morant Over 15.5 Points",
    "Ja Morant Under 15.5 Points",
    "John Collins Over 6.5 Rebounds",
    "John Collins Under 6.5 Rebounds",
    "Los Angeles Lakers -6.5",
    "Over 220.5",
    "Portland Trail Blazers +6.5",
    "Under 220.5",
  ]); // no alt 8.5 line, nothing from the Pinnacle-less game
  const collins = legs.find((l) => l.selection === "John Collins Over 6.5 Rebounds")!;
  assert.equal(collins.game, "Detroit Pistons @ New York Knicks");
  assert.equal(collins.quotes.length, 1);
  assert.equal(collins.quotes[0].source, "Pinnacle");
  assert.deepEqual(collins.quotes[0].sides, [{ label: "Over 6.5", odds: -150 }, { label: "Under 6.5", odds: 122 }]);
  assert.equal(collins.quotes[0].betIndex, 0);
  assert.ok(Math.abs(collins.edge - (collins.fair * americanToDecimal(-110) - 1)) < 1e-12);
  // Sorted best edge first.
  for (let i = 1; i < legs.length; i++) assert.ok(legs[i - 1].edge >= legs[i].edge);
});

test("spreads pair each side with the opposite point", () => {
  const blazers = priceLegs(EVENTS, "draftkings", { now: BEFORE }).find((l) => l.selection === "Portland Trail Blazers +6.5")!;
  const [q] = blazers.quotes;
  assert.equal(q.betIndex, 1);
  assert.deepEqual(q.sides.map((s) => s.odds), [-104, -108]);
  assert.deepEqual(q.sides.map((s) => s.label), ["Los Angeles Lakers -6.5", "Portland Trail Blazers +6.5"]);
});

test("picks qualifying parlays from different games, best boosted EV first", () => {
  const picks = bestBets(priceLegs(EVENTS, "draftkings", { now: BEFORE }), nbaParlayBoost(), { league: "NBA" });
  assert.ok(picks.length > 0);
  for (const p of picks) {
    assert.equal(p.kind, "parlay");
    assert.equal(new Set(p.legs.map((l) => l.eventId)).size, p.legs.length, "one leg per game");
    assert.ok(americanToDecimal(p.americanOdds) >= americanToDecimal(200));
    assert.ok(p.eval.ev > 0);
  }
  for (let i = 1; i < picks.length; i++) assert.ok(picks[i - 1].eval.ev >= picks[i].eval.ev);
  // Collins over + Morant over (the brief's DK example legs) is the best pair.
  assert.deepEqual(picks[0].legs.map((l) => l.selection).sort(), ["Ja Morant Over 15.5 Points", "John Collins Over 6.5 Rebounds"]);
});

test("respects the promo's rules", () => {
  const legs = priceLegs(EVENTS, "draftkings", { now: BEFORE });
  assert.deepEqual(bestBets(legs, nbaParlayBoost({ leagues: ["NFL"] }), { league: "NBA" }), [], "wrong league");
  assert.deepEqual(bestBets(legs, nbaParlayBoost({ min_total_odds: 2000 }), { league: "NBA" }), [], "nothing long enough");
  assert.deepEqual(bestBets(legs, nbaParlayBoost({ bet_kinds: ["sgp"] }), { league: "NBA" }), [], "SGPs aren't auto-picked");
  const rebounds = bestBets(legs, nbaParlayBoost({ markets: ["player_rebounds"], min_total_odds: null, bet_kinds: [] }), { league: "NBA" });
  assert.ok(rebounds.length && rebounds.every((p) => p.legs.every((l) => l.market.startsWith("player_rebounds"))), "a market-limited promo picks only that market");
  const singles = bestBets(legs, nbaParlayBoost({ bet_kinds: ["single"], min_total_odds: null }), { league: "NBA" });
  assert.ok(singles.every((p) => p.kind === "single" && p.legs.length === 1));
});

test("a pick prints as the brief's bet card", () => {
  const [best] = bestBets(priceLegs(EVENTS, "draftkings", { now: BEFORE }), nbaParlayBoost(), { league: "NBA" });
  const { text } = formatBet({
    title: "DK 50% NBA Profit Boost", book: "DraftKings", bookOdds: best.americanOdds, boost: 0.5,
    legs: cardLegs(best),
  });
  assert.match(text, /^DEVIG \(sharp source: Pinnacle\)$/m);
  assert.match(text, /^BET TO BUILD: 2-leg parlay on DraftKings$/m);
  assert.match(text, /^\d\. John Collins Over 6\.5 Rebounds -110 \| Detroit Pistons @ New York Knicks, Sat 8:10 PM ET$/m);
  assert.match(text, /^Leg \d: Pinnacle -150\/\+122 \(\d\.\d%\) -> fair -1\d\d \(5\d\.\d%\)$/m);
  assert.match(text, /^Method: worst-case of multiplicative, additive, power, Shin$/m);
  assert.match(text, /^EV: \+\d+\.\d%$/m);
});

test("formats start times in Eastern", () => {
  assert.equal(formatStart("2026-11-01T00:10:00Z"), "Sat 8:10 PM ET");
});

test("odds client sends the right query and reads the credit headers", async () => {
  const real = globalThis.fetch;
  let url = "";
  globalThis.fetch = (async (u: string) => {
    url = u;
    return new Response(JSON.stringify(EVENTS), { headers: { "x-requests-remaining": "494", "x-requests-used": "6" } });
  }) as typeof fetch;
  try {
    const r = await getOdds("KEY", "basketball_nba", { markets: ["h2h", "totals"], bookmakers: ["draftkings", "pinnacle"] });
    const q = new URL(url).searchParams;
    assert.equal(new URL(url).pathname, "/v4/sports/basketball_nba/odds");
    assert.equal(q.get("markets"), "h2h,totals");
    assert.equal(q.get("bookmakers"), "draftkings,pinnacle");
    assert.equal(q.get("oddsFormat"), "american");
    assert.equal(r.remaining, 494);
    assert.equal(r.used, 6);
    assert.equal(r.data.length, 3);
  } finally {
    globalThis.fetch = real;
  }
});

// A real /odds pull (NBA, 2026-10-29 01:29 UTC), trimmed to four games:
// MEM @ POR and OKC @ DAL hadn't started and Pinnacle priced both; SAC @ NOP
// had no Pinnacle line yet; MIA @ ATL was live with BetMGM's market frozen.
const REAL: OddsEvent[] = JSON.parse(readFileSync(new URL("./samples/nba-2026-10-29.json", import.meta.url), "utf8"));
const PULLED = new Date("2026-10-29T01:29:30Z");

test("real pull: started games are skipped, so frozen live prices aren't picked", () => {
  const legs = priceLegs(REAL, "betmgm", { now: PULLED });
  assert.deepEqual([...new Set(legs.map((l) => l.game))].sort(), [
    "Memphis Grizzlies @ Portland Trail Blazers",
    "Oklahoma City Thunder @ Dallas Mavericks",
  ]);
  // After tip-off, nothing from that game is priced.
  assert.equal(priceLegs(REAL, "betmgm", { now: new Date("2026-10-30T03:00:00Z") }).length, 0);
});

test("real pull: legs match only where BetMGM and Pinnacle share the line", () => {
  const labels = priceLegs(REAL, "betmgm", { now: PULLED }).map((l) => `${l.game} | ${l.selection}`).sort();
  assert.deepEqual(labels, [
    "Memphis Grizzlies @ Portland Trail Blazers | Memphis Grizzlies +7.5",
    "Memphis Grizzlies @ Portland Trail Blazers | Memphis Grizzlies ML",
    "Memphis Grizzlies @ Portland Trail Blazers | Over 234.5",
    "Memphis Grizzlies @ Portland Trail Blazers | Portland Trail Blazers -7.5",
    "Memphis Grizzlies @ Portland Trail Blazers | Portland Trail Blazers ML",
    "Memphis Grizzlies @ Portland Trail Blazers | Under 234.5",
    "Oklahoma City Thunder @ Dallas Mavericks | Dallas Mavericks ML",
    "Oklahoma City Thunder @ Dallas Mavericks | Oklahoma City Thunder ML",
    "Oklahoma City Thunder @ Dallas Mavericks | Over 228.5",
    "Oklahoma City Thunder @ Dallas Mavericks | Under 228.5",
  ]); // DAL/OKC spreads differ (BetMGM 5.5, Pinnacle 5.0), so they're skipped
});

test("explains an empty pick list", () => {
  const legs = priceLegs(REAL, "betmgm", { now: PULLED }); // two games with sharp lines
  const mgm10 = normalizePromo({
    book: "BetMGM", title: "NBA 10% Parlay Boost Token", type: "profit_boost", boost_pct: 10, max_stake: 25,
    min_total_odds: 400, min_legs: 3, max_legs: null, legs_apply_to: [], bet_kinds: ["parlay", "sgp"], leagues: ["NBA"],
    live: true, pregame: true, paid_in: "cash", expires_at: null, notes: null,
  });
  assert.deepEqual(bestBets(legs, mgm10, { league: "NBA" }), []);
  assert.match(noPicksReason(legs, mgm10), /needs 3\+ legs, but only 2 games have sharp lines/);
  assert.match(noPicksReason([], mgm10), /No games on this book have sharp/);
  assert.match(noPicksReason(legs, { ...mgm10, bet_kinds: ["sgp"] }), /same-game parlays only/);
  assert.match(noPicksReason(legs, { ...mgm10, min_legs: 2, boost_pct: 0 }), /No bet that qualifies/);
});

// The DK "NBA 50% SGP(X) Boost" covered "all NBA games on 10/29/2026"; the bot
// picked Pistons @ Nets, which tipped off 10/30, and found no sharp props.
test("a promo only covers games that start by its expiry", () => {
  const promo = normalizePromo({ book: "DraftKings", title: "NBA 50% SGP(X) Boost", type: "profit_boost", boost_pct: 50,
    bet_kinds: ["sgp"], leagues: ["NBA"], expires_at: "2026-10-29" });
  const now = new Date("2026-10-29T23:25:00Z"); // 7:25 PM ET
  assert.equal(promoCovers(promo, "2026-10-30T00:10:00Z", now), true, "8:10 PM ET tonight");
  assert.equal(promoCovers(promo, "2026-10-30T02:10:00Z", now), true, "10:10 PM ET tonight is still 10/29 in Eastern");
  assert.equal(promoCovers(promo, "2026-10-30T23:40:00Z", now), false, "tomorrow's game");
  assert.equal(promoCovers(promo, "2026-10-29T23:00:00Z", now), false, "already started");
  const timed = { ...promo, expires_at: "2026-10-29T21:00" };
  assert.equal(promoCovers(timed, "2026-10-30T00:10:00Z", now), true, "8:10 PM ET is before a 9 PM expiry");
  assert.equal(promoCovers(timed, "2026-10-30T02:10:00Z", now), false, "10:10 PM ET is after it");
  assert.equal(promoCovers({ ...promo, expires_at: null }, "2026-12-25T17:10:00Z", now), true);
});

test("SGP games are tried best main lines first", () => {
  const legs = priceLegs(EVENTS, "draftkings", { now: BEFORE });
  const order = rankSgpGames(legs);
  assert.deepEqual([...order].sort(), ["e1", "e2"], "only games with two priced legs");
  const score = (id: string) => suggestSgpLegs(legs, 2, id)!.legs.reduce((a, l) => a + l.edge, 0);
  assert.ok(score(order[0]) >= score(order[1]));
});
