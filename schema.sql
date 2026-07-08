-- ============================================================================
--  Runaway — Database Schema
--  Paste this entire file into the Supabase SQL Editor.
-- ============================================================================

-- Drop old tables if rebuilding. The group_* tables are dropped (not recreated)
-- because the group feature has been removed — this cleans them out of any
-- earlier install.
drop table if exists public.runs cascade;
drop table if exists public.group_invites cascade;
drop table if exists public.group_members cascade;
drop table if exists public.groups cascade;
drop table if exists public.friends cascade;
drop table if exists public.profiles cascade;

-- Drop now-removed group helper/RPC functions from earlier installs.
drop function if exists public.is_group_member(uuid, uuid) cascade;
drop function if exists public.is_group_owner(uuid, uuid) cascade;
drop function if exists public.get_invite(text) cascade;
drop function if exists public.join_group_by_code(text) cascade;

-- Generate a short, unique, human-shareable friend code (e.g. "AB12CD").
-- Used as the profiles.friend_code default so EVERY profile gets one — whether
-- created by the signup trigger, the app's self-heal insert, or the backfill
-- below. Alphabet omits ambiguous chars (0/O, 1/I) so codes are easy to read
-- aloud and retype. SECURITY DEFINER so the uniqueness check can see all rows
-- even under RLS. Defined before profiles so the column default can reference it
-- (plpgsql defers the table lookup, so the not-yet-created table is fine here).
create or replace function public.gen_friend_code()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text;
  i int;
begin
  loop
    code := '';
    for i in 1..6 loop
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.profiles where friend_code = code);
  end loop;
  return code;
end;
$$;

-- Profiles table linked to Supabase Auth
-- NOTE: email is intentionally NOT stored here. Any column here is visible to
-- every signed-in user (for Discord-style profile lookups). Email lives only in
-- auth.users; the client reads it from the signed-in session, never from here.
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  display_name text,
  avatar_url text,
  friend_code text unique default public.gen_friend_code(),
  created_at timestamptz default now()
);

-- Friendship table (Discord style request -> accept)
create table public.friends (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade not null,
  friend_id uuid references public.profiles(id) on delete cascade not null,
  status text not null check (status in ('pending', 'accepted')),
  created_at timestamptz default now(),
  unique (user_id, friend_id),
  constraint no_self_friend check (user_id <> friend_id)
);

-- Runs table (linked to profiles)
create table public.runs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references public.profiles(id) on delete cascade not null,
  distance_km  numeric not null check (distance_km > 0),
  duration_min numeric check (duration_min is null or duration_min > 0),
  run_date     date not null default current_date,
  notes        text,
  created_at   timestamptz not null default now()
);

-- Indexes for efficient queries
create index runs_user_date_idx on public.runs(user_id, run_date desc);
create index runs_run_date_idx on public.runs(run_date desc);

-- ============================================================================
-- Row Level Security (RLS) Policies
-- ============================================================================
alter table public.profiles enable row level security;
alter table public.friends enable row level security;
alter table public.runs enable row level security;

-- Profiles: readable by any SIGNED-IN user (needed for friend-code lookups and
-- Discord-style profile previews), but NOT by anonymous callers holding the
-- public anon key — that blocks scraping the whole user list. Insert/update
-- limited to the owner. The insert policy lets the app self-heal a missing
-- profile (the client fallback in app.js) when the signup trigger didn't fire.
create policy "View profiles" on public.profiles for select using (auth.role() = 'authenticated');
create policy "Create own profile" on public.profiles for insert with check (auth.uid() = id);
create policy "Update profile" on public.profiles for update using (auth.uid() = id);

-- Friends: viewable, insertable, updatable, and deletable by the two involved users
create policy "View friendships" on public.friends for select using (auth.uid() = user_id or auth.uid() = friend_id);
create policy "Create friendship request" on public.friends for insert with check (auth.uid() = user_id);
create policy "Accept friendship request" on public.friends for update
  using (auth.uid() = user_id or auth.uid() = friend_id)
  with check (auth.uid() = user_id or auth.uid() = friend_id);
create policy "Remove friendship" on public.friends for delete using (auth.uid() = user_id or auth.uid() = friend_id);

-- Runs: visible to self or accepted friends
create policy "View runs" on public.runs for select using (
  user_id = auth.uid() or
  exists (
    select 1 from public.friends f
    where f.status = 'accepted' and (
      (f.user_id = auth.uid() and f.friend_id = runs.user_id) or
      (f.friend_id = auth.uid() and f.user_id = runs.user_id)
    )
  )
);
create policy "Insert own runs" on public.runs for insert with check (auth.uid() = user_id);
create policy "Update own runs" on public.runs for update using (auth.uid() = user_id);
create policy "Delete own runs" on public.runs for delete using (auth.uid() = user_id);

-- ============================================================================
-- Triggers & Publications
-- ============================================================================

-- Auto-create profile from Google Auth signup data
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', 'Runner'),
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture')
  );
  return new;
end;
$$;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Enable realtime broadcasts. runs powers the live feed/leaderboard; friends
-- powers live friend-request arrival and the tab notification badge. Both tables
-- were dropped above, which also removed them from the publication, so these
-- adds are safe to re-run.
alter publication supabase_realtime add table public.runs;
alter publication supabase_realtime add table public.friends;

-- Backfill any existing auth users into the profiles table.
-- Done row-by-row (not a single INSERT...SELECT) so each row's friend_code
-- default runs as its own statement and can see the codes assigned to earlier
-- rows — guaranteeing uniqueness across the backfilled set.
do $$
declare u record;
begin
  for u in select id, raw_user_meta_data from auth.users loop
    insert into public.profiles (id, display_name, avatar_url)
    values (
      u.id,
      coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', 'Runner'),
      coalesce(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture')
    )
    on conflict (id) do nothing;
  end loop;
end $$;

-- ============================================================================
-- Storage: avatars bucket (custom profile picture uploads)
-- Without this bucket, uploadAvatar() in db.js fails with "Bucket not found".
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- Storage policies live on storage.objects (which we never drop), so guard the
-- re-run case by dropping first — unlike the table policies above, whose tables
-- are dropped and recreated fresh at the top of this file.
drop policy if exists "Avatar images are publicly readable" on storage.objects;
drop policy if exists "Users can upload their own avatar" on storage.objects;
drop policy if exists "Users can update their own avatar" on storage.objects;
drop policy if exists "Users can delete their own avatar" on storage.objects;

-- Public read; write limited to the uploader's own folder. uploadAvatar() stores
-- files at "<uid>/<timestamp>.webp", so the first path segment is the owner id.
create policy "Avatar images are publicly readable"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "Users can upload their own avatar"
  on storage.objects for insert
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users can update their own avatar"
  on storage.objects for update
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users can delete their own avatar"
  on storage.objects for delete
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
