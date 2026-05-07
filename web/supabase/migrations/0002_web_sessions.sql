-- Legacy migration slot retained after extension module removal.
-- Keep only free-tier safety index for fresh environments.
create unique index if not exists licenses_one_free_per_user
  on public.licenses (user_id)
  where tier_id = 'tier-1';
