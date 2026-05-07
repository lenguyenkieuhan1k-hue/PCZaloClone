-- web_sessions — receive captured Zalo Web sessions from the Chrome extension
-- (AutoZalo Bridge). Each row belongs to one Supabase user, identified by
-- (user_id, z_uuid). Updates upsert by that key so re-capture on the same
-- account just refreshes cookies/localStorage.
--
-- Electron app pulls these via authenticated GET (TODO: /api/web-sessions)
-- to seed a fresh profile without re-scanning QR.

create table if not exists public.web_sessions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users(id) on delete cascade,
  z_uuid          text not null,
  display_name    text,
  cookies         jsonb not null,
  local_storage   jsonb not null default '{}'::jsonb,
  session_info    jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, z_uuid)
);
create index if not exists web_sessions_user_idx on public.web_sessions (user_id);

alter table public.web_sessions enable row level security;
create policy "web_sessions self read" on public.web_sessions
  for select using (auth.uid() = user_id);
-- Insert/update only via admin client (service-role) — extension calls
-- /api/extension-import which uses service role.

-- Auto-refresh updated_at on every UPDATE so dashboard sees latest sync time.
create or replace function public.web_sessions_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;$$;

drop trigger if exists trg_web_sessions_updated_at on public.web_sessions;
create trigger trg_web_sessions_updated_at
  before update on public.web_sessions
  for each row execute function public.web_sessions_set_updated_at();

-- Optional: limit one free key per user using a partial unique index.
-- Skip if already exists from a previous migration.
create unique index if not exists licenses_one_free_per_user
  on public.licenses (user_id)
  where tier_id = 'tier-1';
