-- ============================================================
-- Sports Bet Tracker — Full Data Seed
-- ============================================================
-- IMPORTANT: Run update.sql FIRST if you haven't already.
-- Then run this file in Supabase SQL Editor.
-- ============================================================

-- ── Sportsbooks (current real balances) ──────────────────
INSERT INTO sportsbooks (name, current_balance) VALUES
  ('theScore Bet', 6186.80),
  ('DraftKings',     48.10),
  ('FanDuel',       194.52),
  ('Fanatics',      383.83),
  ('Bet365',          0.00),
  ('BetMGM',       2488.73);

-- ── Dan's Deposits (Venmo → Brent → pool) ────────────────
-- sportsbook_id is null — Dan sent via Venmo, not direct to a book
INSERT INTO transactions (type, person, sportsbook_id, amount, notes, created_at) VALUES
  ('deposit', 'dan', NULL,  75.00, 'Venmo', '2025-09-07'),
  ('deposit', 'dan', NULL, 100.00, 'Venmo', '2025-09-09'),
  ('deposit', 'dan', NULL,  72.31, 'Venmo', '2025-09-10'),
  ('deposit', 'dan', NULL,  50.00, 'Venmo', '2025-09-12'),
  ('deposit', 'dan', NULL, 350.00, 'Venmo', '2025-10-16'),
  ('deposit', 'dan', NULL, 500.00, 'Venmo', '2025-11-21'),
  ('deposit', 'dan', NULL, 500.00, 'Venmo', '2026-01-04');

-- ── Brent's Deposits (into sportsbooks) ──────────────────
INSERT INTO transactions (type, person, sportsbook_id, amount, created_at) VALUES
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'DraftKings'),    50.00, '2025-09-01'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'theScore Bet'),  50.00, '2025-09-06'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'FanDuel'),       50.00, '2025-09-06'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'Fanatics'),      50.00, '2025-09-07'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'theScore Bet'), 100.00, '2025-09-08'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'theScore Bet'), 200.00, '2025-09-10'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'FanDuel'),       50.00, '2025-09-20'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'FanDuel'),       55.00, '2025-09-21'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'Bet365'),        50.00, '2025-09-19'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'Bet365'),        50.00, '2025-10-09'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'Bet365'),       300.00, '2025-10-20'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'Bet365'),       100.00, '2025-10-21'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'theScore Bet'),  10.00, '2025-10-13'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'theScore Bet'),  10.00, '2025-10-20'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'theScore Bet'),  10.00, '2025-10-27'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'theScore Bet'),  10.00, '2025-11-03'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'DraftKings'),   100.00, '2025-11-05'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'theScore Bet'),  10.00, '2025-11-10'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'theScore Bet'),  10.00, '2025-11-17'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'DraftKings'),    37.47, '2025-11-18'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'DraftKings'),   100.00, '2025-11-19'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'Fanatics'),      50.00, '2025-11-20'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'Fanatics'),     105.00, '2025-11-20'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'theScore Bet'),  10.00, '2025-11-24'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'FanDuel'),      100.00, '2025-12-05'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'theScore Bet'),  10.00, '2025-12-08'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'theScore Bet'),  10.00, '2025-12-15'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'theScore Bet'),  10.00, '2025-12-15'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'DraftKings'),   100.00, '2025-12-25'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'BetMGM'),       250.00, '2026-01-03'),
  ('deposit', 'brent', (SELECT id FROM sportsbooks WHERE name = 'DraftKings'),   100.00, '2026-02-08');

-- ── Withdrawals (sportsbook → bucket) ────────────────────
INSERT INTO transactions (type, person, sportsbook_id, amount, created_at) VALUES
  ('withdrawal', 'brent', (SELECT id FROM sportsbooks WHERE name = 'theScore Bet'),  841.47, '2026-01-04'),
  ('withdrawal', 'brent', (SELECT id FROM sportsbooks WHERE name = 'Bet365'),       1230.65, '2026-01-10'),
  ('withdrawal', 'brent', (SELECT id FROM sportsbooks WHERE name = 'Fanatics'),      265.00, '2026-01-18'),
  ('withdrawal', 'brent', (SELECT id FROM sportsbooks WHERE name = 'Fanatics'),      136.50, '2026-01-18'),
  ('withdrawal', 'brent', (SELECT id FROM sportsbooks WHERE name = 'Bet365'),        750.00, '2026-01-18'),
  ('withdrawal', 'brent', (SELECT id FROM sportsbooks WHERE name = 'theScore Bet'), 1110.39, '2026-01-27'),
  ('withdrawal', 'brent', (SELECT id FROM sportsbooks WHERE name = 'Fanatics'),      140.00, '2026-01-27'),
  ('withdrawal', 'brent', (SELECT id FROM sportsbooks WHERE name = 'Bet365'),        245.12, '2026-01-28');

-- ── Disbursements (bucket → person) ──────────────────────
INSERT INTO transactions (type, person, sportsbook_id, amount, notes, created_at) VALUES
  ('disbursement', 'brent', NULL, 2147.47, 'Brent pocket withdrawal', '2026-02-10');
