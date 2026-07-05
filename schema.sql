-- ============================================================================
--  Run Club — database schema
--  Paste this whole file into the Supabase SQL Editor (Dashboard → SQL Editor
--  → New query → Run). Safe to run more than once.
-- ============================================================================

create table if not exists public.runs (
  id           uuid primary key default gen_random_uuid(),
  runner       text not null,
  distance_km  numeric not null check (distance_km > 0),
  duration_min numeric check (duration_min is null or duration_min > 0),
  run_date     date not null default current_date,
  notes        text,
  created_at   timestamptz not null default now()
);

-- Helpful index for the newest-first list and date-range leaderboards.
create index if not exists runs_run_date_idx on public.runs (run_date desc);

-- ---------------------------------------------------------------------------
--  Row Level Security
--  For a small private friend group we allow the public "anon" key full access
--  to this one table. Real protection = the site URL + passcode aren't shared
--  publicly. If you ever want stricter control, switch to Supabase Auth.
-- ---------------------------------------------------------------------------
alter table public.runs enable row level security;

drop policy if exists "group read"   on public.runs;
drop policy if exists "group insert" on public.runs;
drop policy if exists "group update" on public.runs;
drop policy if exists "group delete" on public.runs;

create policy "group read"   on public.runs for select using (true);
create policy "group insert" on public.runs for insert with check (true);
create policy "group update" on public.runs for update using (true) with check (true);
create policy "group delete" on public.runs for delete using (true);

-- ---------------------------------------------------------------------------
--  Realtime: broadcast every insert/update/delete on this table to clients.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.runs;
