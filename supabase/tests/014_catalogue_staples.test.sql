-- 014: the catalogue accepts USDA staples and the new categories; nothing else loosens.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

grant catalogue_writer to postgres;
set local role catalogue_writer;
select lives_ok($$ insert into public.foods (name, source, source_ref, category, food_kind, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
  values ('Test banana 14', 'usda_fdc', 'T14-1', 'fruit', 'ingredient', 89, 1.09, 20.24, 0.33) $$, 'USDA staples are accepted');
select lives_ok($$ insert into public.foods (name, source, source_ref, category, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
  values ('Test curd 14', 'usda_fdc', 'T14-2', 'dairy', 61, 3.47, 4.66, 3.25) $$, 'New categories are accepted');
select lives_ok($$ insert into public.foods (name, source, source_ref, category, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
  values ('Test sabzi 14', 'indb', 'T14-3', 'sabzi', 50, 1, 5, 2) $$, 'Existing categories still work');
select throws_ok($$ insert into public.foods (name, source, source_ref, category, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
  values ('Bad source', 'wikipedia', 'T14-4', 'fruit', 1, 1, 1, 1) $$, '23514', null, 'Unknown sources are still refused');
select throws_ok($$ insert into public.foods (name, source, source_ref, category, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
  values ('Bad category', 'usda_fdc', 'T14-5', 'junk_food', 1, 1, 1, 1) $$, '23514', null, 'Unknown categories are still refused');
reset role;

set local role authenticated;
select throws_ok($$ insert into public.foods (name, source, source_ref, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
  values ('User food', 'usda_fdc', 'T14-6', 1, 1, 1, 1) $$, '42501', null, 'Users still cannot write the catalogue');
reset role;

select * from finish();
rollback;
