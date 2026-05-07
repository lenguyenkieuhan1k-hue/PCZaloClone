-- ZaloMask backend schema — Phase 2.
-- Run on a fresh Supabase project. Auth must already be enabled (Google OAuth
-- via Supabase Auth dashboard — no app code needed).
--
-- Single-session license rule:
--   licenses.active_session_id is the source of truth. Activate a key on a new
--   machine → server overwrites this column with a new UUID. Old client polls
--   heartbeat, sees its own session_id ≠ active_session_id, kicks itself.
--
-- All policies use auth.uid() so a stolen anon key cannot read other users.

-- 1. Users mirror table — denormalized profile info from auth.users.
create table if not exists public.users (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null unique,
  display_name  text,
  is_admin      boolean not null default false,
  created_at    timestamptz not null default now()
);
alter table public.users enable row level security;
create policy "users self read" on public.users
  for select using (auth.uid() = id);
create policy "users self update" on public.users
  for update using (auth.uid() = id);

-- Trigger: when a Supabase auth.users row is created, mirror it into public.users.
create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', new.email))
  on conflict (id) do nothing;
  return new;
end;$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- 2. Licenses — one row per purchased key.
create table if not exists public.licenses (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.users(id) on delete cascade,
  key                 text not null unique,
  tier_id             text not null,            -- tier-1 (free) / tier-6 / tier-15 / tier-25 / tier-50 / tier-100
  account_quota       integer not null,
  duration            text not null,            -- 1m / 3m / 6m / 1y
  expires_at          timestamptz not null,
  status              text not null default 'active',  -- active / revoked / expired
  active_session_id   uuid,                     -- null = no active machine
  active_device_name  text,                     -- friendly name shown in dashboard
  created_at          timestamptz not null default now()
);
create index if not exists licenses_user_id_idx on public.licenses (user_id);
create index if not exists licenses_status_idx on public.licenses (status);
alter table public.licenses enable row level security;
create policy "licenses self read" on public.licenses
  for select using (auth.uid() = user_id);
-- Insert/update only via service-role (server-side API routes). No client RLS.

-- 3. Sessions — every successful activate creates one row. Heartbeat updates last_seen_at.
create table if not exists public.sessions (
  id                  uuid primary key default gen_random_uuid(),
  license_id          uuid not null references public.licenses(id) on delete cascade,
  device_fingerprint  text not null,
  device_name         text,
  app_version         text,
  ip                  inet,
  user_agent          text,
  created_at          timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  ended_at            timestamptz                 -- null = still considered alive
);
create index if not exists sessions_license_idx on public.sessions (license_id);
alter table public.sessions enable row level security;
create policy "sessions self read" on public.sessions
  for select using (
    exists (select 1 from public.licenses l where l.id = sessions.license_id and l.user_id = auth.uid())
  );

-- 4. Payments — SePay webhook posts here.
create table if not exists public.payments (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references public.users(id) on delete set null,
  license_id      uuid references public.licenses(id) on delete set null,
  tier_id         text,
  duration        text,
  amount_vnd      bigint not null,
  method          text not null default 'sepay',
  sepay_txn_id    text unique,
  memo            text,
  status          text not null default 'pending',  -- pending / paid / failed / refunded
  created_at      timestamptz not null default now(),
  paid_at         timestamptz
);
create index if not exists payments_user_idx on public.payments (user_id);
create index if not exists payments_status_idx on public.payments (status);
alter table public.payments enable row level security;
create policy "payments self read" on public.payments
  for select using (auth.uid() = user_id);

-- 5. Audit log — every activate / kick / transfer / payment for dispute resolution.
create table if not exists public.audit_log (
  id          bigserial primary key,
  actor_id    uuid references public.users(id) on delete set null,
  license_id  uuid references public.licenses(id) on delete set null,
  action      text not null,             -- activate / kick / transfer / refund / revoke
  detail      jsonb,
  ip          inet,
  created_at  timestamptz not null default now()
);
create index if not exists audit_log_license_idx on public.audit_log (license_id);
alter table public.audit_log enable row level security;
-- No client read policy — admin only via service-role.

-- 6. Generate license key helper (16 chars, dash-grouped, urlsafe).
create or replace function public.generate_license_key()
returns text language plpgsql as $$
declare
  chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  result text := '';
  i integer;
begin
  for i in 1..16 loop
    result := result || substr(chars, 1 + floor(random() * length(chars))::int, 1);
    if i in (4, 8, 12) then result := result || '-'; end if;
  end loop;
  return 'ZM-' || result;
end;$$;
