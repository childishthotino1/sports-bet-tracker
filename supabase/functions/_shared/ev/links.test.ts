import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  betterPrices, BOOK_STATE, combinedLink, fillState, legLink, normalizeSlip, priceLegs, shopButtons, shopLegs, slipButtons, suggestSgpLegs,
  type OddsEvent,
} from "./mod.ts";

// Real links from the live pull (2026-11-07/08, CIN @ ATL).
const MGM = "https://sports.{state}.betmgm.com/en/sports?options=6:44009-3451275-5411235&type=Single";
const MGM_GAME = "https://sports.{state}.betmgm.com/en/sports/events/cincinnati-bengals-@-atlanta-falcons-6%3A44009";
const DK = "https://sportsbook.draftkings.com/?outcomes=0ML84695561_1";
const DK_GAME = "https://sportsbook.draftkings.com/event/34118128";
const FD = "https://sportsbook.fanduel.com/addToBetslip?marketId=42.578189645&selectionId=50199";
const SCORE = "https://sportsbook.thescore.bet/?market_selection_id[0]=3575ef93-588d-407f-9ae2-c7d6dcd021c3&odds_numerator[0]=2&odds_denominator[0]=1";

// A real per-game pull with links: main lines for all nine books, plus anytime
// TD for two players (BetMGM, DraftKings, FanDuel; theScore had no TD market up).
const GAME: OddsEvent = JSON.parse(readFileSync(new URL("./samples/nfl-2026-11-08-cin-atl-links.json", import.meta.url), "utf8"));
const BEFORE = new Date("2026-11-08T12:00:00Z");

test("BetMGM's {state} is Maryland", () => {
  assert.equal(BOOK_STATE, "md");
  assert.equal(fillState(MGM), "https://sports.md.betmgm.com/en/sports?options=6:44009-3451275-5411235&type=Single");
  assert.equal(fillState(MGM, "nj"), "https://sports.nj.betmgm.com/en/sports?options=6:44009-3451275-5411235&type=Single");
  assert.equal(fillState("https://sports.%7Bstate%7D.betmgm.com/x"), "https://sports.md.betmgm.com/x");
  assert.equal(fillState(DK), DK, "other books are left alone");
});

test("a leg's link: its own, else the game's, else none", () => {
  assert.equal(legLink({ link: MGM, eventLink: MGM_GAME }), fillState(MGM));
  assert.equal(legLink({ link: null, eventLink: MGM_GAME }), fillState(MGM_GAME));
  assert.equal(legLink({}), null);
  assert.equal(legLink({ link: "javascript:alert(1)", eventLink: "" }), null, "only http(s) links make buttons");
});

test("one leg: one Build button, or the game, or nothing", () => {
  assert.deepEqual(slipButtons("BetMGM", [{ selection: "Atlanta Falcons ML", link: MGM, eventLink: MGM_GAME }]),
    [[{ text: "🛒 Build in BetMGM", url: fillState(MGM) }]]);
  assert.deepEqual(slipButtons("DraftKings", [{ selection: "Atlanta Falcons ML", eventLink: DK_GAME }]),
    [[{ text: "📍 Open the game in DraftKings", url: DK_GAME }]]);
  assert.deepEqual(slipButtons("FanDuel", [{ selection: "Atlanta Falcons ML" }]), [], "no links: the card goes out as before");
});

test("several legs: a button per leg, then the games of legs without one", () => {
  const rows = slipButtons("theScore Bet", [
    { selection: "Atlanta Falcons -2.5", link: SCORE },
    { selection: "Atlanta Falcons ML", link: SCORE.replace("3575", "9999") },
    { selection: "A very long player name Over 249.5 Passing Yards", link: FD },
    { selection: "Bears ML", eventLink: "https://sportsbook.thescore.bet/game/1" },
    { selection: "Bears Over 20.5", eventLink: "https://sportsbook.thescore.bet/game/1" },
    { selection: "Lions ML", eventLink: "https://sportsbook.thescore.bet/game/2" },
  ]);
  assert.deepEqual(rows.map((r) => r.length), [1, 1, 1, 1, 1], "one button per row");
  assert.equal(rows[0][0].text, "🛒 1. Atlanta Falcons -2.5");
  assert.equal(rows[0][0].url, SCORE);
  assert.ok(rows[2][0].text.length <= 40 && rows[2][0].text.endsWith("…"), rows[2][0].text);
  assert.deepEqual(rows.slice(3).map((r) => [r[0].text, r[0].url]), [
    ["📍 Open game 1", "https://sportsbook.thescore.bet/game/1"],
    ["📍 Open game 2", "https://sportsbook.thescore.bet/game/2"],
  ]);
  assert.deepEqual(slipButtons("BetMGM", [{ selection: "a" }, { selection: "b" }]), []);
  const many = Array.from({ length: 8 }, (_, i) => ({ selection: `Leg ${i}`, link: `${FD}${i}` }));
  many[0] = { selection: "Leg 0", link: DK }; // two books: no combined link
  assert.equal(slipButtons("FanDuel", many).length, 5, "at most five leg buttons");
});

test("real pull: every book leg carries its own book's link, never a sharp's", () => {
  for (const [key, host] of [["betmgm", "betmgm.com"], ["draftkings", "draftkings.com"], ["fanduel", "fanduel.com"], ["espnbet", "thescore.bet"]]) {
    const legs = priceLegs([GAME], key, { now: BEFORE });
    assert.ok(legs.length >= 4, `${key}: ${legs.length} legs`);
    for (const l of legs) {
      assert.ok(l.link?.includes(host), `${key} ${l.selection}: ${l.link}`);
      assert.ok(l.eventLink?.includes(host), `${key} ${l.selection} game: ${l.eventLink}`);
    }
  }
  // Every BetMGM leg gets a Maryland link, props included.
  const mgm = priceLegs([GAME], "betmgm", { now: BEFORE });
  assert.ok(mgm.some((l) => l.market === "player_anytime_td"), "anytime TD priced");
  for (const l of mgm) {
    const url = legLink(l)!;
    assert.match(url, /^https:\/\/sports\.md\.betmgm\.com\//);
    assert.doesNotMatch(url, /\{state\}/);
  }
});

test("game answers: each button goes to the book with the best price", () => {
  const shop = shopLegs(GAME, { betmgm: "BetMGM", draftkings: "DraftKings", fanduel: "FanDuel", espnbet: "theScore Bet" }, { now: BEFORE });
  const host: Record<string, string> = { BetMGM: "betmgm.com", DraftKings: "draftkings.com", FanDuel: "fanduel.com", "theScore Bet": "thescore.bet" };
  for (const l of shop) assert.ok(l.link?.includes(host[l.book]), `${l.selection} @ ${l.book}: ${l.link}`);
  const rows = shopButtons(shop);
  assert.equal(rows.length, 4, "at most four");
  assert.match(rows[0][0].text, new RegExp(`^🛒 .* @ ${shop[0].book}`));
  assert.equal(rows[0][0].url, legLink(shop[0]));
});

test("SGP suggestions carry a button per leg", () => {
  const legs = priceLegs([GAME], "fanduel", { now: BEFORE });
  const sg = suggestSgpLegs(legs, 3, GAME.id, "FanDuel")!;
  const rows = slipButtons("FanDuel", sg.legs);
  assert.deepEqual(rows.map((r) => r[0].text), ["🛒 Build all 3 legs in FanDuel"]);
  sg.legs.forEach((l) => {
    const q = new URL(l.link!).searchParams;
    assert.ok(rows[0][0].url.includes(`=${q.get("marketId")}&`) && rows[0][0].url.includes(`=${q.get("selectionId")}`), l.selection);
  });
});

test("a better price elsewhere keeps that book's link", () => {
  const slip = normalizeSlip({ book: "BetMGM", league: "NFL", bet_kind: "single", total_odds: 0, boosted_odds: 0, boost_pct: 0, game: "",
    legs: [{ team_or_player: "Atlanta Falcons", market: "h2h", line: null, side: "Atlanta Falcons", team: "", game: "", odds: 100 }] })!;
  const [b] = betterPrices(slip, [GAME], "betmgm", { draftkings: "DraftKings", fanduel: "FanDuel", espnbet: "theScore Bet" });
  assert.ok(b, "the slip's +100 is beaten somewhere");
  const host: Record<string, string> = { DraftKings: "draftkings.com", FanDuel: "fanduel.com", "theScore Bet": "thescore.bet" };
  assert.ok(b!.link?.includes(host[b!.book]), `${b!.book}: ${b!.link}`);
});

// The links tapped on a phone (2026-11-07): Falcons ML + Broncos ML, two games,
// and Falcons ML + Over 52.5, one game. Each loaded both legs.
test("phase 2: one link for every leg, in the format each book took", () => {
  const mgm = (o: string) => `https://sports.{state}.betmgm.com/en/sports?options=${o}&type=Single`;
  assert.equal(combinedLink([mgm("6:44009-3451275-5411235"), mgm("6:44012-3451278-5411240")]),
    "https://sports.md.betmgm.com/en/sports?options=6:44009-3451275-5411235,6:44012-3451278-5411240&type=Combo");
  assert.equal(combinedLink([mgm("6:44009-3451275-5411235"), mgm("6:44009-4354778-7073291")]),
    "https://sports.md.betmgm.com/en/sports?options=6:44009-3451275-5411235,6:44009-4354778-7073291&type=Combo");
  assert.equal(combinedLink(["https://sportsbook.draftkings.com/?outcomes=0ML84695561_1", "https://sportsbook.draftkings.com/?outcomes=0ML84695479_3"]),
    "https://sportsbook.draftkings.com/?outcomes=0ML84695561_1+0ML84695479_3");
  assert.equal(combinedLink([FD, "https://sportsbook.fanduel.com/addToBetslip?marketId=42.619967591&selectionId=50211"]),
    "https://sportsbook.fanduel.com/addToBetslip?marketId[0]=42.578189645&selectionId[0]=50199&marketId[1]=42.619967591&selectionId[1]=50211");
  assert.equal(combinedLink([SCORE, "https://sportsbook.thescore.bet/?market_selection_id[0]=2b3c71bf-0eed-4805-aabf-bde4621e9b38&odds_numerator[0]=2&odds_denominator[0]=1"]),
    "https://sportsbook.thescore.bet/?market_selection_id[0]=3575ef93-588d-407f-9ae2-c7d6dcd021c3&odds_numerator[0]=2&odds_denominator[0]=1&market_selection_id[1]=2b3c71bf-0eed-4805-aabf-bde4621e9b38&odds_numerator[1]=2&odds_denominator[1]=1");
  // A DraftKings prop sid keeps its escaped #.
  const prop = "https://sportsbook.draftkings.com/?outcomes=0QA385025617%232346198679_13L88808Q1-1195523501Q20";
  assert.equal(combinedLink([DK, prop]), `https://sportsbook.draftkings.com/?outcomes=0ML84695561_1+0QA385025617%232346198679_13L88808Q1-1195523501Q20`);
  // No combined link: one leg, two books, a missing link, or the same leg twice.
  assert.equal(combinedLink([DK]), null);
  assert.equal(combinedLink([DK, FD]), null);
  assert.equal(combinedLink([DK, null]), null);
  assert.equal(combinedLink([DK, DK]), null);
  // The button: one tap for the whole parlay.
  assert.deepEqual(slipButtons("DraftKings", [{ selection: "Falcons ML", link: DK }, { selection: "Broncos ML", link: "https://sportsbook.draftkings.com/?outcomes=0ML84695479_3" }]),
    [[{ text: "🛒 Build all 2 legs in DraftKings", url: "https://sportsbook.draftkings.com/?outcomes=0ML84695561_1+0ML84695479_3" }]]);
});

test("Caesars: one link for a parlay, the IDs comma-joined (the format the phone took)", () => {
  const a = "https://sportsbook.caesars.com/us/md/bet/betslip?selectionIds=a19587ac-336d-3561-9cfb-82d51164a0d7";
  const b = "https://sportsbook.caesars.com/us/md/bet/betslip?selectionIds=38e1d24a-c6f0-359d-85a0-d465d6ee7c57";
  assert.equal(
    combinedLink([a, b]),
    "https://sportsbook.caesars.com/us/md/bet/betslip?selectionIds=a19587ac-336d-3561-9cfb-82d51164a0d7,38e1d24a-c6f0-359d-85a0-d465d6ee7c57",
  );
  const [[btn], ...rest] = slipButtons("Caesars", [{ selection: "Temple Owls +7", link: a }, { selection: "Utah State Aggies ML", link: b }]);
  assert.equal(btn.text, "🛒 Build all 2 legs in Caesars");
  assert.equal(rest.length, 0);
  // A {state} placeholder is filled first.
  assert.match(combinedLink([a.replace("/md/", "/{state}/"), b])!, /\/us\/md\/bet\/betslip\?selectionIds=a19587ac[^,]+,38e1d24a/);
});

test("real pull: a BetMGM SGP suggestion is one Maryland link", () => {
  const legs = priceLegs([GAME], "betmgm", { now: BEFORE });
  const sg = suggestSgpLegs(legs, 3, GAME.id, "BetMGM")!;
  const [[b]] = slipButtons("BetMGM", sg.legs);
  assert.match(b.url, /^https:\/\/sports\.md\.betmgm\.com\/en\/sports\?options=6:44009-[\d-]+,6:44009-[\d-]+,6:44009-[\d-]+&type=Combo$/);
});

test("a shared slip: the same bet at each book that posts it, best price first", async () => {
  const { slipOffers } = await import("./mod.ts");
  const books = { betmgm: "BetMGM", draftkings: "DraftKings", fanduel: "FanDuel", espnbet: "theScore Bet" };
  const read = (kind: string, legs: unknown[]) => normalizeSlip({ book: "", league: "NFL", bet_kind: kind, total_odds: 0, boosted_odds: 0, boost_pct: 0, game: "", legs })!;
  const ml = { team_or_player: "Atlanta Falcons", market: "h2h", line: null, side: "Atlanta Falcons", team: "Atlanta Falcons", game: "", odds: 0 };
  const td = { team_or_player: "Bijan Robinson", market: "player_anytime_td", line: null, side: "Yes", team: "Atlanta Falcons", game: "", odds: 0 };

  const single = slipOffers(read("single", [ml]), [GAME], books);
  assert.deepEqual(single.map((o) => [o.book, o.odds]), [["DraftKings", 150], ["BetMGM", 145], ["theScore Bet", 145], ["FanDuel", 140]]);
  assert.match(slipButtons(single[1].book, single[1].legs)[0][0].url, /^https:\/\/sports\.md\.betmgm\.com\//);

  // theScore has no TD market up, so it isn't offered for an SGP with the TD; an SGP shows no price.
  const sgp = slipOffers(read("sgp", [ml, td]), [GAME, GAME], books);
  assert.deepEqual(sgp.map((o) => o.book).sort(), ["BetMGM", "DraftKings", "FanDuel"]);
  assert.ok(sgp.every((o) => o.odds === null && o.legs.length === 2));
  assert.match(slipButtons("DraftKings", sgp.find((o) => o.book === "DraftKings")!.legs)[0][0].text, /Build all 2 legs/);

  assert.deepEqual(slipOffers(read("single", [ml]), [null], books), [], "no game, no offers");
  assert.equal(single[0].legs[0].start, GAME.commence_time, "each leg carries its game's start, so the link can stop once it's live");
});

test("tap tracking: each 🛒 URL points at the bot under a fresh id; other buttons untouched", async () => {
  const { trackButtons, newLinkId, LINK_ID } = await import("./mod.ts");
  let n = 0;
  const ids = ["AAAAAAAAA1", "AAAAAAAAA2"];
  const rows = [[{ text: "🛒 Build in DraftKings", url: DK }], [{ text: "📍 Open game", url: DK_GAME }]];
  const t = trackButtons(rows, "https://x.supabase.co/functions/v1/promo-bot", () => ids[n++]);
  assert.deepEqual(t.rows, [[{ text: "🛒 Build in DraftKings", url: "https://x.supabase.co/functions/v1/promo-bot?go=AAAAAAAAA1" }],
    [{ text: "📍 Open game", url: "https://x.supabase.co/functions/v1/promo-bot?go=AAAAAAAAA2" }]]);
  assert.deepEqual(t.links.map((l) => [l.id, l.url]), [["AAAAAAAAA1", DK], ["AAAAAAAAA2", DK_GAME]]);
  assert.deepEqual(trackButtons([], "u").links, []);
  const id = newLinkId();
  assert.match(id, LINK_ID);
  assert.notEqual(id, newLinkId());
  assert.equal(LINK_ID.test("../etc"), false);
});

test("a bet's 🛒 link expires when its first game starts", async () => {
  const { earliestStart } = await import("./mod.ts");
  assert.equal(earliestStart(["2026-11-09T18:00:00Z", null, "2026-11-08T03:14:00Z", "bad"]), "2026-11-08T03:14:00Z");
  assert.equal(earliestStart([undefined, null]), null);
});
