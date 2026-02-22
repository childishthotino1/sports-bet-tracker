-- ============================================================
-- Baltimore Bets — Activity Log
-- Run in Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS activity_log (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_name  TEXT NOT NULL,          -- 'brent' or 'dan'
  action     TEXT NOT NULL,          -- see below
  details    JSONB DEFAULT '{}',     -- action-specific context
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Actions logged:
--   login            { }
--   bets_placed      { count, bets: [{sport, description, total_wager}] }
--   bet_settled      { bet_id, sport, description, result, sportsbook }
--   bet_deleted      { bet_id, sport, description, sportsbook }
--   undo             { undone: 'settle'|'delete', bet_id, description }
--   transaction_added { type, amount, person }

-- Add Dan's PIN (update the value '0000' to Dan's actual PIN)
INSERT INTO settings (key, value) VALUES ('pin_dan', '0000')
ON CONFLICT (key) DO NOTHING;
