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
  allowsSgpx, bestBets, formatAmerican, formatShop, shopLegs, BOOK_KEYS, cardLegs, EXTRA_MARKETS, leaguesToSearch, checkSlip, filterMode, findEvent, formatBet, formatRange, formatSgpSuggestion,
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
async function eventOdds(sportKey: string, eventId: string, markets: string[], bookKey: string) {
  const bookmakers = withSharps(bookKey);
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
  // An SGPx spans games, so it's out when the promo names one game.
  const covered = sgpOnly ? await coveredGames(promo, leagues) : [];
  const named = findEvent(covered, [promo.notes, promo.title]);
  const sgpx = sgpOnly && covered.length > 0 && !named && allowsSgpx(promo);

  const { markets: mode } = await loadSettings(chatId);
  const what = mode === "main" ? "main lines" : mode === "props" ? "player props" : "lines and props";
  const where = leagues.length === 1 ? leagues[0] : `${leagues.length} leagues`;
  await send(chatId, `🔎 Pulling ${promo.book} ${where} ${what} and the sharp prices (Pinnacle + exchanges)…`);

  if (sgpOnly && !sgpx) return sendSgpLegs(chatId, s, bookKey, leagues, null, null);
  // Main lines: one call per league.
  let { events, remaining } = mode !== "props" || sgpx
    ? await mainLines(promo, bookKey, leagues)
    : { events: [] as OddsEvent[], remaining: null as number | null };
  // Props need one call per game.
  if (mode !== "main") {
    if (remaining !== null && remaining < PROP_CREDIT_FLOOR) {
      await send(chatId, `⚠️ Only ${remaining} odds credits left, so I'm skipping props this time.`);
    } else {
      const games = (await coveredGames(promo, leagues)).slice(0, PROP_GAMES);
      for (const g of games) {
        const league = LEAGUE_OF[g.sport_key];
        const markets = PROP_MARKETS[league] ?? [];
        if (!markets.length) continue;
        const r = await eventOdds(g.sport_key, g.id, markets, bookKey);
        events.push(r.data);
        remaining = r.remaining;
      }
    }
  }

  const legs = filterMode(priceLegs(events, bookKey), mode);
  const picks = bestBets(legs, promo, { league: leagues.length === 1 ? leagues[0] : undefined, target: s.target });
  if (sgpx && !picks.length) {
    // No SGPx of one leg per game works: try single-game SGP legs instead.
    return sendSgpLegs(chatId, s, bookKey, leagues, events, remaining);
  }
  if (!picks.length) {
    const setting = mode === "all" ? "" : `\n\n(Picks are set to ${MODE_LABELS[mode]}; /settings to change.)`;
    await send(chatId, noPicksReason(legs, promo, s.target) + setting);
  }
  for (const p of picks) {
    await send(chatId, formatBet({
      title: `${promo.book} ${promo.title}${s.target ? ` (target ${formatRange(s.target)})` : ""}`,
      book: promo.book!,
      bookOdds: p.americanOdds,
      boost: (promo.boost_pct ?? 0) / 100,
      legs: cardLegs(p),
      kindLabel: p.kind === "sgp" ? `${p.legs.length}-leg ${SGPX_NAME[promo.book!] ?? "SGPx"}, one leg per game` : undefined,
    }).text);
  }
  if (sgpx && picks.length) {
    await send(chatId, `Each leg is from a different game, so ${promo.book} should price the ${SGPX_NAME[promo.book!] ?? "SGPx"} as the legs multiplied, the price shown. If the slip shows a different total, send me the screenshot and I'll reprice it.`);
  }
  await creditsNote(chatId, remaining);
  await sendPrompt(chatId, prompt(s));
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
  const named = findEvent(events, [promo.notes, promo.title]);
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
    const markets = [...MAIN_MARKETS, ...(EXTRA_MARKETS[league] ?? []), ...(PROP_MARKETS[league] ?? [])];
    const odds = await eventOdds(game.sport_key, game.id, markets, bookKey);
    remaining = odds.remaining;
    sg = suggestSgpLegs(filterMode(priceLegs([odds.data], bookKey), mode), Math.max(3, promo.min_legs ?? 3), game.id, promo.book!);
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
    const r = await eventOdds(sportKey, id, markets, bookKey);
    odds.set(id, r.data);
    remaining = r.remaining;
  }
  const priced = priceSlipLegs(slip, ids.map((id) => odds.get(id!) ?? null), bookKey);
  const promo = s.noPromo ? null : s.promo;
  const c = checkSlip(slip, priced, promo, book);
  if (!c) {
    // Market types the odds feed doesn't carry come back as "other": say so, rather than blaming the prices.
    const unknown = slip.legs.flatMap((l, i) => l.market === "other" && priced[i].fair === null ? [priced[i].label.replace(/ Other$/, "")] : []);
    const missing = priced.filter((l, i) => l.fair === null && slip.legs[i].market !== "other").map((l) => l.label);
    const why = [
      unknown.length ? `The odds feed doesn't carry that kind of bet (${unknown.join(", ")}), so there's no sharp line to devig.` : "",
      missing.length ? `I couldn't find ${book} or sharp prices for: ${missing.join(", ")}.` : "",
    ].filter(Boolean).join(" ") || "I couldn't read the slip's total price.";
    const typing: FlowState = { ...done, promo: { ...done.promo, book }, step: "slip", legs: slip.legs.length };
    // The slip's total was read: go straight to the margin question, through the
    // same promo checks a typed price gets.
    const r = slip.total_odds !== null ? step(typing, formatAmerican(slip.total_odds)) : null;
    if (r && r.state.step === "fair") {
      await send(chatId, `${why} I'll check the slip's ${formatAmerican(slip.total_odds!)} with an assumed margin instead.`);
      await saveState(chatId, r.state);
      return sendPrompt(chatId, prompt(r.state));
    }
    await send(chatId, `${why} Type the slip's price (e.g. +350) and I'll check it with an assumed margin instead.`);
    await saveState(chatId, typing);
    return;
  }
  await send(chatId, formatSlipCheck(slip, book, c, promo));
  await creditsNote(chatId, remaining);
  if (!s.noPromo) await sendPrompt(chatId, prompt(done));
}

// ── Questions ─────────────────────────────────────────────

// Books a question is priced at: the ones on the free plan that the bettors
// use. With the five sharp sources that's nine, inside one region's credits.
const QUESTION_BOOKS: Record<string, string> = { betmgm: "BetMGM", draftkings: "DraftKings", fanduel: "FanDuel", espnbet: "theScore Bet" };

// Finds the game a question names (a team's nickname is enough) among every
// league's upcoming games, soonest first, and lists its best-priced legs.
// False when no team is named, so the caller can fall back.
async function answerQuestion(chatId: number, text: string): Promise<boolean> {
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
  const markets = [...MAIN_MARKETS, ...(EXTRA_MARKETS[league] ?? []), ...(mode === "main" ? [] : PROP_MARKETS[league] ?? [])];
  const { data, remaining } = await getEventOdds(ODDS_API_KEY, game.sport_key, game.id, {
    markets, bookmakers: [...Object.keys(QUESTION_BOOKS), ...SHARP_KEYS],
  });
  await send(chatId, formatShop(game, filterMode(shopLegs(data, QUESTION_BOOKS), mode)));
  await creditsNote(chatId, remaining);
  return true;
}

// ── Handler ───────────────────────────────────────────────

const HELP = "Send me a screenshot of a sportsbook promo and I'll find the best bets to use it on. " +
  "Or send a screenshot of a bet slip you've built, and I'll devig it against Pinnacle and the exchanges (Novig, ProphetX, Kalshi, Polymarket): fair value, EV and Kelly.\n\n" +
  "Or ask about a game (\"good bets on the Ravens game?\") and I'll find its best prices across your books.\n\n" +
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
      return priceSlip(chatId, inPlay ? { ...current, slip: read.slip } : slipOnly(read.slip));
    }
    return send(chatId, "That doesn't look like a promo or a bet slip. Send a screenshot of a promo's details or of your bet slip.");
  }

  if (text) return advance(chatId, text, true);
}

async function advance(chatId: number, input: string, typed = false) {
  const s = await loadState(chatId);
  // Typed text that isn't an answer to a question the bot asked: a question
  // about a game ("good bets on the Ravens game?").
  if (typed && (!s || s.noPromo || s.step === "action" || s.step === "end") && await answerQuestion(chatId, input)) return;
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
