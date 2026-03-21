-- Pending bets queue for Telegram bot intake
-- Run via: ./db.sh push add_pending_bets.sql

CREATE TABLE IF NOT EXISTS pending_bets (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id              TEXT NOT NULL,
  bet_code             TEXT,
  telegram_message_id  INTEGER,
  placed_at            TIMESTAMPTZ,
  status               TEXT NOT NULL DEFAULT 'pending',  -- pending | confirmed | skipped | replaced
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pending_bets_chat_status ON pending_bets (chat_id, status);
