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
  allowsSgpx, easternStamp, exposureNote, whyNote, parseBankroll, questionLeagues, questionBook, expandTeamAliases, mentionsBot, stripMention, looksLikeAnswer, slipButtons, shopButtons, earliestStart, startsTooSoon, legKey, matchMust, type MustMatch, type PricedLeg, BOOK_STATE, type LinkButton, americanToDecimal, parseBoost, marketAllowed, marketsLabel, askBoost, HALF_MARKETS, QUESTION_PROP_MARKETS, bestBets, betterPrices, blowoutNote, formatAmerican, formatBetterPrices, formatShop, formatWongSlate, isPropOver, shopLegs, SHOP_BOOKS, BOOK_KEYS, cardLegs, EXTRA_MARKETS, leaguesToSearch, checkSlip, filterMode, findEvent, formatBet, formatRange, formatSgpSuggestion,
  formatSlipCheck, formatStart, legLabel, getEventOdds, getEvents, getOdds, legEventIds, marketsFor, noPicksReason, priceLegs, MIN_LEAD_MINUTES,
  priceSlipLegs, promoCovers, prompt, PROP_MARKETS, rankSgpGames, SHARP_KEYS, slipOnly, slipOffers, type SlipOffer, SPORT_KEYS, startFlow, step, suggestSgpLegs, type FlowState, type MarketMode,
  type OddsEvent, type EventInfo, type Promo, type Prompt,
  questionFilter, questionMarkets, questionNames, questionRest, wantLeg, filterLabel, formatSlate, type QuestionFilter, type ShopLeg,
  mainMarkets, formatStats, parseStatsArgs, pickRow, trackedLeg, type PickRow, type StoredPick, type TrackedLeg,
} from "../_shared/ev/mod.ts";

const TOKEN = Deno.env.get("PROMO_BOT_TOKEN")!;
const WEBHOOK_SECRET = Deno.env.get("PROMO_WEBHOOK_SECRET")!;
const ODDS_API_KEY = Deno.env.get("ODDS_API_KEY")!;
const ALLOWED = (Deno.env.get("PROMO_ALLOWED") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const MAIN_MARKETS = ["h2h", "spreads", "totals"];

// The book plus every sharp source in one request: up to 10 bookmakers cost
// the same credits as one.
const withSharps = (bookKey: string | null) => [...(bookKey ? [bookKey] : []), ...SHARP_KEYS.filter((k) => k !== bookKey)];

// Props need one odds call per game, so picks with props check the next few
// games only, and skip props when credits run low.
const PROP_GAMES = 8;
const FOCUSED_GAMES = 10; // games searched for a market-limited promo (a TD boost: 2 credits a game)
const PROP_CREDIT_FLOOR = 500;
// SGP legs: games to try, best main lines first, before giving up.
const SGP_GAMES = 5;
// Warn when the month's odds credits run this low.
const CREDIT_WARNING = 1000;

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

// The book's state for BetMGM's {state} links (links.ts); Maryland unless set.
const BOOK_STATE_ENV = Deno.env.get("PROMO_BOOK_STATE")?.trim().toLowerCase() || BOOK_STATE;

type LinkSource = "pick" | "sgp_legs" | "slip_offer" | "better_price" | "question";

// A message with 🛒 URL buttons (links.ts): the book's own links, so one tap
// opens the book's app. No buttons: sent exactly as before. If Telegram turns
// the buttons down (a URL it won't take), the message still goes out without
// them. The message is remembered with its first game's start, so the sweep
// (sweepButtons) can take the buttons off once that game is live.
async function sendWithButtons(chatId: number, text: string, rows: LinkButton[][], source: LinkSource, starts: (string | null | undefined)[] = []) {
  if (!rows.length) return send(chatId, text);
  const r = await tg("sendMessage", { chat_id: chatId, text, reply_markup: { inline_keyboard: rows } });
  if (r?.ok === false) {
    console.error("buttons refused", r.description);
    return send(chatId, text);
  }
  const startsAt = earliestStart(starts);
  const messageId = r?.result?.message_id;
  if (startsAt && messageId) {
    const { error } = await db.from("promo_bot_messages").insert({ chat_id: String(chatId), message_id: messageId, source, starts_at: startsAt });
    if (error) console.error("promo_bot_messages", error.message);
  }
  return r;
}

// Takes the 🛒 buttons off every card whose first game has started (pg_cron
// every 5 minutes calls promo-bot?sweep=1). Harmless to call any time: it only
// touches games already under way.
async function sweepButtons(): Promise<Response> {
  const { data, error } = await db.from("promo_bot_messages").select("id, chat_id, message_id")
    .is("cleared_at", null).lte("starts_at", new Date().toISOString()).order("starts_at").limit(100);
  if (error) return new Response(error.message, { status: 500 });
  for (const m of data ?? []) {
    const r = await tg("editMessageReplyMarkup", {
      chat_id: m.chat_id, message_id: m.message_id,
      reply_markup: { inline_keyboard: [[{ text: "⏱ Game started: no longer a pregame bet", callback_data: "started" }]] },
    });
    if (r?.ok === false) console.error("sweep", m.message_id, r.description); // deleted or too old: nothing to clear
    await db.from("promo_bot_messages").update({ cleared_at: new Date().toISOString() }).eq("id", m.id);
  }
  return new Response(`cleared ${data?.length ?? 0}`);
}

// "Be specific" and "Try something different" on the priced legs: the legs a
// pick must include, and the legs already shown left out (unless they're the
// ones it must include). "nomatch" when the must text names no priced leg.
function narrowLegs(s: FlowState, legs: PricedLeg[]): { legs: PricedLeg[]; must: MustMatch | null } | "nomatch" {
  const must = s.must ? matchMust(legs, s.must) : null;
  if (s.must && !must) return "nomatch";
  const shown = new Set(s.shown ?? []);
  return { legs: legs.filter((l) => !shown.has(legKey(l)) || !!must?.match(l)), must };
}
const possessive = (name: string) => name.endsWith("s") ? `${name}'` : `${name}'s`;
function noMatchText(s: FlowState): string {
  return `I couldn't find "${s.must}" among ${possessive(s.promo.book ?? "the book")} lines that the sharps price. Try a last name, a team nickname, or a line as the book shows it ("Ravens -3.5", "over 220.5"), or tap Be specific again to change or clear it.`;
}
// The leg was found, but no bet with it qualifies (a -310 single under a -200 minimum).
function mustNoPicksText(s: FlowState, legs: PricedLeg[], must: MustMatch): string {
  const found = legs.filter(must.match).slice(0, 3).map((l) => `${l.selection} ${formatAmerican(l.bookOdds)}`).join(", ");
  const { min_total_odds: min, bet_kinds: kinds } = s.promo;
  const rule = min !== null ? ` This promo needs total odds of ${formatAmerican(min)} or longer${kinds.length ? ` on a ${kinds.join(" or ")}` : ""}.` : "";
  return `No bet that qualifies for this promo includes ${must.game ? must.label : `${found}`}.${rule} Tap ✍️ Change what to include to pick something else, or clear it.`;
}
// Remembers the legs just suggested, so "Try something different" skips them.
async function remember(chatId: number, s: FlowState, legs: PricedLeg[]): Promise<FlowState> {
  if (!legs.length) return s;
  const shown = [...new Set([...(s.shown ?? []), ...legs.map(legKey)])];
  const next = { ...s, shown };
  await saveState(chatId, { ...(await loadState(chatId) ?? s), shown });
  return next;
}
// Put the must legs first, so the SGP suggestion (which takes legs in order) uses them.
const mustFirst = (legs: PricedLeg[], must: MustMatch | null) => must ? [...legs.filter(must.match), ...legs.filter((l) => !must.match(l))] : legs;

const SGP_BUTTON_HINT = "🛒 Tap each leg to add it to the slip; you may have to switch the slip to SGP / Same Game Parlay.";
const SGP_ALL_HINT = "🛒 One tap puts every leg in the slip; if it shows as a regular parlay, switch it to SGP / Same Game Parlay.";

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
// bankroll: dollars, for one suggested stake on every card (/bankroll); unset = a stake for four bankrolls.
type Settings = { markets: MarketMode; bankroll?: number };
const DEFAULT_SETTINGS: Settings = { markets: "all" };

async function loadSettings(chatId: number): Promise<Settings> {
  const { data } = await db.from("promo_bot_settings").select("settings").eq("chat_id", String(chatId)).maybeSingle();
  return { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
}

async function saveSettings(chatId: number, settings: Settings) {
  await db.from("promo_bot_settings").upsert({ chat_id: String(chatId), settings, updated_at: new Date().toISOString() });
}

async function bankrollCommand(chatId: number, arg: string) {
  const settings = await loadSettings(chatId);
  const money = (n: number) => `$${n.toLocaleString("en-US")}`;
  if (!arg) {
    return send(chatId, settings.bankroll
      ? `💵 Your bankroll is ${money(settings.bankroll)}. Every card suggests one stake: ¼ Kelly, never more than 3% (${money(Math.round(settings.bankroll * 0.03))}). Change it with /bankroll 5000, or /bankroll off.`
      : "💵 No bankroll set, so cards show stakes for four bankrolls. Set yours with /bankroll 4000.");
  }
  const bankroll = parseBankroll(arg);
  if (bankroll === undefined) return send(chatId, "Type your bankroll in dollars, like /bankroll 4000 (or /bankroll off).");
  const { bankroll: _old, ...rest } = settings;
  await saveSettings(chatId, bankroll === null ? rest : { ...rest, bankroll });
  return send(chatId, bankroll === null
    ? "💵 Bankroll cleared. Cards show stakes for four bankrolls again."
    : `💵 Bankroll set to ${money(bankroll)}. Every card now suggests one stake for you: ¼ Kelly, capped at 3% (${money(Math.round(bankroll * 0.03))}) and at the promo's max wager.`);
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
// extra: more books in the same request (every 10 books bill as one region).
async function eventOdds(sportKey: string, eventId: string, markets: string[], bookKey: string | null, extra: string[] = []) {
  const bookmakers = [...new Set([...withSharps(bookKey), ...extra])];
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
  if (remaining !== null && remaining < CREDIT_WARNING) await send(chatId, `⚠️ ${remaining} odds credits left this month.`);
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
  if (promo.game_date && !covered.length) {
    await send(chatId, `No ${leagues.join("/")} games left on ${promo.game_date}, the only date this promo covers. Games that have started can't be priced: live lines move faster than the odds feed.`);
    return sendPrompt(chatId, prompt(s));
  }
  // The promo's game, or, if its name for it doesn't match, the game a "Be specific" names.
  const named = promoGame(promo, covered) ?? (promo.game && s.must ? findEvent(covered, [expandTeamAliases(s.must)]) : null);
  if (promo.game && !named) {
    // Say why: the game starts inside the cutoff (or has started), or it isn't on the schedule.
    const all = (await Promise.all(leagues.map((l) => getEvents(ODDS_API_KEY, SPORT_KEYS[l]).catch(() => [])))).flat();
    const game = promoGame(promo, all) ?? (s.must ? findEvent(all, [expandTeamAliases(s.must)]) : null);
    await send(chatId, game
      ? `${game.away_team} @ ${game.home_team} ${new Date(game.commence_time).getTime() <= Date.now() ? "has started" : `starts at ${formatStart(game.commence_time)}`}, so it's too close to price: I stop ${MIN_LEAD_MINUTES} minutes before kickoff, when books start taking it live and live lines move faster than the odds feed.`
      : `I can't find ${promo.game} among the upcoming ${leagues.join("/")} games. Tap ✍️ Be specific and type the teams (e.g. "Bucs Bears") if I misread them.`);
    return sendPrompt(chatId, prompt(s));
  }
  const sgpx = sgpOnly && covered.length > 0 && !named && allowsSgpx(promo);

  // A promo limited to some markets (a TD boost) searches those only, whatever /settings says.
  const only = promo.markets ?? [];
  // "Be specific" can name a prop or a main line, so it searches both, whatever /settings says.
  const mode: MarketMode = only.length || s.must ? "all" : (await loadSettings(chatId)).markets;
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
      // A game named by "Be specific" goes first, so its props are in the search.
      const mustGame = s.must ? findEvent(covered, [expandTeamAliases(s.must)]) : null;
      const ordered = mustGame ? [mustGame, ...covered.filter((g) => g.id !== mustGame.id)] : covered;
      const games = ordered.slice(0, only.length ? FOCUSED_GAMES : PROP_GAMES);
      for (const g of games) {
        const markets = gameMarkets(LEAGUE_OF[g.sport_key], promo, mode);
        if (!markets.length) continue;
        const r = await eventOdds(g.sport_key, g.id, markets, bookKey);
        events.push(r.data);
        remaining = r.remaining;
      }
    }
  }

  const priced = filterMode(priceLegs(events, bookKey), mode).filter((l) => marketAllowed(promo, l.market));
  const narrowed = narrowLegs(s, priced);
  if (narrowed === "nomatch") {
    await send(chatId, noMatchText(s));
    return sendPrompt(chatId, prompt(s));
  }
  const { legs, must } = narrowed;
  const picks = bestBets(legs, promo, { league: leagues.length === 1 ? leagues[0] : undefined, target: s.target, book: promo.book ?? undefined, must: must?.match });
  if (sgpx && !picks.length) {
    // No SGPx of one leg per game works: try single-game SGP legs instead.
    return sendSgpLegs(chatId, s, bookKey, leagues, events, remaining);
  }
  if (!picks.length) {
    const setting = mode === "all" ? "" : `\n\n(Picks are set to ${MODE_LABELS[mode]}; /settings to change.)`;
    const again = s.shown?.length ? "That's every different bet I can find right now. " : "";
    await send(chatId, must ? mustNoPicksText(s, legs, must) : again + noPicksReason(legs, promo, s.target) + setting);
  }
  await sendCards(chatId, s, picks, events);
  s = await remember(chatId, s, picks.flatMap((p) => p.legs));
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
  const { bankroll } = await loadSettings(chatId);
  const byId = new Map<string, OddsEvent>();
  for (const e of events) if (e.bookmakers.some((b) => b.markets.some((m) => m.key === "spreads"))) byId.set(e.id, e);
  const rows = picks.map((p) => pickRow({
    chat_id: String(chatId), source: "pick", book: promo.book!, league: LEAGUE_OF[p.legs[0].sportKey] ?? null, kind: p.kind,
    promo_title: promo.title, boost_pct: promo.boost_pct ?? 0, book_odds: p.americanOdds, fair_prob: p.eval.fairProb,
    ev: p.eval.ev, verdict: p.eval.ev > 0 ? "plus_ev" : "minus_ev", legs: p.legs.map(trackedLeg),
  }));
  const past = await recentPicks(chatId);
  for (const [k, p] of picks.entries()) {
    const cautions = [...new Set(p.legs.flatMap((l) => {
      const e = byId.get(l.eventId);
      const note = e && isPropOver(l.market, l.side) ? blowoutNote(e) : null;
      return note ? [note] : [];
    })), ...new Set((p.free ?? []).map((f) => `🧩 ${f.rule.why}`)),
      whyNote(p, (promo.boost_pct ?? 0) / 100, promo.book!),
      ...(p.eval.ev > 0 ? [] : [`⚠️ Nothing +EV includes "${s.must}", so this is the closest. Skip it unless you want that leg anyway.`]),
      ...[exposureNote(rows[k].legs, past, rows[k].dedup_key)].filter((x): x is string => !!x)];
    await sendWithButtons(chatId, [formatBet({
      title: `${promo.book} ${promo.title}${s.target ? ` (target ${formatRange(s.target)})` : ""}`,
      book: promo.book!,
      bookOdds: p.americanOdds,
      boost: (promo.boost_pct ?? 0) / 100,
      legs: cardLegs(p),
      maxStake: promo.max_stake,
      bankroll,
      kindLabel: p.kind === "sgp" ? `${p.legs.length}-leg ${SGPX_NAME[promo.book!] ?? "SGPx"}, one leg per game` : undefined,
    }).text, ...cautions].join("\n\n"), slipButtons(promo.book!, p.legs, { state: BOOK_STATE_ENV }), "pick", p.legs.map((l) => l.start));
  }
  await logPicks(rows);
}

// This chat's bets still waiting on their games (sent or checked in the last
// 3 days), for exposure notes. A failure only costs the note.
async function recentPicks(chatId: number): Promise<StoredPick[]> {
  const since = new Date(Date.now() - 3 * 86400e3).toISOString();
  const { data, error } = await db.from("promo_bot_picks").select("dedup_key, legs")
    .eq("chat_id", String(chatId)).eq("status", "pending").gte("created_at", since).limit(500);
  if (error) console.error("recentPicks", error.message);
  return (Array.isArray(data) ? data : []) as StoredPick[];
}

// ── Tracking (promo_bot_picks; graded by the grade-picks function) ──

// Logging never gets in the way of an answer: a failure is only logged.
async function logPicks(rows: PickRow[]) {
  if (!rows.length) return;
  const { error } = await db.from("promo_bot_picks").upsert(rows, { onConflict: "dedup_key", ignoreDuplicates: true });
  if (error) console.error("logPicks", error.message);
}

// SGP legs to build: logged as one SGP with no total price (the book prices it).
function sgpRow(chatId: number, promo: Promo, sg: NonNullable<ReturnType<typeof suggestSgpLegs>>): PickRow {
  return pickRow({
    chat_id: String(chatId), source: "sgp_legs", book: promo.book!, league: LEAGUE_OF[sg.legs[0].sportKey] ?? null, kind: "sgp",
    promo_title: promo.title, boost_pct: promo.boost_pct ?? 0, book_odds: null,
    fair_prob: sg.legs.reduce((p, l) => p * l.fair, 1), ev: null, verdict: null, legs: sg.legs.map(trackedLeg),
  });
}

// SGP legs to build, with a 🛒 button per leg (each opens that leg in the slip).
function sendSgpSuggestion(chatId: number, sg: NonNullable<ReturnType<typeof suggestSgpLegs>>, book: string) {
  const rows = slipButtons(book, sg.legs, { state: BOOK_STATE_ENV });
  const text = formatSgpSuggestion(sg, book);
  const hint = rows.length === 1 && rows[0][0].text.startsWith("🛒 Build all") ? SGP_ALL_HINT : SGP_BUTTON_HINT;
  return sendWithButtons(chatId, rows.length ? `${text}\n\n${hint}` : text, rows, "sgp_legs", sg.legs.map((l) => l.start));
}

// Every suggestion so far, paged past Supabase's 1000-row cap.
// One chat's logged suggestions, or everyone's (chatId null), paged past the 1000-row cap.
async function loadPicks(chatId: number | null): Promise<StoredPick[]> {
  const out: StoredPick[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from("promo_bot_picks").select("*");
    if (chatId !== null) q = q.eq("chat_id", String(chatId));
    const { data, error } = await q.order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data as StoredPick[]));
    if (!data || data.length < 1000) return out;
  }
}

// The one game a promo is for, among these games: its `game`, or for a promo
// saved before `game` was read, a matchup named in its notes or title.
function promoGame<E extends Pick<OddsEvent, "id" | "home_team" | "away_team" | "commence_time">>(promo: Promo, events: E[]): E | null {
  if (promo.game === undefined) return findEvent(events, [promo.notes, promo.title]);
  return promo.game ? findEvent(events, [expandTeamAliases(promo.game)]) : null;
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
    : [...mainMarkets(league), ...lines, ...props];
  const { data, remaining } = await eventOdds(game.sport_key, game.id, markets, bookKey);
  const narrowed = narrowLegs(s, filterMode(priceLegs([data], bookKey), s.must ? "all" : mode).filter((l) => marketAllowed(promo, l.market)));
  if (narrowed === "nomatch") {
    await send(chatId, noMatchText(s));
    return sendPrompt(chatId, prompt(s));
  }
  const { legs, must } = narrowed;
  const picks = bestBets(legs, promo, { league, target: s.target, book: promo.book ?? undefined, must: must?.match });
  if (!picks.length) {
    const setting = mode === "all" ? "" : `\n\n(Picks are set to ${MODE_LABELS[mode]}; /settings to change.)`;
    const why = must ? mustNoPicksText(s, legs, must) : legs.length ? noPicksReason(legs, { ...promo, bet_kinds: promo.bet_kinds.filter((k) => k !== "sgp") }, s.target) : `Neither ${promo.book} nor the sharp sources have lines up for ${name} yet. Try closer to kickoff.`;
    await send(chatId, why + setting);
  }
  await sendCards(chatId, s, picks, [data]);
  const shownNow = picks.flatMap((p) => p.legs);
  if (!promo.bet_kinds.length || promo.bet_kinds.includes("sgp")) {
    const sg = suggestSgpLegs(mustFirst(legs, must), Math.max(3, promo.min_legs ?? 3), game.id, promo.book!);
    if (sg) {
      await sendSgpSuggestion(chatId, sg, promo.book!);
      await logPicks([sgpRow(chatId, promo, sg)]);
      shownNow.push(...sg.legs);
    }
  }
  s = await remember(chatId, s, shownNow);
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
    const r = await getOdds(ODDS_API_KEY, SPORT_KEYS[league], { markets: mainMarkets(league), bookmakers: withSharps(bookKey) });
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
    await send(chatId, `No ${leagues.join("/")} games left that this promo covers${promo.game_date ? ` (games on ${promo.game_date} only)` : promo.expires_at ? ` (it runs through ${promo.expires_at})` : ""}.`);
    return sendPrompt(chatId, prompt(s));
  }
  const named = promoGame(promo, events) ?? (s.must ? findEvent(events, [expandTeamAliases(s.must)]) : null);
  if (!named && !mainEvents) ({ events: mainEvents, remaining } = await mainLines(promo, bookKey, leagues));
  const candidates = named ? [named] : rankSgpGames(priceLegs(mainEvents!, bookKey))
    .map((id) => events.find((e) => e.id === id))
    .filter((e) => !!e)
    .slice(0, SGP_GAMES);
  if (!candidates.length) {
    await send(chatId, `Neither ${promo.book} nor the sharp sources have lines up for these games yet. Try closer to game time, or build an SGP and send me the slip.`);
    return sendPrompt(chatId, prompt(s));
  }
  const mode: MarketMode = s.must ? "all" : (await loadSettings(chatId)).markets;
  const tried: string[] = [];
  let sg = null;
  for (const game of candidates) {
    const league = LEAGUE_OF[game.sport_key];
    const markets = promo.markets?.length
      ? [...promo.markets.filter((m) => MAIN_MARKETS.includes(m)), ...gameMarkets(league, promo, "all")]
      : [...mainMarkets(league), ...(EXTRA_MARKETS[league] ?? []), ...(PROP_MARKETS[league] ?? [])];
    const odds = await eventOdds(game.sport_key, game.id, markets, bookKey);
    remaining = odds.remaining;
    const narrowed = narrowLegs(s, filterMode(priceLegs([odds.data], bookKey), promo.markets?.length ? "all" : mode).filter((l) => marketAllowed(promo, l.market)));
    if (narrowed !== "nomatch") sg = suggestSgpLegs(mustFirst(narrowed.legs, narrowed.must), Math.max(3, promo.min_legs ?? 3), game.id, promo.book!);
    if (sg) break;
    tried.push(`${game.away_team} @ ${game.home_team} (${formatStart(game.commence_time)})`);
  }
  if (!sg && s.must) {
    await send(chatId, noMatchText(s));
  } else if (!sg) {
    const setting = mode === "all" ? "" : ` (picks are set to ${MODE_LABELS[mode]}; /settings to change)`;
    const again = s.shown?.length ? "Nothing different left to suggest. " : "";
    await send(chatId, `${again}The sharp sources don't price enough lines yet${setting} on: ${tried.join("; ")}. Try closer to kickoff, or build an SGP and send me the slip; I'll price it.`);
  } else {
    await sendSgpSuggestion(chatId, sg, promo.book!);
    await logPicks([sgpRow(chatId, promo, sg)]);
    s = await remember(chatId, s, sg.legs);
  }
  await creditsNote(chatId, remaining);
  const next: FlowState = { ...s, step: "slip" };
  await saveState(chatId, next);
  await sendPrompt(chatId, prompt(next));
}

// ── Bet slips ─────────────────────────────────────────────

// After a slip check: "which book?" with a button per book that posts every leg
// (its price on a straight bet or parlay), so a slip someone shared becomes a
// link to build the same bet. The tap is answered by sendOfferLink.
function sendOffers(chatId: number, offers: SlipOffer[]) {
  if (!offers.length) return null;
  const buttons = offers.map((o) => ({ text: `${o.book}${o.odds !== null ? ` ${formatAmerican(o.odds)}` : ""}`, callback_data: `pl:${o.key}` }));
  const keyboard: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < buttons.length; i += 2) keyboard.push(buttons.slice(i, i + 2));
  return tg("sendMessage", { chat_id: chatId, text: "🛒 Want a link to build this bet? Which book?", reply_markup: { inline_keyboard: keyboard } });
}
async function sendOfferLink(chatId: number, key: string) {
  const offer = (await loadState(chatId))?.slipOffers?.find((o) => o.key === key);
  if (!offer) return send(chatId, "That slip is no longer the one in play. Send the screenshot again and I'll find the links.");
  const rows = slipButtons(offer.book, offer.legs, { state: BOOK_STATE_ENV });
  if (!rows.length) return send(chatId, `${offer.book} didn't send a link for this bet.`);
  const all = offer.legs.length > 1 && rows.length === 1 && rows[0][0].text.startsWith("🛒 Build all");
  const price = offer.odds !== null ? ` (${formatAmerican(offer.odds)} there)` : "";
  const hint = offer.legs.every((l) => !l.link) ? `That bet isn't on my odds feed, so this opens the game in ${offer.book}; pick it there.`
    : offer.legs.length === 1 ? "Tap to put it in the slip." : all ? "One tap puts every leg in the slip." : "Tap each leg to add it to the slip.";
  const sgp = offer.odds === null && offer.legs.length > 1 ? " If it shows as a regular parlay, switch it to SGP / Same Game Parlay." : "";
  return sendWithButtons(chatId, `🛒 ${offer.book}${price}: ${hint}${sgp} Check the price in the slip before you place it.`, rows, "slip_offer", offer.legs.map((l) => l.start));
}

async function priceSlip(chatId: number, s: FlowState) {
  const slip = s.slip!;
  const book = slip.book ?? s.promo.book;
  if (!book) {
    const asking: FlowState = { ...s, step: "book" };
    await saveState(chatId, asking);
    return sendPrompt(chatId, { ...prompt(asking), text: "Which sportsbook is this slip on?" });
  }
  const done: FlowState = { ...s, slip: undefined, slipOffers: undefined, step: s.noPromo ? "end" : "action" };
  await saveState(chatId, done);

  // A book the feed doesn't carry (Caesars, Fanatics, bet365) is priced from
  // the slip's own leg prices against the sharps.
  const bookKey = BOOK_KEYS[book] && Object.keys(SHOP_BOOKS).includes(BOOK_KEYS[book]) ? BOOK_KEYS[book] : null;
  const league = slip.league ?? s.promo.leagues.find((l) => SPORT_KEYS[l]);
  const sportKey = league ? SPORT_KEYS[league] : undefined;
  if (!sportKey) return send(chatId, `I can only price ${Object.keys(SPORT_KEYS).join(", ")} slips so far.`);
  if (!bookKey && slip.legs.length > 1 && slip.legs.some((l) => l.odds == null)) {
    await send(chatId, `${book} isn't on my odds feed and the slip doesn't show every leg's price, so I'll judge the legs against the sharps and use the slip's total.`);
  }

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
    // Only markets the feed doesn't carry: the moneyline alone, for the book's link to the game.
    // Your other books ride along (same credits) so the check can line-shop each leg.
    const r = await eventOdds(sportKey, id, markets.length ? markets : ["h2h"], bookKey, Object.keys(SHOP_BOOKS));
    odds.set(id, r.data);
    remaining = r.remaining;
  }
  const legEvents = ids.map((id) => odds.get(id!) ?? null);
  const priced = priceSlipLegs(slip, legEvents, bookKey);
  const promo = s.noPromo ? null : s.promo;
  // A promo for one game doesn't cover a leg from another.
  const promoEvent = promo ? promoGame(promo, events) : null;
  const otherGame = !!promoEvent && ids.some((id) => id !== promoEvent.id);
  const byStart = new Map(events.map((e) => [e.id, e.commence_time]));
  const offDate = !!promo?.game_date && ids.some((id) => !!id && !!byStart.get(id) && easternStamp(byStart.get(id)!).slice(0, 10) !== promo.game_date);
  const c = checkSlip(slip, priced, promo, book, otherGame, offDate);
  // A boost is tied to its book, so line shopping only helps an unboosted slip.
  const boosted = !!slip.boost_pct || (!s.noPromo && !!s.promo.boost_pct);
  const better = boosted ? [] : betterPrices(slip, legEvents, bookKey, SHOP_BOOKS);
  const shopNote = boosted ? null : formatBetterPrices(slip, book, better);
  const offers = slipOffers(slip, legEvents, SHOP_BOOKS, bookKey);
  const shopRows = shopButtons(better.flatMap((b, i) => (b ? [{ selection: legLabel(slip.legs[i]), book: b.book, link: b.link }] : [])), { state: BOOK_STATE_ENV });
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
    if (shopNote) await sendWithButtons(chatId, shopNote, shopRows, "better_price", legEvents.map((e) => e?.commence_time));
    if (offers.length) {
      typing.slipOffers = offers;
      await sendOffers(chatId, offers);
    }
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
  const byId = new Map(events.map((e) => [e.id, e]));
  const row = pickRow({
    chat_id: String(chatId), source: "slip", book, league: league ?? null, kind: slip.bet_kind, promo_title: promo?.title ?? null,
    boost_pct: Math.round(c.boost * 10000) / 100, book_odds: c.totalOdds, fair_prob: c.fairProb, ev: c.eval.ev,
    verdict: c.eval.ev > 0 ? "plus_ev" : "minus_ev",
    legs: slip.legs.map((l, i): TrackedLeg => {
      const e = ids[i] ? byId.get(ids[i]!) : undefined;
      return {
        event_id: ids[i] ?? null, sport_key: e?.sport_key ?? sportKey, game: e ? `${e.away_team} @ ${e.home_team}` : l.game,
        start: e?.commence_time ?? null, market: l.market, selection: priced[i].label, side: l.side, point: l.line,
        player: l.market === "h2h" || l.market === "spreads" ? null : l.team_or_player, book_odds: priced[i].bookOdds, fair: priced[i].fair,
      };
    }),
  });
  const exposure = exposureNote(row.legs, await recentPicks(chatId), row.dedup_key);
  const { bankroll } = await loadSettings(chatId);
  await send(chatId, [formatSlipCheck(slip, book, c, promo, bankroll ?? null), exposure].filter(Boolean).join("\n\n"));
  await logPicks([row]);
  if (shopNote) await sendWithButtons(chatId, shopNote, shopRows, "better_price", legEvents.map((e) => e?.commence_time));
  await creditsNote(chatId, remaining);
  if (offers.length) {
    await saveState(chatId, { ...done, slipOffers: offers });
    await sendOffers(chatId, offers);
  }
  if (!s.noPromo) await sendPrompt(chatId, prompt(done));
}

// ── Questions ─────────────────────────────────────────────

// Books a question is priced at: every retail book on our plan (BetMGM,
// DraftKings, FanDuel, theScore, Caesars, Fanatics). With the five sharp
// sources that's eleven books, billed as two regions.
const QUESTION_BOOKS = SHOP_BOOKS;

// "teasers?", "any Wong teasers this week": every NFL spread that fits a Wong
// teaser (guide.ts). One spreads-only call for the whole slate: 1 credit.
async function answerTeasers(chatId: number) {
  await send(chatId, "🔎 Checking this week's NFL spreads for Wong teaser legs…");
  const { data, remaining } = await getOdds(ODDS_API_KEY, SPORT_KEYS.NFL, { markets: ["spreads"], bookmakers: ["pinnacle", ...Object.keys(QUESTION_BOOKS)] });
  const upcoming = data.filter((e) => !startsTooSoon(e.commence_time));
  await send(chatId, formatWongSlate(upcoming));
  await creditsNote(chatId, remaining);
}

// Finds the game a question names (a team's nickname is enough) among every
// league's upcoming games, soonest first, and lists its best-priced legs.
// False when no team is named, so the caller can fall back.
// "Run the promo on the Ravens game": find that game among the promo's leagues,
// limit the promo to it, and find the picks. False when the text names no game.
async function focusPromo(chatId: number, s: FlowState, text: string): Promise<boolean> {
  const leagues = leaguesToSearch({ ...s, sport: s.sport ?? "ALL" });
  const lists = await Promise.all(leagues.map((l) => getEvents(ODDS_API_KEY, SPORT_KEYS[l]).catch(() => [])));
  const events = lists.flat().filter((e) => !startsTooSoon(e.commence_time))
    .sort((a, b) => a.commence_time.localeCompare(b.commence_time));
  const game = findEvent(events, [expandTeamAliases(text)]);
  if (!game) return false;
  const focused: FlowState = {
    ...s, step: "action", autoRun: false, sport: LEAGUE_OF[game.sport_key],
    promo: { ...s.promo, game: `${game.away_team} @ ${game.home_team}` },
  };
  await saveState(chatId, focused);
  await send(chatId, `🎯 Running ${s.promo.title} on ${focused.promo.game} only.`);
  await sendPicks(chatId, focused);
  return true;
}

// How many games a league-wide question prices one by one, when it needs lines
// the sport-wide call doesn't carry (props, 1st half, team totals).
const SLATE_GAMES = 4;

// Logs a question's ✅ lines (better than fair as is), each as a single.
function logQuestion(chatId: number, legs: ShopLeg[]) {
  return logPicks(legs.filter((l) => l.edge > 0).map((l) => pickRow({
    chat_id: String(chatId), source: "question", book: l.book, league: LEAGUE_OF[l.sportKey] ?? null, kind: "single", promo_title: null, boost_pct: 0,
    book_odds: l.bookOdds, fair_prob: l.fair, ev: l.edge, verdict: "plus_ev", legs: [trackedLeg(l)],
  })));
}

const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9.+\- ]/g, " ").split(/\s+/).filter(Boolean);

// A question about a game ("Knicks game plays, not player props", "Brunson
// points", "Ravens 1st half spread") or a league ("nba spreads tonight", "nfl
// TD props"). questionFilter (lookup.ts) reads which lines it wants; what's
// left names a player or a team's side. False when it names neither a game
// nor a league, so the caller can fall back.
async function answerQuestion(chatId: number, text: string): Promise<boolean> {
  if (/\b(teasers?|wong)\b/i.test(text)) {
    await answerTeasers(chatId);
    return true;
  }
  // A league named in the question ("ncaaf") narrows the search; otherwise every league.
  const named = questionLeagues(text).filter((l) => SPORT_KEYS[l]);
  const keys = named.length ? named.map((l) => SPORT_KEYS[l]) : Object.values(SPORT_KEYS);
  const lists = await Promise.all(keys.map((k) => getEvents(ODDS_API_KEY, k).catch(() => [] as EventInfo[])));
  const events = lists.flat()
    .filter((e) => !startsTooSoon(e.commence_time))
    .sort((a, b) => a.commence_time.localeCompare(b.commence_time));
  const rest = questionRest(text);
  const game = findEvent(events, [expandTeamAliases(text)]);
  if (!game && !named.length) return false;

  const { markets: setting } = await loadSettings(chatId);
  const asked = questionFilter(text);
  const f: QuestionFilter = { ...asked, mode: asked.mode ?? setting };
  const label = filterLabel(asked);
  // A book named in the question ("on fanduel") is the only one priced, if it's on the feed.
  const book = questionBook(text);
  const bookKey = book ? Object.keys(QUESTION_BOOKS).find((k) => QUESTION_BOOKS[k] === book) : undefined;
  const books = bookKey ? { [bookKey]: book! } : QUESTION_BOOKS;
  const offFeed = book && !bookKey ? ` (${book} isn't on my odds feed, so here are your other books)` : "";
  const bookmakers = [...Object.keys(books), ...SHARP_KEYS];
  if (!game) return answerSlate(chatId, text, named, events, f, label, books, bookmakers, offFeed);

  const league = LEAGUE_OF[game.sport_key];
  await send(chatId, `🔎 Pricing ${game.away_team} @ ${game.home_team}${label ? ` (${label})` : ""} at ${Object.values(books).join(", ")} against the sharp price${offFeed}…`);
  // Team totals for every sport but soccer (+1 credit); soccer gets its own extra markets.
  const extra = EXTRA_MARKETS[league] ?? ["team_totals"];
  const props = f.mode === "main" ? [] : [...(PROP_MARKETS[league] ?? []), ...(QUESTION_PROP_MARKETS[league] ?? [])];
  const markets = questionMarkets(asked, game.sport_key)
    ?? [...mainMarkets(league), ...(f.mode === "props" ? [] : [...extra, ...(HALF_MARKETS[league] ?? [])]), ...props];
  // If the feed rejects a market for this league, ask again for the main lines alone.
  const { data, remaining } = await getEventOdds(ODDS_API_KEY, game.sport_key, game.id, { markets, bookmakers })
    .catch(() => getEventOdds(ODDS_API_KEY, game.sport_key, game.id, { markets: mainMarkets(league), bookmakers }));
  let shopped = shopLegs(data, books).filter((l) => wantLeg(f, l));
  // What's left of the question: a player ("Brunson") or a team's side ("Knicks spread").
  const must = matchMust(shopped, rest);
  const team = new Set(tokens(`${game.home_team} ${game.away_team}`));
  const names = questionNames(text);
  const unknown = tokens(expandTeamAliases(names)).filter((w) => !team.has(w));
  let note = "";
  if (must && !must.game) shopped = shopped.filter(must.match);
  else if (!must && unknown.length && shopped.length) note = `\n\n(I couldn't find a line for "${names.split(" ").filter((w) => !team.has(w.toLowerCase())).join(" ")}" in this game, so here's everything${label ? ` for ${label}` : ""}.)`;
  const plus = shopped.slice(0, 6).filter((l) => l.edge > 0);
  await sendWithButtons(chatId, formatShop(data, shopped, 6, label) + note, shopButtons(plus, { state: BOOK_STATE_ENV }), "question", [game.commence_time]);
  await logQuestion(chatId, shopped.slice(0, 6));
  await creditsNote(chatId, remaining);
  return true;
}

// A league with no game named: the best prices across its upcoming games.
// Main lines come from one sport-wide call per league; props, 1st half lines
// and team totals need a call per game, so those cover the next SLATE_GAMES.
async function answerSlate(
  chatId: number, text: string, leagues: string[], events: EventInfo[], f: QuestionFilter, label: string | null,
  books: Record<string, string>, bookmakers: string[], offFeed: string,
): Promise<boolean> {
  // "tonight" / "today": games starting today, Eastern time.
  const today = /\b(tonight|today)\b/i.test(text) ? easternStamp(new Date().toISOString()).slice(0, 10) : null;
  const upcoming = events.filter((e) => !today || easternStamp(e.commence_time).slice(0, 10) === today);
  const where = leagues.length > 2 ? "soccer" : leagues.join("/");
  if (!upcoming.length) {
    await send(chatId, `No ${where} games left to price${today ? " today" : ""}. Games that have started (or start within ${MIN_LEAD_MINUTES} minutes) can't be priced.`);
    return true;
  }
  const perGame = f.mode === "props" || f.stats.length > 0 || f.periods.length > 0 || f.main.includes("team_totals");
  await send(chatId, `🔎 Pricing ${where}${label ? ` ${label}` : ""}${perGame ? ` for the next ${Math.min(SLATE_GAMES, upcoming.length) === 1 ? "game" : `${Math.min(SLATE_GAMES, upcoming.length)} games`}` : ""} at ${Object.values(books).join(", ")} against the sharp price${offFeed}…`);
  const priced: OddsEvent[] = [];
  let remaining: number | null = null;
  if (perGame) {
    for (const g of upcoming.slice(0, SLATE_GAMES)) {
      const league = LEAGUE_OF[g.sport_key];
      const markets = questionMarkets(f, g.sport_key)
        ?? [...mainMarkets(league), ...(f.mode === "main" ? [] : [...(PROP_MARKETS[league] ?? []), ...(QUESTION_PROP_MARKETS[league] ?? [])])];
      const r = await getEventOdds(ODDS_API_KEY, g.sport_key, g.id, { markets, bookmakers }).catch(() => null);
      if (r) { priced.push(r.data); remaining = r.remaining; }
    }
  } else {
    const ids = new Set(upcoming.map((e) => e.id));
    for (const league of leagues) {
      const main = mainMarkets(league);
      const markets = f.main.length ? main.filter((m) => f.main.includes(m)) : main;
      if (!markets.length) continue;
      const r = await getOdds(ODDS_API_KEY, SPORT_KEYS[league], { markets, bookmakers }).catch(() => null);
      if (r) { priced.push(...r.data.filter((e) => ids.has(e.id))); remaining = r.remaining; }
    }
  }
  let legs = priced.flatMap((e) => shopLegs(e, books)).filter((l) => wantLeg(f, l)).sort((a, b) => b.edge - a.edge);
  const must = matchMust(legs, questionRest(text));
  if (must && !must.game) legs = legs.filter(must.match);
  const plus = legs.slice(0, 8).filter((l) => l.edge > 0);
  await sendWithButtons(chatId, formatSlate(where.toUpperCase(), legs, label, priced.length), shopButtons(plus, { state: BOOK_STATE_ENV }), "question", plus.map((l) => l.start));
  await logQuestion(chatId, legs.slice(0, 8));
  await creditsNote(chatId, remaining);
  return true;
}

// ── Handler ───────────────────────────────────────────────

const HELP = "Send me a screenshot of a sportsbook promo and I'll find the best bets to use it on. " +
  "Or send a screenshot of a bet slip you've built, and I'll devig it against Pinnacle and the exchanges (Novig, ProphetX, Kalshi, Polymarket): fair value, EV and Kelly.\n\n" +
  "Or ask about a game (\"good bets on the Ravens game?\") and I'll find its best prices across your books, or ask for \"teasers\" and I'll list this week's Wong teaser legs.\n\n" +
  "Stakes are ¼ Kelly, never more than 3% of your bankroll on one bet; keep a day's total under 7%. Set /bankroll 4000 and every card suggests one stake for you.\n\n" +
  "/skip drops the promo in progress so you can start over. /settings picks main lines, props, or both. /stats shows how the bot's suggestions to you have done (/stats 7 for the last week, /stats all for everyone's, /stats full for the breakdown).";

// The commands Telegram shows in its menu. /cancel, /new and /reset also work.
// Typed text that names no upcoming game.
const NO_GAME = `I couldn't match that to an upcoming game or league. Name a team the way the book does ("Notre Dame", "Ravens"), and add the league if it could be more than one ("Miami ncaaf"). For a player, add his team ("Ravens Lamar TD"); for a whole league, name it ("nba spreads tonight", "nfl TD props"). Or send a promo or bet slip screenshot. /help shows everything I do.`;

const COMMANDS = [
  { command: "skip", description: "Drop the current promo and start over" },
  { command: "settings", description: "Main lines, props, or both" },
  { command: "bankroll", description: "Your bankroll, for one suggested stake" },
  { command: "stats", description: "How the bot's picks for you have done (/stats all: everyone)" },
  { command: "help", description: "What this bot does" },
];
const RESET_COMMANDS = ["skip", "cancel", "new", "reset"];

// The bot's own @username, for spotting mentions in group chats (looked up once).
let botUsername: Promise<string> | null = null;
function myUsername(): Promise<string> {
  botUsername ??= tg("getMe", {}).then((r) => String(r?.result?.username ?? "")).catch(() => "");
  return botUsername;
}

function allowed(chatId: number, username?: string): boolean {
  return ALLOWED.includes(String(chatId)) || (!!username && ALLOWED.includes(`@${username.toLowerCase()}`));
}

async function handle(update: any) {
  const msg = update.message ?? update.callback_query?.message;
  if (!msg) return;
  const chatId = msg.chat.id as number;
  const from = update.message?.from ?? update.callback_query?.from;

  // In a group the bot sees every message (privacy mode off), so it answers
  // only what's meant for it: a command to it, a message naming it or replying
  // to it. Screenshots and short answers to its question are handled below.
  const group = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const me = group ? await myUsername() : "";
  const rawText = String(update.message?.text ?? "").trim();
  const toOtherBot = /^\/\w+@(\w+)/.exec(rawText)?.[1];
  if (group && toOtherBot && toOtherBot.toLowerCase() !== me.toLowerCase()) return;
  const addressed = !group || rawText.startsWith("/") || mentionsBot(rawText, me) ||
    (!!update.message?.reply_to_message?.from?.is_bot && update.message.reply_to_message.from.username?.toLowerCase() === me.toLowerCase());

  if (!allowed(chatId, from?.username)) {
    if (update.message && addressed) await send(chatId, `This bot is private. Your chat ID is ${chatId}.`);
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
    if (data.startsWith("pl:")) return sendOfferLink(chatId, data.slice(3));
    if (!data.startsWith("pf:")) return;
    return advance(chatId, data.slice(3));
  }

  const text = group ? stripMention(rawText, me) : rawText;
  // "/skip" or "/skip@Bmorepromobot"
  const command = text.match(/^\/([a-z]+)(@\w+)?\b/i)?.[1].toLowerCase();
  if (command) await tg("setMyCommands", { commands: COMMANDS }); // keeps the menu current; cheap and idempotent
  if (command === "start" || command === "help") return send(chatId, HELP);
  if (command === "settings") return sendSettings(chatId, await loadSettings(chatId));
  if (command === "bankroll") return bankrollCommand(chatId, text.replace(/^\/\w+(@\w+)?/, "").trim());
  if (command === "stats") {
    // This chat's suggestions; "/stats all" for everyone's combined.
    const { all, days, full } = parseStatsArgs(text);
    return send(chatId, formatStats(await loadPicks(all ? null : chatId), days, new Date(), all ? "all" : "mine", full));
  }
  if (command && RESET_COMMANDS.includes(command)) {
    await clearState(chatId);
    return send(chatId, "🧹 Cleared. Send a promo or bet slip screenshot to start fresh.");
  }
  if (command) return send(chatId, `I don't know /${command}.\n\n${HELP}`);

  // Screenshot: a promo starts a new promo; a slip is priced with the promo in play, if any.
  if (update.message.photo) {
    // In a group, any photo reaches the bot; it reads them all but speaks only for promos and slips.
    if (!group) await send(chatId, "📖 Reading the screenshot…");
    const fileId = (update.message.photo as { file_id: string }[]).at(-1)!.file_id;
    // A caption is instructions ("Ravens game", "props only"): the read applies it to the promo.
    const caption = stripMention(String(update.message.caption ?? ""), me) || null;
    const read = await readImage(anthropic, await photoBase64(fileId), PROMO_EXAMPLES_MD, "image/jpeg", caption, easternStamp(new Date().toISOString()).slice(0, 10));
    if (read.kind === "promo") {
      const s: FlowState = { ...startFlow(read.promo), ...(caption ? { autoRun: true } : {}) };
      await saveState(chatId, s);
      if (s.autoRun && s.step === "action") return advance(chatId, "picks");
      return sendPrompt(chatId, prompt(s));
    }
    if (read.kind === "slip") {
      const current = await loadState(chatId);
      const inPlay = current && !current.noPromo && current.step !== "end";
      if (inPlay) return priceSlip(chatId, { ...current, slip: read.slip });
      if (read.slip.boost_pct) return priceSlip(chatId, slipOnly(read.slip));
      // A caption like "25%" or "no boost" answers the boost question up front.
      const boost = caption ? parseBoost(caption.match(/no boost|\d+(\.\d+)?\s*%/i)?.[0] ?? "") : undefined;
      if (boost !== undefined) return priceSlip(chatId, { ...slipOnly(read.slip), slip: { ...read.slip, boost_pct: boost, boost_entered: boost !== null } });
      // No promo and no boost on screen: ask which boost (if any) is going on it.
      const asking = askBoost(read.slip);
      await saveState(chatId, asking);
      return sendPrompt(chatId, prompt(asking));
    }
    if (group) return; // a meme, not a bet
    return send(chatId, "That doesn't look like a promo or a bet slip. Send a screenshot of a promo's details or of your bet slip.");
  }

  if (!text) return;
  // Group chatter: only a message naming the bot or replying to it, or a short
  // answer ("+350", "25", "any") while the bot is waiting on one of its questions.
  if (group && !addressed) {
    const s = await loadState(chatId);
    const waiting = !!s && !["action", "end"].includes(s.step);
    if (!waiting || !looksLikeAnswer(text)) return;
  }
  return advance(chatId, text, true);
}

// "give me the bet link", "link?": the last slip's book links, without starting a question.
const LINK_ASK = /\b(links?|url)\b/i;

async function advance(chatId: number, input: string, typed = false) {
  const s = await loadState(chatId);
  if (typed && LINK_ASK.test(input) && input.length <= 60) {
    if (s?.slipOffers?.length) return sendOffers(chatId, s.slipOffers);
    return send(chatId, "I don't have a link for that: none of your books on my odds feed posts it, or the slip's game has started. Send the slip screenshot again, or name the game (\"Blues game\") for its best lines with links.");
  }
  // Typed text that isn't an answer to a question the bot asked: a question
  // about a game ("good bets on the Ravens game?").
  // With a promo open, naming a game runs the promo on that game.
  if (typed && s && !s.noPromo && (s.step === "action" || s.step === "end") && await focusPromo(chatId, s, input)) return;
  if (typed && (!s || (s.noPromo && s.step !== "boost") || s.step === "action" || s.step === "end") && await answerQuestion(chatId, input)) return;
  if (!s) return send(chatId, typed ? NO_GAME : HELP);
  const { bankroll } = await loadSettings(chatId);
  let r = step({ ...s, bankroll }, input);
  // A promo sent with instructions runs its search once the bot's questions (book, max wager) are answered.
  if (r.state.autoRun && r.state.step === "action" && !r.action) {
    // A promo sent with instructions runs at once, without the odds-range question.
    const run = step({ ...r.state, autoRun: false, rangeAsked: true }, "picks");
    r = { ...run, reply: r.reply ?? run.reply };
  }
  await saveState(chatId, r.state);
  if (r.reply) await send(chatId, r.reply);
  if (r.action === "picks") return sendPicks(chatId, r.state);
  if (r.action === "slip") return priceSlip(chatId, r.state);
  // Re-show the question unless the reply already asked for a retry.
  if (!r.reply || r.state.step !== s.step) await sendPrompt(chatId, prompt(r.state));
}

Deno.serve(async (req) => {
  // A tap on a 🛒 button (a GET from the phone, no secret): log and redirect.
  const params = new URL(req.url).searchParams;
  // pg_cron's sweep (no secret: it only takes buttons off games already under way).
  if (params.get("sweep") === "1") return sweepButtons();
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
