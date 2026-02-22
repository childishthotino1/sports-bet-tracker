-- ============================================================
-- Baltimore Bets — Early History Seed
-- Covers the pre-tracking period (9/1/2025 – 10/22/2025)
-- before individual bet records begin on 10/23/2025.
--
-- Run AFTER seed.sql:
--   ./db.sh push history_seed.sql
-- ============================================================

-- ── Placeholder bet for early season P&L ─────────────────
-- Between 9/1 and 10/22, net results were:
--   Dan:   $647.31 deposited → $302.11 equity → -$345.20 net loss
--   Brent: $1,125.00 deposited → $1,089.05 equity → -$35.95 net loss
-- A single aggregate "lost" bet encodes this in the equity model.
INSERT INTO bets (
  sportsbook_id,
  sport,
  description,
  base_odds,
  boost_pct,
  total_wager,
  my_wager,
  his_wager,
  status,
  placed_at,
  settled_at
)
SELECT
  id,
  'Various',
  'Early Season (9/1–10/22)',
  0,
  0,
  381.15,
  35.95,
  345.20,
  'lost',
  '2025-10-22 12:00:00+00',
  '2025-10-22 12:00:00+00'
FROM sportsbooks
WHERE name = 'theScore Bet';

-- ── Fix snapshot values to match actual balances ─────────
-- 10/22: estimated $1,216.16, actual book total $1,391.16
UPDATE snapshots
SET cash = 1391.16
WHERE snapshot_date = '2025-10-22';

-- 11/03: estimated $4,319.42, actual book total $4,399.42
UPDATE snapshots
SET cash = 4399.42
WHERE snapshot_date = '2025-11-03';
