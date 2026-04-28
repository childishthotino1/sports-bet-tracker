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
- BOOK: identify by color scheme and logo:
    SCORE = theScore (red & white)
    DK = DraftKings (green & black)
    FD = FanDuel (blue & white)
    MGM = BetMGM (black & gold)
    B365 = Bet365 (green & yellow)
    CS = Caesars (blue & gold)
    FAN = Fanatics (red & white, "Fanatics" wordmark)
  Use best guess if unclear.
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
