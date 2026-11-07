// Bet-slip links: The Odds API (includeLinks=true, no extra credits) returns,
// for each price, a link that opens the sportsbook with that bet in the slip,
// and for each book a link to the game. The bot turns them into Telegram URL
// buttons (🛒) on pick cards, SGP suggestions and game answers, so the user
// only checks the stake and taps Place Bet. The bot never places bets.
//
// Formats seen on a live pull (2026-11-07), all four free-plan books, props too:
//   BetMGM      https://sports.{state}.betmgm.com/en/sports?options=6:44009-3451275-5411235&type=Single
//   DraftKings  https://sportsbook.draftkings.com/?outcomes=0ML84695561_1
//   FanDuel     https://sportsbook.fanduel.com/addToBetslip?marketId=42.578189645&selectionId=50199
//   theScore    https://sportsbook.thescore.bet/?market_selection_id[0]=<uuid>&odds_numerator[0]=2&odds_denominator[0]=1
// BetMGM's carry a literal {state}: the users are in Maryland. theScore's carry
// a dummy 2/1 price, replaced by the live one when the slip loads.
//
// Links always come from the book's own outcome, never a sharp source's. A leg
// with no outcome link falls back to the game's link; no links at all, no
// buttons, and the message goes out as it always did. Phase 1: one link per
// leg; one link for a whole parlay is phase 2 (unverified formats).

export const BOOK_STATE = "md";

export type LinkButton = { text: string; url: string };

// What a leg needs to have a button: its book's outcome link and/or game link.
export type LinkedLeg = { selection: string; link?: string | null; eventLink?: string | null };

export function fillState(link: string, state = BOOK_STATE): string {
  return link.replaceAll("{state}", state).replaceAll("%7Bstate%7D", state);
}

// Telegram rejects a message whose button URL isn't http(s), so only those count.
const usable = (u: string | null | undefined): u is string => !!u && /^https?:\/\/\S+$/.test(u);

// The leg's own slip link, else its game's, with the state filled in.
export function legLink(leg: Pick<LinkedLeg, "link" | "eventLink">, state = BOOK_STATE): string | null {
  const url = usable(leg.link) ? leg.link : usable(leg.eventLink) ? leg.eventLink : null;
  return url ? fillState(url, state) : null;
}

const MAX_TEXT = 40; // Telegram cuts button text off around 40-60 characters
export const clip = (s: string, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export type ButtonOptions = { state?: string; max?: number };

// One row per button. One leg: "🛒 Build in BetMGM". Several: one button per
// leg that has its own link, then "📍 Open game" for each game whose legs
// don't. Nothing when there are no links.
export function slipButtons(book: string, legs: LinkedLeg[], opts: ButtonOptions = {}): LinkButton[][] {
  const { state = BOOK_STATE, max = 5 } = opts;
  if (legs.length === 1) {
    const [leg] = legs;
    if (usable(leg.link)) return [[{ text: `🛒 Build in ${book}`, url: fillState(leg.link, state) }]];
    if (usable(leg.eventLink)) return [[{ text: `📍 Open the game in ${book}`, url: fillState(leg.eventLink, state) }]];
    return [];
  }
  const rows: LinkButton[][] = [];
  legs.forEach((leg, i) => {
    if (usable(leg.link) && rows.length < max) rows.push([{ text: clip(`🛒 ${i + 1}. ${leg.selection}`), url: fillState(leg.link, state) }]);
  });
  const games = [...new Set(legs.filter((l) => !usable(l.link) && usable(l.eventLink)).map((l) => fillState(l.eventLink!, state)))];
  for (const url of games) rows.push([{ text: games.length > 1 ? `📍 Open game ${games.indexOf(url) + 1}` : "📍 Open game", url }]);
  return rows;
}

// Game answers: each leg at its own (best-priced) book, "🛒 <selection> @ <book>".
export function shopButtons(legs: (LinkedLeg & { book: string })[], opts: ButtonOptions = {}): LinkButton[][] {
  const { state = BOOK_STATE, max = 4 } = opts;
  return legs.flatMap((l) => {
    const url = legLink(l, state);
    return url ? [[{ text: clip(`🛒 ${l.selection} @ ${l.book}`, 56), url }]] : [];
  }).slice(0, max);
}
