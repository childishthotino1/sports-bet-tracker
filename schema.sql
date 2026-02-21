-- ============================================================
-- Sports Bet Tracker — Supabase Schema
-- ============================================================
-- HOW TO RUN:
-- 1. Open your Supabase project at supabase.com
-- 2. Click "SQL Editor" in the left sidebar
-- 3. Paste this entire file and click Run
-- ============================================================

CREATE TABLE IF NOT EXISTS sportsbooks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  current_balance DECIMAL(10,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bets (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sportsbook_id UUID REFERENCES sportsbooks(id) ON DELETE RESTRICT,
  sport TEXT NOT NULL,
  description TEXT NOT NULL,
  boost_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  total_wager DECIMAL(10,2) NOT NULL,
  his_wager DECIMAL(10,2) NOT NULL,
  my_wager DECIMAL(10,2) NOT NULL,
  base_odds INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'won', 'lost', 'push')),
  placed_at TIMESTAMPTZ DEFAULT NOW(),
  settled_at TIMESTAMPTZ,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('deposit', 'withdrawal')),
  sportsbook_id UUID REFERENCES sportsbooks(id) ON DELETE RESTRICT,
  person TEXT NOT NULL CHECK (person IN ('me', 'friend')),
  amount DECIMAL(10,2) NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Default settings (PIN is 1234 — update in Supabase dashboard or via app later)
INSERT INTO settings (key, value) VALUES
  ('pin', '1234'),
  ('my_name', 'Brent'),
  ('friend_name', 'Friend')
ON CONFLICT (key) DO NOTHING;
