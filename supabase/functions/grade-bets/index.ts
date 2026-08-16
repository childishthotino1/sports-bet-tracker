// Auto-checks open bets against public results using Claude + web search.
// Recommend-and-confirm: nothing settles without a human tap, except the
// narrow case of a single-leg bet the model is highly confident about —
// see isAutoSettleEligible below. Runs on a schedule (pg_cron -> pg_net,
// authenticated with the project anon key) or manually via a POST with a
// valid Authorization header (this function has verify_jwt: true).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TELEGRAM_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const ANTHROPIC_KEY  = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// A bet's game is almost certainly over by this many hours after it was
// placed. Imperfect (early-morning games, postponements) — false negatives
// just mean it's picked up on a later run.
const MIN_HOURS_SINCE_PLACED = 5;

// Only auto-settle without a human tap when ALL of these hold: verdict is
// won/lost/push (never void — too ambiguous), confidence is "high", and the
// bet has no recorded legs (i.e. a straight bet, not a parlay/SGP where a
// wrong leg read would silently misgrade the whole thing).
function isAutoSettleEligible(bet: any, verdict: string, confidence: string): boolean {
  const hasLegs = Array.isArray(bet.legs) && bet.legs.length > 0;
  return !hasLegs && confidence === "high" && ["won", "lost", "push"].includes(verdict);
}

// ── Settle math (mirrors js/math.js — keep in sync) ────────

function boostedOdds(baseOdds: number, boostPct: number): number {
  if (!boostPct) return baseOdds;
  if (baseOdds >= 0) return Math.floor(baseOdds * (1 + boostPct / 100));
  const profitPer100 = (10000 / Math.abs(baseOdds)) * (1 + boostPct / 100);
  if (profitPer100 >= 100) return Math.floor(profitPer100);
  return -Math.floor(10000 / profitPer100);
}

function totalReturn(wager: number, odds: number): number {
  if (!odds) return wager;
  const rawProfit = odds > 0 ? wager * (odds / 100) : wager * (100 / Math.abs(odds));
  return wager + Math.floor(rawProfit * 100) / 100;
}

function betSettleDelta(bet: any, result: string): number {
  if (result === "lost") return 0;
  if (result === "won") {
    const boosted = boostedOdds(parseInt(bet.base_odds), parseFloat(bet.boost_pct) || 0);
    return totalReturn(parseFloat(bet.total_wager), boosted);
  }
  return parseFloat(bet.total_wager); // push
}

// ── Telegram ────────────────────────────────────────────────

type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

async function reply(chatId: string, text: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function replyWithButtons(chatId: string, text: string, keyboard: InlineKeyboard) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, reply_markup: { inline_keyboard: keyboard } }),
  });
}

async function findNotifyChatId(supabase: ReturnType<typeof createClient>): Promise<string | null> {
  const { data } = await supabase.from("settings").select("key").like("key", "default_book_%").limit(1);
  const key = data?.[0]?.key as string | undefined;
  return key ? key.replace("default_book_", "") : null;
}

// ── Claude verdict ──────────────────────────────────────────

interface Verdict {
  verdict: "won" | "lost" | "push" | "void" | "unknown";
  confidence: "high" | "medium" | "low";
  explanation: string;
}

async function gradeBet(bet: any): Promise<Verdict | null> {
  const legsText = Array.isArray(bet.legs) && bet.legs.length > 0
    ? "\nLegs:\n" + bet.legs.map((l: any) => `  - ${l.team_or_player}: ${l.market} (${l.selection})`).join("\n")
    : "";
  const dateStr = new Date(bet.placed_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  const prompt = `Research whether this sports bet won or lost using web search for the actual game/event result. Today is ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}.

Sportsbook: ${bet.sportsbooks?.name ?? "unknown"}
Sport: ${bet.sport}
Description: ${bet.description}
Odds: ${bet.base_odds > 0 ? "+" : ""}${bet.base_odds}
Placed: ${dateStr}${legsText}

Search for the final score / result of the relevant game(s) on or near that date. If this is a multi-leg bet, every leg must have won for the bet to be a win — if any leg lost, the whole bet lost (unless a leg was specifically postponed/cancelled, which usually voids just that leg — use judgment and reflect it in confidence).

If you cannot find a confident result (game not found, ambiguous description, postponed/cancelled), use verdict "unknown" and explain why in one sentence.

Respond with ONLY a JSON object, no other text:
{"verdict": "won" | "lost" | "push" | "void" | "unknown", "confidence": "high" | "medium" | "low", "explanation": "one sentence citing the specific result you found"}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    console.error("Claude request failed:", res.status, await res.text());
    return null;
  }

  const data = await res.json();
  if (data.stop_reason === "refusal") return null;

  const textBlocks = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text);
  const text = textBlocks.join("\n").trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]);
    if (!["won", "lost", "push", "void", "unknown"].includes(parsed.verdict)) return null;
    return parsed as Verdict;
  } catch {
    return null;
  }
}

// ── Main ────────────────────────────────────────────────────

serve(async (_req) => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const chatId = await findNotifyChatId(supabase);
  if (!chatId) {
    return new Response(JSON.stringify({ error: "no chat_id found in settings — bot must be used at least once first" }), { status: 200 });
  }

  const cutoff = new Date(Date.now() - MIN_HOURS_SINCE_PLACED * 60 * 60 * 1000).toISOString();

  const { data: openBets } = await supabase
    .from("bets")
    .select("*, sportsbooks(name)")
    .eq("version", 2)
    .eq("status", "pending")
    .lt("placed_at", cutoff);

  if (!openBets || openBets.length === 0) {
    return new Response(JSON.stringify({ checked: 0, message: "no eligible open bets" }), { status: 200 });
  }

  // Skip bets we've already sent a suggestion for (don't re-spam every run
  // while Brent/Dan are still deciding, or once they explicitly skipped it).
  const { data: alreadyGraded } = await supabase
    .from("activity_log")
    .select("details")
    .in("action", ["grade_suggested", "grade_auto_settled"]);
  const gradedIds = new Set((alreadyGraded ?? []).map((r: any) => r.details?.bet_id).filter(Boolean));

  const results: Array<{ bet_id: string; verdict: string; auto: boolean }> = [];

  for (const bet of openBets) {
    if (gradedIds.has(bet.id)) continue;

    const v = await gradeBet(bet);
    if (!v) continue; // request/parse failure — not logged, so this bet is retried on the next run

    if (v.verdict === "unknown") {
      // Logged so it's not re-researched daily — an ambiguous description or
      // unfindable game won't resolve itself; settle it manually in the app.
      await supabase.from("activity_log").insert({
        user_name: "grader", action: "grade_suggested",
        details: { bet_id: bet.id, verdict: v.verdict, confidence: v.confidence, unresolved: true },
      });
      continue; // no message sent — nothing confident enough to show
    }

    const odds = bet.base_odds > 0 ? `+${bet.base_odds}` : String(bet.base_odds);
    const header = `${bet.sportsbooks?.name?.replace("theScore Bet", "Score") ?? ""} · ${bet.sport} · ${bet.description}\n${odds} · $${bet.total_wager} total`;

    if (isAutoSettleEligible(bet, v.verdict, v.confidence)) {
      const delta = betSettleDelta(bet, v.verdict);
      await supabase.from("bets").update({ status: v.verdict, settled_at: new Date().toISOString() }).eq("id", bet.id);
      if (delta !== 0 && bet.sportsbook_id) {
        const { data: sb } = await supabase.from("sportsbooks").select("current_balance").eq("id", bet.sportsbook_id).single();
        if (sb) {
          await supabase.from("sportsbooks").update({ current_balance: parseFloat(sb.current_balance) + delta }).eq("id", bet.sportsbook_id);
        }
      }
      await supabase.from("activity_log").insert({
        user_name: "grader", action: "grade_auto_settled",
        details: { bet_id: bet.id, sport: bet.sport, description: bet.description, result: v.verdict, sportsbook: bet.sportsbooks?.name, source: "auto_graded" },
      });

      const emoji = { won: "✅", lost: "❌", push: "➖" }[v.verdict as "won" | "lost" | "push"];
      await reply(chatId, `${emoji} Auto-settled ${v.verdict.toUpperCase()}\n${header}\n\n${v.explanation}`);
      results.push({ bet_id: bet.id, verdict: v.verdict, auto: true });
    } else {
      await supabase.from("activity_log").insert({
        user_name: "grader", action: "grade_suggested",
        details: { bet_id: bet.id, verdict: v.verdict, confidence: v.confidence },
      });

      const label = { won: "WIN", lost: "LOSS", push: "PUSH", void: "VOID", unknown: "?" }[v.verdict];
      const keyboard: InlineKeyboard = [
        [
          { text: "✅ Won", callback_data: `gw:${bet.id}` },
          { text: "❌ Lost", callback_data: `gl:${bet.id}` },
        ],
        [
          { text: "➖ Push", callback_data: `gp:${bet.id}` },
          { text: "⊘ Void", callback_data: `gv:${bet.id}` },
        ],
        [{ text: "Leave open", callback_data: `gs:${bet.id}` }],
      ];
      await replyWithButtons(
        chatId,
        `Looks like a ${label} (${v.confidence} confidence) — tap to confirm:\n${header}\n\n${v.explanation}`,
        keyboard,
      );
      results.push({ bet_id: bet.id, verdict: v.verdict, auto: false });
    }
  }

  return new Response(JSON.stringify({ checked: openBets.length, graded: results.length, results }), {
    headers: { "Content-Type": "application/json" },
  });
});
