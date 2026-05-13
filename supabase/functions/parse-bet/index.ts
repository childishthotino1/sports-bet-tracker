import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    const { image, mimeType } = await req.json();

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY!,
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
              source: { type: "base64", media_type: mimeType, data: image },
            },
            {
              type: "text",
              text: `Parse this sportsbook bet slip screenshot into a single bet code line.

Format: BOOK.SPORT.DESC.BOOST.TOTAL.??.??±ODDS

Rules:
- BOOK: identify using these specific visual rules, checked in order:
    CZR   = Caesars      WHITE/light background; 'CAESARS SPORTSBOOK' green logo; 'CAESARS REWARDS.' badge; trophy icon; labels: Cash Wagered/To Win/Pays; dark green Done button
    FAN   = Fanatics     Dark background; 'Fanatics Sportsbook' wordmark always visible; FanCash column; purple FCash badge; green oval Cash out button; labels: Wager/Payout
    MGM   = BetMGM       Dark background; NO logo on slip; white 'Your bet has been accepted. Good luck!' banner with green left border; gold/tan Done button; labels: Stake/Total payout
    SCORE = theScore Bet Dark navy background; 'theScore BET' logo with yellow BET pill top-left; blue + balance button; green upward-arrow boost icon; labels: BET/POTENTIAL PAYOUT
    DK    = DraftKings   Dark background; green DraftKings crown logo
    FD    = FanDuel      Blue background; FanDuel wordmark
    B365  = Bet365       Green background; bet365 wordmark
    CRITICAL: white/light background = always CZR. Dark + Fanatics wordmark = always FAN. Dark + gold Done button = always MGM.
- SPORT: NBA, NFL, NHL, MLB, NCAAF, NCAAB, SOCCER, TENNIS, MMA, etc.
- DESC: short label, no spaces or dots — include team/player name, never just '3LegParlay':
    Single: LakersML, BrownsCover, CurrieO29pts
    Parlay: up to 3 key teams/players + leg count — Angels-TBRays-3Leg, Wemby-Castle-2Leg
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
    const code = data.content?.[0]?.text?.trim() ?? "";

    return new Response(JSON.stringify({ code }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
