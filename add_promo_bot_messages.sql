-- Promo bot messages with 🛒 bet-slip buttons, and when each bet's first game
-- starts. The buttons are the books' own links (one tap opens the book's app),
-- so a card can sit in the chat after its game is live; every 5 minutes the
-- sweep (promo-bot?sweep=1) swaps the buttons on started games for a
-- "Game started" note, so an old card can't open a live bet.
create table if not exists promo_bot_messages (
  id          bigserial primary key,
  chat_id     text not null,
  message_id  bigint not null,
  source      text not null,               -- pick / sgp_legs / slip_offer / better_price / question
  starts_at   timestamptz not null,        -- the bet's first game
  cleared_at  timestamptz,                 -- when the sweep took the buttons off
  created_at  timestamptz not null default now()
);
create index if not exists promo_bot_messages_due on promo_bot_messages (starts_at) where cleared_at is null;

-- Only the edge functions (service role) read or write it.
alter table promo_bot_messages enable row level security;

-- The sweep. No auth needed: promo-bot runs with verify_jwt off, and the sweep
-- only touches games already under way.
select cron.schedule('promo-bot-sweep', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://lsdqwfklbmcabxeewoys.supabase.co/functions/v1/promo-bot?sweep=1',
    body := '{}'::jsonb
  );
$$);
