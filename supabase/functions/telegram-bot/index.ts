import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TELEGRAM_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const ANTHROPIC_KEY  = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ── Telegram helpers ──────────────────────────────────────

type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

async function reply(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function replyWithButtons(chatId: number, text: string, keyboard: InlineKeyboard) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, reply_markup: { inline_keyboard: keyboard } }),
  });
}

async function answerCallback(id: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: id }),
  });
}

// ── Keyboard layouts ──────────────────────────────────────

const EDIT_BUTTONS: InlineKeyboard = [
  [
    { text: "✏️ Book",  callback_data: "edit_book"  },
    { text: "✏️ Sport", callback_data: "edit_sport" },
    { text: "✏️ Odds",  callback_data: "edit_odds"  },
  ],
  [
    { text: "✏️ Total", callback_data: "edit_total" },
    { text: "✏️ Boost", callback_data: "edit_boost" },
    { text: "✏️ Desc",  callback_data: "edit_desc"  },
  ],
];

const CONFIRM_BUTTONS: InlineKeyboard = [
  [
    { text: "✅ Save", callback_data: "save" },
    { text: "❌ Skip", callback_data: "skip" },
  ],
  ...EDIT_BUTTONS,
];

// ── Base64 (chunked to handle large images) ───────────────

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ── Claude image parsing ──────────────────────────────────

interface ParsedSlip {
  book: string;
  sport: string;
  description: string;
  boost_pct: number;
  total_wager: number;
  base_odds: number;
  his_wager?: number;
  my_wager?: number;
  _editing_field?: string;
}

async function parseImageWithClaude(base64: string): Promise<ParsedSlip | null> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-4-6",
      max_tokens: 300,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: base64 },
          },
          {
            type: "text",
            text: `Parse this sportsbook bet slip and return a JSON object with these fields:

{
  "book": "sportsbook abbreviation — identify by logo, color scheme, and name:
    DK    = DraftKings   (TODO: add color scheme)
    FD    = FanDuel      (TODO: add color scheme)
    MGM   = BetMGM       (black & gold)
    SCORE = theScore Bet (TODO: add color scheme)
    B365  = Bet365       (TODO: add color scheme)
    CS    = Caesars      (TODO: add color scheme)
    FAN   = Fanatics     (TODO: add color scheme)",
  "sport": "sport abbreviation — NBA, NFL, NHL, MLB, NCAAF, NCAAB, SOCCER, etc.",
  "description": "short label including team or player name and bet type, no spaces or dots — e.g. LakersML, BrownsCover, CurrieO29pts, PHLvsWSH, 3TeamParlay",
  "boost_pct": boost percentage as a number (0 if no boost shown),
  "total_wager": total wager amount as a number,
  "base_odds": the ORIGINAL pre-boost odds as an integer in American format (e.g. 180, -110, -114). If a profit boost is applied, use the original odds shown BEFORE the boost. If no boost, use the displayed odds.
}

Return ONLY valid JSON. No explanation.`,
          },
        ],
      }],
    }),
  });

  const data = await res.json();
  const text = data.content?.[0]?.text?.trim() ?? "";
  if (!text) return null;

  try {
    const clean = text.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
    return JSON.parse(clean) as ParsedSlip;
  } catch {
    return null;
  }
}

// ── Sportsbook matching ───────────────────────────────────

const BOOK_ALIASES: Record<string, string> = {
  "ESPN": "theScore Bet", "THESCORE": "theScore Bet", "SCORE": "theScore Bet", "THESCOREBET": "theScore Bet",
  "FD": "FanDuel", "FANDUEL": "FanDuel",
  "DK": "DraftKings", "DRAFTKINGS": "DraftKings",
  "MGM": "BetMGM", "BETMGM": "BetMGM",
  "B365": "Bet365", "BET365": "Bet365",
  "FAN": "Fanatics", "FANATICS": "Fanatics",
  "CS": "Ceasars", "CAESARS": "Ceasars", "CEASARS": "Ceasars",
};

function matchBook(book: string, sportsbooks: { id: string; name: string }[]) {
  const upper = book.toUpperCase().replace(/\s/g, "");
  const alias = BOOK_ALIASES[upper];
  return alias
    ? sportsbooks.find(sb => sb.name === alias)
    : sportsbooks.find(sb => sb.name.toUpperCase().replace(/\s/g, "").includes(upper.slice(0, 4)));
}

// ── Correction parser ─────────────────────────────────────
// Understands: "book FD", "total 30", "odds +180", "boost 0", "sport NFL", "desc PatsCover"

interface Correction {
  field: "book" | "total_wager" | "base_odds" | "boost_pct" | "sport" | "description";
  value: string | number;
}

function parseCorrection(text: string): Correction | null {
  const t = text.trim();
  const lo = t.toLowerCase();

  // Book: "book DK", "book is FanDuel", or just a bare book token
  const bookKw = t.match(/^(?:book|change book|wrong book)[^\w]*(?:is\s+|to\s+)?(\w+)/i);
  if (bookKw) return { field: "book", value: bookKw[1].toUpperCase() };

  // Bare book alias (e.g. just "DK" or "FanDuel")
  const bareUpper = t.toUpperCase().replace(/\s/g, "");
  if (BOOK_ALIASES[bareUpper] || ["DRAFTKINGS","FANDUEL","BETMGM","BET365","FANATICS","THESCOREBET","CAESARS","CEASARS"].includes(bareUpper)) {
    return { field: "book", value: bareUpper };
  }

  // Total: "total 30", "total is 30" — requires keyword, bare numbers are Dan's cut
  const totalKw = t.match(/^(?:total|wager)[^\d]*(\d+(?:\.\d+)?)/i);
  if (totalKw) return { field: "total_wager", value: parseFloat(totalKw[1]) };

  // Odds: "odds +180", "odds -110", bare "+180" or "-110"
  const oddsKw = t.match(/^(?:odds?)[^\d+-]*([+-]\d+)/i);
  if (oddsKw) return { field: "base_odds", value: parseInt(oddsKw[1]) };
  const bareOdds = t.match(/^([+-]\d{2,4})$/);
  if (bareOdds) return { field: "base_odds", value: parseInt(bareOdds[1]) };

  // Boost: "boost 20", "boost is 20", "no boost", "boost 0"
  if (/no boost|boost\s*0|boost none/i.test(lo)) return { field: "boost_pct", value: 0 };
  const boostKw = t.match(/^boost[^\d]*(\d+(?:\.\d+)?)/i);
  if (boostKw) return { field: "boost_pct", value: parseFloat(boostKw[1]) };

  // Sport: "sport NBA", "sport is NFL"
  const sportKw = t.match(/^sport[^\w]*(?:is\s+)?(\w+)/i);
  if (sportKw) return { field: "sport", value: sportKw[1].toUpperCase() };

  // Description: "desc PatsCover", "description LakersML"
  const descKw = t.match(/^(?:desc(?:ription)?)[^\w]*(?:is\s+)?(\S+)/i);
  if (descKw) return { field: "description", value: descKw[1] };

  return null;
}

function summaryText(pd: ParsedSlip) {
  const odds    = pd.base_odds > 0 ? `+${pd.base_odds}` : String(pd.base_odds);
  const boostTx = pd.boost_pct > 0 ? ` (${pd.boost_pct}% boost)` : "";
  const splits  = pd.his_wager != null
    ? `\nDan $${pd.his_wager} / Brent $${pd.my_wager}`
    : "";
  return `${pd.book} · ${pd.sport} · ${pd.description}\n${odds}${boostTx} · $${pd.total_wager} total${splits}`;
}

// ── Day summary (today or yesterday) ─────────────────────

async function sendDaySummary(chatId: number, supabase: ReturnType<typeof createClient>, daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const dateStr = d.toLocaleDateString("en-CA"); // YYYY-MM-DD

  const { data: bets } = await supabase
    .from("bets")
    .select("total_wager, base_odds, boost_pct, status, sportsbooks(name)")
    .gte("placed_at", `${dateStr}T00:00:00`)
    .lte("placed_at", `${dateStr}T23:59:59`);

  const label = daysAgo === 0 ? "Today" : "Yesterday";
  const labelStr = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  if (!bets?.length) {
    await reply(chatId, `📊 ${label} — ${labelStr}\n\nNo bets recorded.`);
    return;
  }

  const byBook: Record<string, { count: number; total: number }> = {};
  (bets as any[]).forEach(b => {
    const name = b.sportsbooks?.name || "Unknown";
    if (!byBook[name]) byBook[name] = { count: 0, total: 0 };
    byBook[name].count++;
    byBook[name].total += parseFloat(b.total_wager);
  });

  const lines = Object.entries(byBook)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([name, d]) => {
      const label = name.replace("theScore Bet", "Score").padEnd(14);
      return `${label} ${d.count} bet${d.count !== 1 ? "s" : " "}  $${d.total.toFixed(0)}`;
    });

  const totalBets  = bets.length;
  const totalWager = (bets as any[]).reduce((s, b) => s + parseFloat(b.total_wager), 0);

  // P&L summary for settled bets (yesterday only — useful context)
  let pnlLine = "";
  if (daysAgo > 0) {
    let pnl = 0;
    let settled = 0;
    for (const b of bets as any[]) {
      if (b.status === "pending") continue;
      settled++;
      const odds = b.base_odds;
      const boost = parseFloat(b.boost_pct ?? 0);
      let effectiveOdds = odds;
      if (boost > 0) {
        if (odds >= 0) effectiveOdds = Math.round(odds * (1 + boost / 100));
        else {
          const p = (10000 / Math.abs(odds)) * (1 + boost / 100);
          effectiveOdds = p >= 100 ? Math.round(p) : -Math.round(10000 / p);
        }
      }
      const wager = parseFloat(b.total_wager);
      if (b.status === "won") {
        const profit = effectiveOdds > 0 ? wager * (effectiveOdds / 100) : wager * (100 / Math.abs(effectiveOdds));
        pnl += profit;
      } else if (b.status === "lost") {
        pnl -= wager;
      }
    }
    if (settled > 0) {
      const sign = pnl >= 0 ? "+" : "";
      pnlLine = `\nP&L: ${sign}$${pnl.toFixed(2)} (${settled} settled)`;
    }
  }

  await reply(chatId, `📊 ${label} — ${labelStr}\n\n${lines.join("\n")}\n\n─────────────\nTotal: ${totalBets} bets · $${totalWager.toFixed(0)} wagered${pnlLine}`);
}

// ── Default book (per chat) ───────────────────────────────

async function getDefaultBook(chatId: number, supabase: ReturnType<typeof createClient>): Promise<string | null> {
  const { data } = await supabase
    .from("settings")
    .select("value")
    .eq("key", `default_book_${chatId}`)
    .single();
  return data?.value ?? null;
}

async function setDefaultBook(chatId: number, bookAlias: string, supabase: ReturnType<typeof createClient>) {
  await supabase.from("settings").upsert({ key: `default_book_${chatId}`, value: bookAlias });
}

// ── Save bet helper ───────────────────────────────────────

async function saveBet(chatId: number, pending: any, supabase: ReturnType<typeof createClient>) {
  const pd = pending.parsed_data as ParsedSlip;
  const { data: sportsbooks } = await supabase.from("sportsbooks").select("id, name");
  const matched = matchBook(pd.book, sportsbooks ?? []);

  if (!matched) {
    await reply(chatId, `❌ Couldn't match sportsbook "${pd.book}". Use /skip and enter manually.`);
    return;
  }

  await supabase.from("bets").insert({
    sportsbook_id: matched.id,
    sport:         pd.sport.toUpperCase(),
    description:   pd.description,
    boost_pct:     pd.boost_pct ?? 0,
    total_wager:   pd.total_wager,
    his_wager:     pd.his_wager,
    my_wager:      pd.my_wager,
    base_odds:     pd.base_odds,
    status:        "pending",
    placed_at:     pending.placed_at,
  });

  await supabase.from("pending_bets").update({ status: "confirmed" }).eq("id", pending.id);

  const { data: sb } = await supabase.from("sportsbooks").select("current_balance").eq("id", matched.id).single();
  if (sb) {
    await supabase.from("sportsbooks").update({ current_balance: parseFloat(sb.current_balance) - pd.total_wager }).eq("id", matched.id);
  }

  // Remember this book for future slips that don't show the sportsbook name
  await setDefaultBook(chatId, pd.book, supabase);

  const odds = pd.base_odds > 0 ? `+${pd.base_odds}` : String(pd.base_odds);
  await reply(chatId, `✅ Saved!\n${matched.name} · ${pd.sport} · ${pd.description}\n${odds} · $${pd.total_wager} total`);
}

// ── Queue helper ──────────────────────────────────────────

async function promoteNextQueued(
  chatId: number,
  supabase: ReturnType<typeof createClient>,
): Promise<boolean> {
  const { data: next } = await supabase
    .from("pending_bets")
    .select()
    .eq("chat_id", String(chatId))
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)
    .single();

  if (!next) return false;

  await supabase.from("pending_bets").update({ status: "pending" }).eq("id", next.id);

  const { count } = await supabase
    .from("pending_bets")
    .select("*", { count: "exact", head: true })
    .eq("chat_id", String(chatId))
    .eq("status", "queued");

  const pd      = next.parsed_data as ParsedSlip;
  const odds    = pd.base_odds > 0 ? `+${pd.base_odds}` : String(pd.base_odds);
  const boostTx = pd.boost_pct > 0 ? ` (${pd.boost_pct}% boost)` : "";
  const moreTx  = (count ?? 0) > 0 ? ` · ${count} still queued` : "";

  await replyWithButtons(
    chatId,
    `⏭️ Next up${moreTx}:\n📋 ${pd.book} · ${pd.sport}\n${pd.description} ${odds}${boostTx}\n$${pd.total_wager} total\n\nWhat's Dan's cut? (or tap to edit a field)`,
    EDIT_BUTTONS,
  );
  return true;
}

// ── Field edit prompts ────────────────────────────────────

const FIELD_PROMPTS: Record<string, string> = {
  book:        "Enter sportsbook (e.g. DK, FD, MGM, SCORE, B365, CS, FAN):",
  sport:       "Enter sport (e.g. NBA, NFL, MLB, NHL):",
  odds:        "Enter American odds (e.g. +180 or -110):",
  total:       "Enter total wager amount (e.g. 50):",
  boost:       "Enter boost % (0 for none, e.g. 20):",
  description: "Enter description (e.g. LakersML):",
};

// ── Main handler ──────────────────────────────────────────

serve(async (req) => {
  const update = await req.json();

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // ── Inline button taps ──────────────────────────────────
  if (update.callback_query) {
    const cq     = update.callback_query;
    const chatId = cq.message.chat.id as number;
    const data   = cq.data as string;

    await answerCallback(cq.id);

    const { data: pending } = await supabase
      .from("pending_bets")
      .select()
      .eq("chat_id", String(chatId))
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!pending) return new Response("ok");

    // Save
    if (data === "save") {
      const pd = pending.parsed_data as ParsedSlip;
      if (pd.his_wager == null) {
        await reply(chatId, "Still need Dan's cut. Reply with the dollar amount.");
      } else {
        await saveBet(chatId, pending, supabase);
        await promoteNextQueued(chatId, supabase);
      }
      return new Response("ok");
    }

    // Skip
    if (data === "skip") {
      await supabase.from("pending_bets").update({ status: "skipped" }).eq("id", pending.id);
      const hadNext = await promoteNextQueued(chatId, supabase);
      if (!hadNext) await reply(chatId, "🗑️ Dismissed.");
      return new Response("ok");
    }

    // Edit field button
    if (data.startsWith("edit_")) {
      const shortKey = data.replace("edit_", "");
      const fieldKey = shortKey === "desc" ? "description" : shortKey;
      const pd = { ...pending.parsed_data as ParsedSlip, _editing_field: fieldKey };
      await supabase.from("pending_bets")
        .update({ stage: "awaiting_field_edit", parsed_data: pd })
        .eq("id", pending.id);
      await reply(chatId, FIELD_PROMPTS[fieldKey] || "Enter new value:");
      return new Response("ok");
    }

    return new Response("ok");
  }

  // ── Regular messages ────────────────────────────────────
  const message = update.message;
  if (!message) return new Response("ok");

  const chatId  = message.chat.id as number;
  const text    = (message.text || "").trim();
  const msgDate = new Date((message.date as number) * 1000).toISOString();

  // ── /today ──────────────────────────────────────────────
  if (text === "/today" || text.startsWith("/today@")) {
    await sendDaySummary(chatId, supabase, 0);
    return new Response("ok");
  }

  // ── /yesterday ──────────────────────────────────────────
  if (text === "/yesterday" || text.startsWith("/yesterday@")) {
    await sendDaySummary(chatId, supabase, 1);
    return new Response("ok");
  }

  // ── /skip ───────────────────────────────────────────────
  if (text === "/skip" || text.startsWith("/skip@")) {
    await supabase
      .from("pending_bets")
      .update({ status: "skipped" })
      .eq("chat_id", String(chatId))
      .eq("status", "pending");
    const hadNext = await promoteNextQueued(chatId, supabase);
    if (!hadNext) await reply(chatId, "🗑️ Dismissed.");
    return new Response("ok");
  }

  // ── Photo ───────────────────────────────────────────────
  if (message.photo) {
    const photo   = (message.photo as { file_id: string }[]).at(-1)!;
    const fileRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${photo.file_id}`);
    const { result } = await fileRes.json() as { result: { file_path: string } };
    const imgRes  = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${result.file_path}`);
    const buffer  = await imgRes.arrayBuffer();
    const base64  = bufferToBase64(buffer);

    let parsed: ParsedSlip | null = null;
    try {
      parsed = await parseImageWithClaude(base64);
    } catch (e) {
      await reply(chatId, `❌ Parse error: ${(e as Error).message}`);
      return new Response("ok");
    }

    if (!parsed) {
      await reply(chatId, "❌ Couldn't read this image. Send the bet code manually:\nDK.NBA.LakersML.0.50.25.25+180");
      return new Response("ok");
    }

    // Fetch sportsbooks once; apply default book fallback if parse didn't recognize the book
    const { data: sportsbooks } = await supabase.from("sportsbooks").select("id, name");
    if (!matchBook(parsed.book, sportsbooks ?? [])) {
      const defaultBook = await getDefaultBook(chatId, supabase);
      if (defaultBook) parsed.book = defaultBook;
    }

    // Check if there's already an active bet in progress
    const { data: activePending } = await supabase
      .from("pending_bets")
      .select("id")
      .eq("chat_id", String(chatId))
      .eq("status", "pending")
      .limit(1)
      .single();

    if (activePending) {
      const { count } = await supabase
        .from("pending_bets")
        .select("*", { count: "exact", head: true })
        .eq("chat_id", String(chatId))
        .eq("status", "queued");

      await supabase.from("pending_bets").insert({
        chat_id:             String(chatId),
        status:              "queued",
        stage:               "awaiting_splits",
        parsed_data:         parsed,
        telegram_message_id: message.message_id,
        placed_at:           msgDate,
      });

      const queueLen = (count ?? 0) + 1;
      await reply(chatId, `📥 Queued (${queueLen} waiting) — ${parsed.book} · ${parsed.sport} · ${parsed.description}`);
      return new Response("ok");
    }

    // No active bet — start conversation immediately
    await supabase.from("pending_bets").insert({
      chat_id:             String(chatId),
      stage:               "awaiting_splits",
      parsed_data:         parsed,
      telegram_message_id: message.message_id,
      placed_at:           msgDate,
    });

    const odds    = parsed.base_odds > 0 ? `+${parsed.base_odds}` : String(parsed.base_odds);
    const boostTx = parsed.boost_pct > 0 ? ` (${parsed.boost_pct}% boost)` : "";

    await replyWithButtons(
      chatId,
      `📋 ${parsed.book} · ${parsed.sport}\n${parsed.description} ${odds}${boostTx}\n$${parsed.total_wager} total\n\nWhat's Dan's cut? (or tap to correct a field)`,
      EDIT_BUTTONS,
    );
    return new Response("ok");
  }

  // ── Text responses ──────────────────────────────────────
  if (!text || text.startsWith("/")) return new Response("ok");

  const { data: pending } = await supabase
    .from("pending_bets")
    .select()
    .eq("chat_id", String(chatId))
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!pending) {
    await reply(chatId, "Send a bet slip photo to get started.\n\n/today — today's bets by book\n/yesterday — yesterday's bets\n/skip — dismiss pending bet");
    return new Response("ok");
  }

  // ── Stage: awaiting_field_edit ──────────────────────────
  if (pending.stage === "awaiting_field_edit") {
    const pd = { ...pending.parsed_data as ParsedSlip };
    const field = pd._editing_field ?? "";
    delete pd._editing_field;

    let newValue: string | number = text;
    if (field === "odds") {
      const v = parseInt(text.replace(/[^+\-\d]/g, ""));
      if (isNaN(v)) {
        await reply(chatId, "Enter valid odds like +180 or -110:");
        return new Response("ok");
      }
      newValue = v;
    } else if (field === "total") {
      const v = parseFloat(text.replace(/[^0-9.]/g, ""));
      if (isNaN(v) || v <= 0) {
        await reply(chatId, "Enter a valid dollar amount:");
        return new Response("ok");
      }
      newValue = v;
    } else if (field === "boost") {
      const v = parseFloat(text.replace(/[^0-9.]/g, "")) || 0;
      newValue = v;
    } else if (field === "book") {
      newValue = text.toUpperCase().replace(/\s/g, "");
    } else if (field === "sport") {
      newValue = text.toUpperCase().replace(/\s/g, "");
    }

    const KEY_MAP: Record<string, string> = {
      odds: "base_odds", total: "total_wager", boost: "boost_pct",
    };
    const key = KEY_MAP[field] ?? field;
    const updated = { ...pd, [key]: newValue };

    if (key === "total_wager") {
      delete updated.his_wager;
      delete updated.my_wager;
      await supabase.from("pending_bets")
        .update({ stage: "awaiting_splits", parsed_data: updated })
        .eq("id", pending.id);
      await replyWithButtons(
        chatId,
        `Total updated to $${newValue}.\n\n${summaryText(updated)}\n\nWhat's Dan's cut?`,
        EDIT_BUTTONS,
      );
      return new Response("ok");
    }

    if (updated.his_wager != null) {
      await supabase.from("pending_bets")
        .update({ stage: "awaiting_confirm", parsed_data: updated })
        .eq("id", pending.id);
      await replyWithButtons(
        chatId,
        `Updated!\n${summaryText(updated)}\n\nLooks good?`,
        CONFIRM_BUTTONS,
      );
    } else {
      await supabase.from("pending_bets")
        .update({ stage: "awaiting_splits", parsed_data: updated })
        .eq("id", pending.id);
      await replyWithButtons(
        chatId,
        `Updated!\n${summaryText(updated)}\n\nWhat's Dan's cut?`,
        EDIT_BUTTONS,
      );
    }
    return new Response("ok");
  }

  // ── Stage: awaiting_splits ──────────────────────────────
  if (pending.stage === "awaiting_splits") {
    const pd = pending.parsed_data as ParsedSlip;

    const correction = parseCorrection(text);
    if (correction && correction.field !== "total_wager") {
      const updated = { ...pd, [correction.field]: correction.value };
      await supabase.from("pending_bets").update({ parsed_data: updated }).eq("id", pending.id);
      await replyWithButtons(chatId, `Updated!\n${summaryText(updated)}\n\nWhat's Dan's cut?`, EDIT_BUTTONS);
      return new Response("ok");
    }

    if (correction?.field === "total_wager") {
      const updated = { ...pd, total_wager: correction.value as number };
      await supabase.from("pending_bets").update({ parsed_data: updated }).eq("id", pending.id);
      await replyWithButtons(chatId, `Total updated to $${correction.value}.\n\nWhat's Dan's cut?`, EDIT_BUTTONS);
      return new Response("ok");
    }

    const danAmt = parseFloat(text.replace(/[^0-9.]/g, ""));
    if (isNaN(danAmt) || danAmt < 0) {
      await replyWithButtons(
        chatId,
        "Reply with Dan's cut in dollars (e.g. 25), or tap a button to edit a field:",
        EDIT_BUTTONS,
      );
      return new Response("ok");
    }

    const brentAmt = Math.round((pd.total_wager - danAmt) * 100) / 100;
    if (brentAmt < 0) {
      await reply(chatId, `Dan's cut can't exceed the total ($${pd.total_wager}). Try again.`);
      return new Response("ok");
    }

    const updated = { ...pd, his_wager: danAmt, my_wager: brentAmt };
    await supabase
      .from("pending_bets")
      .update({ stage: "awaiting_confirm", parsed_data: updated })
      .eq("id", pending.id);

    await replyWithButtons(
      chatId,
      `Ready to save:\n${summaryText(updated)}`,
      CONFIRM_BUTTONS,
    );
    return new Response("ok");
  }

  // ── Stage: awaiting_confirm ─────────────────────────────
  if (pending.stage === "awaiting_confirm") {
    const isYes = ["yes", "y", "confirm", "ok", "yep", "yeah"].includes(text.toLowerCase());

    if (!isYes) {
      const correction = parseCorrection(text);
      if (correction) {
        const pd = pending.parsed_data as ParsedSlip;

        if (correction.field === "total_wager") {
          const updated = { ...pd, total_wager: correction.value as number, his_wager: undefined, my_wager: undefined };
          await supabase.from("pending_bets").update({ stage: "awaiting_splits", parsed_data: updated }).eq("id", pending.id);
          await replyWithButtons(chatId, `Total updated to $${correction.value}. What's Dan's cut?`, EDIT_BUTTONS);
          return new Response("ok");
        }

        const updated = { ...pd, [correction.field]: correction.value };
        await supabase.from("pending_bets").update({ parsed_data: updated }).eq("id", pending.id);
        await replyWithButtons(chatId, `Updated!\n${summaryText(updated)}`, CONFIRM_BUTTONS);
        return new Response("ok");
      }

      await replyWithButtons(
        chatId,
        `Tap ✅ Save to confirm, ❌ Skip to dismiss, or a field to edit:`,
        CONFIRM_BUTTONS,
      );
      return new Response("ok");
    }

    await saveBet(chatId, pending, supabase);
    await promoteNextQueued(chatId, supabase);
    return new Response("ok");
  }

  return new Response("ok");
});
