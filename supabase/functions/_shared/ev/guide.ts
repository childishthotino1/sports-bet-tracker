// Rules from The Betting Insider's betting guide
// (thebettinginsider.com/betting-guide; summary and what we skip in
// betting-guide.md) that the bot applies while it researches a game, builds a
// bet, or answers a question. Pure functions over odds-feed events.
//
// Already applied elsewhere: unit sizing caps each stake at 3% of bankroll
// (bet.ts MAX_BET_SHARE); break-even win rates are on every verdict; line
// shopping is answerQuestion / shopLegs and betterPrices in slip.ts.

import type { OddsEvent, Outcome } from "./odds-api.ts";

// The guide: never risk more than 7% of bankroll in one day.
export const MAX_DAY_SHARE = 0.07;

// The game's main spread, Pinnacle's if it posts one (the sharpest), else the
// first book that does. Favorite first: [{team, point}, {team, point}].
export function mainSpread(event: OddsEvent): { favorite: string; underdog: string; points: number } | null {
  const books = [...event.bookmakers].sort((a, b) => (b.key === "pinnacle" ? 1 : 0) - (a.key === "pinnacle" ? 1 : 0));
  for (const b of books) {
    const outcomes = b.markets.find((m) => m.key === "spreads")?.outcomes ?? [];
    const fav = outcomes.find((o: Outcome) => (o.point ?? 0) < 0);
    const dog = outcomes.find((o: Outcome) => o !== fav && o.point === -(fav?.point ?? NaN));
    if (fav && dog) return { favorite: fav.name, underdog: dog.name, points: -(fav.point as number) };
  }
  return null;
}

// Wong teasers (Stanford Wong, "Sharp Sports Betting"): most NFL games are
// decided by 3 to 7, so a 6-point tease that moves a line through both key
// numbers is the one parlay worth making. Favorites of -7.5 to -8.5 tease down
// to -1.5 to -2.5; underdogs of +1.5 to +2.5 tease up to +7.5 to +8.5. Two such
// legs in a 6-point teaser usually price at -110 to -120. NFL only.
export const WONG_TEASE = 6;
export type WongLeg = { team: string; line: number; teased: number; game: string; start: string };

export function wongLegs(event: OddsEvent): WongLeg[] {
  if (event.sport_key !== "americanfootball_nfl") return [];
  const s = mainSpread(event);
  if (!s) return [];
  const game = `${event.away_team} @ ${event.home_team}`;
  const out: WongLeg[] = [];
  if (s.points >= 7.5 && s.points <= 8.5) out.push({ team: s.favorite, line: -s.points, teased: -s.points + WONG_TEASE, game, start: event.commence_time });
  if (s.points >= 1.5 && s.points <= 2.5) out.push({ team: s.underdog, line: s.points, teased: s.points + WONG_TEASE, game, start: event.commence_time });
  return out;
}

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

export function formatWongLeg(w: WongLeg): string {
  return `${w.team} ${signed(w.line)} → ${signed(w.teased)}`;
}

export const WONG_NOTE = "Wong teaser: a 6-point tease that crosses both 3 and 7. Pair two of these in a 6-point teaser; it usually prices around -110 to -120.";

// The guide's prop checklist: "Is this game expected to be a blowout? Will star
// players play less minutes?" A big spread means starters may sit the fourth
// quarter, which hurts their Overs. Basketball only, where benching is routine.
export const BLOWOUT_SPREAD: Record<string, number> = {
  basketball_nba: 10,
  basketball_wnba: 10,
  basketball_ncaab: 15,
};

// A caution for player-prop Overs in this game, or null.
export function blowoutNote(event: OddsEvent): string | null {
  const limit = BLOWOUT_SPREAD[event.sport_key];
  const s = mainSpread(event);
  if (!limit || !s || s.points < limit) return null;
  return `⚠️ Blowout risk: ${s.favorite} ${signed(-s.points)}. Starters may sit late, which hurts player Overs in this game.`;
}

// Is this a player-prop Over (the side a blowout hurts)?
export const isPropOver = (market: string, side: string) => /^(player|batter|pitcher)_/.test(market) && /^over$/i.test(side);
