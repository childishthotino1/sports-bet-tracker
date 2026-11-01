// @Bmorepromobot: a promo screenshot → rules → best bets; a bet slip screenshot
// → each leg devigged against Pinnacle and the exchanges → EV, with the active
// promo's boost.
// Its own bot, token, webhook, and table — it never touches the bet tracker's
// tables, and telegram-bot never sees its messages.
//
// Secrets: PROMO_BOT_TOKEN, PROMO_WEBHOOK_SECRET, PROMO_ALLOWED (comma list of
// chat IDs and/or @usernames), ODDS_API_KEY, ANTHROPIC_API_KEY.
// Deploy: supabase functions deploy promo-bot --no-verify-jwt

import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { readImage } from "../_shared/ev/vision.ts";
import { PROMO_EXAMPLES_MD } from "../_shared/ev/promo-examples.ts";
import {
  allowsSgpx, americanToDecimal, marketAllowed, marketsLabel, askBoost, HALF_MARKETS, QUESTION_PROP_MARKETS, bestBets, betterPrices, blowoutNote, formatAmerican, formatBetterPrices, formatShop, formatWongSlate, isPropOver, shopLegs, SHOP_BOOKS, BOOK_KEYS, cardLegs, EXTRA_MARKETS, leaguesToSearch, checkSlip, filterMode, findEvent, formatBet, formatRange, formatSgpSuggestion,
  formatSlipCheck, formatStart, legLabel, getEventOdds, getEvents, getOdds, legEventIds, marketsFor, noPicksReason, priceLegs,
  priceSlipLegs, promoCovers, prompt, PROP_MARKETS, rankSgpGames, SHARP_KEYS, slipOnly, SPORT_KEYS, startFlow, step, suggestSgpLegs, type FlowState, type MarketMode,
  type OddsEvent, type Promo, type Prompt,
} from "../_shared/ev/mod.ts";

const TOKEN = Deno.env.get("PROMO_BOT_TOKEN")!;
const WEBHOOK_SECRET = Deno.env.get("PROMO_WEBHOOK_SECRET")!;
const ODDS_API_KEY = Deno.env.get("ODDS_API_KEY")!;
const ALLOWED = (Deno.env.get("PROMO_ALLOWED") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const MAIN_MARKETS = ["h2h", "spreads", "totals"];

// The book plus every sharp source in one request: up to 10 bookmakers cost
// the same credits as one.
const withSharps = (bookKey: string) => [bookKey, ...SHARP_KEYS.filter((k) => k !== bookKey)];

// Props need one odds call per game, so picks with props check the next few
// games only, and skip props when credits run low.
const PROP_GAMES = 4;
const FOCUSED_GAMES = 10; // games searched for a market-limited promo (a TD boost: 2 credits a game)
const PROP_CREDIT_FLOOR = 60;
// SGP legs: games to try, best main lines first, before giving up.
const SGP_GAMES = 3;

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// ── Telegram ──────────────────────────────────────────────

async function tg(method: string, body: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

function send(chatId: number, text: string) {
  return tg("sendMessage", { chat_id: chatId, text });
}

function sendPrompt(chatId: number, p: Prompt) {
  const keyboard = p.buttons.map((row) => row.map((b) => ({ text: b.label, callback_data: `pf:${b.value}` })));
  return tg("sendMessage", { chat_id: chatId, text: p.text, ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}) });
}

async function photoBase64(fileId: string): Promise<string> {
  const { result } = await tg("getFile", { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${result.file_path}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ── Per-chat conversation state ───────────────────────────

async function loadState(chatId: number): Promise<FlowState | null> {
  const { data } = await db.from("promo_bot_state").select("state").eq("chat_id", String(chatId)).maybeSingle();
  return (data?.state as FlowState) ?? null;
}

async function saveState(chatId: number, state: FlowState) {
  await db.from("promo_bot_state").upsert({ chat_id: String(chatId), state, updated_at: new Date().toISOString() });
}

async function clearState(chatId: number) {
  await db.from("promo_bot_state").delete().eq("chat_id", String(chatId));
}

// Per-chat settings, kept through /skip.
type Settings = { markets: MarketMode };
const DEFAULT_SETTINGS: Settings = { markets: "all" };

async function loadSettings(chatId: number): Promise<Settings> {
  const { data } = await db.from("promo_bot_settings").select("settings").eq("chat_id", String(chatId)).maybeSingle();
  return { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
}

async function saveSettings(chatId: number, settings: Settings) {
  await db.from("promo_bot_settings").upsert({ chat_id: String(chatId), settings, updated_at: new Date().toISOString() });
}

const MODE_LABELS: Record<MarketMode, string> = { all: "Main lines + props", main: "Main lines only", props: "Props only" };

function sendSettings(chatId: number, settings: Settings) {
  const buttons = (Object.keys(MODE_LABELS) as MarketMode[]).map((m) =>
    [{ label: `${settings.markets === m ? "✅ " : ""}${MODE_LABELS[m]}`, value: m }]);
  const keyboard = buttons.map((row) => row.map((b) => ({ text: b.label, callback_data: `ps:${b.value}` })));
  return tg("sendMessage", {
    chat_id: chatId,
    text: "⚙️ Which markets should picks use? Main lines are healthier for your accounts: books limit prop bettors sooner.",
    reply_markup: { inline_keyboard: keyboard },
  });
}

// ── Odds ──────────────────────────────────────────────────

// One game's odds. Not every sport or plan offers every market (alternate
// lines, soccer props), so a refused request is retried without alternates,
// then with main lines only.
// extra: more books in the same request (up to 10 in all bill as one region).
async function eventOdds(sportKey: string, eventId: string, markets: string[], bookKey: string, extra: string[] = []) {
  const bookmakers = [...new Set([...withSharps(bookKey), ...extra])].slice(0, 10);
  const attempts = [
    markets,
    markets.filter((m) => !m.startsWith("alternate_")),
    markets.filter((m) => MAIN_MARKETS.includes(m)),
  ].filter((m, i, all) => m.length && (i === 0 || m.length < all[i - 1].length));
  for (let i = 0; ; i++) {
    try {
      return await getEventOdds(ODDS_API_KEY, sportKey, eventId, { markets: attempts[i], bookmakers });
    } catch (e) {
      if (i >= attempts.length - 1) throw e;
    }
  }
}

async function creditsNote(chatId: number, remaining: number | null) {
  if (remaining !== null && remaining < 50) await send(chatId, `⚠️ ${remaining} odds credits left this month.`);
}

// ── Picks ─────────────────────────────────────────────────

async function sendPicks(chatId: number, s: FlowState) {
  const { promo } = s;
  const bookKey = promo.book ? BOOK_KEYS[promo.book] : undefined;
  const leagues = leaguesToSearch(s);
  if (!bookKey) return send(chatId, `I can't pull odds for ${promo.book ?? "this book"} yet.`);
  if (!leagues.length) return send(chatId, `I can only find picks for ${Object.keys(SPORT_KEYS).join(", ")} so far.`);
  const sgpOnly = promo.bet_kinds.length === 1 && promo.bet_kinds[0] === "sgp";
  // A promo for one game is searched in that game only. An SGPx spans games,
  // so it's out then too.
  const covered = await coveredGames(promo, leagues);
  const named = promoGame(promo, covered);
  if (promo.game && !named) {
    await send(chatId, `I can't find ${promo.game} among the upcoming ${leagues.join("/")} games. If it has already started, I can't price it: live lines move faster than the odds feed.`);
    return sendPrompt(chatId, prompt(s));
  }
  const sgpx = sgpOnly && covered.length > 0 && !named && allowsSgpx(promo);

  // A promo limited to some markets (a TD boost) searches those only, whatever /settings says.
  const only = promo.markets ?? [];
  const mode: MarketMode = only.length ? "all" : (await loadSettings(chatId)).markets;
  if (named && !sgpOnly) return sendGamePicks(chatId, s, bookKey, named, mode);
  const what = only.length ? `${marketsLabel(promo)} prices` : mode === "main" ? "main lines" : mode === "props" ? "player props" : "lines and props";
  const where = leagues.length === 1 ? leagues[0] : `${leagues.length} leagues`;
  await send(chatId, `🔎 Pulling ${promo.book} ${where} ${what} and the sharp prices (Pinnacle + exchanges)…`);

  if (sgpOnly && !sgpx) return sendSgpLegs(chatId, s, bookKey, leagues, null, null);
  // Main lines: one call per league.
  const needMain = only.length ? only.some((m) => MAIN_MARKETS.includes(m)) : mode !== "props" || sgpx;
  let { events, remaining } = needMain
    ? await mainLines(promo, bookKey, leagues)
    : { events: [] as OddsEvent[], remaining: null as number | null };
  // Props need one call per game.
  // Per-game calls for the next few games: 1st-half lines (unless props only)
  // and props (unless main lines only).
  if (leagues.some((l) => gameMarkets(l, promo, mode).length)) {
    if (remaining !== null && remaining < PROP_CREDIT_FLOOR) {
      await send(chatId, `⚠️ Only ${remaining} odds credits left, so I'm skipping props and 1st-half lines this time.`);
    } else {
      // A market-limited promo has fewer markets per game, so it can afford more games.
      const games = covered.slice(0, only.length ? FOCUSED_GAMES : PROP_GAMES);
      for (const g of games) {
        const markets = gameMarkets(LEAGUE_OF[g.sport_key], promo, mode);
        if (!markets.length) continue;
        const r = await eventOdds(g.sport_key, g.id, markets, bookKey);
        events.push(r.data);
        remaining = r.remaining;
      }
    }
  }

  const legs = filterMode(priceLegs(events, bookKey), mode).filter((l) => marketAllowed(promo, l.market));
  const picks = bestBets(legs, promo, { league: leagues.length === 1 ? leagues[0] : undefined, target: s.target });
  if (sgpx && !picks.length) {
    // No SGPx of one leg per game works: try single-game SGP legs instead.
    return sendSgpLegs(chatId, s, bookKey, leagues, events, remaining);
  }
  if (!picks.length) {
    const setting = mode === "all" ? "" : `\n\n(Picks are set to ${MODE_LABELS[mode]}; /settings to change.)`;
    await send(chatId, noPicksReason(legs, promo, s.target) + setting);
  }
  await sendCards(chatId, s, picks, events);
  if (sgpx && picks.length) {
    await send(chatId, `Each leg is from a different game, so ${promo.book} should price the ${SGPX_NAME[promo.book!] ?? "SGPx"} as the legs multiplied, the price shown. If the slip shows a different total, send me the screenshot and I'll reprice it.`);
  }
  await creditsNote(chatId, remaining);
  await sendPrompt(chatId, prompt(s));
}

// One card per pick, with the guide's prop check: a big spread means starters
// may sit, which hurts player Overs.
async function sendCards(chatId: number, s: FlowState, picks: ReturnType<typeof bestBets>, events: OddsEvent[]) {
  const { promo } = s;
  const byId = new Map<string, OddsEvent>();
  for (const e of events) if (e.bookmakers.some((b) => b.markets.some((m) => m.key === "spreads"))) byId.set(e.id, e);
  for (const p of picks) {
    const cautions = [...new Set(p.legs.flatMap((l) => {
      const e = byId.get(l.eventId);
      const note = e && isPropOver(l.market, l.side) ? blowoutNote(e) : null;
      return note ? [note] : [];
    }))];
    await send(chatId, [formatBet({
      title: `${promo.book} ${promo.title}${s.target ? ` (target ${formatRange(s.target)})` : ""}`,
      book: promo.book!,
      bookOdds: p.americanOdds,
      boost: (promo.boost_pct ?? 0) / 100,
      legs: cardLegs(p),
      maxStake: promo.max_stake,
      kindLabel: p.kind === "sgp" ? `${p.legs.length}-leg ${SGPX_NAME[promo.book!] ?? "SGPx"}, one leg per game` : undefined,
    }).text, ...cautions].join("\n\n"));
  }
}

// The one game a promo is for, among these games: its `game`, or for a promo
// saved before `game` was read, a matchup named in its notes or title.
function promoGame<E extends Pick<OddsEvent, "id" | "home_team" | "away_team" | "commence_time">>(promo: Promo, events: E[]): E | null {
  if (promo.game === undefined) return findEvent(events, [promo.notes, promo.title]);
  return promo.game ? findEvent(events, [promo.game]) : null;
}

// A promo for one game: everything the feed has on that game in one call (main
// and alternate lines, team totals, 1st-half lines, props), the best qualifying
// singles, and for an SGP promo the legs to build it from.
async function sendGamePicks(chatId: number, s: FlowState, bookKey: string, game: Pick<OddsEvent, "id" | "sport_key" | "home_team" | "away_team" | "commence_time">, mode: MarketMode) {
  const { promo } = s;
  const league = LEAGUE_OF[game.sport_key];
  const name = `${game.away_team} @ ${game.home_team}`;
  await send(chatId, `🔎 This promo is for ${name} only (${formatStart(game.commence_time)}). Pulling ${promo.book} lines on that game and the sharp prices (Pinnacle + exchanges)…`);
  const lines = mode === "props" ? [] : [...(EXTRA_MARKETS[league] ?? ["alternate_spreads", "alternate_totals", "team_totals"]), ...(HALF_MARKETS[league] ?? [])];
  const props = mode === "main" ? [] : [...(PROP_MARKETS[league] ?? []), ...(QUESTION_PROP_MARKETS[league] ?? [])];
  const markets = promo.markets?.length
    ? [...promo.markets.filter((m) => MAIN_MARKETS.includes(m)), ...gameMarkets(league, promo, mode)]
    : [...MAIN_MARKETS, ...lines, ...props];
  const { data, remaining } = await eventOdds(game.sport_key, game.id, markets, bookKey);
  const legs = filterMode(priceLegs([data], bookKey), mode).filter((l) => marketAllowed(promo, l.market));
  const picks = bestBets(legs, promo, { league, target: s.target });
  if (!picks.length) {
    const setting = mode === "all" ? "" : `\n\n(Picks are set to ${MODE_LABELS[mode]}; /settings to change.)`;
    const why = legs.length ? noPicksReason(legs, { ...promo, bet_kinds: promo.bet_kinds.filter((k) => k !== "sgp") }, s.target) : `Neither ${promo.book} nor the sharp sources have lines up for ${name} yet. Try closer to kickoff.`;
    await send(chatId, why + setting);
  }
  await sendCards(chatId, s, picks, [data]);
  if (!promo.bet_kinds.length || promo.bet_kinds.includes("sgp")) {
    const sg = suggestSgpLegs(legs, Math.max(3, promo.min_legs ?? 3), game.id, promo.book!);
    if (sg) await send(chatId, formatSgpSuggestion(sg, promo.book!));
  }
  await creditsNote(chatId, remaining);
  await sendPrompt(chatId, prompt(s));
}

// The per-game markets to request: for a market-limited promo its non-main
// markets (every prop for any_player_prop), else 1st-half lines and props per
// the /settings mode. Last TD is left out of picks: no sharp source prices it
// two-way, so it can never be priced against one.
function gameMarkets(league: string, promo: Promo, mode: MarketMode): string[] {
  const only = promo.markets ?? [];
  if (only.length) {
    return [...new Set(only.flatMap((m) =>
      m === "any_player_prop" ? [...(PROP_MARKETS[league] ?? []), ...(QUESTION_PROP_MARKETS[league] ?? [])]
      : MAIN_MARKETS.includes(m) || m === "player_last_td" ? [] : [m]))];
  }
  return [...(mode === "props" ? [] : HALF_MARKETS[league] ?? []), ...(mode === "main" ? [] : PROP_MARKETS[league] ?? [])];
}

// Main lines for every game the promo covers in these leagues: one call per league.
async function mainLines(promo: Promo, bookKey: string, leagues: string[]) {
  const events: OddsEvent[] = [];
  let remaining: number | null = null;
  for (const league of leagues) {
    const r = await getOdds(ODDS_API_KEY, SPORT_KEYS[league], { markets: MAIN_MARKETS, bookmakers: withSharps(bookKey) });
    events.push(...r.data.filter((e) => promoCovers(promo, e.commence_time)));
    remaining = r.remaining;
  }
  return { events, remaining };
}

// What each book calls a parlay of same-game parlays from different games.
const SGPX_NAME: Record<string, string> = { DraftKings: "SGPx", FanDuel: "SGP+" };

// Our league name for a feed sport key.
const LEAGUE_OF: Record<string, string> = Object.fromEntries(Object.entries(SPORT_KEYS).map(([l, k]) => [k, l]));

// Upcoming games in these leagues that the promo covers, soonest first. Free.
async function coveredGames(promo: Promo, leagues: string[]) {
  const all = [];
  for (const league of leagues) all.push(...await getEvents(ODDS_API_KEY, SPORT_KEYS[league]));
  return all.filter((e) => promoCovers(promo, e.commence_time)).sort((a, b) => a.commence_time.localeCompare(b.commence_time));
}

// SGP-only promo: suggest the best-priced legs in the promo's game, or in the
// best games it covers (trying the next one when a game's sharp lines aren't
// up yet), then wait for the user's slip screenshot to price the SGP.
// mainEvents: the leagues' main lines to rank games by, if already pulled.
async function sendSgpLegs(chatId: number, s: FlowState, bookKey: string, leagues: string[], mainEvents: OddsEvent[] | null, remaining: number | null) {
  const { promo } = s;
  const events = await coveredGames(promo, leagues);
  if (!events.length) {
    await send(chatId, `No ${leagues.join("/")} games left that this promo covers${promo.expires_at ? ` (it runs through ${promo.expires_at})` : ""}.`);
    return sendPrompt(chatId, prompt(s));
  }
  const named = promoGame(promo, events);
  if (!named && !mainEvents) ({ events: mainEvents, remaining } = await mainLines(promo, bookKey, leagues));
  const candidates = named ? [named] : rankSgpGames(priceLegs(mainEvents!, bookKey))
    .map((id) => events.find((e) => e.id === id))
    .filter((e) => !!e)
    .slice(0, SGP_GAMES);
  if (!candidates.length) {
    await send(chatId, `Neither ${promo.book} nor the sharp sources have lines up for these games yet. Try closer to game time, or build an SGP and send me the slip.`);
    return sendPrompt(chatId, prompt(s));
  }
  const { markets: mode } = await loadSettings(chatId);
  const tried: string[] = [];
  let sg = null;
  for (const game of candidates) {
    const league = LEAGUE_OF[game.sport_key];
    const markets = promo.markets?.length
      ? [...promo.markets.filter((m) => MAIN_MARKETS.includes(m)), ...gameMarkets(league, promo, "all")]
      : [...MAIN_MARKETS, ...(EXTRA_MARKETS[league] ?? []), ...(PROP_MARKETS[league] ?? [])];
    const odds = await eventOdds(game.sport_key, game.id, markets, bookKey);
    remaining = odds.remaining;
    sg = suggestSgpLegs(filterMode(priceLegs([odds.data], bookKey), promo.markets?.length ? "all" : mode).filter((l) => marketAllowed(promo, l.market)), Math.max(3, promo.min_legs ?? 3), game.id, promo.book!);
    if (sg) break;
    tried.push(`${game.away_team} @ ${game.home_team} (${formatStart(game.commence_time)})`);
  }
  if (!sg) {
    const setting = mode === "all" ? "" : ` (picks are set to ${MODE_LABELS[mode]}; /settings to change)`;
    await send(chatId, `The sharp sources don't price enough lines yet${setting} on: ${tried.join("; ")}. Try closer to kickoff, or build an SGP and send me the slip; I'll price it.`);
  } else {
    await send(chatId, formatSgpSuggestion(sg, promo.book!));
  }
  await creditsNote(chatId, remaining);
  const next: FlowState = { ...s, step: "slip" };
  await saveState(chatId, next);
  await sendPrompt(chatId, prompt(next));
}

// ── Bet slips ─────────────────────────────────────────────

async function priceSlip(chatId: number, s: FlowState) {
  const slip = s.slip!;
  const book = slip.book ?? s.promo.book;
  if (!book) {
    const asking: FlowState = { ...s, step: "book" };
    await saveState(chatId, asking);
    return sendPrompt(chatId, { ...prompt(asking), text: "Which sportsbook is this slip on?" });
  }
  const done: FlowState = { ...s, slip: undefined, step: s.noPromo ? "end" : "action" };
  await saveState(chatId, done);

  const bookKey = BOOK_KEYS[book];
  const league = slip.league ?? s.promo.leagues.find((l) => SPORT_KEYS[l]);
  const sportKey = league ? SPORT_KEYS[league] : undefined;
  if (!bookKey) return send(chatId, `I can't pull odds for ${book} yet.`);
  if (!sportKey) return send(chatId, `I can only price ${Object.keys(SPORT_KEYS).join(", ")} slips so far.`);

  await send(chatId, `🔎 Pricing the slip against Pinnacle and the exchanges…`);
  const events = await getEvents(ODDS_API_KEY, sportKey);
  const ids = legEventIds(slip, events);
  const lost = slip.legs.filter((_, i) => !ids[i]);
  if (lost.length) {
    const which = lost.map((l) => `${legLabel(l)}${l.game ? ` (${l.game})` : ""}`).join("; ");
    return send(chatId, `I couldn't match ${lost.length === slip.legs.length ? "any leg" : which} to a game on the ${league} schedule. If the game has already started, or isn't ${league}, I can't price it.`);
  }
  const odds = new Map<string, OddsEvent>();
  let remaining: number | null = null;
  for (const id of new Set(ids as string[])) {
    const legs = slip.legs.filter((_, i) => ids[i] === id);
    const markets = marketsFor({ ...slip, legs });
    if (!markets.length) continue; // only markets the feed doesn't carry: nothing to fetch
    // Your other books ride along (same credits) so the check can line-shop each leg.
    const r = await eventOdds(sportKey, id, markets, bookKey, Object.keys(SHOP_BOOKS));
    odds.set(id, r.data);
    remaining = r.remaining;
  }
  const legEvents = ids.map((id) => odds.get(id!) ?? null);
  const priced = priceSlipLegs(slip, legEvents, bookKey);
  const promo = s.noPromo ? null : s.promo;
  // A promo for one game doesn't cover a leg from another.
  const promoEvent = promo ? promoGame(promo, events) : null;
  const otherGame = !!promoEvent && ids.some((id) => id !== promoEvent.id);
  const c = checkSlip(slip, priced, promo, book, otherGame);
  // A boost is tied to its book, so line shopping only helps an unboosted slip.
  const boosted = !!slip.boost_pct || (!s.noPromo && !!s.promo.boost_pct);
  const shopNote = boosted ? null : formatBetterPrices(slip, book, betterPrices(slip, legEvents, bookKey, SHOP_BOOKS));
  if (!c) {
    // Market types the odds feed doesn't carry come back as "other": say so, rather than blaming the prices.
    const unknown = slip.legs.flatMap((l, i) => l.market === "other" && priced[i].fair === null ? [priced[i].label.replace(/ Other$/, "")] : []);
    const missing = priced.filter((l, i) => l.fair === null && slip.legs[i].market !== "other").map((l) => l.label);
    const why = [
      unknown.length ? `The odds feed doesn't carry that kind of bet (${unknown.join(", ")}), so there's no sharp line to devig.` : "",
      missing.length ? `I couldn't find ${book} or sharp prices for: ${missing.join(", ")}.` : "",
    ].filter(Boolean).join(" ") || "I couldn't read the slip's total price.";
    // No promo, but the slip shows its own boost: check it at the boosted price the book pays.
    const slipBoost = !s.noPromo || !slip.boost_pct ? null
      : slip.boosted_odds !== null && slip.total_odds !== null
      ? ((americanToDecimal(slip.boosted_odds) - 1) / (americanToDecimal(slip.total_odds) - 1) - 1) * 100
      : slip.boost_pct;
    const typing: FlowState = { ...done, promo: { ...done.promo, book, ...(slipBoost ? { boost_pct: slipBoost } : {}) }, step: "slip", legs: slip.legs.length };
    if (shopNote) await send(chatId, shopNote);
    // The slip's total was read: go straight to the margin question, through the
    // same promo checks a typed price gets.
    const r = slip.total_odds !== null ? step(typing, formatAmerican(slip.total_odds)) : null;
    if (r && r.state.step === "fair") {
      const shown = slipBoost ? ` (boosted ${slip.boost_pct}%${slip.boosted_odds !== null ? ` to ${formatAmerican(slip.boosted_odds)}` : ""})` : "";
      await send(chatId, `${why} I'll check the slip's ${formatAmerican(slip.total_odds!)}${shown} with an assumed margin instead.`);
      await saveState(chatId, r.state);
      return sendPrompt(chatId, prompt(r.state));
    }
    await send(chatId, `${why} Type the slip's price (e.g. +350) and I'll check it with an assumed margin instead.`);
    await saveState(chatId, typing);
    return;
  }
  await send(chatId, formatSlipCheck(slip, book, c, promo));
  if (shopNote) await send(chatId, shopNote);
  await creditsNote(chatId, remaining);
  if (!s.noPromo) await sendPrompt(chatId, prompt(done));
}

// ── Questions ─────────────────────────────────────────────

// Books a question is priced at: the shared list's books on the free plan
// (BetMGM, DraftKings, FanDuel, theScore). With the five sharp sources that's
// nine, inside one region's credits.
const QUESTION_BOOKS = SHOP_BOOKS;

// "teasers?", "any Wong teasers this week": every NFL spread that fits a Wong
// teaser (guide.ts). One spreads-only call for the whole slate: 1 credit.
async function answerTeasers(chatId: number) {
  await send(chatId, "🔎 Checking this week's NFL spreads for Wong teaser legs…");
  const { data, remaining } = await getOdds(ODDS_API_KEY, SPORT_KEYS.NFL, { markets: ["spreads"], bookmakers: ["pinnacle", ...Object.keys(QUESTION_BOOKS)] });
  const upcoming = data.filter((e) => new Date(e.commence_time).getTime() > Date.now());
  await send(chatId, formatWongSlate(upcoming));
  await creditsNote(chatId, remaining);
}

// Finds the game a question names (a team's nickname is enough) among every
// league's upcoming games, soonest first, and lists its best-priced legs.
// False when no team is named, so the caller can fall back.
async function answerQuestion(chatId: number, text: string): Promise<boolean> {
  if (/\b(teasers?|wong)\b/i.test(text)) {
    await answerTeasers(chatId);
    return true;
  }
  const now = Date.now();
  const lists = await Promise.all(Object.values(SPORT_KEYS).map((k) => getEvents(ODDS_API_KEY, k).catch(() => [])));
  const events = lists.flat()
    .filter((e) => new Date(e.commence_time).getTime() > now)
    .sort((a, b) => a.commence_time.localeCompare(b.commence_time));
  const game = findEvent(events, [text]);
  if (!game) return false;
  const league = LEAGUE_OF[game.sport_key];
  const { markets: mode } = await loadSettings(chatId);
  await send(chatId, `🔎 Pricing ${game.away_team} @ ${game.home_team} at ${Object.values(QUESTION_BOOKS).join(", ")} against the sharp price…`);
  // Team totals for every sport but soccer (+1 credit); soccer gets its own extra markets.
  const extra = EXTRA_MARKETS[league] ?? ["team_totals"];
  const props = mode === "main" ? [] : [...(PROP_MARKETS[league] ?? []), ...(QUESTION_PROP_MARKETS[league] ?? [])];
  const markets = [...MAIN_MARKETS, ...extra, ...(mode === "props" ? [] : HALF_MARKETS[league] ?? []), ...props];
  const bookmakers = [...Object.keys(QUESTION_BOOKS), ...SHARP_KEYS];
  // If the feed rejects a market for this league, ask again for the main lines alone.
  const { data, remaining } = await getEventOdds(ODDS_API_KEY, game.sport_key, game.id, { markets, bookmakers })
    .catch(() => getEventOdds(ODDS_API_KEY, game.sport_key, game.id, { markets: MAIN_MARKETS, bookmakers }));
  await send(chatId, formatShop(data, filterMode(shopLegs(data, QUESTION_BOOKS), mode)));
  await creditsNote(chatId, remaining);
  return true;
}

// ── Handler ───────────────────────────────────────────────

const HELP = "Send me a screenshot of a sportsbook promo and I'll find the best bets to use it on. " +
  "Or send a screenshot of a bet slip you've built, and I'll devig it against Pinnacle and the exchanges (Novig, ProphetX, Kalshi, Polymarket): fair value, EV and Kelly.\n\n" +
  "Or ask about a game (\"good bets on the Ravens game?\") and I'll find its best prices across your books, or ask for \"teasers\" and I'll list this week's Wong teaser legs.\n\n" +
  "Stakes are ¼ Kelly, never more than 3% of your bankroll on one bet; keep a day's total under 7%.\n\n" +
  "/skip drops the promo in progress so you can start over. /settings picks main lines, props, or both.";

// The commands Telegram shows in its menu. /cancel, /new and /reset also work.
const COMMANDS = [
  { command: "skip", description: "Drop the current promo and start over" },
  { command: "settings", description: "Main lines, props, or both" },
  { command: "help", description: "What this bot does" },
];
const RESET_COMMANDS = ["skip", "cancel", "new", "reset"];

function allowed(chatId: number, username?: string): boolean {
  return ALLOWED.includes(String(chatId)) || (!!username && ALLOWED.includes(`@${username.toLowerCase()}`));
}

async function handle(update: any) {
  const msg = update.message ?? update.callback_query?.message;
  if (!msg) return;
  const chatId = msg.chat.id as number;
  const from = update.message?.from ?? update.callback_query?.from;

  if (!allowed(chatId, from?.username)) {
    if (update.message) await send(chatId, `This bot is private. Your chat ID is ${chatId}.`);
    return;
  }

  // Button tap
  if (update.callback_query) {
    await tg("answerCallbackQuery", { callback_query_id: update.callback_query.id });
    const data = String(update.callback_query.data ?? "");
    if (data.startsWith("ps:")) {
      const mode = data.slice(3) as MarketMode;
      if (!MODE_LABELS[mode]) return;
      await saveSettings(chatId, { ...(await loadSettings(chatId)), markets: mode });
      return send(chatId, `⚙️ Picks will use: ${MODE_LABELS[mode]}.`);
    }
    if (!data.startsWith("pf:")) return;
    return advance(chatId, data.slice(3));
  }

  const text = (update.message.text ?? "").trim();
  // "/skip" or "/skip@Bmorepromobot"
  const command = text.match(/^\/([a-z]+)(@\w+)?\b/i)?.[1].toLowerCase();
  if (command) await tg("setMyCommands", { commands: COMMANDS }); // keeps the menu current; cheap and idempotent
  if (command === "start" || command === "help") return send(chatId, HELP);
  if (command === "settings") return sendSettings(chatId, await loadSettings(chatId));
  if (command && RESET_COMMANDS.includes(command)) {
    await clearState(chatId);
    return send(chatId, "🧹 Cleared. Send a promo or bet slip screenshot to start fresh.");
  }
  if (command) return send(chatId, `I don't know /${command}.\n\n${HELP}`);

  // Screenshot: a promo starts a new promo; a slip is priced with the promo in play, if any.
  if (update.message.photo) {
    await send(chatId, "📖 Reading the screenshot…");
    const fileId = (update.message.photo as { file_id: string }[]).at(-1)!.file_id;
    const read = await readImage(anthropic, await photoBase64(fileId), PROMO_EXAMPLES_MD);
    if (read.kind === "promo") {
      const s = startFlow(read.promo);
      await saveState(chatId, s);
      return sendPrompt(chatId, prompt(s));
    }
    if (read.kind === "slip") {
      const current = await loadState(chatId);
      const inPlay = current && !current.noPromo && current.step !== "end";
      if (inPlay) return priceSlip(chatId, { ...current, slip: read.slip });
      if (read.slip.boost_pct) return priceSlip(chatId, slipOnly(read.slip));
      // No promo and no boost on screen: ask which boost (if any) is going on it.
      const asking = askBoost(read.slip);
      await saveState(chatId, asking);
      return sendPrompt(chatId, prompt(asking));
    }
    return send(chatId, "That doesn't look like a promo or a bet slip. Send a screenshot of a promo's details or of your bet slip.");
  }

  if (text) return advance(chatId, text, true);
}

async function advance(chatId: number, input: string, typed = false) {
  const s = await loadState(chatId);
  // Typed text that isn't an answer to a question the bot asked: a question
  // about a game ("good bets on the Ravens game?").
  if (typed && (!s || (s.noPromo && s.step !== "boost") || s.step === "action" || s.step === "end") && await answerQuestion(chatId, input)) return;
  if (!s) return send(chatId, HELP);
  const r = step(s, input);
  await saveState(chatId, r.state);
  if (r.reply) await send(chatId, r.reply);
  if (r.action === "picks") return sendPicks(chatId, r.state);
  if (r.action === "slip") return priceSlip(chatId, r.state);
  // Re-show the question unless the reply already asked for a retry.
  if (!r.reply || r.state.step !== s.step) await sendPrompt(chatId, prompt(r.state));
}

Deno.serve(async (req) => {
  if (req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
  const update = await req.json();
  try {
    await handle(update);
  } catch (e) {
    const chatId = (update.message ?? update.callback_query?.message)?.chat?.id;
    if (chatId) await send(chatId, `❌ Something broke: ${(e as Error).message}`);
    console.error(e);
  }
  // Always 200, or Telegram retries the same update.
  return new Response("ok");
});
