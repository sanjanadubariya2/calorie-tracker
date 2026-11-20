-- food_portion (010): the proposal numbers equal what logging would store.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

grant select, insert, update, delete on public.profiles, public.food_logs to anon, authenticated;
update public.foods set is_active = false;

insert into public.foods (id, name, source, source_ref, verification, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100, fiber_g_per_100)
values ('f1000000-0000-0000-0000-000000000001', 'Test roti', 'indb', 'P001', 'curated', 297.4, 9.81, 46.31, 7.52, 6.4);
insert into public.foods (id, name, source, source_ref, basis, density_g_per_ml, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
values ('f1000000-0000-0000-0000-000000000002', 'Test lassi', 'open_food_facts', 'P002', 'ml', 1.04, 89, 2.9, 14, 2.3);
insert into public.foods (id, name, source, source_ref, basis, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
values ('f1000000-0000-0000-0000-000000000003', 'Juice no density', 'manual', 'P003', 'ml', 45, 0, 11, 0);
insert into public.foods (id, name, source, source_ref, is_active, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
values ('f1000000-0000-0000-0000-000000000004', 'Hidden', 'manual', 'P004', false, 100, 1, 1, 1);

insert into auth.users (id, email) values ('a2000000-0000-0000-0000-0000000000a2', 'portion@test.local');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);

select results_eq(
  $$ select calories, carbs_g, fat_g, protein_g, (nutrients_per_100g ->> 'kcal')::numeric
     from public.food_portion('f1000000-0000-0000-0000-000000000001', 80) $$,
  $$ values (238::numeric, 37.0::numeric, 6.0::numeric, 7.8::numeric, 297.4::numeric) $$,
  '80 g of roti: 297.4 * 0.8 = 237.9 -> 238 kcal; macros to 0.1 g');

select results_eq(
  $$ select (nutrients_per_100g ->> 'kcal')::numeric, calories from public.food_portion('f1000000-0000-0000-0000-000000000002', 260) $$,
  $$ values (85.58::numeric, 223::numeric) $$,
  'A per-100 ml food is converted with its density (89/1.04 = 85.58 per 100 g)');

select results_eq(
  $$ select food_id, nutrients_per_100g, calories from public.food_portion('f1000000-0000-0000-0000-000000000003', 100) $$,
  $$ values ('f1000000-0000-0000-0000-000000000003'::uuid, null::jsonb, null::numeric) $$,
  'A per-100 ml food without density: a row with no nutrition (never invented)');
select is_empty($$ select * from public.food_portion('f1000000-0000-0000-0000-000000000004', 100) $$,
  'Inactive foods are invisible');
select throws_ok($$ select * from public.food_portion('f1000000-0000-0000-0000-000000000001', 0) $$, '22023', null, '0 g refused');
select throws_ok($$ select * from public.food_portion('f1000000-0000-0000-0000-000000000001', 5001) $$, '22023', null, 'Over 5 kg refused');

-- Parity: logging the same food and grams stores exactly the proposal's numbers.
insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, serving_g, source, food_id)
values (auth.uid(), current_date, 'lunch', 'Roti', 1, 80, 'ai_assisted', 'f1000000-0000-0000-0000-000000000001');
select results_eq(
  $$ select l.calories, l.carbs_g, l.fat_g, l.protein_g, l.nutrients_per_100g
     from public.food_logs l where l.food_id = 'f1000000-0000-0000-0000-000000000001' $$,
  $$ select calories, carbs_g, fat_g, protein_g, nutrients_per_100g
     from public.food_portion('f1000000-0000-0000-0000-000000000001', 80) $$,
  'A logged item stores exactly what food_portion proposed');

insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, serving_g, source, food_id)
values (auth.uid(), current_date, 'lunch', 'Lassi', 1, 260, 'ai_assisted', 'f1000000-0000-0000-0000-000000000002');
select results_eq(
  $$ select l.calories, l.nutrients_per_100g from public.food_logs l where l.food_id = 'f1000000-0000-0000-0000-000000000002' $$,
  $$ select calories, nutrients_per_100g from public.food_portion('f1000000-0000-0000-0000-000000000002', 260) $$,
  'Parity holds for per-100 ml foods too');

reset role;
set local role anon;
select throws_ok($$ select * from public.food_portion('f1000000-0000-0000-0000-000000000001', 80) $$, '42501', null, 'anon cannot call food_portion');
reset role;

select * from finish();
rollback;
