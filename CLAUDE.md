# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**Baltimore Bets** — a two-person sports betting P&L tracker for Brent + Dan. Vanilla JS PWA backed by Supabase (PostgreSQL). No build step; all dependencies loaded via CDN. Deployed as a static site.

Users (Brent and Dan) each have a 4-digit PIN stored in the `settings` table (`pin` and `pin_dan` keys). Equity is tracked as a ledger: deposits + adjustments + bet P&L - payouts = each person's bag.

## Running & Deploying

No build step. Open `index.html` directly or serve any static file server:
```bash
npx serve .
# or: python3 -m http.server 8000
```

There's no separate dev/staging database — `js/config.js` points straight at the production Supabase project, so local testing is testing against real shared data.

Supabase edge functions (Telegram bot, bet parser) live in `supabase/functions/`. Deploy with:
```bash
supabase functions deploy telegram-bot
supabase functions deploy parse-bet
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
```

**Load order matters:** `config.js` must load before `db.js`; `math.js` before `app.js`.

## Data Model

**sportsbooks** — live cash balance per book (theScore, DraftKings, FanDuel, BetMGM, Bet365, Fanatics, Caesars)

**bets** — `sportsbook_id`, `sport`, `description`, `base_odds` (pre-boost), `boost_pct`, `total_wager`, `my_wager` (Brent), `his_wager` (Dan), `status` (pending/won/lost/push). Can exceed 1000 rows — see pagination note below.

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

The bot never settles a bet (won/lost/push) — settlement only happens through the app UI.

## Migrations

SQL migrations live in the repo root (not a `migrations/` folder). Apply manually via the Supabase dashboard SQL editor or `./db.sh push <file>`. Files: `schema.sql`, `update.sql`, `add_activity_log.sql`, `add_pending_bets.sql`, `add_pending_bets_stage.sql`, `add_snapshots.sql`, `add_transaction_types.sql` (widens `transactions.type` to include `redeployment`, `payout`, `adjustment` — must be applied before adjustment-logging features will insert successfully).
