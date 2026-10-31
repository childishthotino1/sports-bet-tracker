// Sportsbook knowledge shared by every bot: the bet tracker (telegram-bot) and
// the promo bot (promo-bot) name books the same way, identify them in a
// screenshot with the same visual rules, and read base vs boosted prices the
// same way. Fix a rule here and both bots learn it.
//
// Pure TypeScript (no Deno or Telegram APIs), so Node runs the tests and both
// edge functions bundle it.

export type Sportsbook = {
  name: string; // as stored in the tracker's sportsbooks table
  code: string; // the short code the vision prompts answer with
  aliases: string[]; // anything a person or a slip might call it, upper case, no spaces
  oddsApi: string | null; // The Odds API bookmaker key; null if the feed doesn't carry it
  freeFeed: boolean; // on The Odds API's free plan (Caesars and Fanatics need a paid one)
};

export const SPORTSBOOKS: Sportsbook[] = [
  { name: "BetMGM", code: "MGM", aliases: ["MGM", "BETMGM"], oddsApi: "betmgm", freeFeed: true },
  { name: "DraftKings", code: "DK", aliases: ["DK", "DRAFTKINGS"], oddsApi: "draftkings", freeFeed: true },
  { name: "FanDuel", code: "FD", aliases: ["FD", "FANDUEL"], oddsApi: "fanduel", freeFeed: true },
  { name: "Caesars", code: "CZR", aliases: ["CZR", "CS", "CAESARS", "CEASARS", "WILLIAMHILL"], oddsApi: "williamhill_us", freeFeed: false },
  { name: "Fanatics", code: "FAN", aliases: ["FAN", "FANATICS"], oddsApi: "fanatics", freeFeed: false },
  { name: "Bet365", code: "B365", aliases: ["B365", "BET365"], oddsApi: null, freeFeed: false },
  // Formerly ESPN Bet; the feed still calls it espnbet.
  { name: "theScore Bet", code: "SCORE", aliases: ["SCORE", "THESCORE", "THESCOREBET", "ESPN", "ESPNBET"], oddsApi: "espnbet", freeFeed: true },
];

// Alias -> book name, e.g. "DK" -> "DraftKings".
export const BOOK_ALIASES: Record<string, string> = Object.fromEntries(
  SPORTSBOOKS.flatMap((b) => [b.code, ...b.aliases].map((a) => [a, b.name])),
);

const squash = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

// The book a code, alias or name refers to ("mgm", "Bet MGM", "theScore BET"), or null.
export function canonicalBook(text: string | null | undefined): string | null {
  if (!text) return null;
  const key = squash(text);
  if (!key) return null;
  if (BOOK_ALIASES[key]) return BOOK_ALIASES[key];
  return SPORTSBOOKS.find((b) => squash(b.name).includes(key.slice(0, 4)) && key.length >= 4)?.name ?? null;
}

export function bookByName(name: string | null | undefined): Sportsbook | null {
  const canon = canonicalBook(name);
  return SPORTSBOOKS.find((b) => b.name === canon) ?? null;
}

// How to tell the books apart in a screenshot. Both vision prompts include it;
// the answer is a code (MGM, DK, ...). Learned from real slips: BetMGM shows no
// logo at all, so it's recognized by layout.
export const BOOK_ID_RULES = `Use these SPECIFIC visual rules to identify the book — check them in order:

    CZR = Caesars Sportsbook
      • WHITE or light grey background (the only book with a light background)
      • 'CAESARS SPORTSBOOK' logo in green inside the bet card
      • 'CAESARS REWARDS.' badge visible
      • Trophy icon in top-right of card
      • Labels: 'Cash Wagered', 'To Win', 'Pays'
      • Dark green 'Done' button, outlined 'Reuse Selections' button

    FAN = Fanatics Sportsbook
      • Dark background
      • 'Fanatics Sportsbook' wordmark with F-flag logo ALWAYS visible on the slip
      • 'FanCash' column in the header; purple 'FCash' badge next to a dollar amount
      • Green oval 'Cash out $X.XX' button
      • Labels: 'Wager' and 'Payout'
      • Header says 'Receipt / 1 bet placed'

    MGM = BetMGM
      • Dark background
      • NO sportsbook name or logo visible on the slip itself
      • White banner saying 'Your bet has been accepted. Good luck!'  with a green left border
      • 'Account Balance $X,XXX' shown at top center
      • Gold/tan 'Done' button (bottom right); 'View my bets' outline button (bottom left)
      • Labels: 'Stake', 'Total payout'
      • 'incl. Boosted Winnings $X in Cash' in green text when boosted
      • 'Keep placed bets in bet slip' checkbox; 'Share My Bet' link
      • Before the bet is placed: 'Deposit' and 'Close' buttons either side of 'Account Balance', a 'Straights (N)' or 'Parlay' section, a 'Stake' box, 'Clear All', and a 'Place Bet' button at the bottom
      • An odds boost shows as a green check with 'Odds Boost', and the original price struck through next to the boosted one

    DK = DraftKings
      • Dark background, green DraftKings crown logo
      • 'DraftKings' wordmark visible

    FD = FanDuel
      • Blue background, 'FanDuel' wordmark

    SCORE = theScore Bet
      • Dark navy background
      • 'theScore BET' logo top-left with yellow 'BET' pill
      • Blue circular '+' button next to account balance top-right
      • Green upward-arrow boost icon (not a dollar-sign like Fanatics)
      • 'SGP' badge on same-game parlays
      • Labels: 'BET' and 'POTENTIAL PAYOUT' at bottom

    B365 = Bet365
      • Green background, 'bet365' wordmark

    CRITICAL DISAMBIGUATION:
    - If background is WHITE/LIGHT → always CZR
    - If dark background AND 'Fanatics Sportsbook' text visible → always FAN
    - If dark background AND 'Your bet has been accepted. Good luck!' banner visible → always MGM
    - If dark background AND gold 'Done' button → always MGM
    - If dark background AND 'Account Balance' centered between 'Deposit' and 'Close' buttons → always MGM
    - If dark background AND green oval 'Cash out' button + FanCash → always FAN`;

// How to read prices and boosts on any slip. Both vision prompts include it.
export const ODDS_READING_RULES = `Reading prices and boosts:
- A boosted price is shown next to the original one, which is struck through (crossed out): "~~-105~~ +109". The struck-through number is the base (pre-boost) odds; the other is the boosted odds. Never report the boosted price as the base odds.
- Where books show the boost: BetMGM, a green check and "Odds Boost" by the leg, and "incl. Boosted Winnings $X in Cash" on a placed bet; DraftKings, a "Profit Boost" token with its %; FanDuel, "Profit Boost X%"; theScore, a green upward-arrow icon; Fanatics, a dollar-sign icon.
- The boost % is printed on the token or badge when there is one. If only the two prices are shown, the boost % is the boosted profit divided by the base profit, minus 1: -105 boosted to +109 pays $1.09 per $1 instead of $0.95, a 15% boost (books round the boosted price down).
- American odds: +150 wins $150 per $100 staked; -150 risks $150 to win $100.`;

// Markets that look alike on a slip. Both vision prompts include it.
export const MARKET_READING_RULES = `Reading markets:
- "Oregon State: Total points" (a team name, then "Total points", with Over/Under) is a team total: only that team's points count. "Total points" under a matchup with no team name is the game total.
- "1st Half" / "1H" and "1st Quarter" / "1Q" lines are period markets, separate from the full game.
- "Alt" or "Alternate" lines are the same market at a different number.`;

const profit = (american: number) => (american > 0 ? american / 100 : 100 / -american);

// Books boost in these steps; a boost read off two prices snaps up to the nearest one,
// since books round the boosted price down.
const BOOST_STEPS = [5, 10, 15, 20, 25, 30, 33, 35, 40, 50, 75, 100];

// The boost % implied by a base price and its boosted price, or null if they
// aren't a boost (equal, or the "boosted" price pays less).
export function boostFromPrices(base: number, boosted: number): number | null {
  if (!Number.isFinite(base) || !Number.isFinite(boosted) || Math.abs(base) < 100 || Math.abs(boosted) < 100) return null;
  const pct = (profit(boosted) / profit(base) - 1) * 100;
  if (pct < 1) return null;
  return BOOST_STEPS.find((s) => s >= pct - 0.5 && s <= pct + 3) ?? Math.round(pct);
}
