-- ============================================================================
--  Run Club — Database Schema
--  Paste this entire file into the Supabase SQL Editor.
-- ============================================================================

-- Drop old tables if rebuilding
drop table if exists public.runs cascade;
drop table if exists public.group_invites cascade;
drop table if exists public.group_members cascade;
drop table if exists public.groups cascade;
drop table if exists public.friends cascade;
drop table if exists public.profiles cascade;

-- Profiles table linked to Supabase Auth
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  display_name text,
  avatar_url text,
  email text,
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

-- Groups table
create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz default now()
);

-- Group members table
create table public.group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid references public.groups(id) on delete cascade not null,
  user_id uuid references public.profiles(id) on delete cascade not null,
  role text not null check (role in ('owner', 'member')) default 'member',
  joined_at timestamptz default now(),
  unique (group_id, user_id)
);

-- Discord-style invitation codes
create table public.group_invites (
  code text primary key,
  group_id uuid references public.groups(id) on delete cascade not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz default now()
);

-- Revised Runs table (linked to profiles)
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

-- Helper functions for RLS to avoid circular recursion
create or replace function public.is_group_member(group_uuid uuid, user_uuid uuid)
returns boolean security definer as $$
begin
  return exists (
    select 1 from public.group_members
    where group_id = group_uuid and user_id = user_uuid
  );
end;
$$ language plpgsql;

create or replace function public.is_group_owner(group_uuid uuid, user_uuid uuid)
returns boolean security definer as $$
begin
  return exists (
    select 1 from public.group_members
    where group_id = group_uuid and user_id = user_uuid and role = 'owner'
  );
end;
$$ language plpgsql;

-- ============================================================================
-- Row Level Security (RLS) Policies
-- ============================================================================
alter table public.profiles enable row level security;
alter table public.friends enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.group_invites enable row level security;
alter table public.runs enable row level security;

-- Profiles: viewable by anyone, updatable by owner
create policy "View profiles" on public.profiles for select using (true);
create policy "Update profile" on public.profiles for update using (auth.uid() = id);

-- Friends: viewable, insertable, updatable, and deletable by the two involved users
create policy "View friendships" on public.friends for select using (auth.uid() = user_id or auth.uid() = friend_id);
create policy "Create friendship request" on public.friends for insert with check (auth.uid() = user_id);
create policy "Accept friendship request" on public.friends for update using (auth.uid() = user_id or auth.uid() = friend_id);
create policy "Remove friendship" on public.friends for delete using (auth.uid() = user_id or auth.uid() = friend_id);

-- Groups & Members
create policy "View groups in memberships" on public.groups for select using (
  auth.uid() = created_by or public.is_group_member(id, auth.uid())
);
create policy "Create group" on public.groups for insert with check (auth.uid() = created_by);
create policy "Update group details" on public.groups for update using (
  public.is_group_owner(id, auth.uid())
);

create policy "View group memberships" on public.group_members for select using (
  public.is_group_member(group_id, auth.uid())
);
create policy "Join group" on public.group_members for insert with check (auth.uid() = user_id);
create policy "Leave or kick group member" on public.group_members for delete using (
  auth.uid() = user_id or public.is_group_owner(group_id, auth.uid())
);

-- Invites: public select (so visitors can read group info to join), insert by group members
create policy "Read group invites" on public.group_invites for select using (true);
create policy "Create group invites" on public.group_invites for insert with check (
  public.is_group_member(group_id, auth.uid())
);

-- Runs: visible to self, accepted friends, or group co-members
create policy "View runs" on public.runs for select using (
  user_id = auth.uid() or
  exists (
    select 1 from public.friends f 
    where f.status = 'accepted' and (
      (f.user_id = auth.uid() and f.friend_id = runs.user_id) or
      (f.friend_id = auth.uid() and f.user_id = runs.user_id)
    )
  ) or
  exists (
    select 1 from public.group_members m1
    join public.group_members m2 on m1.group_id = m2.group_id
    where m1.user_id = auth.uid() and m2.user_id = runs.user_id
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
returns trigger as $$
begin
  insert into public.profiles (id, display_name, avatar_url, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', 'Runner'),
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture'),
    new.email
  );
  return new;
end;
$$ language plpgsql security definer;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Enable realtime broadcasts for runs
alter publication supabase_realtime add table public.runs;

-- Backfill any existing auth users into the profiles table
insert into public.profiles (id, display_name, avatar_url, email)
select 
  id, 
  coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name', 'Runner'),
  coalesce(raw_user_meta_data->>'avatar_url', raw_user_meta_data->>'picture'),
  email
from auth.users
on conflict (id) do nothing;
