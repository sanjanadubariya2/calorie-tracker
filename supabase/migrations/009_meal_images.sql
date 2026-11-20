-- Calorie Tracker — secure meal image storage
-- Run after 008_catalogue_writer.sql. Safe to re-run.
--
-- Meal photos for AI recognition. Photos are personal data (they can show
-- people, homes and, via EXIF, locations), so:
--   * The `meal-images` bucket is PRIVATE: no public URLs. Images are only
--     reachable with short-lived signed URLs issued to their owner.
--   * Objects live at <user_id>/<image_id>.jpg. Storage policies let a user
--     create, read and delete objects in their own folder only, with exactly
--     that name shape, and never overwrite one (no UPDATE policy).
--   * The bucket only accepts JPEG up to 5 MB. The backend re-encodes every
--     upload (validates the image, strips all metadata including GPS, caps
--     size) before storing it.
--   * meal_images holds one row per stored image, owner-only (RLS), with a
--     per-user rate limit and an expiry date for retention.

begin;

-- ============================================================
-- 1. Bucket
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('meal-images', 'meal-images', false, 5242880, array['image/jpeg'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ============================================================
-- 2. Storage policies (storage.objects has RLS enabled by Supabase)
--
-- Name must be exactly '<auth.uid()>/<uuid>.jpg'. No UPDATE policy: an
-- object can't be replaced or moved once written.
-- ============================================================
drop policy if exists "Meal images: owners upload" on storage.objects;
create policy "Meal images: owners upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'meal-images'
    and name ~ ('^' || (select auth.uid())::text
                || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$')
  );

drop policy if exists "Meal images: owners read" on storage.objects;
create policy "Meal images: owners read" on storage.objects
  for select to authenticated
  using (bucket_id = 'meal-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Meal images: owners delete" on storage.objects;
create policy "Meal images: owners delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'meal-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ============================================================
-- 3. meal_images
-- ============================================================
create table if not exists public.meal_images (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  storage_path text not null unique,
  mime_type text not null default 'image/jpeg' check (mime_type = 'image/jpeg'),
  size_bytes int not null check (size_bytes between 1 and 5242880),
  width int not null check (width between 1 and 4096),
  height int not null check (height between 1 and 4096),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'uploaded'
    check (status in ('uploaded', 'analyzing', 'analyzed', 'failed')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  -- The path is derived from the owner and id; it can't point elsewhere.
  constraint meal_images_path_matches check (storage_path = user_id::text || '/' || id::text || '.jpg'),
  constraint meal_images_expiry_after_creation check (expires_at > created_at)
);

create index if not exists meal_images_user_created_idx on public.meal_images (user_id, created_at desc);
create index if not exists meal_images_expires_idx on public.meal_images (expires_at);

alter table public.meal_images enable row level security;

drop policy if exists "Users see their own meal images" on public.meal_images;
create policy "Users see their own meal images" on public.meal_images
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "Users register their own meal images" on public.meal_images;
create policy "Users register their own meal images" on public.meal_images
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "Users delete their own meal images" on public.meal_images;
create policy "Users delete their own meal images" on public.meal_images
  for delete to authenticated using ((select auth.uid()) = user_id);

-- No UPDATE for clients: status changes belong to the future analysis
-- pipeline. Insert is limited to the descriptive columns; status, timestamps
-- and expiry come from defaults.
revoke all on table public.meal_images from anon, authenticated;
grant select, delete on table public.meal_images to authenticated;
grant insert (id, user_id, storage_path, mime_type, size_bytes, width, height, sha256)
  on table public.meal_images to authenticated;

-- ============================================================
-- 4. Rate limit: at most 60 images per user per rolling hour
-- ============================================================
create or replace function public.meal_images_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('meal_images:' || new.user_id::text, 0));
  if (select count(*) from public.meal_images m
      where m.user_id = new.user_id and m.created_at > now() - interval '1 hour') >= 60 then
    raise exception 'Too many meal images uploaded in the last hour' using errcode = '54000';
  end if;
  return new;
end;
$$;

drop trigger if exists meal_images_rate_limit on public.meal_images;
create trigger meal_images_rate_limit
  before insert on public.meal_images
  for each row execute function public.meal_images_rate_limit();

revoke all on function public.meal_images_rate_limit() from public, anon, authenticated;

commit;

-- ============================================================
-- Retention
--   expires_at defaults to 30 days. Expired images are removed by the
--   backend command `python -m app.cli purge-meal-images`, which deletes the
--   object through the Storage API and then the row. (Deleting rows from
--   storage.objects in SQL would orphan the files.)
--
-- Rollback (manual): drop table public.meal_images; drop the three storage
-- policies; delete the bucket from the dashboard once it is empty.
-- ============================================================
