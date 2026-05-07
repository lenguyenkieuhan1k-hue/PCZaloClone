-- Multi-key license + per-license profiles isolation.
-- Each license gets its own profile partition + upgrade tracking.
--
-- Key changes:
-- 1. Add profiles table (partition by license_id)
-- 2. Modify licenses: add parent_license_id (for upgrade tracking), active_machine_id (single-session enforcement)
-- 3. Modify cloud_backups: unique(license_id) instead of unique(user_id)
-- 4. Add license_upgrades table (tracking tier upgrades)

-- 1. Add columns to licenses
alter table if exists public.licenses
  add column if not exists license_id uuid default gen_random_uuid() unique,
  add column if not exists parent_license_id uuid references public.licenses(id) on delete set null,
  add column if not exists active_machine_id text;

-- 2. Create profiles table — partition by license_id
create table if not exists public.profiles (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(id) on delete cascade,
  license_id        uuid not null references public.licenses(id) on delete cascade,
  profile_name      text not null,
  display_name      text,
  metadata          jsonb,  -- fingerprint, proxy, webSession snapshots, cookies
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (license_id, profile_name)  -- allow profile_1 in both LIC1 and LIC2
);

create index if not exists profiles_user_id_idx on public.profiles (user_id);
create index if not exists profiles_license_id_idx on public.profiles (license_id);

alter table public.profiles enable row level security;

create policy "profiles self read" on public.profiles
  for select using (auth.uid() = user_id);

-- 3. Modify cloud_backups: change unique constraint from (user_id) to (license_id)
alter table if exists public.cloud_backups
  drop constraint if exists cloud_backups_user_key;

alter table if exists public.cloud_backups
  add constraint cloud_backups_license_key unique (license_id);

-- 4. Create license_upgrades table — track upgrade history
create table if not exists public.license_upgrades (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references public.users(id) on delete cascade,
  old_license_id          uuid references public.licenses(id) on delete set null,
  new_license_id          uuid references public.licenses(id) on delete set null,
  old_tier_id             text,
  new_tier_id             text,
  upgrade_type            text not null,  -- 'upgrade', 'downgrade', 'renewal'
  transfer_profile_count  int default 0,
  transfer_status         text default 'pending',  -- 'pending', 'completed', 'failed'
  transfer_error          text,
  upgraded_at             timestamptz not null default now()
);

create index if not exists license_upgrades_user_idx on public.license_upgrades (user_id);
create index if not exists license_upgrades_old_license_idx on public.license_upgrades (old_license_id);
create index if not exists license_upgrades_new_license_idx on public.license_upgrades (new_license_id);

alter table public.license_upgrades enable row level security;

create policy "license_upgrades self read" on public.license_upgrades
  for select using (auth.uid() = user_id);

-- 5. Add helper function: get total quota for user (sum of all active licenses)
create or replace function public.get_user_total_quota(p_user_id uuid)
returns integer as $$
declare
  total_quota integer;
begin
  select coalesce(sum(account_quota), 0)
  into total_quota
  from public.licenses
  where user_id = p_user_id
    and status = 'active'
    and expires_at > now();
  
  return coalesce(total_quota, 1);  -- fallback to 1 (free tier)
end;
$$ language plpgsql stable security definer;

-- 6. Add helper function: count profiles for a license
create or replace function public.get_license_profile_count(p_license_id uuid)
returns integer as $$
declare
  profile_count integer;
begin
  select count(*)
  into profile_count
  from public.profiles
  where license_id = p_license_id;
  
  return profile_count;
end;
$$ language plpgsql stable security definer;
