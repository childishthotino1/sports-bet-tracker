-- Widen transactions.type to cover every type the app code actually writes.
-- 'redeployment' and 'payout' were already used by js/app.js (Money Moves modal)
-- but never made it into a committed migration — only 'disbursement' was added
-- in update.sql. 'adjustment' is new: used to log manual sportsbook balance
-- corrections (Manage Books → Update) so they're reflected in personEquity()
-- instead of silently orphaning the pool total from Brent + Dan's totals.
-- Run via: ./db.sh push add_transaction_types.sql

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;

ALTER TABLE transactions
  ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('deposit', 'withdrawal', 'disbursement', 'redeployment', 'payout', 'adjustment'));
