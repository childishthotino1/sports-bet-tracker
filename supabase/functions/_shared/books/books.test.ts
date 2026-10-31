import { test } from "node:test";
import assert from "node:assert/strict";
import { BOOK_ALIASES, BOOK_ID_RULES, boostFromPrices, canonicalBook, bookByName } from "./books.ts";

test("aliases cover everything the tracker bot accepted before", () => {
  const tracker: Record<string, string> = {
    ESPN: "theScore Bet", THESCORE: "theScore Bet", SCORE: "theScore Bet", THESCOREBET: "theScore Bet",
    FD: "FanDuel", FANDUEL: "FanDuel", DK: "DraftKings", DRAFTKINGS: "DraftKings", MGM: "BetMGM", BETMGM: "BetMGM",
    B365: "Bet365", BET365: "Bet365", FAN: "Fanatics", FANATICS: "Fanatics",
    CZR: "Caesars", CS: "Caesars", CAESARS: "Caesars", CEASARS: "Caesars",
  };
  for (const [alias, name] of Object.entries(tracker)) assert.equal(BOOK_ALIASES[alias], name, alias);
});

test("canonicalBook reads codes, names and loose spellings", () => {
  assert.equal(canonicalBook("mgm"), "BetMGM");
  assert.equal(canonicalBook("Bet MGM"), "BetMGM");
  assert.equal(canonicalBook("theScore BET"), "theScore Bet");
  assert.equal(canonicalBook("bet365"), "Bet365");
  assert.equal(canonicalBook("Draft Kings Sportsbook"), "DraftKings");
  assert.equal(canonicalBook(""), null);
  assert.equal(canonicalBook("Circa"), null);
  assert.equal(bookByName("ESPN Bet")?.oddsApi, "espnbet");
});

test("boost % from a base and boosted price", () => {
  assert.equal(boostFromPrices(-105, 109), 15); // BetMGM Odds Boost on Oregon State Over 31.5
  assert.equal(boostFromPrices(300, 450), 50);
  assert.equal(boostFromPrices(200, 250), 25);
  assert.equal(boostFromPrices(-110, -110), null);
  assert.equal(boostFromPrices(-110, -120), null);
});

test("the book rules know BetMGM's slip before it's placed, not just the receipt", () => {
  assert.match(BOOK_ID_RULES, /'Your bet has been accepted\. Good luck!'/);
  assert.match(BOOK_ID_RULES, /'Place Bet' button/);
  assert.match(BOOK_ID_RULES, /centered between 'Deposit' and 'Close' buttons → always MGM/);
});
