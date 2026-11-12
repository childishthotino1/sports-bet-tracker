// Weekly NFL spreads from DraftKings, for the HLD pick'em page.
// pg_cron (job "nfl-spreads-thursday") calls this at 16:00 and 17:00 UTC on
// Thursdays; only the run that lands at noon New York time pulls, so the
// snapshot is always "DraftKings at noon ET Thursday" across DST changes.
// POST {"force": true} pulls regardless of the time (used for a missed week).
// One Odds API call (1 market x 1 book = 1 credit). The snapshot is upserted
// into nfl_spread_snapshots by week (the Thursday's date); the shared page is
// republished from that row by a scheduled Claude task.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ODDS_KEY = Deno.env.get("ODDS_API_KEY")!;
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

function nyParts(d: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return { weekday: p.weekday, hour: Number(p.hour), date: `${p.year}-${p.month}-${p.day}` };
}

// The Thursday (NY date) that starts the NFL week containing `d` (Thu–Wed).
function weekOf(d: Date): string {
  for (let back = 0; back < 7; back++) {
    const t = new Date(d.getTime() - back * 86400000);
    const p = nyParts(t);
    if (p.weekday === "Thu") return p.date;
  }
  return nyParts(d).date;
}

Deno.serve(async (req) => {
  let force = false;
  try { force = !!(await req.json())?.force; } catch { /* no body */ }

  const now = new Date();
  const ny = nyParts(now);
  if (!force && !(ny.weekday === "Thu" && ny.hour === 12)) {
    return Response.json({ skipped: `not noon Thursday in New York (${ny.weekday} ${ny.hour}:00)` });
  }

  // Games from now through the following Tuesday morning: Thu, Sun and Mon.
  const until = new Date(now.getTime() + 5.5 * 86400000);
  const params = new URLSearchParams({
    apiKey: ODDS_KEY, bookmakers: "draftkings", markets: "spreads", oddsFormat: "american",
    commenceTimeFrom: now.toISOString().replace(/\.\d+Z$/, "Z"),
    commenceTimeTo: until.toISOString().replace(/\.\d+Z$/, "Z"),
  });
  const res = await fetch(`https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds?${params}`);
  if (!res.ok) return Response.json({ error: `Odds API ${res.status}: ${await res.text()}` }, { status: 502 });
  const events = await res.json();

  const games = events.map((e: any) => {
    const m = e.bookmakers?.[0]?.markets?.find((x: any) => x.key === "spreads");
    const o = (team: string) => m?.outcomes?.find((x: any) => x.name === team);
    const h = o(e.home_team), a = o(e.away_team);
    return {
      id: e.id, kickoff: e.commence_time, home: e.home_team, away: e.away_team,
      home_spread: h?.point ?? null, home_price: h?.price ?? null,
      away_spread: a?.point ?? null, away_price: a?.price ?? null,
      dk_updated: m?.last_update ?? null,
    };
  }).sort((x: any, y: any) => x.kickoff.localeCompare(y.kickoff));

  const row = { week_of: weekOf(now), pulled_at: now.toISOString(), source: "DraftKings", games };
  const { error } = await db.from("nfl_spread_snapshots").upsert(row, { onConflict: "week_of" });
  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({
    ok: true, week_of: row.week_of, games: games.length,
    credits_remaining: res.headers.get("x-requests-remaining"),
  });
});
