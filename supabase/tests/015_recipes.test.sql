-- 015: recipes, ingredients, deterministic nutrition, scaling, versioning, access.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

grant catalogue_writer to postgres;

-- Test foods (as the owner). Values chosen so the expected sums are easy to check.
insert into public.foods (id, name, source, source_ref, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100, fiber_g_per_100, sodium_g_per_100)
values ('f1500000-0000-0000-0000-000000000001', 'R15 flour', 'manual', 'R15-1', 340, 13, 70, 2.5, 11, 0.002),
       ('f1500000-0000-0000-0000-000000000004', 'R15 oil', 'manual', 'R15-4', 884, 0, 0, 100, 0, 0);
insert into public.foods (id, name, source, source_ref, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
values ('f1500000-0000-0000-0000-000000000002', 'R15 ghee', 'manual', 'R15-2', 900, 0, 0, 100);       -- no fibre/sodium data
insert into public.foods (id, name, source, source_ref, kcal_per_100)
values ('f1500000-0000-0000-0000-000000000003', 'R15 mystery spice', 'manual', 'R15-3', 300);  -- no macros: not matchable
insert into public.foods (id, name, source, source_ref, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100, is_active)
values ('f1500000-0000-0000-0000-000000000005', 'R15 retired', 'manual', 'R15-5', 100, 1, 1, 1, false);
update public.foods set density_g_per_ml = 0.92 where id = 'f1500000-0000-0000-0000-000000000004';

insert into auth.users (id, email) values ('a1500000-0000-0000-0000-0000000000a1', 'recipes@test.local');

-- ------------------------------------------------------------ creation and units (catalogue_writer)
set local role catalogue_writer;
insert into public.recipes (id, slug, name, servings, serving_label, source, source_name)
values ('e1500000-0000-0000-0000-000000000001', 'test-roti', 'Test roti', 6, '1 roti', 'curated', 'test kitchen');
select lives_ok($$ insert into public.recipe_ingredients (recipe_id, position, food_id, quantity, unit)
  values ('e1500000-0000-0000-0000-000000000001', 1, 'f1500000-0000-0000-0000-000000000001', 180, 'g'),
         ('e1500000-0000-0000-0000-000000000001', 2, 'f1500000-0000-0000-0000-000000000002', 1, 'tbsp') $$,
  'A recipe takes multiple ingredients');
select results_eq($$ select position, grams, grams_source from public.recipe_ingredients
                     where recipe_id = 'e1500000-0000-0000-0000-000000000001' order by position $$,
  $$ values (1::smallint, 180::numeric, 'unit'::text), (2::smallint, null::numeric, null::text) $$,
  'grams come from g; a tablespoon without a stated weight stays unknown');

select is((select complete from public.recipe_nutrition('e1500000-0000-0000-0000-000000000001')), false,
  'An ingredient without grams makes the recipe incomplete');
select is((select total from public.recipe_nutrition('e1500000-0000-0000-0000-000000000001')), null,
  '...and no totals are invented');
select ok((select missing[1] like '#2 R15 ghee: no weight%' from public.recipe_nutrition('e1500000-0000-0000-0000-000000000001')),
  'The gap is named');

update public.recipe_ingredients set grams = 12 where recipe_id = 'e1500000-0000-0000-0000-000000000001' and position = 2;
select is((select grams_source from public.recipe_ingredients where recipe_id = 'e1500000-0000-0000-0000-000000000001' and position = 2),
  'stated', 'A stated weight is recorded as stated');

select throws_ok($$ insert into public.recipe_ingredients (recipe_id, position, food_id, quantity, unit, grams)
  values ('e1500000-0000-0000-0000-000000000001', 3, 'f1500000-0000-0000-0000-000000000001', 100, 'g', 90) $$,
  '22023', null, 'Inconsistent units are rejected (100 g is not 90 g)');
select throws_ok($$ insert into public.recipe_ingredients (recipe_id, position, food_id, quantity, unit)
  values ('e1500000-0000-0000-0000-000000000001', 3, 'f1500000-0000-0000-0000-000000000005', 10, 'g') $$,
  '23503', null, 'Inactive foods are invalid references');
select throws_ok($$ insert into public.recipe_ingredients (recipe_id, position, food_id, quantity, unit)
  values ('e1500000-0000-0000-0000-000000000001', 3, 'f1500000-0000-0000-0000-0000000000ff', 10, 'g') $$,
  '23503', null, 'Unknown foods are invalid references');
select throws_ok($$ insert into public.recipe_ingredients (recipe_id, position, food_id, quantity, unit)
  values ('e1500000-0000-0000-0000-000000000001', 3, 'f1500000-0000-0000-0000-000000000001', 0, 'g') $$,
  '23514', null, 'Quantities must be positive');
select throws_ok($$ insert into public.recipes (slug, name, servings, serving_label, source)
  values ('zero', 'Zero servings', 0, '1', 'curated') $$, '23514', null, 'Servings must be positive');

-- ------------------------------------------------------------ nutrition
-- flour 180 g: 612 kcal, P 23.4, C 126, F 4.5; ghee 12 g: 108 kcal, F 12 -> 720 kcal, F 16.5.
select results_eq(
  $$ select (total ->> 'calories')::numeric, (total ->> 'protein_g')::numeric, (total ->> 'carbs_g')::numeric,
            (total ->> 'fat_g')::numeric, (total ->> 'grams')::numeric
     from public.recipe_nutrition('e1500000-0000-0000-0000-000000000001') $$,
  $$ values (720::numeric, 23.4::numeric, 126.0::numeric, 16.5::numeric, 192.0::numeric) $$,
  'Total nutrition is the sum of ingredient grams x catalogue values');
select results_eq(
  $$ select (per_serving ->> 'calories')::numeric, (per_serving ->> 'protein_g')::numeric,
            (per_serving ->> 'carbs_g')::numeric, (per_serving ->> 'fat_g')::numeric
     from public.recipe_nutrition('e1500000-0000-0000-0000-000000000001') $$,
  $$ values (120::numeric, 3.9::numeric, 21.0::numeric, 2.8::numeric) $$,
  'Per serving = total / 6 servings (2.75 g fat rounds to 2.8)');
select results_eq(
  $$ select missing_nutrients, per_serving ? 'fiber_g' from public.recipe_nutrition('e1500000-0000-0000-0000-000000000001') $$,
  $$ values (array['fiber_g', 'sugars_g', 'saturated_fat_g', 'sodium_g']::text[], false) $$,
  'Nutrients some ingredient lacks are not reported (never filled in)');

-- Scaling.
select results_eq(
  $$ select servings, scale, (total ->> 'calories')::numeric, (per_serving ->> 'calories')::numeric
     from public.recipe_nutrition('e1500000-0000-0000-0000-000000000001', 12) $$,
  $$ values (12::numeric, 2::numeric, 1440::numeric, 120::numeric) $$,
  'Doubling the servings doubles the batch, not the serving');
select results_eq(
  $$ select quantity, grams from public.recipe_scaled_ingredients('e1500000-0000-0000-0000-000000000001', 3) order by ingredient_no $$,
  $$ values (90.00::numeric, 90.0::numeric), (0.50::numeric, 6.0::numeric) $$,
  'Ingredients scale with the servings');
select is((public.recipe_portion('e1500000-0000-0000-0000-000000000001', 2) ->> 'calories')::numeric, 240::numeric,
  'Eating 2 servings = 240 kcal');
select is((public.recipe_portion('e1500000-0000-0000-0000-000000000001', 1.5) ->> 'fat_g')::numeric, 4.1::numeric,
  'Portions use exact sums then round (1.5 x 2.75 = 4.125 -> 4.1)');
select throws_ok($$ select * from public.recipe_nutrition('e1500000-0000-0000-0000-000000000001', 0) $$,
  '22023', null, 'Serving counts must be positive');

-- Density: 10 ml of oil at 0.92 g/ml is 9.2 g.
insert into public.recipe_ingredients (recipe_id, position, food_id, quantity, unit, optional)
values ('e1500000-0000-0000-0000-000000000001', 3, 'f1500000-0000-0000-0000-000000000004', 10, 'ml', true);
select results_eq($$ select grams, grams_source from public.recipe_ingredients
                     where recipe_id = 'e1500000-0000-0000-0000-000000000001' and position = 3 $$,
  $$ values (9.20::numeric, 'density'::text) $$, 'ml converts with the food''s density');
select is((select (total ->> 'calories')::numeric from public.recipe_nutrition('e1500000-0000-0000-0000-000000000001')), 720::numeric,
  'Optional ingredients are excluded from nutrition');

-- Missing nutrition on a required ingredient.
insert into public.recipe_ingredients (recipe_id, position, food_id, quantity, unit)
values ('e1500000-0000-0000-0000-000000000001', 4, 'f1500000-0000-0000-0000-000000000003', 2, 'g');
select results_eq($$ select complete, missing from public.recipe_nutrition('e1500000-0000-0000-0000-000000000001') $$,
  $$ values (false, array['#4 R15 mystery spice: no usable nutrition data']::text[]) $$,
  'An ingredient without nutrition data blocks totals and is named');
delete from public.recipe_ingredients where recipe_id = 'e1500000-0000-0000-0000-000000000001' and position = 4;

-- ------------------------------------------------------------ duplicates
select throws_ok($$ insert into public.recipes (slug, name, servings, serving_label, source)
  values ('test-roti-2', 'Test Roti', 4, '1 roti', 'curated') $$,
  '23505', null, 'A second current recipe with the same name is a duplicate');
select lives_ok($$ insert into public.recipes (slug, name, variant, servings, serving_label, source)
  values ('test-roti-ghee', 'Test roti', 'with extra ghee', 4, '1 roti', 'curated') $$,
  'A different variant is a different recipe');
select throws_ok($$ insert into public.recipes (slug, name, servings, serving_label, source, owner_id)
  values ('user-roti', 'User roti', 4, '1 roti', 'user', 'a1500000-0000-0000-0000-0000000000a1') $$,
  '42501', null, 'catalogue_writer cannot create user recipes');

-- ------------------------------------------------------------ publishing
select throws_ok($$ select public.publish_recipe('e1500000-0000-0000-0000-000000000001', '') $$,
  '22023', null, 'Publishing needs a reviewer');
insert into public.recipes (id, slug, name, servings, serving_label, source)
values ('e1500000-0000-0000-0000-000000000009', 'incomplete', 'Incomplete recipe', 2, '1 bowl', 'curated');
insert into public.recipe_ingredients (recipe_id, position, food_id, quantity, unit)
values ('e1500000-0000-0000-0000-000000000009', 1, 'f1500000-0000-0000-0000-000000000001', 1, 'cup');
select throws_ok($$ select public.publish_recipe('e1500000-0000-0000-0000-000000000009', 'reviewer') $$,
  '23514', null, 'Incomplete recipes cannot be published');

select lives_ok($$ select public.publish_recipe('e1500000-0000-0000-0000-000000000001', 'reviewer') $$,
  'A complete recipe is published');
select results_eq($$ select status, is_current, (nutrition_snapshot -> 'per_serving' ->> 'calories')::numeric
                     from public.recipes where id = 'e1500000-0000-0000-0000-000000000001' $$,
  $$ values ('published'::text, true, 120::numeric) $$, 'Publishing freezes a nutrition snapshot');
select throws_ok($$ update public.recipe_ingredients set quantity = 200
                    where recipe_id = 'e1500000-0000-0000-0000-000000000001' and position = 1 $$,
  '55000', null, 'Published ingredients are immutable');
select throws_ok($$ update public.recipes set servings = 8 where id = 'e1500000-0000-0000-0000-000000000001' $$,
  '55000', null, 'Published recipes are immutable');
select throws_ok($$ delete from public.recipe_ingredients where recipe_id = 'e1500000-0000-0000-0000-000000000001' $$,
  '55000', null, 'Published ingredients cannot be removed');

-- ------------------------------------------------------------ ingredient replacement via a new version
select lives_ok($$ create temp table v2 as select public.new_recipe_version('e1500000-0000-0000-0000-000000000001') as id $$,
  'A new draft version can be created');
select results_eq($$ select version, status, is_current from public.recipes where id = (select id from v2) $$,
  $$ values (2, 'draft'::text, false) $$, 'The new version is a draft and not yet current');
update public.recipe_ingredients set food_id = 'f1500000-0000-0000-0000-000000000004', quantity = 12, unit = 'g', grams = null
  where recipe_id = (select id from v2) and position = 2;                      -- ghee -> oil
select is((select (total ->> 'calories')::numeric from public.recipe_nutrition((select id from v2))), 718::numeric,
  'Replacing an ingredient recalculates (612 + 12 g oil 106.08 = 718)');
select public.publish_recipe((select id from v2), 'reviewer');
select results_eq($$ select version, is_current from public.recipes where family_id =
                       (select family_id from public.recipes where id = 'e1500000-0000-0000-0000-000000000001') order by version $$,
  $$ values (1, false), (2, true) $$, 'Publishing v2 makes it current; v1 stays as history');
select results_eq($$ select food_id from public.recipe_ingredients
                     where recipe_id = 'e1500000-0000-0000-0000-000000000001' and position = 2 $$,
  $$ values ('f1500000-0000-0000-0000-000000000002'::uuid) $$, 'v1 still has its original ingredient');
reset role;

-- ------------------------------------------------------------ historical nutrition independence
update public.foods set kcal_per_100 = 400 where id = 'f1500000-0000-0000-0000-000000000001';   -- catalogue revision
select is((select (per_serving ->> 'calories')::numeric from public.recipe_nutrition('e1500000-0000-0000-0000-000000000001')),
  138::numeric, 'Live nutrition follows the catalogue: (180 g x 400/100 + 108) / 6 = 138');
select is((select (nutrition_snapshot -> 'per_serving' ->> 'calories')::numeric from public.recipes
           where id = 'e1500000-0000-0000-0000-000000000001'), 120::numeric,
  'The published snapshot does not change');
select is((select (nutrition_snapshot -> 'ingredients' -> 0 -> 'per_100g' ->> 'kcal')::numeric from public.recipes
           where id = 'e1500000-0000-0000-0000-000000000001'), 340::numeric,
  'It records the catalogue values it was computed from');

-- ------------------------------------------------------------ access
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1500000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
select ok((select count(*) from public.recipes where slug = 'test-roti') = 2, 'Users read published versions');
select is_empty($$ select 1 from public.recipes where status = 'draft' $$, 'Drafts are invisible to users');
select is_empty($$ select 1 from public.recipe_nutrition('e1500000-0000-0000-0000-000000000009') $$,
  'No nutrition for recipes a user cannot see');
select ok((select count(*) from public.recipe_ingredients where recipe_id = 'e1500000-0000-0000-0000-000000000001') = 3,
  'Users read ingredients of published recipes');
select throws_ok($$ insert into public.recipes (slug, name, servings, serving_label, source, owner_id)
  values ('mine', 'My recipe', 2, '1 bowl', 'user', 'a1500000-0000-0000-0000-0000000000a1') $$,
  '42501', null, 'User recipe writing is not enabled yet');
select throws_ok($$ select public.publish_recipe('e1500000-0000-0000-0000-000000000009', 'me') $$,
  '42501', null, 'Users cannot publish recipes');
reset role;

set local role anon;
select throws_ok($$ select * from public.recipes $$, '42501', null, 'anon: no recipes');
reset role;

select * from finish();
rollback;
