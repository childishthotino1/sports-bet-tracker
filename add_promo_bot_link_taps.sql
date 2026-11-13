-- The promo bot's 🛒 bet-slip buttons, and every tap on one.
--
-- Telegram doesn't tell a bot when a URL button is tapped, so each button the
-- bot sends points at the bot itself (promo-bot?go=<id>), which logs the tap and
-- redirects to the sportsbook link stored here. The dashboard reads both tables.
create table if not exists promo_bot_links (
  id          text primary key,              -- short random id in the button's URL
  chat_id     text not null,
  source      text not null,                 -- pick / sgp_legs / slip_offer / better_price / question
  label       text,                          -- the button's text, e.g. "🛒 Build in DraftKings"
  url         text not null,                 -- where the tap goes (the book's own link)
  starts_at   timestamptz,                   -- the bet's first game; taps after it get a "game started" page, not the book
  created_at  timestamptz not null default now()
);
create index if not exists promo_bot_links_chat on promo_bot_links (chat_id, created_at desc);

create table if not exists promo_bot_link_taps (
  id          bigserial primary key,
  link_id     text not null references promo_bot_links (id) on delete cascade,
  tapped_at   timestamptz not null default now()
);
create index if not exists promo_bot_link_taps_link on promo_bot_link_taps (link_id);

-- Only the edge functions (service role) read or write these.
alter table promo_bot_links enable row level security;
alter table promo_bot_link_taps enable row level security;

-- Added after the first deploy (a tap minutes after tip-off opened a live bet):
alter table promo_bot_links add column if not exists starts_at timestamptz;
