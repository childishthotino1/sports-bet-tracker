import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TELEGRAM_TOKEN  = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const ANTHROPIC_KEY   = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL    = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ── Telegram helper ───────────────────────────────────────

async function tg(method: string, body: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function reply(chatId: number, text: string, extra: Record<string, unknown> = {}) {
  return tg("sendMessage", { chat_id: chatId, text, ...extra });
}

// ── Claude image parsing ──────────────────────────────────

async function parseImageWithClaude(base64: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-4-6",
      max_tokens: 256,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: base64 },
          },
          {
            type: "text",
            text: `Parse this sportsbook bet slip screenshot into a single bet code line.

Format: BOOK.SPORT.DESC.BOOST.TOTAL.??.??±ODDS

Rules:
- BOOK: use SCORE (theScore), DK (DraftKings), FD (FanDuel), MGM (BetMGM), B365 (Bet365), or best guess
- SPORT: NBA, NFL, NHL, MLB, NCAAF, NCAAB, SOCCER, TENNIS, MMA, etc.
- DESC: short label, no spaces or dots (e.g. LakersML, PatsCover, 3legSGP)
- BOOST: boost % number only, 0 if not shown
- TOTAL: total wager in dollars, number only
- ?? for both wager splits (those are internal, not on the slip)
- ODDS: American format attached to second ??, e.g. ??+180 or ??-114

Reply with ONLY the single bet code line. Nothing else.
Example: SCORE.NBA.LakersML.0.50.??.??+180`,
          },
        ],
      }],
    }),
  });
  const data = await res.json();
  return data.content?.[0]?.text?.trim() ?? "";
}

// ── Bet code parser ───────────────────────────────────────

const BOOK_ALIASES: Record<string, string> = {
  "ESPN": "theScore Bet", "THESCORE": "theScore Bet", "SCORE": "theScore Bet",
  "FD": "FanDuel", "DK": "DraftKings", "MGM": "BetMGM", "B365": "Bet365",
};

function parseBetCode(raw: string, sportsbooks: { id: string; name: string }[]) {
  const parts = raw.trim().split(".");
  let book: string, sport: string, desc: string,
      boostStr: string, totalStr: string, danStr: string, brentStr: string, oddsStr: string;

  if (parts.length === 8) {
    [book, sport, desc, boostStr, totalStr, danStr, brentStr, oddsStr] = parts;
  } else if (parts.length === 7) {
    [book, sport, desc, boostStr, totalStr, danStr] = parts;
    const m = parts[6].match(/^([\d.]+)([+-]\d+)$/);
    if (!m) return { error: "Last segment must be BrentWager±Odds (e.g. 25+180)" };
    brentStr = m[1]; oddsStr = m[2];
  } else {
    return { error: `Need 7 or 8 segments, got ${parts.length}` };
  }

  if (danStr === "??" || brentStr === "??") {
    return { error: "Fill in the ?? splits — e.g. reply with: " + raw.replace("??.??", "25.25").replace("??", "25") };
  }

  const boost_pct   = parseFloat(boostStr) || 0;
  const total_wager = parseFloat(totalStr);
  const his_wager   = parseFloat(danStr);
  const my_wager    = parseFloat(brentStr);
  const base_odds   = parseInt(oddsStr);

  if (isNaN(total_wager) || total_wager <= 0) return { error: "Invalid total wager" };
  if (isNaN(his_wager) || isNaN(my_wager))    return { error: "Invalid wager splits" };
  if (Math.abs(his_wager + my_wager - total_wager) > 0.02) {
    return { error: `Splits don't add up: Dan $${his_wager} + Brent $${my_wager} ≠ $${total_wager}` };
  }

  const bookUpper = book.toUpperCase().replace(/\s/g, "");
  const aliasName = BOOK_ALIASES[bookUpper];
  const matched = aliasName
    ? sportsbooks.find(sb => sb.name === aliasName)
    : sportsbooks.find(sb => sb.name.toUpperCase().replace(/\s/g, "").includes(bookUpper.slice(0, 4)));

  if (!matched) return { error: `Book "${book}" not recognized` };

  return {
    sportsbook_id:   matched.id,
    sportsbook_name: matched.name,
    sport:           sport.toUpperCase(),
    description:     desc,
    boost_pct,
    total_wager,
    his_wager,
    my_wager,
    base_odds,
  };
}

// ── Formatting helpers ────────────────────────────────────

function fmtOdds(n: number) { return n > 0 ? `+${n}` : String(n); }

function todaySummaryText(bets: { total_wager: string; sportsbooks?: { name: string } }[]) {
  const byBook: Record<string, { count: number; total: number }> = {};
  bets.forEach(b => {
    const name = b.sportsbooks?.name || "Unknown";
    if (!byBook[name]) byBook[name] = { count: 0, total: 0 };
    byBook[name].count++;
    byBook[name].total += parseFloat(b.total_wager);
  });
  const lines = Object.entries(byBook)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([name, d]) => {
      const label = name.replace("theScore Bet", "Score").padEnd(14);
      return `${label} ${String(d.count).padStart(2)} bet${d.count !== 1 ? "s" : " "}  $${d.total.toFixed(0)}`;
    });
  const totalBets  = bets.length;
  const totalWager = bets.reduce((s, b) => s + parseFloat(b.total_wager), 0);
  const dateStr    = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return `📊 Today — ${dateStr}\n\n${lines.join("\n")}\n\n─────────────\nTotal: ${totalBets} bets · $${totalWager.toFixed(0)} wagered`;
}

// ── Main handler ──────────────────────────────────────────

serve(async (req) => {
  const update = await req.json();
  const message = update.message;
  if (!message) return new Response("ok");

  const chatId  = message.chat.id as number;
  const text    = (message.text || "").trim();
  const msgDate = new Date((message.date as number) * 1000).toISOString();

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // ── /today ──────────────────────────────────────────────
  if (text === "/today" || text.startsWith("/today@")) {
    const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD
    const { data: bets } = await supabase
      .from("bets")
      .select("total_wager, sportsbooks(name)")
      .gte("placed_at", `${today}T00:00:00`)
      .lte("placed_at", `${today}T23:59:59`);

    if (!bets?.length) {
      await reply(chatId, "📊 No bets entered today yet.");
      return new Response("ok");
    }
    await reply(chatId, todaySummaryText(bets as any));
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
    const base64  = btoa(String.fromCharCode(...new Uint8Array(buffer)));

    let code = "";
    try {
      code = await parseImageWithClaude(base64);
    } catch {
      await reply(chatId, "❌ Couldn't parse the image. Send the bet code manually.");
      return new Response("ok");
    }

    if (!code) {
      await reply(chatId, "❌ No bet found in image. Send the bet code manually.");
      return new Response("ok");
    }

    // Replace any existing pending for this chat
    await supabase
      .from("pending_bets")
      .update({ status: "replaced" })
      .eq("chat_id", String(chatId))
      .eq("status", "pending");

    await supabase.from("pending_bets").insert({
      chat_id:             String(chatId),
      bet_code:            code,
      telegram_message_id: message.message_id,
      placed_at:           msgDate,
    });

    const hasUnknown = code.includes("??");
    const msg = hasUnknown
      ? `Parsed:\n${code}\n\n⚠️ Fill in the ?? splits, then reply with the complete code to save.\nExample: ${code.replace("??.??", "25.25").replace("??", "25")}`
      : `Parsed:\n${code}\n\nReply "yes" to save, or send a corrected code.`;

    await reply(chatId, msg);
    return new Response("ok");
  }

  // ── Text: confirmation or correction ───────────────────
  if (text && !text.startsWith("/")) {
    const { data: pending } = await supabase
      .from("pending_bets")
      .select()
      .eq("chat_id", String(chatId))
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!pending) {
      await reply(chatId, "Send a bet slip photo or a bet code to get started.\n\n/today — today's bets by book");
      return new Response("ok");
    }

    const isConfirm = ["yes", "y", "confirm", "ok", "yep"].includes(text.toLowerCase());
    const codeToUse = isConfirm ? pending.bet_code : text;

    // Block confirm if code still has unknowns
    if (isConfirm && pending.bet_code.includes("??")) {
      await reply(chatId, "⚠️ Code still has ??. Reply with the complete code including the wager splits.");
      return new Response("ok");
    }

    const { data: sportsbooks } = await supabase.from("sportsbooks").select("id, name");
    const parsed = parseBetCode(codeToUse, sportsbooks ?? []);

    if ("error" in parsed) {
      // If it's a new code attempt, update the pending record
      if (!isConfirm) {
        await reply(chatId, `❌ ${parsed.error}\n\nCorrect and try again, or /skip to dismiss.`);
      } else {
        await reply(chatId, `❌ ${parsed.error}`);
      }
      return new Response("ok");
    }

    // Insert bet
    await supabase.from("bets").insert({
      sportsbook_id: parsed.sportsbook_id,
      sport:         parsed.sport,
      description:   parsed.description,
      boost_pct:     parsed.boost_pct,
      total_wager:   parsed.total_wager,
      his_wager:     parsed.his_wager,
      my_wager:      parsed.my_wager,
      base_odds:     parsed.base_odds,
      status:        "pending",
      placed_at:     pending.placed_at,
    });

    await supabase
      .from("pending_bets")
      .update({ status: "confirmed", bet_code: codeToUse })
      .eq("id", pending.id);

    await reply(
      chatId,
      `✅ Saved!\n${parsed.sportsbook_name} · ${parsed.sport} · ${parsed.description}\n${fmtOdds(parsed.base_odds)} · $${parsed.total_wager} total (Dan $${parsed.his_wager} / Brent $${parsed.my_wager})`,
    );
  }

  return new Response("ok");
});
