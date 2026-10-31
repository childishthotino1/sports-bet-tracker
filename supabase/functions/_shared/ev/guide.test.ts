import { test } from "node:test";
import assert from "node:assert/strict";
import {
  betterPrices, blowoutNote, formatBetterPrices, formatShop, formatWongSlate, guideNotes, mainSpread, normalizeSlip, shopLegs, wongLegs,
  type OddsEvent,
} from "./mod.ts";

const START = "2030-11-02T18:00:00Z";
const spreads = (fav: string, dog: string, pts: number, price = -110) => ({
  key: "spreads", outcomes: [{ name: fav, point: -pts, price }, { name: dog, point: pts, price }],
});
const nfl = (home: string, away: string, fav: string, pts: number): OddsEvent => ({
  id: `${away}@${home}`, sport_key: "americanfootball_nfl", commence_time: START, home_team: home, away_team: away,
  bookmakers: [{ key: "pinnacle", title: "Pinnacle", markets: [spreads(fav, fav === home ? away : home, pts, -105)] }],
});

test("Wong teaser legs: favorites -7.5 to -8.5 and underdogs +1.5 to +2.5, NFL only", () => {
  assert.deepEqual(wongLegs(nfl("Baltimore Ravens", "Cleveland Browns", "Baltimore Ravens", 7.5)).map((w) => [w.team, w.line, w.teased]),
    [["Baltimore Ravens", -7.5, -1.5]]);
  assert.deepEqual(wongLegs(nfl("Green Bay Packers", "Carolina Panthers", "Green Bay Packers", 2.5)).map((w) => [w.team, w.line, w.teased]),
    [["Carolina Panthers", 2.5, 8.5]]);
  assert.deepEqual(wongLegs(nfl("Detroit Lions", "Chicago Bears", "Detroit Lions", 3)), []); // a 3 doesn't cross both key numbers
  assert.deepEqual(wongLegs({ ...nfl("A", "B", "A", 7.5), sport_key: "americanfootball_ncaaf" }), []);
  const slate = formatWongSlate([nfl("Baltimore Ravens", "Cleveland Browns", "Baltimore Ravens", 8), nfl("Detroit Lions", "Chicago Bears", "Detroit Lions", 3)]);
  assert.match(slate, /^1\. Baltimore Ravens -8 → -2 \| Cleveland Browns @ Baltimore Ravens, /m);
  assert.ok(!slate.includes("Lions"));
  assert.match(formatWongSlate([]), /No NFL lines fit a Wong teaser/);
});

test("the main spread prefers Pinnacle's", () => {
  const e = nfl("Baltimore Ravens", "Cleveland Browns", "Baltimore Ravens", 7.5);
  e.bookmakers.unshift({ key: "betmgm", title: "BetMGM", markets: [spreads("Baltimore Ravens", "Cleveland Browns", 6.5)] });
  assert.deepEqual(mainSpread(e), { favorite: "Baltimore Ravens", underdog: "Cleveland Browns", points: 7.5 });
});

test("blowout risk flags player Overs in a lopsided basketball game", () => {
  const game: OddsEvent = {
    id: "okc-was", sport_key: "basketball_nba", commence_time: START, home_team: "Oklahoma City Thunder", away_team: "Washington Wizards",
    bookmakers: [
      { key: "pinnacle", title: "Pinnacle", markets: [
        spreads("Oklahoma City Thunder", "Washington Wizards", 14.5),
        { key: "player_points", outcomes: [
          { name: "Over", description: "Shai Gilgeous-Alexander", point: 30.5, price: -105 },
          { name: "Under", description: "Shai Gilgeous-Alexander", point: 30.5, price: -115 },
        ] },
      ] },
      { key: "betmgm", title: "BetMGM", markets: [{ key: "player_points", outcomes: [
        { name: "Over", description: "Shai Gilgeous-Alexander", point: 30.5, price: -110 },
        { name: "Under", description: "Shai Gilgeous-Alexander", point: 30.5, price: -110 },
      ] }] },
    ],
  };
  assert.match(blowoutNote(game)!, /Blowout risk: Oklahoma City Thunder -14\.5/);
  assert.equal(guideNotes(game, [{ market: "player_points", side: "Under" }]).length, 0, "Unders aren't hurt by benched starters");
  const text = formatShop(game, shopLegs(game, { betmgm: "BetMGM" }, { now: new Date("2030-11-01T00:00:00Z") }));
  assert.match(text, /⚠️ Blowout risk/);
  assert.equal(blowoutNote({ ...game, bookmakers: [{ key: "pinnacle", title: "Pinnacle", markets: [spreads("Oklahoma City Thunder", "Washington Wizards", 6.5)] }] }), null);
});

test("line shopping: a better price on the same leg at another of your books", () => {
  const slip = normalizeSlip({ book: "MGM", league: "NFL", bet_kind: "single", total_odds: -115, boosted_odds: 0, boost_pct: 0, game: "",
    legs: [{ team_or_player: "Baltimore Ravens", market: "spreads", line: -7.5, side: "Baltimore Ravens", team: "Baltimore Ravens", game: "" }] })!;
  const e = nfl("Baltimore Ravens", "Cleveland Browns", "Baltimore Ravens", 7.5);
  e.bookmakers.push(
    { key: "betmgm", title: "BetMGM", markets: [spreads("Baltimore Ravens", "Cleveland Browns", 7.5, -115)] },
    { key: "draftkings", title: "DraftKings", markets: [spreads("Baltimore Ravens", "Cleveland Browns", 7.5, -108)] },
    { key: "fanduel", title: "FanDuel", markets: [spreads("Baltimore Ravens", "Cleveland Browns", 7.5, -112)] },
  );
  const better = betterPrices(slip, [e], "betmgm", { betmgm: "BetMGM", draftkings: "DraftKings", fanduel: "FanDuel" });
  assert.deepEqual(better, [{ book: "DraftKings", odds: -108, mine: -115 }]);
  assert.equal(formatBetterPrices(slip, "BetMGM", better), "💲 Better price elsewhere:\nBaltimore Ravens -7.5: DraftKings -108 vs BetMGM -115");
  assert.equal(formatBetterPrices(slip, "BetMGM", [null]), null);
});

test("1st-half and 1st-quarter lines are labelled with their period", () => {
  const e: OddsEvent = {
    id: "bal-buf", sport_key: "americanfootball_nfl", commence_time: START, home_team: "Buffalo Bills", away_team: "Baltimore Ravens",
    bookmakers: ["betmgm", "pinnacle"].map((key) => ({ key, title: key, markets: [
      { key: "spreads_h1", outcomes: [{ name: "Buffalo Bills", point: -1.5, price: key === "pinnacle" ? -105 : -110 }, { name: "Baltimore Ravens", point: 1.5, price: key === "pinnacle" ? -105 : -110 }] },
      { key: "totals_h1", outcomes: [{ name: "Over", point: 24.5, price: -110 }, { name: "Under", point: 24.5, price: key === "pinnacle" ? -102 : -110 }] },
      { key: "h2h_q1", outcomes: [{ name: "Buffalo Bills", price: 140 }, { name: "Baltimore Ravens", price: 170 }, { name: "Draw", price: 340 }] },
    ] })),
  };
  const labels = shopLegs(e, { betmgm: "BetMGM" }, { now: new Date("2030-11-01T00:00:00Z") }).map((l) => l.selection).sort();
  assert.ok(labels.includes("1st Half Baltimore Ravens +1.5"), labels.join(" | "));
  assert.ok(labels.includes("1st Half Over 24.5"));
  assert.ok(labels.includes("Buffalo Bills 1st Quarter ML"));
});
