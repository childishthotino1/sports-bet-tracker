# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**Baltimore Bets** — a two-person sports betting P&L tracker for Brent + Dan. Vanilla JS PWA backed by Supabase (PostgreSQL). No build step; all dependencies loaded via CDN. Deployed as a static site.

Users (Brent and Dan) each have a 4-digit PIN stored in the `settings` table (`pin` and `pin_dan` keys). Equity is tracked as a ledger: deposits + adjustments + bet P&L - payouts = each person's bag.

## Seasons (V1 / V2)

The app is on **Season 2** (V2). Season 1 closed 2026-08-15: every bet settled, the drift reconciled 50/50, and final payouts logged so V1's pool, bank, and both equities are exactly $0 (see `add_version_v2.sql`).

**V2's purpose is narrower than V1's:** Brent tracks his own betting in Pikkit now. This app exists because some of Dan's money is deployed in Brent's sportsbooks — so only bets Dan has a piece of get entered here, and the point of the ledger is Dan's equity (Brent's cut is tracked too, since it keeps book balances and the pool honest). Nearly all shared bets are on **BetMGM**, which is preselected in the Add Bet and Money Moves forms. All season tables carry a `version` column — existing rows were backfilled to 1; the DB default is 2, so the app and the Telegram bot write V2 rows with no edge-function changes. `js/db.js` filters every getter to `version = 2` (`SEASON` constant); V1 history is read-only, fetched lazily by `DB.getV1Bundle()` for the "Season 1" review page (reached from Summary). The git tag `v1` marks the last V1 commit of the front end.

## Running & Deploying

No build step. Open `index.html` directly or serve any static file server:
```bash
npx serve .
# or: python3 -m http.server 8000
```

There's no separate dev/staging database — `js/config.js` points straight at the production Supabase project, so local testing is testing against real shared data.

Supabase edge functions (Telegram bot, bet parser, auto-grader) live in `supabase/functions/`. Deploy with:
```bash
supabase functions deploy telegram-bot
supabase functions deploy parse-bet
supabase functions deploy grade-bets
```

No `package.json` — dependencies are CDN-loaded in `index.html` (Supabase JS v2, Chart.js v4).

## Architecture

```
index.html          # App shell; loads scripts in order: config → math → db → app
js/config.js        # Supabase URL + anon key
js/math.js          # Pure calculation functions — no DB, no DOM
js/db.js            # Supabase singleton client; all DB read/write functions
js/app.js           # Everything else: state, routing, rendering, modals, undo
css/style.css       # Ravens-themed (purple/orange/gold), PWA-safe-area insets
supabase/functions/
  telegram-bot/     # Webhook: photo → Claude vision → conversational intake → save
  parse-bet/        # Simple CORS endpoint for direct image parsing (legacy)
  grade-bets/       # Daily auto-checker: Claude + web search verifies open bets, recommend-and-confirm
  _shared/ev/       # +EV promo bot core: devig, EV, Kelly, bet-card formatter (pure; not wired to a command yet)
```

**Load order matters:** `config.js` must load before `db.js`; `math.js` before `app.js`.

## Data Model

**sportsbooks** — live cash balance per book (theScore, DraftKings, FanDuel, BetMGM, Bet365, Fanatics, Caesars)

**bets** — `sportsbook_id`, `sport`, `description`, `base_odds` (pre-boost), `boost_pct`, `total_wager`, `my_wager` (Brent), `his_wager` (Dan), `status` (pending/won/lost/push/**void**), `version`. Can exceed 1000 rows — see pagination note below. **void** = book cancelled the bet: the ledger treats it exactly like push (stake refunded, `_betSettleDelta`), and the math excludes it from P&L, record, and win% (`BetMath._noPnl`).

**transactions** — `deposit`, `withdrawal`, `redeployment` (bank→book), `payout` (bank→person), `disbursement`, `adjustment` (manual balance correction — logged automatically by Manage Books → Update Balance and Add Snapshot when the number you enter differs from what's tracked; see `add_transaction_types.sql`). `person` field has legacy values `'me'`/`'friend'` (normalized to `'brent'`/`'dan'` in `math.js`)

**settings** — key/value: `pin`, `pin_dan`, `my_name`, `friend_name`, `default_book_CHATID` (Telegram per-chat default book)

**pending_bets** — Telegram bot queue. Stages: `awaiting_splits` → `awaiting_confirm` → `confirmed`

**activity_log** — actions: `login`, `bets_placed`, `bet_settled`, `bet_deleted`, `undo`, `transaction_added`, `bet_edited`

**snapshots** — date-unique daily snapshots for the performance chart (cash + at_risk + per-book JSON)

## Key Patterns

**Sportsbook balance is a running ledger.** When a bet is placed, settled, deleted, or edited, `_adjustBookBalance()`/`_betSettleDelta()` in `app.js` compute how the book balance should change. Undo reverses this exactly. Editing a bet's wager/odds/boost/sportsbook also reconciles the balance delta — don't let a field edit leave `current_balance` stale. Do not double-apply deltas.

**No forced equity normalization.** `personEquity()` in `math.js` returns raw ledger values, and both the Pool page and each person's own page show that same raw number — they must always agree. Do **not** rescale Brent + Dan to force them to sum to Pool Total; if they don't match, that's real drift (an unlogged correction, a pending bet, a bug) and should be visible, not hidden. Close real drift by logging an `adjustment` transaction at the source (Update Balance / Add Snapshot already do this automatically), not by rescaling the display.

**Supabase caps a single REST request at 1000 rows.** `bets` has already exceeded that. `DB.getBets()` / `DB.getTransactions()` in `js/db.js` page through `.range()` until a partial page comes back — any new query against a table that can grow needs the same treatment, or it will silently drop the oldest rows from every calculation that reads it.

**Odds are stored pre-boost.** `base_odds` in the DB is the raw line. `boostedOdds()` in `math.js` applies `boost_pct` at display/calculation time. Never store boosted odds.

**Undo stack** is capped at 3 entries in `state.undoStack`. Each entry stores enough to reverse a settle or delete (prior status, prior book balance). Toast auto-expires after 5 seconds.

**Two-person split validation.** In the add/edit bet modal, Dan's wager is typed directly; Brent's wager is derived as the exact remainder (`total_wager - his_wager`, rounded to the cent) rather than trusted as typed, so the two always sum to `total_wager` exactly. The `±$0.02` check on the typed values just catches fat-finger input before deriving the final number.

## Telegram Bot Flow

1. User sends a photo of a bet slip to the bot
2. Bot calls Claude (claude-opus-4-6) vision with a structured prompt → returns a bet-code string: `BOOK.SPORT.DESC.BOOST.TOTAL.??.??±ODDS`
3. Bot saves a `pending_bet` row (stage: `awaiting_splits`), asks Dan's cut
4. User replies with Dan's dollar amount → bot computes Brent's cut → previews → saves to `bets` table → adjusts sportsbook balance

Sportsbook aliases in the bot: DK→DraftKings, FD→FanDuel, MGM→BetMGM, CS/theScore→theScore Bet, etc.

The bot never settles a bet (won/lost/push) — settlement only happens through the app UI, or the auto-grader below.

Multi-leg bets (parlays/SGPs) also get a structured `legs` array (`{team_or_player, market, selection}` per leg, stored in `bets.legs` jsonb) so they're checkable later — the `description` field alone (e.g. `Wemby-Castle-2Leg`) isn't enough for anything to grade against. Straight bets leave `legs` null.

## Auto-Grader (`grade-bets`)

Runs daily via `pg_cron` (job `grade-bets-daily`, `0 13 * * *` UTC, calls the edge function through `pg_net` with the project anon key as the bearer token — required because the function has `verify_jwt: true`, unlike the Telegram webhook). For each open (`status = 'pending'`, `version = 2`) bet placed more than 5 hours ago that hasn't already been graded (dedup via `activity_log` action `grade_suggested`/`grade_auto_settled`), it asks Claude (`claude-opus-4-8` + the `web_search_20260209` tool) to find the actual result and return `{verdict, confidence, explanation}`.

- **Auto-settles without a human tap** only when: no `legs` (straight bet), `confidence: "high"`, and verdict is won/lost/push — never void. Sends a Telegram FYI (no buttons).
- **Everything else** — multi-leg bets, lower confidence, or a void guess — gets a Telegram message with Won/Lost/Push/Void/Leave-open buttons (`gw:`/`gl:`/`gp:`/`gv:`/`gs:` + bet id), handled by `handleGradeCallback` in `telegram-bot/index.ts`. `verdict: "unknown"` sends nothing and is retried on a later run (still logged, so it isn't re-researched every day).
- Settle math (`boostedOdds`/`totalReturn`/`betSettleDelta`) is duplicated in both edge functions and must stay in sync with `js/math.js` — there's no shared module between the browser app and Deno functions.
- Notify chat is whichever chat has a `default_book_<chatId>` setting (i.e., has used the bot before) — no separate config needed.

## Migrations

SQL migrations live in the repo root (not a `migrations/` folder). Apply manually via the Supabase dashboard SQL editor or `./db.sh push <file>`. Files: `schema.sql`, `update.sql`, `add_activity_log.sql`, `add_pending_bets.sql`, `add_pending_bets_stage.sql`, `add_snapshots.sql`, `add_transaction_types.sql` (widens `transactions.type` to include `redeployment`, `payout`, `adjustment` — must be applied before adjustment-logging features will insert successfully), `add_version_v2.sql` (the V1→V2 season split: `version` columns + `void` status; already applied), `add_legs_and_grading_support.sql` (bets.legs jsonb + pg_cron/pg_net extensions; already applied — see Auto-Grader above).

## +EV Core (`supabase/functions/_shared/ev/`)

Pure TypeScript for the planned +EV promo bot (`/devig`, `/promo`, `/best`): odds conversions, four devig methods (multiplicative, additive, power, Shin) plus worst-case, profit-boost EV, Kelly, free-bet value, and the plain-text bet card. No Telegram, DB, or Deno APIs, so a Discord adapter can reuse it. Imports use `.ts` extensions, so it runs under Deno and Node. Tests: `node --test supabase/functions/_shared/ev/ev.test.ts` (or `deno test`); the DK 50% boost worked example is pinned there.
