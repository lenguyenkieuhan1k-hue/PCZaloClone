-- Add revocation + grace period support to licenses table.
-- When user clicks "Huỷ bỏ", status → 'revoked', revoked_at → now, delete_after → now+24h
-- App or job can auto-delete profiles after delete_after timestamp

alter table if exists public.licenses
  add column if not exists revoked_at timestamptz,
  add column if not exists delete_after timestamptz;

-- Helper function: get all revoked licenses past grace period (ready for auto-delete)
create or replace function public.get_revoked_licenses_for_cleanup()
returns table (
  id uuid,
  user_id uuid,
  key text,
  revoked_at timestamptz,
  profile_count integer
) as $$
begin
  return query
  select
    l.id,
    l.user_id,
    l.key,
    l.revoked_at,
    count(p.id)::integer
  from public.licenses l
  left join public.profiles p on l.id = p.license_id
  where l.status = 'revoked'
    and l.delete_after is not null
    and l.delete_after <= now()
  group by l.id, l.user_id, l.key, l.revoked_at;
end;
$$ language plpgsql stable security definer;

-- Update audit_log if needed (or keep as-is since it already has license_id)
