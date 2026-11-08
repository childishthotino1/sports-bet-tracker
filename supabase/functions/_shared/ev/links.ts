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
//   Caesars     https://sportsbook.caesars.com/us/md/bet/betslip?selectionIds=<uuid>   (paid plan; seen 2026-11-07)
// BetMGM's carry a literal {state}: the users are in Maryland. theScore's carry
// a dummy 2/1 price, replaced by the live one when the slip loads.
//
// Links always come from the book's own outcome, never a sharp source's. A leg
// with no outcome link falls back to the game's link; no links at all, no
// buttons, and the message goes out as it always did. Phase 1: one link per
// leg; one link for a whole parlay (phase 2) where the book has a combined
// format that worked on a phone (MULTI_LEG).

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

// One link with every leg in it, per book, built from the legs' own links.
// Each format loaded both legs of a two-game parlay and of a same-game parlay
// on a phone in Maryland (2026-11-07). Keyed by the links' host.
const param = (url: string, name: string): string | null => {
  const m = url.match(new RegExp(`[?&]${name.replace(/[[\]]/g, "\\$&")}=([^&#]*)`));
  return m ? m[1] : null;
};
export const MULTI_LEG: { host: RegExp; join: (links: string[]) => string | null }[] = [
  { // BetMGM: options=A,B,C&type=Combo
    host: /^https:\/\/sports\.[^/]+\.betmgm\.com\//,
    join: (links) => {
      const opts = links.map((l) => param(l, "options"));
      if (opts.some((o) => !o)) return null;
      return `${links[0].split("?")[0]}?options=${opts.join(",")}&type=Combo`;
    },
  },
  { // DraftKings: outcomes=A+B+C
    host: /^https:\/\/sportsbook\.draftkings\.com\//,
    join: (links) => {
      const ids = links.map((l) => param(l, "outcomes"));
      return ids.some((o) => !o) ? null : `https://sportsbook.draftkings.com/?outcomes=${ids.join("+")}`;
    },
  },
  { // FanDuel: marketId[i]=…&selectionId[i]=…
    host: /^https:\/\/sportsbook\.fanduel\.com\/addToBetslip\?/,
    join: (links) => {
      const pairs = links.map((l) => [param(l, "marketId"), param(l, "selectionId")]);
      if (pairs.some(([m, s]) => !m || !s)) return null;
      return `https://sportsbook.fanduel.com/addToBetslip?${pairs.map(([m, s], i) => `marketId[${i}]=${m}&selectionId[${i}]=${s}`).join("&")}`;
    },
  },
  { // theScore: market_selection_id[i]=…&odds_numerator[i]=…&odds_denominator[i]=…
    host: /^https:\/\/sportsbook\.thescore\.bet\//,
    join: (links) => {
      const legs = links.map((l) => [param(l, "market_selection_id[0]"), param(l, "odds_numerator[0]") ?? "2", param(l, "odds_denominator[0]") ?? "1"]);
      if (legs.some(([id]) => !id)) return null;
      return `https://sportsbook.thescore.bet/?${legs.map(([id, n, d], i) => `market_selection_id[${i}]=${id}&odds_numerator[${i}]=${n}&odds_denominator[${i}]=${d}`).join("&")}`;
    },
  },
  { // Caesars: selectionIds=A,B,C (a phone loaded both legs with "," and with "%2C", 2026-11-07)
    host: /^https:\/\/sportsbook\.caesars\.com\/us\/[^/]+\/bet\/betslip\?/,
    join: (links) => {
      const ids = links.map((l) => param(l, "selectionIds"));
      if (ids.some((o) => !o)) return null;
      return `${links[0].split("?")[0]}?selectionIds=${ids.join(",")}`;
    },
  },
];

// One link for all the legs, or null: every leg needs its own link, all on one
// book with a combined format, and no leg twice.
export function combinedLink(links: (string | null | undefined)[], state = BOOK_STATE): string | null {
  if (links.length < 2 || links.some((l) => !usable(l)) || new Set(links).size < links.length) return null;
  const book = MULTI_LEG.find((b) => links.every((l) => b.host.test(fillState(l!, state))));
  const url = book?.join(links.map((l) => fillState(l!, state))) ?? null;
  return url && usable(url) ? url : null;
}

const MAX_TEXT = 40; // Telegram cuts button text off around 40-60 characters
export const clip = (s: string, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export type ButtonOptions = { state?: string; max?: number };

// One row per button. One leg: "🛒 Build in BetMGM". Several: one "Build all"
// button when every leg has its own link on a book with a combined format;
// else one button per leg that has its own link, then "📍 Open game" for each
// game whose legs don't. Nothing when there are no links.
export function slipButtons(book: string, legs: LinkedLeg[], opts: ButtonOptions = {}): LinkButton[][] {
  const { state = BOOK_STATE, max = 5 } = opts;
  if (legs.length === 1) {
    const [leg] = legs;
    if (usable(leg.link)) return [[{ text: `🛒 Build in ${book}`, url: fillState(leg.link, state) }]];
    if (usable(leg.eventLink)) return [[{ text: `📍 Open the game in ${book}`, url: fillState(leg.eventLink, state) }]];
    return [];
  }
  // Phase 2: one button with every leg, where the book takes a combined link.
  const all = combinedLink(legs.map((l) => l.link), state);
  if (all) return [[{ text: `🛒 Build all ${legs.length} legs in ${book}`, url: all }]];
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

// ── Tap tracking ────────────────────────────────────────────
// Telegram doesn't tell a bot when a URL button is tapped, so each 🛒 button
// points at the bot (promo-bot?go=<id>), which logs the tap and redirects to the
// book's link, stored under that id (promo_bot_links).

const ID_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
export const LINK_ID = /^[A-Za-z0-9]{10}$/;

// A random 10-character id: about 58 bits, so ids can't be guessed.
export function newLinkId(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return [...random(10)].map((b) => ID_CHARS[b % ID_CHARS.length]).join("");
}

export function trackedUrl(functionUrl: string, id: string): string {
  return `${functionUrl}?go=${id}`;
}

// The buttons with each URL swapped for a tracked one, and the rows to store.
export function trackButtons(rows: LinkButton[][], functionUrl: string, newId: () => string = () => newLinkId()): {
  rows: LinkButton[][];
  links: { id: string; label: string; url: string }[];
} {
  const links: { id: string; label: string; url: string }[] = [];
  const out = rows.map((row) => row.map((b) => {
    if (!usable(b.url)) return b;
    const id = newId();
    links.push({ id, label: b.text, url: b.url });
    return { ...b, url: trackedUrl(functionUrl, id) };
  }));
  return { rows: out, links };
}

// When the first of a bet's games starts (ISO), or null if none is known. A 🛒
// link stops opening the book at that moment: past it the bet would be live.
export function earliestStart(starts: (string | null | undefined)[]): string | null {
  const known = starts.filter((s): s is string => !!s && !Number.isNaN(new Date(s).getTime())).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  return known[0] ?? null;
}
