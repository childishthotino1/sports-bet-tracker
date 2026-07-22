# Sports Bet Tracker

PWA for tracking sports bets and P&L split between two people (Brent + Dan). No build step — vanilla JS + Supabase direct.

## Key Files
- `js/app.js` — routing and main logic
- `js/db.js` — ALL Supabase queries (read/write here for data changes)
- `js/math.js` — P&L math: odds conversion, boost %, split wager calculations
- `js/config.js` — Supabase URL/key
- `schema.sql` — DB source of truth; `add_*.sql` files are migrations
- `data/` — CSV exports from Dan, raw bet history

## Database Tables
- `sportsbooks` — balance per book
- `bets` — split wagers (`his_wager` / `my_wager`), odds, boost %, status (pending/won/lost/push)
- `transactions` — deposits/withdrawals/adjustments by person per book. Types: `deposit`, `withdrawal`, `redeployment`, `payout`, `disbursement`, `adjustment` (manual balance correction, logged automatically when you use Manage Books → Update Balance — see `add_transaction_types.sql`, must be pushed via `./db.sh push add_transaction_types.sql` before adjustments will insert)
- `snapshots` — balance snapshots over time
- `pending_bets` — unsettled bets staging (populated by the Telegram bot edge function, `supabase/functions/telegram-bot/`)

## Honeypot Reconciliation
Pool Total (`sportsbookTotal + bankBalance`) and Brent + Dan's equity (`personEquity`, summed from transactions + bet P&L) are two independently-derived numbers and can drift apart — a pending bet in flight, an unlogged balance correction, etc. The Honeypot page shows the real, unreconciled equity for both people (no forced normalization) and surfaces the gap as "Unreconciled" when it's non-trivial. Don't reintroduce silent rescaling to force Brent + Dan to sum to the pool total — that hides real bookkeeping drift instead of fixing it.

## Quick Tasks
- **New feature in UI** → edit `js/app.js`, style in `css/`
- **Change a DB query** → edit `js/db.js`
- **Fix P&L math** → edit `js/math.js`
- **Schema change** → update `schema.sql`, create a new `add_*.sql` migration
- **No build needed** — edits to JS/CSS/HTML are live immediately
