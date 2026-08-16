-- ============================================================
-- Auto-grader support — APPLIED 2026-08-16 via Supabase MCP
-- (recorded here for the repo's migration convention)
-- ============================================================
-- 1. bets.legs jsonb — structured parlay/SGP legs captured at intake by the
--    Telegram bot ({team_or_player, market, selection} per leg), so
--    multi-leg bets are checkable by grade-bets later. Null for straight
--    bets and all historical rows.
-- 2. pg_cron + pg_net — power the daily schedule that calls the grade-bets
--    edge function (see the "grade-bets-daily" cron job, set up separately
--    via `SELECT cron.schedule(...)`).

ALTER TABLE bets ADD COLUMN IF NOT EXISTS legs jsonb;

CREATE INDEX IF NOT EXISTS idx_activity_log_action ON activity_log(action);

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
