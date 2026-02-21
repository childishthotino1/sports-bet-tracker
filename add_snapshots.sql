-- ============================================================
-- Sports Bet Tracker — Add Snapshots Table
-- Run in Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS snapshots (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  snapshot_date DATE NOT NULL UNIQUE,
  cash          DECIMAL(10,2) NOT NULL,
  at_risk       DECIMAL(10,2) NOT NULL DEFAULT 0,
  book_balances JSONB DEFAULT '{}',
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Historical snapshots
INSERT INTO snapshots (snapshot_date, cash, at_risk, book_balances) VALUES
  ('2025-10-22', 1216.16,    0.00, '{"theScore Bet": 629.57,  "DraftKings": 163.81, "Bet365": 184.00,   "FanDuel": 238.78, "Fanatics": 0.00}'),
  ('2025-11-03', 4319.42,    0.00, '{"theScore Bet": 2168.58, "DraftKings": 111.08, "Bet365": 1910.03,  "FanDuel": 129.73, "Fanatics": 0.00}'),
  ('2025-11-06', 6063.75,    0.00, '{"theScore Bet": 3949.75, "DraftKings": 66.08,  "Bet365": 1938.19,  "FanDuel": 109.73, "Fanatics": 0.00}'),
  ('2025-11-17', 6947.20,  485.00, '{"theScore Bet": 4822.23, "DraftKings": 57.53,  "Bet365": 1929.15,  "FanDuel": 138.29, "Fanatics": 0.00}'),
  ('2025-12-05', 8533.17,   70.00, '{"theScore Bet": 5649.93, "DraftKings": 45.55,  "Bet365": 2253.80,  "FanDuel": 0.00,   "Fanatics": 583.89}'),
  ('2026-01-03', 7881.82,   80.00, '{"theScore Bet": 4841.47, "DraftKings": 90.00,  "Bet365": 2230.65,  "FanDuel": 68.20,  "Fanatics": 651.50}'),
  ('2026-01-17', 10877.45,  65.00, '{"theScore Bet": 6480.02, "DraftKings": 90.00,  "Bet365": 1000.00,  "FanDuel": 60.00,  "Fanatics": 651.50, "BetMGM": 2595.93}'),
  ('2026-02-21', 9301.98,  470.00, '{"theScore Bet": 6186.80, "DraftKings": 48.10,  "Bet365": 0.00,     "FanDuel": 194.52, "Fanatics": 383.83, "BetMGM": 2488.73}')
ON CONFLICT (snapshot_date) DO NOTHING;
