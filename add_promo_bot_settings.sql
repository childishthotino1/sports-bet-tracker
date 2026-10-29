-- Promo bot (@Bmorepromobot) per-chat settings, e.g. which markets picks use
-- ({"markets": "all" | "main" | "props"}). Kept apart from promo_bot_state so
-- /skip, which deletes the conversation, keeps them.
-- RLS on with no policies: only the edge function's service role reads it.

create table if not exists promo_bot_settings (
  chat_id    text primary key,
  settings   jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table promo_bot_settings enable row level security;
