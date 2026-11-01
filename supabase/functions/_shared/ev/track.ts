// Tracking the bot's own suggestions, to measure how it does: the rows it logs
// (promo_bot_picks), grading legs from a final score, settling each pick at a
// flat 1 unit, and the /stats report. Pure: the bot writes the rows, and the
// grade-picks function grades them.

import { americanToDecimal } from "./odds.ts";
import { sameTeam } from "./names.ts";
import type { PricedLeg } from "./picks.ts";

export type LegResult = "won" | "lost" | "push" | "void" | "unknown"; // unknown: gave up grading it

export type TrackedLeg = {
  event_id: string | null;
  sport_key: string | null;
  game: string | null; // "Away @ Home", as the feed names the teams
  start: string | null; // ISO
  market: string; // feed key: h2h, alternate_spreads, player_anytime_td, ...
  selection: string; // as the bot showed it: "CeeDee Lamb Anytime TD"
  side: string; // "Over", "Yes", a team
  point: number | null;
  player: string | null; // the outcome's description: a player, or the team of a team total
  book_odds: number | null;
  fair: number | null; // the fair probability the bot used
  result?: LegResult | null;
  why?: string | null;
};

// pick: a pick card. sgp_legs: legs suggested for an SGP (no total price).
// question: a line that beat the fair price in a game answer. slip: a slip the bot checked.
export type PickSource = "pick" | "sgp_legs" | "question" | "slip";

export type PickRow = {
  chat_id: string;
  source: PickSource;
  dedup_key: string;
  book: string;
  league: string | null;
  kind: "single" | "parlay" | "sgp";
  promo_title: string | null;
  boost_pct: number; // 0 for none
  book_odds: number | null; // the whole bet, before the boost
  fair_prob: number | null;
  ev: number | null; // what the bot predicted, after the boost
  verdict: "plus_ev" | "minus_ev" | null;
  legs: TrackedLeg[];
  first_start: string | null;
  last_start: string | null;
};

export type PickStatus = "pending" | "won" | "lost" | "push" | "ungraded";
export type StoredPick = PickRow & { id: number; created_at: string; status: PickStatus; profit: number | null };

export function trackedLeg(l: PricedLeg): TrackedLeg {
  return {
    event_id: l.eventId, sport_key: l.sportKey, game: l.game, start: l.start, market: l.market,
    selection: l.selection, side: l.side, point: l.point ?? null, player: l.description ?? null,
    book_odds: l.bookOdds, fair: l.fair,
  };
}

// A row to log. The dedup key makes the same suggestion, made again the same
// day (tapping Find the best bets twice), one row.
export function pickRow(
  r: Omit<PickRow, "dedup_key" | "first_start" | "last_start">,
  now = new Date(),
): PickRow {
  const starts = r.legs.map((l) => l.start).filter((s): s is string => !!s).sort();
  const legKeys = r.legs.map((l) => `${l.event_id ?? l.game}|${l.market}|${l.selection}`).sort().join(";");
  const day = now.toISOString().slice(0, 10);
  return {
    ...r,
    dedup_key: `${r.chat_id}|${r.source}|${r.book}|${r.boost_pct}|${r.book_odds ?? ""}|${legKeys}|${day}`,
    first_start: starts[0] ?? null,
    last_start: starts.at(-1) ?? null,
  };
}

// ── Grading from a final score ──────────────────────────────

export type Score = {
  home_team: string;
  away_team: string;
  home: number;
  away: number;
  home_h1?: number | null;
  away_h1?: number | null;
};

const cmp = (x: number) => (x > 0 ? "won" : x < 0 ? "lost" : "push");
const quarterLine = (p: number) => !Number.isInteger(p * 2); // 2.25, -0.75: split stakes, left to the research

// The result of a game-line leg from the score: moneyline, spread, total, team
// total, draw no bet, BTTS, and their 1st-half versions. Null for anything a
// score can't settle (props, corners, 1st quarter, quarter lines).
export function gradeFromScore(leg: TrackedLeg, s: Score): Exclude<LegResult, "unknown" | "void"> | null {
  const half = leg.market.endsWith("_h1");
  if (/_q\d$/.test(leg.market)) return null;
  const base = leg.market.replace(/^alternate_/, "").replace(/_h1$/, "");
  const home = half ? s.home_h1 : s.home;
  const away = half ? s.away_h1 : s.away;
  if (home === null || home === undefined || away === null || away === undefined) return null;
  const side = (name: string | null): "home" | "away" | null =>
    !name ? null : sameTeam(name, s.home_team) && !sameTeam(name, s.away_team) ? "home"
    : sameTeam(name, s.away_team) && !sameTeam(name, s.home_team) ? "away" : null;
  const margin = (t: "home" | "away") => (t === "home" ? home - away : away - home);
  const soccer = (leg.sport_key ?? "").startsWith("soccer_");

  if (base === "h2h" || base === "draw_no_bet") {
    if (leg.side === "Draw") return home === away ? "won" : "lost";
    const t = side(leg.side);
    if (!t) return null;
    const r = cmp(margin(t));
    return r === "push" && base === "h2h" && soccer ? "lost" : r; // a soccer draw loses a 3-way moneyline
  }
  if (base === "spreads") {
    const t = side(leg.side);
    if (!t || leg.point === null || quarterLine(leg.point)) return null;
    return cmp(margin(t) + leg.point);
  }
  if (base === "totals" || base === "team_totals") {
    if (leg.point === null || quarterLine(leg.point)) return null;
    let total = home + away;
    if (base === "team_totals") {
      const t = side(leg.player);
      if (!t) return null;
      total = t === "home" ? home : away;
    }
    const over = cmp(total - leg.point);
    if (leg.side === "Over") return over;
    if (leg.side === "Under") return over === "push" ? "push" : over === "won" ? "lost" : "won";
    return null;
  }
  if (base === "btts") {
    const both = home > 0 && away > 0;
    return leg.side === "Yes" ? (both ? "won" : "lost") : leg.side === "No" ? (both ? "lost" : "won") : null;
  }
  return null;
}

// ── Research prompt (the grader asks Claude with web search, one call per game) ──

export function gradePrompt(game: string, startIso: string, legs: TrackedLeg[], today = new Date()): string {
  const day = (d: Date) => d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "long", day: "numeric", year: "numeric" });
  const list = legs.map((l, i) => `${i + 1}. ${l.selection}${l.market.includes("_h1") ? " (1st half only)" : ""} [${l.market}]`).join("\n");
  return `Find the result of this game with web search, then grade each bet below. Today is ${day(today)}.

Game: ${game}, started ${day(new Date(startIso))} (US Eastern).

Bets:
${list}

Rules: an Over/Under needs the exact stat (a player's receptions, yards, the team's points). "Anytime TD" wins if the player scored a rushing or receiving touchdown (passing TDs don't count); "1st TD" / "Last TD" win only if he scored the game's first / last touchdown. A player who didn't play makes his prop "void". A postponed or cancelled game makes every bet "void". If you can't find a stat for sure, say "unknown" for that bet; don't guess.

Respond with ONLY a JSON object, no other text:
{"status": "final" | "not_final" | "postponed" | "not_found",
 "final": {"away": <points>, "home": <points>} or null,
 "first_half": {"away": <points>, "home": <points>} or null,
 "bets": [{"n": 1, "result": "won" | "lost" | "push" | "void" | "unknown", "why": "the stat you found, briefly"}]}`;
}

export type GradeReply = {
  status: "final" | "not_final" | "postponed" | "not_found";
  final: { away: number; home: number } | null;
  first_half: { away: number; home: number } | null;
  bets: { n: number; result: LegResult; why: string }[];
};

export function parseGradeReply(text: string): GradeReply | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const r = JSON.parse(m[0]);
    if (!["final", "not_final", "postponed", "not_found"].includes(r.status)) return null;
    const pts = (x: unknown) => {
      const o = x as { away?: unknown; home?: unknown } | null;
      return o && typeof o.away === "number" && typeof o.home === "number" ? { away: o.away, home: o.home } : null;
    };
    const results = ["won", "lost", "push", "void", "unknown"];
    const bets = (Array.isArray(r.bets) ? r.bets : []).filter((b: { n?: unknown; result?: unknown }) =>
      typeof b?.n === "number" && results.includes(String(b.result)),
    ).map((b: { n: number; result: LegResult; why?: unknown }) => ({ n: b.n, result: b.result, why: String(b.why ?? "") }));
    return { status: r.status, final: pts(r.final), first_half: pts(r.first_half), bets };
  } catch {
    return null;
  }
}

// Each leg's result from the research: the score settles game lines (overriding
// the model's read), the model's verdict settles the rest. Null = not yet.
export function legResults(legs: TrackedLeg[], g: GradeReply, teams: { home_team: string; away_team: string }): { result: LegResult | null; why: string | null }[] {
  if (g.status === "postponed") return legs.map(() => ({ result: "void", why: "game postponed or cancelled" }));
  if (g.status !== "final") return legs.map(() => ({ result: null, why: null }));
  const score: Score | null = g.final
    ? { ...teams, home: g.final.home, away: g.final.away, home_h1: g.first_half?.home ?? null, away_h1: g.first_half?.away ?? null }
    : null;
  return legs.map((leg, i) => {
    const fromScore = score ? gradeFromScore(leg, score) : null;
    const scoreText = score ? `${teams.away_team} ${score.away}, ${teams.home_team} ${score.home}` : null;
    if (fromScore) return { result: fromScore, why: `final: ${scoreText}${leg.market.endsWith("_h1") ? ` (1st half ${score!.away_h1}-${score!.home_h1})` : ""}` };
    const b = g.bets.find((x) => x.n === i + 1);
    return b && b.result !== "unknown" ? { result: b.result, why: b.why } : { result: null, why: b?.why ?? null };
  });
}

// ── Settling a pick ─────────────────────────────────────────

// A pick's status and profit at a 1-unit stake. Any lost leg loses it; a
// pushed or void leg drops out and the rest pay at their own prices. Profit is
// null for an SGP leg suggestion, which has no total price.
export function settle(p: Pick<PickRow, "legs" | "book_odds" | "boost_pct">): { status: PickStatus; profit: number | null } {
  const priced = p.book_odds !== null;
  const rs = p.legs.map((l) => l.result ?? null);
  if (rs.includes("lost")) return { status: "lost", profit: priced ? -1 : null };
  if (rs.includes(null)) return { status: "pending", profit: null };
  if (rs.includes("unknown")) return { status: "ungraded", profit: null };
  const won = p.legs.filter((l) => l.result === "won");
  if (!won.length) return { status: "push", profit: priced ? 0 : null };
  let decimal: number | null = null;
  if (!priced) decimal = null;
  else if (won.length === p.legs.length) decimal = americanToDecimal(p.book_odds!);
  else if (won.every((l) => l.book_odds !== null)) decimal = won.reduce((d, l) => d * americanToDecimal(l.book_odds!), 1);
  const profit = decimal === null ? null : Math.round((decimal - 1) * (1 + p.boost_pct / 100) * 10000) / 10000;
  return { status: "won", profit };
}

// ── The report ──────────────────────────────────────────────

const SOURCE_LABELS: Record<PickSource, string> = {
  pick: "Pick cards", sgp_legs: "SGP leg ideas", question: "Game answers (+EV lines)", slip: "Slips checked",
};

const MARKET_LABELS: Record<string, string> = {
  h2h: "Moneyline", spreads: "Spread", totals: "Game total", team_totals: "Team total",
  h2h_h1: "1H moneyline", spreads_h1: "1H spread", totals_h1: "1H total", draw_no_bet: "Draw no bet",
  btts: "Both teams score", totals_corners: "Corners", player_anytime_td: "Anytime TD", player_1st_td: "1st TD",
  player_last_td: "Last TD", player_goal_scorer_anytime: "Anytime goal",
};

export function marketLabel(market: string): string {
  const base = market.replace(/^alternate_/, "").replace(/_alternate$/, "");
  return MARKET_LABELS[base] ?? base.replace(/^(player|batter|pitcher)_/, "").split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

type Tally = { w: number; l: number; p: number; units: number; staked: number; evSum: number; evN: number };
const tally = (): Tally => ({ w: 0, l: 0, p: 0, units: 0, staked: 0, evSum: 0, evN: 0 });

function add(t: Tally, r: StoredPick) {
  if (r.status === "won") t.w++;
  else if (r.status === "lost") t.l++;
  else if (r.status === "push") t.p++;
  if (r.profit !== null) {
    t.units += r.profit;
    t.staked++;
    if (r.ev !== null) { t.evSum += r.ev; t.evN++; }
  }
}

const signedPct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const signedU = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}u`;

function line(label: string, t: Tally): string {
  const rec = `${t.w}-${t.l}${t.p ? `-${t.p}` : ""}`;
  if (!t.staked) return `${label}: ${rec}`;
  const ev = t.evN ? ` (bot expected ${signedPct(t.evSum / t.evN)})` : "";
  return `${label}: ${rec}, ${signedU(t.units)}, ROI ${signedPct(t.units / t.staked)}${ev}`;
}

function grouped(rows: StoredPick[], key: (r: StoredPick) => string | null, min = 1): string[] {
  const m = new Map<string, Tally>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    if (!m.has(k)) m.set(k, tally());
    add(m.get(k)!, r);
  }
  return [...m].filter(([, t]) => t.w + t.l + t.p >= min).sort((a, b) => b[1].w + b[1].l - (a[1].w + a[1].l)).map(([k, t]) => line(k, t));
}

// Every graded leg, by market: how often it hit against how often the bot's
// fair price said it would. The truest test of the fair prices.
function legLines(rows: StoredPick[]): string[] {
  const m = new Map<string, { won: number; n: number; fair: number }>();
  const seen = new Set<string>();
  for (const r of rows) {
    for (const l of r.legs) {
      if (l.result !== "won" && l.result !== "lost") continue;
      const key = `${l.event_id}|${l.market}|${l.selection}`; // the same leg suggested twice (or at two books) counts once
      if (seen.has(key)) continue;
      seen.add(key);
      const k = marketLabel(l.market);
      const t = m.get(k) ?? { won: 0, n: 0, fair: 0 };
      t.n++;
      if (l.result === "won") t.won++;
      t.fair += l.fair ?? 0;
      m.set(k, t);
    }
  }
  return [...m].sort((a, b) => b[1].n - a[1].n).map(([k, t]) =>
    `${k}: hit ${t.won}/${t.n} (${((t.won / t.n) * 100).toFixed(0)}%) vs fair ${((t.fair / t.n) * 100).toFixed(0)}%`);
}

export function formatStats(all: StoredPick[], days: number | null = null, now = new Date()): string {
  const since = days ? new Date(now.getTime() - days * 86400e3).toISOString() : null;
  const rows = since ? all.filter((r) => r.created_at >= since) : all;
  const period = days ? `last ${days} day${days === 1 ? "" : "s"}` : "all time";
  if (!rows.length) return `📊 No suggestions logged (${period}) yet. Every pick card, SGP leg idea, +EV game line and slip check gets logged from now on, and graded after the game.`;
  const settled = rows.filter((r) => r.status === "won" || r.status === "lost" || r.status === "push");
  const pending = rows.filter((r) => r.status === "pending").length;
  const ungraded = rows.filter((r) => r.status === "ungraded").length;
  const total = tally();
  for (const r of settled) if (r.source !== "slip") add(total, r);
  const out = [
    `📊 Bot performance, ${period}: ${rows.length} suggestion${rows.length === 1 ? "" : "s"} logged, ${settled.length} settled, ${pending} waiting on games${ungraded ? `, ${ungraded} couldn't be graded` : ""}.`,
    "Flat 1 unit per bet, at the price and boost the bot showed.",
    "",
    line("Bot's suggestions", total),
  ];
  const section = (title: string, lines: string[]) => { if (lines.length) out.push("", title, ...lines.map((l) => `• ${l}`)); };
  section("By source", grouped(settled, (r) => SOURCE_LABELS[r.source]));
  const sugg = settled.filter((r) => r.source !== "slip");
  section("By book", grouped(sugg, (r) => r.book));
  section("By league", grouped(sugg, (r) => r.league));
  section("By bet type", grouped(sugg, (r) => r.kind === "single" ? "Singles" : r.kind === "sgp" ? "SGPs" : "Parlays"));
  section("By market (singles)", grouped(sugg.filter((r) => r.legs.length === 1), (r) => marketLabel(r.legs[0].market)));
  section("By promo boost", grouped(sugg, (r) => r.boost_pct ? `${r.boost_pct}% boost` : "No boost"));
  section("Slips checked, by the bot's verdict", grouped(settled.filter((r) => r.source === "slip"), (r) => r.verdict === "plus_ev" ? "Called +EV" : r.verdict === "minus_ev" ? "Called -EV" : null));
  section("Every leg, hit rate vs the bot's fair price", legLines(settled.concat(rows.filter((r) => r.status === "pending"))));
  if (settled.length < 30) out.push("", `Small sample: ${settled.length} settled. Results swing a lot until there are a few hundred; the leg hit rates vs fair are the earliest honest signal.`);
  return out.join("\n");
}
