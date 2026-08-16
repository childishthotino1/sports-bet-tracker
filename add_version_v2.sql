-- ============================================================
-- V2 season split — APPLIED 2026-08-15 via Supabase MCP
-- (recorded here for the repo's migration convention)
-- ============================================================
-- 1. Every table that accumulates season data gets a `version`
--    column. Existing rows were backfilled to 1 (V1 history);
--    new rows default to 2, so the app and the Telegram bot
--    write V2 rows without any edge-function changes.
-- 2. bets.status check widened to allow 'void' (bet cancelled
--    by the book — wager refunded, excluded from P&L/record).
--
-- V1 was closed out the same day: pool, bank, and both equities
-- were zeroed with version=1 transactions —
--   adjustment  brent   +286.18  (50/50 split of $572.36 drift)
--   adjustment  dan     +286.18
--   payout      brent    412.68  'V1 final payout — season closed'
--   payout      dan    10402.11  'V1 final payout — season closed'

ALTER TABLE bets         ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 2;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 2;
ALTER TABLE snapshots    ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 2;
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 2;
ALTER TABLE pending_bets ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 2;

UPDATE bets         SET version = 1;
UPDATE transactions SET version = 1;
UPDATE snapshots    SET version = 1;
UPDATE activity_log SET version = 1;
UPDATE pending_bets SET version = 1;

CREATE INDEX IF NOT EXISTS idx_bets_version         ON bets(version);
CREATE INDEX IF NOT EXISTS idx_transactions_version ON transactions(version);

ALTER TABLE bets DROP CONSTRAINT IF EXISTS bets_status_check;
ALTER TABLE bets ADD CONSTRAINT bets_status_check
  CHECK (status IN ('pending', 'won', 'lost', 'push', 'void'));
