// Promo JSON for real screenshots, as the vision call should return it.

// Third real screenshot: "30% NFL Parlay Profit Boost". SGPs, Super Parlays,
// and 4-25 leg parlays qualify, so the 4-25 leg limit covers regular parlays
// only — a 2-leg SGP must still pass.
export const NFL_30_PARLAY_BOOST = {
  book: null,
  title: "30% NFL Parlay Profit Boost",
  type: "profit_boost",
  boost_pct: 30,
  max_stake: 25,
  min_total_odds: 300,
  min_legs: 4,
  max_legs: 25,
  legs_apply_to: ["parlay"],
  bet_kinds: ["sgp", "parlay"],
  leagues: ["NFL"],
  live: true,
  pregame: true,
  paid_in: null,
  expires_at: "2026-10-29T09:29",
  notes: "Super Parlays also qualify",
};
