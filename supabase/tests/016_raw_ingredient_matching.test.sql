-- 016: raw cooking ingredients rank below dishes unless the query asks for them.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

update public.foods set is_active = false;     -- isolate from loaded catalogue data (rolled back)
insert into public.foods (id, name, source, source_ref, verification, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100, quality_flags)
values ('f1600000-0000-0000-0000-000000000001', 'Test lentil (raw)', 'usda_fdc', 'T16-1', 'curated', 343, 22, 52, 1.5, array['raw_ingredient']),
       ('f1600000-0000-0000-0000-000000000002', 'Test lentil curry', 'indb', 'T16-2', 'curated', 120, 6, 15, 4, '{}');
insert into auth.users (id, email) values ('a1600000-0000-0000-0000-0000000000a1', 'raw@test.local');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1600000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

select ok((select score from public.search_food_catalogue('test lentil') where food_id = 'f1600000-0000-0000-0000-000000000001')
          < (select score from public.search_food_catalogue('test lentil') where food_id = 'f1600000-0000-0000-0000-000000000002'),
  'A dish outranks the raw ingredient for a plain query');
select ok((select score from public.search_food_catalogue('test lentil raw') where food_id = 'f1600000-0000-0000-0000-000000000001') >= 0.85,
  'Asking for "raw" finds the raw ingredient confidently');
select ok((select score from public.search_food_catalogue('test lentil') where food_id = 'f1600000-0000-0000-0000-000000000001') < 0.85,
  'A raw ingredient is never a confident match for a plain query');
reset role;

select * from finish();
rollback;
