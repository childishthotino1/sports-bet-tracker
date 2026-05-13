# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**Baltimore Bets** — a two-person sports betting P&L tracker for Brent + Dan. Vanilla JS PWA backed by Supabase (PostgreSQL). No build step; all dependencies loaded via CDN. Deployed as a static site.

Users (Brent and Dan) each have a 4-digit PIN stored in the `settings` table (`pin` and `pin_dan` keys). Equity is tracked as a ledger: deposits + bet P&L - payouts = each person's bag.

## Running & Deploying

No build step. Open `index.html` directly or serve any static file server:
```bash
npx serve .
```

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

**bets** — `sportsbook_id`, `sport`, `description`, `base_odds` (pre-boost), `boost_pct`, `total_wager`, `my_wager` (Brent), `his_wager` (Dan), `status` (pending/won/lost/push)

**transactions** — deposits, withdrawals, redeployments (bank→book), payouts. `person` field has legacy values `'me'`/`'friend'` (normalized to `'brent'`/`'dan'` in `math.js`)

**settings** — key/value: `pin`, `pin_dan`, `my_name`, `friend_name`, `default_book_CHATID` (Telegram per-chat default book)

**pending_bets** — Telegram bot queue. Stages: `awaiting_splits` → `awaiting_confirm` → `confirmed`

**activity_log** — actions: `login`, `bets_placed`, `bet_settled`, `bet_deleted`, `undo`, `transaction_added`, `bet_edited`

**snapshots** — date-unique daily snapshots for the performance chart (cash + at_risk + per-book JSON)

## Key Patterns

**Sportsbook balance is a running ledger.** When a bet is settled won/lost, `_betSettleDelta()` in `app.js` computes how the book balance should change and calls `updateSportsbookBalance()`. Undo reverses this exactly. Do not double-apply deltas.

**Equity normalization.** `personEquity()` in `math.js` returns raw ledger values. The Pool view normalizes them so Brent + Dan always = 100% of whatever is in the pool. Do not show raw percentages — always normalize.

**Odds are stored pre-boost.** `base_odds` in the DB is the raw line. `boostedOdds()` in `math.js` applies `boost_pct` at display/calculation time. Never store boosted odds.

**Undo stack** is capped at 3 entries in `state.undoStack`. Each entry stores enough to reverse a settle or delete (prior status, prior book balance). Toast auto-expires after 5 seconds.

**Two-person split validation.** In the add/edit bet modal, `my_wager + his_wager` must equal `total_wager` ±$0.02. This is checked before saving.

## Telegram Bot Flow

1. User sends a photo of a bet slip to the bot
2. Bot calls Claude (claude-opus-4-6) vision with a structured prompt → returns a bet-code string: `BOOK.SPORT.DESC.BOOST.TOTAL.??.??±ODDS`
3. Bot saves a `pending_bet` row (stage: `awaiting_splits`), asks Dan's cut
4. User replies with Dan's dollar amount → bot computes Brent's cut → previews → saves to `bets` table → adjusts sportsbook balance

Sportsbook aliases in the bot: DK→DraftKings, FD→FanDuel, MGM→BetMGM, CS/theScore→theScore Bet, etc.

## Migrations

SQL migrations live in the repo root (not a `migrations/` folder). Apply manually via the Supabase dashboard SQL editor or `supabase db push`. Files: `schema.sql`, `add_activity_log.sql`, `add_pending_bets.sql`, `add_pending_bets_stage.sql`, `add_snapshots.sql`.
