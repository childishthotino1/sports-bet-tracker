-- Weekly DraftKings NFL spreads for the HLD pick'em page (see
-- supabase/functions/nfl-spreads). One row per NFL week, keyed by the
-- Thursday's New York date. RLS on with no policies: only the edge function's
-- service role (and the dashboard / MCP) reads it.

create table if not exists nfl_spread_snapshots (
  week_of    date primary key,
  pulled_at  timestamptz not null,
  source     text not null default 'DraftKings',
  games      jsonb not null
);

alter table nfl_spread_snapshots enable row level security;

-- Thursday noon New York time. pg_cron runs in UTC, so fire at both 16:00
-- (EDT) and 17:00 (EST) UTC; the function only pulls in the noon-ET run.
-- The command reuses grade-bets-daily's headers (project anon key as bearer).
select cron.schedule(
  'nfl-spreads-thursday',
  '0 16,17 * * 4',
  replace((select command from cron.job where jobname = 'grade-bets-daily'), '/grade-bets', '/nfl-spreads')
);
