// @Bmorepromobot: promo screenshot → rules → best bets (or check a bet you're
// building). Its own bot, token, webhook, and table — it never touches the
// bet tracker's tables, and telegram-bot never sees its messages.
//
// Secrets: PROMO_BOT_TOKEN, PROMO_WEBHOOK_SECRET, PROMO_ALLOWED (comma list of
// chat IDs and/or @usernames), ODDS_API_KEY, ANTHROPIC_API_KEY.
// Deploy: supabase functions deploy promo-bot --no-verify-jwt

import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parsePromoImage } from "../_shared/ev/promo-vision.ts";
import { PROMO_EXAMPLES_MD } from "../_shared/ev/promo-examples.ts";
import {
  bestBets, BOOK_KEYS, cardLegs, formatBet, getOdds, noPicksReason, priceLegs, prompt, SPORT_KEYS, startFlow,
  step, type FlowState, type Prompt,
} from "../_shared/ev/mod.ts";

const TOKEN = Deno.env.get("PROMO_BOT_TOKEN")!;
const WEBHOOK_SECRET = Deno.env.get("PROMO_WEBHOOK_SECRET")!;
const ODDS_API_KEY = Deno.env.get("ODDS_API_KEY")!;
const ALLOWED = (Deno.env.get("PROMO_ALLOWED") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

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

// ── Picks ─────────────────────────────────────────────────

async function sendPicks(chatId: number, s: FlowState) {
  const { promo } = s;
  const bookKey = promo.book ? BOOK_KEYS[promo.book] : undefined;
  const league = s.sport ?? promo.leagues.find((l) => SPORT_KEYS[l]);
  if (!bookKey) return send(chatId, `I can't pull odds for ${promo.book ?? "this book"} yet.`);
  if (!league) return send(chatId, `I can only find picks for ${Object.keys(SPORT_KEYS).join(", ")} so far.`);

  await send(chatId, `🔎 Pulling ${promo.book} and Pinnacle ${league} lines…`);
  const { data: events, remaining } = await getOdds(ODDS_API_KEY, SPORT_KEYS[league], {
    markets: ["h2h", "spreads", "totals"],
    bookmakers: [bookKey, BOOK_KEYS.Pinnacle],
  });
  const legs = priceLegs(events, bookKey);
  const picks = bestBets(legs, promo, { league });
  if (!picks.length) await send(chatId, noPicksReason(legs, promo));
  for (const p of picks) {
    await send(chatId, formatBet({
      title: `${promo.book} ${promo.title}`,
      book: promo.book!,
      bookOdds: p.americanOdds,
      boost: (promo.boost_pct ?? 0) / 100,
      sharpSource: "Pinnacle",
      legs: cardLegs(p),
    }).text);
  }
  if (remaining !== null && remaining < 50) await send(chatId, `⚠️ ${remaining} odds credits left this month.`);
  await sendPrompt(chatId, prompt(s));
}

// ── Handler ───────────────────────────────────────────────

const HELP = "Send me a screenshot of a sportsbook promo. I'll read its rules and find the best bets to use it on, " +
  "or check a bet you're building.";

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
    if (!data.startsWith("pf:")) return;
    return advance(chatId, data.slice(3));
  }

  const text = (update.message.text ?? "").trim();
  if (text === "/start" || text === "/help") return send(chatId, HELP);

  // Screenshot → new promo
  if (update.message.photo) {
    await send(chatId, "📖 Reading the promo…");
    const fileId = (update.message.photo as { file_id: string }[]).at(-1)!.file_id;
    const promo = await parsePromoImage(anthropic, await photoBase64(fileId), PROMO_EXAMPLES_MD);
    if (!promo) return send(chatId, "That doesn't look like a promo. Send a screenshot of the promo's details page.");
    const s = startFlow(promo);
    await saveState(chatId, s);
    return sendPrompt(chatId, prompt(s));
  }

  if (text) return advance(chatId, text);
}

async function advance(chatId: number, input: string) {
  const s = await loadState(chatId);
  if (!s) return send(chatId, HELP);
  const r = step(s, input);
  await saveState(chatId, r.state);
  if (r.reply) await send(chatId, r.reply);
  if (r.action === "picks") return sendPicks(chatId, r.state);
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
