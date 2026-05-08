-- Bucket riêng cho backup desktop (.zmb): upload qua signed URL (Electron PUT thẳng lên Storage),
-- tránh payload quá lớn qua Vercel/serverless.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cloud-backups', 'cloud-backups', false, 524288000, null)
on conflict (id) do update set file_size_limit = excluded.file_size_limit;
