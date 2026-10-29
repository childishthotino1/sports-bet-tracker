-- Promo bot (@Bmorepromobot) conversation state: where each chat is in the
-- promo flow between messages. Separate from every bet-tracker table.
-- RLS on with no policies: only the edge function's service role reads it.

create table if not exists promo_bot_state (
  chat_id    text primary key,
  state      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table promo_bot_state enable row level security;
