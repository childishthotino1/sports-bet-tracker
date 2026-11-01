-- Every bet the promo bot suggests (and every slip it checks), graded after the
-- game, to measure how the bot does. Its own table: the promo bot never touches
-- the bet tracker's tables. Written by the promo-bot and grade-picks edge
-- functions with the service role, so RLS is on with no policies.

create table if not exists promo_bot_picks (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  chat_id     text not null,
  source      text not null check (source in ('pick', 'sgp_legs', 'question', 'slip')),
  dedup_key   text not null unique,      -- the same suggestion twice in a day is one row
  book        text not null,
  league      text,
  kind        text not null check (kind in ('single', 'parlay', 'sgp')),
  promo_title text,
  boost_pct   numeric not null default 0,
  book_odds   integer,                   -- whole bet, before the boost; null for SGP leg ideas
  fair_prob   numeric,
  ev          numeric,                   -- what the bot predicted, after the boost
  verdict     text check (verdict in ('plus_ev', 'minus_ev')),
  legs        jsonb not null,            -- [{event_id, sport_key, game, start, market, selection, side, point, player, book_odds, fair, result, why}]
  first_start timestamptz,
  last_start  timestamptz,
  status      text not null default 'pending' check (status in ('pending', 'won', 'lost', 'push', 'ungraded')),
  profit      numeric,                   -- units at a flat 1-unit stake, boost included
  graded_at   timestamptz
);

create index if not exists promo_bot_picks_pending on promo_bot_picks (last_start) where status = 'pending';
alter table promo_bot_picks enable row level security;

-- One row per game the grader researched: how many tries, and what it found.
create table if not exists promo_bot_games (
  event_id    text primary key,
  sport_key   text,
  game        text,
  start       timestamptz,
  attempts    integer not null default 0,
  status      text,                      -- final / not_final / postponed / not_found
  result      jsonb,                     -- the research reply
  updated_at  timestamptz not null default now()
);
alter table promo_bot_games enable row level security;

-- One row per leg, for slicing in SQL (by book, league, market, source...).
create or replace view promo_bot_pick_legs with (security_invoker = true) as
select p.id as pick_id, p.created_at, p.source, p.book, p.league, p.kind, p.boost_pct, p.status as pick_status,
       l->>'game' as game, (l->>'start')::timestamptz as start, l->>'market' as market, l->>'selection' as selection,
       (l->>'book_odds')::int as book_odds, (l->>'fair')::numeric as fair, l->>'result' as result, l->>'why' as why
from promo_bot_picks p, jsonb_array_elements(p.legs) l;
