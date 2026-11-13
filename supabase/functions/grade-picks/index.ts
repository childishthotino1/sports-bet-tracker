// grade-picks: grades the promo bot's logged suggestions (promo_bot_picks) once
// their games are over, so /stats can show how the bot is doing.
//
// ESPN first (results.ts): the scoreboard's final settles game lines (1st half
// and 1st quarter too), and the game's box score settles basketball and
// football player props. A game ESPN shows still in play waits for a later run.
// Whatever ESPN can't settle (a game it doesn't list, 1st / last TD scorer,
// soccer and MLB / NHL props) goes to one Claude + web search call per game.
// A game whose result isn't found is retried on later runs, up to
// MAX_ATTEMPTS, then its legs are marked "unknown" and their picks "ungraded".
//
// Runs on a schedule (pg_cron -> pg_net with the project anon key; verify_jwt
// is on). It answers at once and keeps working in the background, since a run
// takes a few minutes. Never touches the bet tracker's tables.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  gradePrompt, legResults, parseGradeReply, settle,
  type GradeReply, type LegResult, type StoredPick, type TrackedLeg,
} from "../_shared/ev/track.ts";
import {
  easternDay, espnResults, matchGame, parseBox, parseScoreboard, scoreboardUrl, summaryUrl, type EspnGame,
} from "../_shared/ev/results.ts";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const HOURS_AFTER_START = 4; // most games are over by then; an unfinished one is just retried
const MAX_GAMES_PER_RUN = 8; // keeps a run inside the function's time limit
const MAX_ATTEMPTS = 4;
const CONCURRENCY = 4;

const legKey = (l: TrackedLeg) => `${l.market}|${l.selection}`;

// Claude with web search. Server tools can pause a long turn; continue it.
async function research(prompt: string): Promise<GradeReply | null> {
  const messages: { role: string; content: unknown }[] = [{ role: "user", content: prompt }];
  for (let turn = 0; turn < 3; turn++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "anthropic-beta": "server-side-fallback-2026-07-01" },
      body: JSON.stringify({
        model: "claude-opus-5-5",
        max_tokens: 8000,
        output_config: { effort: "medium" },
        fallbacks: "default",
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }],
        messages,
      }),
    });
    if (!res.ok) {
      console.error("Claude", res.status, await res.text());
      return null;
    }
    const data = await res.json();
    if (data.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: data.content });
      continue;
    }
    if (data.stop_reason === "refusal") return null;
    const text = (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n");
    return parseGradeReply(text);
  }
  return null;
}

// ESPN's public site API. One scoreboard per sport and day per run.
const boards = new Map<string, Promise<EspnGame[]>>();
async function espnJson(url: string): Promise<unknown | null> {
  try {
    // ESPN answers 403 to Deno's default User-Agent and to a browser-style one; a plain name gets through.
    const res = await fetch(url, { headers: { "User-Agent": "baltimore-bets-grader/1.0" } });
    if (!res.ok) { console.error("ESPN", res.status, url); return null; }
    return await res.json();
  } catch (e) {
    console.error("ESPN", url, e);
    return null;
  }
}
function espnBoard(sportKey: string, startIso: string): Promise<EspnGame[]> {
  const url = scoreboardUrl(sportKey, easternDay(startIso));
  if (!url) return Promise.resolve([]);
  if (!boards.has(url)) boards.set(url, espnJson(url).then(parseScoreboard));
  return boards.get(url)!;
}

type Found = { result: LegResult; why: string | null } | null;

// ESPN's results for a game's legs: null when ESPN doesn't list the game,
// "wait" while it's still being played.
async function fromEspn(g: Game, teams: { home_team: string; away_team: string }): Promise<{ results: Found[]; espn: EspnGame } | "wait" | null> {
  if (!g.sport_key) return null;
  const espn = matchGame(await espnBoard(g.sport_key, g.start), g.game, g.start);
  if (!espn) return null;
  if (espn.status === "live" || espn.status === "scheduled") return "wait";
  const props = g.legs.some((l) => /^player_/.test(l.market));
  const box = espn.status === "final" && props && /^(basketball|americanfootball)_/.test(g.sport_key)
    ? parseBox(await espnJson(summaryUrl(g.sport_key, espn.id)!), g.sport_key)
    : null;
  return { results: espnResults(g.legs, espn, g.sport_key, teams, box), espn };
}

async function pendingPicks(): Promise<StoredPick[]> {
  const out: StoredPick[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("promo_bot_picks").select("*").eq("status", "pending").order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data as StoredPick[]));
    if (!data || data.length < 1000) return out;
  }
}

type Game = { event_id: string; sport_key: string | null; game: string; start: string; legs: TrackedLeg[] };

async function run() {
  const picks = await pendingPicks();
  const cutoff = new Date(Date.now() - HOURS_AFTER_START * 3600e3).toISOString();

  // The finished games with ungraded legs, each leg once.
  const games = new Map<string, Game>();
  for (const p of picks) {
    for (const l of p.legs) {
      if (l.result || !l.event_id || !l.start || !l.game || l.start > cutoff) continue;
      const g = games.get(l.event_id) ?? { event_id: l.event_id, sport_key: l.sport_key, game: l.game, start: l.start, legs: [] };
      if (!g.legs.some((x) => legKey(x) === legKey(l))) g.legs.push(l);
      games.set(l.event_id, g);
    }
  }
  if (!games.size) return { picks: picks.length, games: 0 };

  const { data: tried } = await db.from("promo_bot_games").select("event_id, attempts").in("event_id", [...games.keys()]);
  const attempts = new Map((tried ?? []).map((r: { event_id: string; attempts: number }) => [r.event_id, r.attempts]));
  const queue = [...games.values()].sort((a, b) => a.start.localeCompare(b.start)).slice(0, MAX_GAMES_PER_RUN);

  // event_id -> leg key -> result
  const found = new Map<string, Map<string, { result: LegResult; why: string | null }>>();
  let espnLegs = 0, researched = 0;
  const gradeGame = async (g: Game) => {
    const [away_team, home_team] = g.game.split(" @ ");
    const teams = { home_team, away_team };
    const espn = await fromEspn(g, teams);
    if (espn === "wait") return; // still being played: a later run
    const results: Found[] = espn ? espn.results : g.legs.map(() => null);
    espnLegs += results.filter(Boolean).length;
    const rest = g.legs.flatMap((l, i) => (results[i] ? [] : [i]));
    let reply: GradeReply | null = null;
    let tries = attempts.get(g.event_id) ?? 0;
    if (rest.length) {
      researched++;
      tries++;
      const legs = rest.map((i) => g.legs[i]);
      reply = await research(gradePrompt(g.game, g.start, legs));
      const r = reply ? legResults(legs, reply, teams) : legs.map(() => ({ result: null, why: null }));
      rest.forEach((i, k) => {
        results[i] = r[k].result ? { result: r[k].result!, why: r[k].why }
          : tries >= MAX_ATTEMPTS ? { result: "unknown", why: r[k].why ?? `no result found after ${tries} tries` } : null;
      });
    }
    const byLeg = new Map<string, { result: LegResult; why: string | null }>();
    g.legs.forEach((l, i) => { if (results[i]) byLeg.set(legKey(l), results[i]!); });
    found.set(g.event_id, byLeg);
    const e = espn?.espn;
    await db.from("promo_bot_games").upsert({
      event_id: g.event_id, sport_key: g.sport_key, game: g.game, start: g.start, attempts: tries,
      status: e && !rest.length ? (e.status === "final" ? "final" : "postponed") : reply?.status ?? (e ? e.status : "error"),
      result: { espn: e ? { id: e.id, status: e.status, home: e.home, away: e.away } : null, research: reply },
      updated_at: new Date().toISOString(),
    });
  };
  for (let i = 0; i < queue.length; i += CONCURRENCY) await Promise.all(queue.slice(i, i + CONCURRENCY).map(gradeGame));

  // Write each leg's result into its picks, and settle them.
  let settled = 0;
  for (const p of picks) {
    let changed = false;
    const legs = p.legs.map((l) => {
      const r = !l.result && l.event_id ? found.get(l.event_id)?.get(legKey(l)) : undefined;
      if (!r) return l;
      changed = true;
      return { ...l, result: r.result, why: r.why };
    });
    if (!changed) continue;
    const { status, profit } = settle({ ...p, legs });
    if (status !== "pending") settled++;
    const { error } = await db.from("promo_bot_picks").update({
      legs, status, profit, graded_at: status === "pending" ? null : new Date().toISOString(),
    }).eq("id", p.id);
    if (error) console.error("update pick", p.id, error.message);
  }
  return { picks: picks.length, games: queue.length, espnLegs, researched, settled };
}

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

Deno.serve((_req) => {
  const job = run().then((r) => console.log("grade-picks", JSON.stringify(r))).catch((e) => console.error("grade-picks", e));
  if (typeof EdgeRuntime !== "undefined") {
    EdgeRuntime.waitUntil(job);
    return new Response(JSON.stringify({ started: true }), { status: 202, headers: { "Content-Type": "application/json" } });
  }
  return job.then(() => new Response(JSON.stringify({ done: true })));
});
