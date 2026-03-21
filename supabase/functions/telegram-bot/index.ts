import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TELEGRAM_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const ANTHROPIC_KEY  = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ── Telegram helper ───────────────────────────────────────

async function reply(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

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
  "book": "sportsbook abbreviation — DK (DraftKings), FD (FanDuel), MGM (BetMGM), SCORE (theScore Bet), B365 (Bet365)",
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
    // Strip markdown code fences if present
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
  if (BOOK_ALIASES[bareUpper] || ["DRAFTKINGS","FANDUEL","BETMGM","BET365","FANATICS","THESCOREBET"].includes(bareUpper)) {
    return { field: "book", value: bareUpper };
  }

  // Total: "total 30", "total is 30", "$30"
  const totalKw = t.match(/^(?:total|wager)[^\d]*(\d+(?:\.\d+)?)/i);
  if (totalKw) return { field: "total_wager", value: parseFloat(totalKw[1]) };
  const bareAmt = t.match(/^\$?(\d+(?:\.\d+)?)$/);
  if (bareAmt) return { field: "total_wager", value: parseFloat(bareAmt[1]) };

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

function summaryText(pd: ParsedSlip & { his_wager?: number; my_wager?: number }) {
  const odds    = pd.base_odds > 0 ? `+${pd.base_odds}` : String(pd.base_odds);
  const boostTx = pd.boost_pct > 0 ? ` (${pd.boost_pct}% boost)` : "";
  const splits  = pd.his_wager != null
    ? `\nDan $${pd.his_wager} / Brent $${pd.my_wager}`
    : "";
  return `${pd.book} · ${pd.sport} · ${pd.description}\n${odds}${boostTx} · $${pd.total_wager} total${splits}`;
}

// ── /today summary ────────────────────────────────────────

async function sendTodaySummary(chatId: number, supabase: ReturnType<typeof createClient>) {
  const today = new Date().toLocaleDateString("en-CA");
  const { data: bets } = await supabase
    .from("bets")
    .select("total_wager, sportsbooks(name)")
    .gte("placed_at", `${today}T00:00:00`)
    .lte("placed_at", `${today}T23:59:59`);

  if (!bets?.length) {
    await reply(chatId, "📊 No bets entered today yet.");
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
  const dateStr    = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  await reply(chatId, `📊 Today — ${dateStr}\n\n${lines.join("\n")}\n\n─────────────\nTotal: ${totalBets} bets · $${totalWager.toFixed(0)} wagered`);
}

// ── Main handler ──────────────────────────────────────────

serve(async (req) => {
  const update  = await req.json();
  const message = update.message;
  if (!message) return new Response("ok");

  const chatId  = message.chat.id as number;
  const text    = (message.text || "").trim();
  const msgDate = new Date((message.date as number) * 1000).toISOString();

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // ── /today ──────────────────────────────────────────────
  if (text === "/today" || text.startsWith("/today@")) {
    await sendTodaySummary(chatId, supabase);
    return new Response("ok");
  }

  // ── /skip ───────────────────────────────────────────────
  if (text === "/skip" || text.startsWith("/skip@")) {
    await supabase
      .from("pending_bets")
      .update({ status: "skipped" })
      .eq("chat_id", String(chatId))
      .eq("status", "pending");
    await reply(chatId, "🗑️ Dismissed.");
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

    // Dismiss any previous pending for this chat
    await supabase
      .from("pending_bets")
      .update({ status: "replaced" })
      .eq("chat_id", String(chatId))
      .eq("status", "pending");

    await supabase.from("pending_bets").insert({
      chat_id:             String(chatId),
      stage:               "awaiting_splits",
      parsed_data:         parsed,
      telegram_message_id: message.message_id,
      placed_at:           msgDate,
    });

    const odds    = parsed.base_odds > 0 ? `+${parsed.base_odds}` : String(parsed.base_odds);
    const boostTx = parsed.boost_pct > 0 ? ` (${parsed.boost_pct}% boost)` : "";

    await reply(
      chatId,
      `📋 ${parsed.book} · ${parsed.sport}\n${parsed.description} ${odds}${boostTx}\n$${parsed.total_wager} total\n\nWhat's Dan's cut? (Brent gets the rest)\nReply with a number, e.g. 25`,
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
    await reply(chatId, "Send a bet slip photo to get started.\n\n/today — today's bets by book\n/skip — dismiss pending bet");
    return new Response("ok");
  }

  // ── Stage: awaiting_splits ──────────────────────────────
  if (pending.stage === "awaiting_splits") {
    const pd = pending.parsed_data as ParsedSlip;

    // Allow corrections at this stage too
    const correction = parseCorrection(text);
    if (correction && correction.field !== "total_wager") {
      const updated = { ...pd, [correction.field]: correction.value };
      await supabase.from("pending_bets").update({ parsed_data: updated }).eq("id", pending.id);
      const odds = updated.base_odds > 0 ? `+${updated.base_odds}` : String(updated.base_odds);
      const boostTx = updated.boost_pct > 0 ? ` (${updated.boost_pct}% boost)` : "";
      await reply(chatId, `Updated! ${summaryText(updated)}\n\nWhat's Dan's cut?`);
      return new Response("ok");
    }

    // Total correction resets everything
    if (correction?.field === "total_wager") {
      const updated = { ...pd, total_wager: correction.value as number };
      await supabase.from("pending_bets").update({ parsed_data: updated }).eq("id", pending.id);
      await reply(chatId, `Total updated to $${correction.value}.\n\nWhat's Dan's cut?`);
      return new Response("ok");
    }

    const danAmt = parseFloat(text.replace(/[^0-9.]/g, ""));
    if (isNaN(danAmt) || danAmt < 0) {
      await reply(chatId, "Reply with Dan's cut in dollars, e.g. 25\nOr correct a field: book DK · total 30 · odds +180 · boost 0 · sport NFL · desc PatsCover");
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

    await reply(chatId, `Ready to save:\n${summaryText(updated)}\n\nReply "yes" to save or /skip to dismiss.`);
    return new Response("ok");
  }

  // ── Stage: awaiting_confirm ─────────────────────────────
  if (pending.stage === "awaiting_confirm") {
    const isYes = ["yes", "y", "confirm", "ok", "yep", "yeah"].includes(text.toLowerCase());

    // Handle corrections
    if (!isYes) {
      const correction = parseCorrection(text);
      if (correction) {
        const pd = pending.parsed_data as ParsedSlip & { his_wager: number; my_wager: number };

        // Total change → reset splits, go back to awaiting_splits
        if (correction.field === "total_wager") {
          const updated = { ...pd, total_wager: correction.value as number, his_wager: undefined, my_wager: undefined };
          await supabase.from("pending_bets").update({ stage: "awaiting_splits", parsed_data: updated }).eq("id", pending.id);
          await reply(chatId, `Total updated to $${correction.value}. What's Dan's cut?`);
          return new Response("ok");
        }

        const updated = { ...pd, [correction.field]: correction.value };
        await supabase.from("pending_bets").update({ parsed_data: updated }).eq("id", pending.id);
        await reply(chatId, `Updated!\n${summaryText(updated)}\n\nReply "yes" to save or /skip to dismiss.`);
        return new Response("ok");
      }

      await reply(chatId, `Reply "yes" to save, or correct a field:\nbook DK · total 30 · odds +180 · boost 0 · sport NFL · desc PatsCover\n\n/skip to dismiss`);
      return new Response("ok");
    }

    const pd = pending.parsed_data as ParsedSlip & { his_wager: number; my_wager: number };
    const { data: sportsbooks } = await supabase.from("sportsbooks").select("id, name");
    const matched = matchBook(pd.book, sportsbooks ?? []);

    if (!matched) {
      await reply(chatId, `❌ Couldn't match sportsbook "${pd.book}". Use /skip and enter manually.`);
      return new Response("ok");
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

    await supabase
      .from("pending_bets")
      .update({ status: "confirmed" })
      .eq("id", pending.id);

    const odds = pd.base_odds > 0 ? `+${pd.base_odds}` : String(pd.base_odds);
    await reply(
      chatId,
      `✅ Saved!\n${matched.name} · ${pd.sport} · ${pd.description}\n${odds} · $${pd.total_wager} total`,
    );
    return new Response("ok");
  }

  return new Response("ok");
});
