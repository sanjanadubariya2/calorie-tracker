-- Database tests for 009_meal_images.sql: private bucket, storage policies,
-- meal_images ownership/shape, rate limit.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

insert into auth.users (id, email) values
  ('a1000000-0000-0000-0000-0000000000a1', 'img_a@test.local'),
  ('b1000000-0000-0000-0000-0000000000b1', 'img_b@test.local');
select set_config('t.a', 'a1000000-0000-0000-0000-0000000000a1', true);
select set_config('t.b', 'b1000000-0000-0000-0000-0000000000b1', true);
select set_config('t.img', '11111111-2222-3333-4444-555555555555', true);

-- ==================================================================
-- 1. Bucket
-- ==================================================================
select results_eq(
  $$ select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'meal-images' $$,
  $$ values (false, 5242880::bigint, array['image/jpeg']::text[]) $$,
  'Bucket is private, 5 MB, JPEG only');

-- ==================================================================
-- 2. Storage policies (as user A)
-- ==================================================================
set local role authenticated;
select set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', current_setting('t.a')), true);

select lives_ok(
  format($$ insert into storage.objects (bucket_id, name, owner_id) values ('meal-images', '%s/%s.jpg', '%s') $$,
         current_setting('t.a'), current_setting('t.img'), current_setting('t.a')),
  'A can create <own uid>/<uuid>.jpg');
select throws_ok(
  format($$ insert into storage.objects (bucket_id, name) values ('meal-images', '%s/%s.jpg') $$,
         current_setting('t.b'), current_setting('t.img')),
  '42501', null, 'A cannot write into B''s folder');
select throws_ok(
  format($$ insert into storage.objects (bucket_id, name) values ('meal-images', '%s/photo.png') $$, current_setting('t.a')),
  '42501', null, 'Names must be <uuid>.jpg');
select throws_ok(
  format($$ insert into storage.objects (bucket_id, name) values ('meal-images', '%s/x/%s.jpg') $$,
         current_setting('t.a'), current_setting('t.img')),
  '42501', null, 'No nested paths');
select throws_ok(
  format($$ insert into storage.objects (bucket_id, name) values ('meal-images', '../%s/%s.jpg') $$,
         current_setting('t.b'), current_setting('t.img')),
  '42501', null, 'No path tricks');

select is((select count(*)::int from storage.objects where bucket_id = 'meal-images'), 1, 'A sees its own object');

-- No UPDATE policy: an object can't be renamed/moved/overwritten.
update storage.objects set name = current_setting('t.b') || '/' || current_setting('t.img') || '.jpg'
where bucket_id = 'meal-images';
reset role;
select is((select (storage.foldername(name))[1] from storage.objects where bucket_id = 'meal-images'),
  current_setting('t.a'), 'Objects cannot be moved (no UPDATE policy)');

-- B can neither see nor delete A's object.
set local role authenticated;
select set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', current_setting('t.b')), true);
select is((select count(*)::int from storage.objects where bucket_id = 'meal-images'), 0, 'B cannot see A''s object');
-- Deletes can't be exercised here: Supabase refuses any direct SQL delete on
-- storage tables ("use the Storage API"). "B cannot delete A's object" is
-- covered through the real Storage API in backend/tests/integration.
reset role;

set local role anon;
select is((select count(*)::int from storage.objects where bucket_id = 'meal-images'), 0, 'anon sees nothing');
reset role;

-- ==================================================================
-- 3. meal_images table
-- ==================================================================
set local role authenticated;
select set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', current_setting('t.a')), true);

select lives_ok(
  format($$ insert into public.meal_images (id, user_id, storage_path, size_bytes, width, height, sha256)
            values ('%s', '%s', '%s/%s.jpg', 123456, 1600, 1200, repeat('a', 64)) $$,
         current_setting('t.img'), current_setting('t.a'), current_setting('t.a'), current_setting('t.img')),
  'A registers its image');
select results_eq(
  $$ select status, expires_at > now() + interval '29 days' from public.meal_images $$,
  $$ values ('uploaded'::text, true) $$, 'Defaults: status uploaded, expires in 30 days');

select throws_ok(
  format($$ insert into public.meal_images (id, user_id, storage_path, size_bytes, width, height, sha256)
            values (gen_random_uuid(), '%s', '%s/other.jpg', 1, 10, 10, repeat('b', 64)) $$,
         current_setting('t.a'), current_setting('t.a')),
  '23514', null, 'storage_path must be <user_id>/<id>.jpg');
select throws_ok(
  format($$ insert into public.meal_images (id, user_id, storage_path, size_bytes, width, height, sha256)
            values ('%s', '%s', '%s/%s.jpg', 1, 10, 10, repeat('c', 64)) $$,
         '99999999-2222-3333-4444-555555555555', current_setting('t.b'), current_setting('t.b'),
         '99999999-2222-3333-4444-555555555555'),
  '42501', null, 'A cannot register an image as B');
select throws_ok(
  format($$ insert into public.meal_images (id, user_id, storage_path, size_bytes, width, height, sha256, status)
            values (gen_random_uuid(), '%s', 'x', 1, 10, 10, repeat('d', 64), 'analyzed') $$, current_setting('t.a')),
  '42501', null, 'Clients cannot set status (column not granted)');
select throws_ok($$ update public.meal_images set status = 'analyzed' $$, '42501', null, 'Clients cannot update rows');
select throws_ok(
  format($$ insert into public.meal_images (id, user_id, storage_path, size_bytes, width, height, sha256)
            values ('%s', '%s', '%s/%s.jpg', 9999999, 10, 10, repeat('e', 64)) $$,
         '88888888-2222-3333-4444-555555555555', current_setting('t.a'), current_setting('t.a'),
         '88888888-2222-3333-4444-555555555555'),
  '23514', null, 'size over 5 MB rejected');

select set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', current_setting('t.b')), true);
select is((select count(*)::int from public.meal_images), 0, 'B cannot see A''s images');
delete from public.meal_images;
reset role;
select is((select count(*)::int from public.meal_images), 1, 'B cannot delete A''s images');

-- ==================================================================
-- 4. Rate limit: 60 per user per hour
-- ==================================================================
set local role authenticated;
select set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', current_setting('t.b')), true);
create temporary table if not exists _ids as select gen_random_uuid() as id from generate_series(1, 61);
grant select on _ids to authenticated;
select lives_ok(
  format($$ insert into public.meal_images (id, user_id, storage_path, size_bytes, width, height, sha256)
            select id, '%s', '%s/' || id || '.jpg', 1000, 100, 100, repeat('f', 64)
            from (select id from _ids limit 60) x $$, current_setting('t.b'), current_setting('t.b')),
  '60 images in an hour are allowed');
select throws_ok(
  format($$ insert into public.meal_images (id, user_id, storage_path, size_bytes, width, height, sha256)
            select id, '%s', '%s/' || id || '.jpg', 1000, 100, 100, repeat('f', 64)
            from (select id from _ids offset 60) x $$, current_setting('t.b'), current_setting('t.b')),
  '54000', null, 'The 61st within an hour is refused');

set local role anon;
select throws_ok($$ select * from public.meal_images $$, '42501', null, 'anon has no access to meal_images');
reset role;

select * from finish();
rollback;
