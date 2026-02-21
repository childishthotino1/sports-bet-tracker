-- ============================================================
-- Sports Bet Tracker — Schema Update
-- ============================================================
-- Run this in Supabase SQL Editor to apply these changes.
-- ============================================================

-- Update names
UPDATE settings SET value = 'Brent' WHERE key = 'my_name';
UPDATE settings SET value = 'Dan'   WHERE key = 'friend_name';

-- Update transactions: add 'disbursement' type, rename persons to 'brent'/'dan'
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_person_check;

ALTER TABLE transactions
  ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('deposit', 'withdrawal', 'disbursement'));

ALTER TABLE transactions
  ADD CONSTRAINT transactions_person_check
  CHECK (person IN ('brent', 'dan'));

-- Make sportsbook_id nullable (disbursements don't belong to a sportsbook)
ALTER TABLE transactions ALTER COLUMN sportsbook_id DROP NOT NULL;

-- Migrate any existing data with old person values
UPDATE transactions SET person = 'brent' WHERE person = 'me';
UPDATE transactions SET person = 'dan'   WHERE person = 'friend';
