-- Add stage + parsed_data to pending_bets for conversational flow
-- Run via: ./db.sh push add_pending_bets_stage.sql

ALTER TABLE pending_bets ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'awaiting_splits';
ALTER TABLE pending_bets ADD COLUMN IF NOT EXISTS parsed_data JSONB;
