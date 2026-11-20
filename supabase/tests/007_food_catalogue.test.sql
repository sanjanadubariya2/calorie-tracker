-- Database tests for 007_food_catalogue.sql and 008_catalogue_writer.sql.
-- Independent of any loaded data: existing foods are deactivated inside this
-- transaction (rolled back at the end) and small fixtures are used instead.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

grant select, insert, update, delete on public.profiles, public.food_logs to anon, authenticated;
update public.foods set is_active = false;

-- ==================================================================
-- 1. Normalisation
-- ==================================================================
select is(public.normalize_food_name('Paneer Butter Masala'), 'paneer butter masala', 'lower-case');
select is(public.normalize_food_name('2 Idlis'), 'idli', 'quantity removed, plural singularised');
select is(public.normalize_food_name('Homemade Dal Tadka 200g'), 'dal tadka', 'filler and grams removed');
select is(public.normalize_food_name('1 katori rajma'), 'rajma', 'household unit removed');
select is(public.normalize_food_name('Crème brûlée'), 'creme brulee', 'accents removed');
select is(public.normalize_food_name('Haldiram''s Aloo Bhujia'), 'haldiram aloo bhujia', 'apostrophe dropped');
select is(public.normalize_food_name('Chapati/Roti'), 'chapati roti', 'punctuation to spaces');
select is(public.normalize_food_name('Hummus'), 'hummus', '-us words keep their s');
select is(public.normalize_food_name('   '), null, 'blank -> null');
select is(public.normalize_brand('Haldiram Foods Pvt. Ltd.'), 'haldiram', 'brand suffixes removed');

-- ==================================================================
-- 2. Fixtures (as the owner; clients can't write the catalogue)
-- ==================================================================
insert into public.foods (id, name, source, source_ref, verification, category,
  kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100, fiber_g_per_100, sugars_g_per_100,
  saturated_fat_g_per_100, sodium_g_per_100)
values
  ('f0000000-0000-0000-0000-000000000001', 'Chapati/Roti', 'indb', 'T001', 'curated', 'bread', 297, 9.8, 46.3, 7.5, 6.4, 0.5, 1.2, 0.27),
  ('f0000000-0000-0000-0000-000000000002', 'Plain paratha', 'indb', 'T002', 'curated', 'bread', 315, 6.5, 40.1, 14.2, 4.8, 0.4, 3.2, 0.31),
  ('f0000000-0000-0000-0000-000000000004', 'Aloo bhujia', 'indb', 'T004', 'curated', 'snack', 550, 10.5, 40.2, 38.0, 6.0, 1.0, 9.0, 0.9),
  ('f0000000-0000-0000-0000-000000000005', 'Paneer in butter sauce', 'indb', 'T005', 'curated', 'paneer_dish', 210, 8.1, 7.2, 16.3, 1.0, 2.1, 9.5, 0.4);

insert into public.foods (id, name, brand, source, source_ref, verification, food_kind,
  kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100, fiber_g_per_100, sugars_g_per_100,
  saturated_fat_g_per_100, sodium_g_per_100)
values ('f0000000-0000-0000-0000-000000000003', 'Aloo Bhujia', 'Haldiram''s', 'open_food_facts', '8904004400262',
        'auto_checked', 'packaged', 589, 11.0, 41.0, 41.0, 5.0, 2.0, 9.5, 0.95);

-- Per 100 ml, density 1.05.
insert into public.foods (id, name, brand, source, source_ref, verification, food_kind, basis, density_g_per_ml,
  kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
values ('f0000000-0000-0000-0000-000000000006', 'Mango drink', 'Maaza', 'open_food_facts', '8901764012273',
        'auto_checked', 'beverage', 'ml', 1.05, 63, 0, 15.6, 0);

-- Incomplete (no fat) and inactive foods.
insert into public.foods (id, name, source, source_ref, kcal_per_100, protein_g_per_100, carbs_g_per_100)
values ('f0000000-0000-0000-0000-000000000007', 'Mystery snack', 'manual', 'T007', 400, 5, 60);
insert into public.foods (id, name, source, source_ref, verification, is_active,
  kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
values ('f0000000-0000-0000-0000-000000000008', 'Old roti', 'indb', 'T008', 'curated', false, 290, 9, 45, 7);

insert into public.food_aliases (food_id, alias, kind) values
  ('f0000000-0000-0000-0000-000000000001', 'phulka', 'synonym'),
  ('f0000000-0000-0000-0000-000000000001', 'roti', 'name_variant'),
  ('f0000000-0000-0000-0000-000000000005', 'paneer butter masala', 'common_name');
insert into public.food_servings (food_id, label, grams, is_default) values
  ('f0000000-0000-0000-0000-000000000001', '1 medium roti', 40, true),
  ('f0000000-0000-0000-0000-000000000006', '1 glass', 262.5, true);

-- ==================================================================
-- 3. Constraints and the quality trigger
-- ==================================================================
select throws_ok($$ insert into public.foods (name, source, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
                    values ('x', 'manual', 1200, 1, 1, 1) $$, '23514', null, 'kcal over 1000 per 100 rejected');
select throws_ok($$ insert into public.foods (name, source, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
                    values ('x', 'manual', 400, 50, 40, 30) $$, '23514', null, 'macros summing over 105 g rejected');
select throws_ok($$ insert into public.foods (name, source, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100, sugars_g_per_100)
                    values ('x', 'manual', 100, 1, 10, 1, 20) $$, '23514', null, 'sugars above carbs rejected');
select throws_ok($$ insert into public.foods (name, source, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
                    values ('x', 'manual', -5, 1, 1, 1) $$, '23514', null, 'negative kcal rejected');
select throws_ok($$ insert into public.foods (name, source, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100, micronutrients)
                    values ('x', 'manual', 100, 1, 10, 1, '{"iron": 2}') $$, '23514', null, 'micronutrient key without unit rejected');
select throws_ok($$ insert into public.foods (name, source, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
                    values ('x', 'llm_guess', 100, 1, 10, 1) $$, '23514', null, 'unknown source rejected');
select throws_ok($$ insert into public.foods (name, source, source_ref, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
                    values ('dup', 'indb', 'T001', 100, 1, 10, 1) $$, '23505', null, 'duplicate (source, source_ref) rejected');

insert into public.foods (id, name, source, source_ref, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
values ('f0000000-0000-0000-0000-000000000009', 'No kcal given', 'manual', 'T009', 10, 20, 5);
select results_eq(
  $$ select kcal_per_100, 'kcal_derived' = any(quality_flags) from public.foods where id = 'f0000000-0000-0000-0000-000000000009' $$,
  $$ values (165.0::numeric, true) $$, 'Missing kcal is derived from macros (4/4/9) and flagged');

insert into public.foods (id, name, source, source_ref, verification, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
values ('f0000000-0000-0000-0000-00000000000a', 'Egg drop soup', 'open_food_facts', '0000000000001', 'auto_checked', 27, 10, 20, 6);
select results_eq(
  $$ select 'energy_mismatch' = any(quality_flags), verification from public.foods where id = 'f0000000-0000-0000-0000-00000000000a' $$,
  $$ values (true, 'unverified'::text) $$, 'Energy inconsistent with macros is flagged; an OFF row is downgraded to unverified');

select results_eq(
  $$ select completeness from public.foods where id in ('f0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000006', 'f0000000-0000-0000-0000-000000000007') order by id $$,
  $$ values (1.00::numeric), (0.70::numeric), (0.53::numeric) $$, 'Completeness: all values 1.0, core only 0.7, three core 0.53');
insert into public.foods (id, name, source, source_ref, basis, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
values ('f0000000-0000-0000-0000-00000000000b', 'Juice no density', 'manual', 'T00B', 'ml', 45, 0, 11, 0);
select ok((select 'density_unknown' = any(quality_flags) from public.foods where id = 'f0000000-0000-0000-0000-00000000000b'),
  'A per-100 ml food without density is flagged density_unknown');

-- ==================================================================
-- 4. Access: users read active foods only and never write
-- ==================================================================
insert into auth.users (id, email) values ('a0000000-0000-0000-0000-0000000000c1', 'cat_a@test.local');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-0000000000c1","role":"authenticated"}', true);

select is((select count(*)::int from public.foods where id = 'f0000000-0000-0000-0000-000000000001'), 1, 'Users read active foods');
select is((select count(*)::int from public.foods where id = 'f0000000-0000-0000-0000-000000000008'), 0, 'Users never see inactive foods');
select throws_ok($$ insert into public.foods (name, source, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
                    values ('hack', 'curated', 1, 1, 1, 1) $$, '42501', null, 'Users cannot insert foods');
select throws_ok($$ update public.foods set kcal_per_100 = 1 where id = 'f0000000-0000-0000-0000-000000000001' $$,
  '42501', null, 'Users cannot update foods');
select throws_ok($$ insert into public.food_aliases (food_id, alias) values ('f0000000-0000-0000-0000-000000000001', 'cake') $$,
  '42501', null, 'Users cannot add aliases');
reset role;
set local role anon;
select throws_ok($$ select * from public.foods $$, '42501', null, 'anon cannot read the catalogue');
select throws_ok($$ select * from public.search_food_catalogue('roti') $$, '42501', null, 'anon cannot search');
reset role;

-- catalogue_writer: catalogue only, no deletes of foods, no user data.
-- (Membership only so this session can switch to the role; rolled back.)
grant catalogue_writer to postgres;
set local role catalogue_writer;
select lives_ok($$ insert into public.foods (name, source, source_ref, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
                   values ('Writer test', 'curated', 'W001', 100, 1, 20, 1) $$, 'catalogue_writer can insert foods');
select lives_ok($$ update public.foods set is_active = false where source_ref = 'W001' $$, 'catalogue_writer can deactivate foods');
select throws_ok($$ delete from public.foods where source_ref = 'W001' $$, '42501', null, 'catalogue_writer cannot delete foods');
select throws_ok($$ select * from public.food_logs $$, '42501', null, 'catalogue_writer cannot read food logs');
select throws_ok($$ select * from public.profiles $$, '42501', null, 'catalogue_writer cannot read profiles');
reset role;

-- ==================================================================
-- 5. Matching
-- ==================================================================
set local role authenticated;
select results_eq($$ select food_id, match_type from public.search_food_catalogue('Chapati/Roti') limit 1 $$,
  $$ values ('f0000000-0000-0000-0000-000000000001'::uuid, 'exact'::text) $$, 'Exact name match ranks first');
select results_eq($$ select food_id, match_type from public.search_food_catalogue('phulka') limit 1 $$,
  $$ values ('f0000000-0000-0000-0000-000000000001'::uuid, 'alias'::text) $$, 'Alias match');
select is((select food_id from public.search_food_catalogue('chapathi') limit 1),
  'f0000000-0000-0000-0000-000000000001'::uuid, 'Misspelling found by fuzzy match');
select is((select food_id from public.search_food_catalogue('2 rotis') limit 1),
  'f0000000-0000-0000-0000-000000000001'::uuid, 'Quantity and plural in the query are normalised away');
select is((select food_id from public.search_food_catalogue('Paneer Butter Masala') limit 1),
  'f0000000-0000-0000-0000-000000000005'::uuid, 'Everyday name resolves through a curated alias');
select ok((select score >= 0.85 from public.search_food_catalogue('phulka') limit 1), 'Alias match of a curated food scores >= 0.85');

select is((select food_id from public.search_food_catalogue('aloo bhujia', 'Haldiram') limit 1),
  'f0000000-0000-0000-0000-000000000003'::uuid, 'With a brand, the branded product ranks first');
select is((select food_id from public.search_food_catalogue('aloo bhujia') limit 1),
  'f0000000-0000-0000-0000-000000000004'::uuid, 'Without a brand, the generic food ranks first');
select is((select count(*)::int from public.search_food_catalogue('mystery snack')), 0, 'Foods missing core values are never returned');
select is((select count(*)::int from public.search_food_catalogue('old roti') where food_id = 'f0000000-0000-0000-0000-000000000008'),
  0, 'Inactive foods are never returned');
select is((select count(*)::int from public.search_food_catalogue('zzqxv')), 0, 'Nonsense finds nothing');
select is((select count(*)::int from public.search_food_catalogue('   ')), 0, 'Blank query finds nothing');

-- Portions
select results_eq(
  $$ select portion_grams, portion_kcal, portion_carbs_g, portion_fat_g, portion_protein_g, default_serving_g
     from public.search_food_catalogue('Chapati/Roti', null, 40) limit 1 $$,
  $$ values (40::numeric, 119::numeric, 18.5::numeric, 3.0::numeric, 3.9::numeric, 40::numeric) $$,
  '40 g of roti: 297*0.4 = 118.8 -> 119 kcal; macros to 0.1 g');
select results_eq(
  $$ select portion_grams, portion_kcal from public.search_food_catalogue('Mango drink', null, 200, 'ml') limit 1 $$,
  $$ values (210.0::numeric, 126::numeric) $$, '200 ml of a 63 kcal/100 ml drink at 1.05 g/ml = 210 g = 126 kcal');
select is((select portion_kcal from public.search_food_catalogue('Chapati/Roti', null, 100, 'ml') limit 1), null,
  'ml for a per-100 g food without density: no portion (no guessing)');
select throws_ok($$ select * from public.search_food_catalogue('roti', null, 10, 'cups') $$, '22023', null, 'Unknown unit refused');
select throws_ok($$ select * from public.search_food_catalogue('roti', null, 6000) $$, '22023', null, 'Quantity over 5 kg refused');

-- portion_nutrition: the same rounding as the 006 trigger.
select results_eq($$ select * from public.portion_nutrition(520, 58, 30.04, 2.3, 37) $$,
  $$ values (192::numeric, 21.5::numeric, 11.1::numeric, 0.9::numeric) $$, 'portion_nutrition matches the 006 fixture');
select results_eq($$ select * from public.portion_nutrition(250, 5, 15, 1.5, 3) $$,
  $$ values (8::numeric, 0.2::numeric, 0.5::numeric, 0.0::numeric) $$, 'Half-away-from-zero at .5 boundaries');

-- ==================================================================
-- 6. Logging a catalogue food
-- ==================================================================
insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, carbs_g, fat_g, protein_g,
  serving_g, source, food_id, nutrients_per_100g)
values (auth.uid(), current_date, 'lunch', 'Roti', 9999, 1, 1, 1, 40, 'ai_assisted',
        'f0000000-0000-0000-0000-000000000001', '{"kcal": 999, "carbs_g": 1, "fat_g": 1, "protein_g": 1}');
select results_eq(
  $$ select calories, carbs_g, (nutrients_per_100g ->> 'kcal')::numeric, source_ref, source
     from public.food_logs where food_id = 'f0000000-0000-0000-0000-000000000001' $$,
  $$ values (119::numeric, 18.5::numeric, 297::numeric, 'T001'::text, 'ai_assisted'::text) $$,
  'A log with food_id takes its snapshot from the catalogue, not the client');

select lives_ok($$ insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, serving_g, source, food_id)
                   values (auth.uid(), current_date, 'dinner', 'Search pick', 0, 100, 'catalogue', 'f0000000-0000-0000-0000-000000000002') $$,
  'source = catalogue is accepted');
select throws_ok($$ insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, serving_g, food_id)
                    values (auth.uid(), current_date, 'lunch', 'x', 0, 50, 'f0000000-0000-0000-0000-000000000008') $$,
  '23503', null, 'An inactive food cannot be logged');
select throws_ok($$ insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, serving_g, food_id)
                    values (auth.uid(), current_date, 'lunch', 'x', 0, 50, 'f0000000-0000-0000-0000-000000000007') $$,
  '23514', null, 'A food without core values cannot be logged (incomplete nutrition)');

insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, serving_g, source, food_id)
values (auth.uid(), current_date, 'breakfast', 'Mango drink', 0, 210, 'catalogue', 'f0000000-0000-0000-0000-000000000006');
select results_eq(
  $$ select calories, (nutrients_per_100g ->> 'kcal')::numeric from public.food_logs where food_id = 'f0000000-0000-0000-0000-000000000006' $$,
  $$ values (126::numeric, 60.00::numeric) $$, 'A per-100 ml food is snapshotted per 100 g via density (63/1.05 = 60)');

-- History is immutable: catalogue edits and food_id changes don't touch the log.
reset role;
update public.foods set kcal_per_100 = 350 where id = 'f0000000-0000-0000-0000-000000000001';
set local role authenticated;
update public.food_logs set food_id = 'f0000000-0000-0000-0000-000000000002', serving_g = 40
where food_id = 'f0000000-0000-0000-0000-000000000001';
select results_eq(
  $$ select food_id, calories, (nutrients_per_100g ->> 'kcal')::numeric from public.food_logs where food_name = 'Roti' $$,
  $$ values ('f0000000-0000-0000-0000-000000000001'::uuid, 119::numeric, 297::numeric) $$,
  'Later catalogue edits and attempts to repoint food_id leave the logged snapshot unchanged');

reset role;
delete from public.foods where id = 'f0000000-0000-0000-0000-000000000001';
select results_eq(
  $$ select food_id, (nutrients_per_100g ->> 'kcal')::numeric from public.food_logs where food_name = 'Roti' $$,
  $$ values (null::uuid, 297::numeric) $$, 'Deleting a food sets food_id null and keeps the snapshot');

select * from finish();
rollback;
