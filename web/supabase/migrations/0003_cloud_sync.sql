-- Cloud sync: lưu toàn bộ profile data của user trên server để chuyển máy.
-- Mỗi user chỉ có 1 bản backup (upsert by user_id).
-- Chỉ session ACTIVE mới được upload/download (kiểm tra trong API layer).

create table if not exists public.cloud_backups (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users(id) on delete cascade,
  license_id      uuid not null references public.licenses(id) on delete cascade,
  session_id      text not null,
  profiles_json   jsonb not null default '[]'::jsonb,
  profile_count   int not null default 0,
  uploaded_at     timestamptz not null default now(),
  unique (user_id)
);

create index if not exists cloud_backups_user_idx on public.cloud_backups (user_id);
create index if not exists cloud_backups_license_idx on public.cloud_backups (license_id);

alter table public.cloud_backups enable row level security;

-- User chỉ đọc được backup của chính mình (qua dashboard nếu cần).
-- Upload/download đều qua service-role (API routes) nên không cần write policy.
drop policy if exists "cloud_backups self read" on public.cloud_backups;
create policy "cloud_backups self read" on public.cloud_backups
  for select using (auth.uid() = user_id);
