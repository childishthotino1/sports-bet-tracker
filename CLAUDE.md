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
supabase functions deploy promo-bot --no-verify-jwt   # Telegram can't send a JWT
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
  promo-bot/        # @Bmorepromobot webhook: promo screenshot → rules → best bets / check a bet (separate bot)
  _shared/ev/       # +EV core used by promo-bot: devig, EV, Kelly, promo rules + flow, odds client, picks
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

SQL migrations live in the repo root (not a `migrations/` folder). Apply manually via the Supabase dashboard SQL editor or `./db.sh push <file>`. Files: `schema.sql`, `update.sql`, `add_activity_log.sql`, `add_pending_bets.sql`, `add_pending_bets_stage.sql`, `add_snapshots.sql`, `add_transaction_types.sql` (widens `transactions.type` to include `redeployment`, `payout`, `adjustment` — must be applied before adjustment-logging features will insert successfully), `add_version_v2.sql` (the V1→V2 season split: `version` columns + `void` status; already applied), `add_legs_and_grading_support.sql` (bets.legs jsonb + pg_cron/pg_net extensions; already applied — see Auto-Grader above), `add_promo_bot_state.sql` (promo bot's per-chat conversation state; RLS on, no policies).

## +EV Core (`supabase/functions/_shared/ev/`)

Pure TypeScript for the planned +EV promo bot (`/devig`, `/promo`, `/best`): odds conversions, four devig methods (multiplicative, additive, power, Shin) plus worst-case, profit-boost EV, Kelly, free-bet value, and the plain-text bet card. No Telegram, DB, or Deno APIs, so a Discord adapter can reuse it. Imports use `.ts` extensions, so it runs under Deno and Node. Tests: `node --test supabase/functions/_shared/ev/*.test.ts` (or `deno test`); the DK 50% boost worked example is pinned there.

`promo-examples.md` is the bot's reference for reading promos: real screenshots described in words, the gotcha each one teaches, and the JSON it should produce. Its whole text goes into the vision prompt (`promoPrompt()`), and the tests check every JSON block in it, so it doubles as the promo test cases. To teach the bot a new kind of promo, add a section there; no code change needed. It's context, not a database: there's no promo log.

`promo-flow.ts` is the conversation after a screenshot is read: buttons for whatever the screenshot didn't show (book, max wager), then "check a bet I'm building" → book price → fair price (an assumed book margin, or a typed price) → EV verdict. It's stateless; the bot stores `FlowState` per chat (its own table) and calls `step()` with each tap or reply.

`promo.ts` holds the promo JSON schema and prompt, `normalizePromo`, and the rule checks (`promoViolations`, `promoStake`, `breakEvenProb`). `slip.ts` does the same for bet slips and prices them (below). `image.ts` combines both into one vision schema (`kind`: promo / slip / other); `vision.ts` is the Claude call that fills it, and it imports `npm:@anthropic-ai/sdk`, so it's Deno-only and not re-exported from `mod.ts`.

**Odds feed: The Odds API** (v4, `odds-api.ts`). Book prices come from the promo's book; sharp prices from Pinnacle (its `pinnacle` key; Pinnacle closed its own public API in July 2025). Credits per odds call are markets × regions, so main lines for a whole sport are one call, while player props need one `/events/{id}/odds` call per game. `picks.ts` prices every leg the book offers against Pinnacle's worst-case devig (`priceLegs`), then builds qualifying singles and cross-game parlays and ranks them by boosted EV (`bestBets`). Same-game parlays aren't auto-picked: the feed has no SGP prices, and the book's SGP price includes correlation. **Sharp prices: Pinnacle plus four exchanges** (`sharp.ts`): Novig, ProphetX, Kalshi and Polymarket ride in the same request as the book (up to 10 bookmakers bill as one region, so no extra credits). Each source's line is devigged on its own (worst case), then the fair probabilities are averaged; the card lists every source with its hold. The exchanges post both sides of bets the sportsbooks sell one way (anytime TD "No") and price lines Pinnacle skips (Pinnacle has no NFL anytime TD). Exchanges list every resting offer, many stale or for a few dollars, so each side keeps its best price with at least $50 behind it (`includeBetLimits`), and a line is dropped if a side is missing or the hold is under 0 (crossed) or over 10%. Pinnacle's prop limits are $250–500 against $10K+ on game lines, so its prop prices are the weakest of its quotes. Caesars and Fanatics need a paid Odds API plan; Circa and Bookmaker aren't on the feed. Real CAR@GB pull with all five: `samples/nfl-2026-10-29-car-gb.json`. Checked against a real NBA pull (`samples/nba-2026-10-29.json`): Pinnacle main lines come through; Caesars and Fanatics returned nothing; Pinnacle posts lines close to game time; started games are skipped by default because live lines from different books are captured at different moments (a frozen BetMGM live market sat at +1400).

**Keep the promo bot out of `telegram-bot`.** That function treats every incoming photo as a bet slip and queues it in `pending_bets`, so a promo screenshot sent there becomes a bogus pending bet. The promo bot gets its own edge function and its own Telegram bot token (its own webhook); nothing in `_shared/ev/` is imported by the live bet-tracking functions. The Supabase CLI doesn't deploy `_`-prefixed folders as functions.

## Promo Bot (`promo-bot`, @Bmorepromobot)

Its own Telegram bot, token, webhook, and table (`promo_bot_state`); it never reads or writes the bet tracker's tables. Any photo goes to `readImage` (Claude vision, with `promo-examples.md` as context), which says whether it's a promo, a bet slip, or neither.

- **Promo** → `promo-flow.ts` buttons for whatever's missing (book, max wager; the sport when the promo names none) → **🎯 Find the best bets** (The Odds API: the promo's book + Pinnacle main lines, `priceLegs` → `bestBets`, or `noPicksReason`) or **🔍 Check a bet I'm building**, which waits for a slip screenshot (typing the slip's price is the fallback, priced with an assumed margin). SGP-only promos get leg suggestions instead (`suggestSgpLegs`: best-priced legs vs Pinnacle in the promo's game, at most one game-result leg so it never bets both sides), and then wait for the slip.
- **Slip** (at any point; with the active promo's boost if one is in play, otherwise none) → find each leg's game (`/events`, free) → that game's odds for the slip's markets, alternate lines included → each leg devigged against Pinnacle, falling back to the book's own two-way price (or a 6% one-sided margin) and saying so → `checkSlip` / `formatSlipCheck`. **SGPs:** the feed has no SGP prices, so the fair estimate keeps the book's own correlation adjustment (its SGP price ÷ its legs multiplied) and swaps each leg's vig for the fair price; the card says how much extra SGP margin the book can add before the bet turns -EV.

Button taps arrive as `callback_data` `pf:<value>`.

Secrets: `PROMO_BOT_TOKEN`, `PROMO_WEBHOOK_SECRET` (Telegram sends it as `X-Telegram-Bot-Api-Secret-Token`; anything else gets 403), `PROMO_ALLOWED` (comma list of chat IDs and/or `@usernames`; others get "This bot is private" with their chat ID), `ODDS_API_KEY`, and the existing `ANTHROPIC_API_KEY`. Never name a secret `TELEGRAM_BOT_TOKEN`: secrets are project-wide, and that one belongs to the tracker bot.

The bot imports the examples from `promo-examples.ts`, generated from the `.md` (edge functions can't read a bundled `.md`): after editing the `.md`, run `node supabase/functions/_shared/ev/gen-examples.mjs` (a test fails if they drift).
