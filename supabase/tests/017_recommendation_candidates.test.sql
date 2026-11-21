-- 017: recommendation candidate functions, attribute aggregation, recipe references in history and feedback.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

insert into auth.users (id, email) values ('a1700000-0000-0000-0000-0000000000a1', 'cand-a@test.local');

-- Foods (per 100 g). A: dal, reviewed vegetarian with milk. B: reviewed vegan. C: inferred, wheat.
-- D: no attributes. E: recipe-only ingredient. F: packaged. G: category other.
insert into public.foods (id, name, source, source_ref, category, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
values ('f1700000-0000-0000-0000-00000000000a', 'T17 dal', 'manual', 'T17A', 'dal', 200, 10, 20, 8),
       ('f1700000-0000-0000-0000-00000000000b', 'T17 sabzi', 'manual', 'T17B', 'sabzi', 100, 5, 15, 2),
       ('f1700000-0000-0000-0000-00000000000c', 'T17 garnish', 'manual', 'T17C', 'side', 50, 2, 8, 1),
       ('f1700000-0000-0000-0000-00000000000d', 'T17 snack', 'manual', 'T17D', 'snack', 400, 8, 50, 18),
       ('f1700000-0000-0000-0000-00000000000e', 'T17 raw lentil', 'manual', 'T17E', 'legume', 340, 22, 50, 1.5),
       ('f1700000-0000-0000-0000-000000000010', 'T17 other', 'manual', 'T17G', 'other', 100, 1, 1, 1);
insert into public.foods (id, name, brand, source, source_ref, category, food_kind, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
values ('f1700000-0000-0000-0000-00000000000f', 'T17 biscuits', 'Brand', 'manual', 'T17F', 'snack', 'packaged', 480, 7, 70, 20);
update public.foods set quality_flags = quality_flags || array['raw_ingredient'] where id = 'f1700000-0000-0000-0000-00000000000e';
insert into public.food_servings (food_id, label, grams, is_default) values
  ('f1700000-0000-0000-0000-00000000000a', '1 katori', 150, true),
  ('f1700000-0000-0000-0000-00000000000b', '1 katori', 100, true),
  ('f1700000-0000-0000-0000-00000000000c', '1 tbsp', 10, true),
  ('f1700000-0000-0000-0000-00000000000d', '1 plate', 50, true),
  ('f1700000-0000-0000-0000-00000000000e', '1 cup', 190, true),
  ('f1700000-0000-0000-0000-00000000000f', '4 biscuits', 30, true),
  ('f1700000-0000-0000-0000-000000000010', '1 serving', 100, true);
insert into public.food_attributes (food_id, diet_class, diet_status, vegan_compatible, jain_compatible, allergens, allergen_status,
                                    regions, meal_types, source, reviewed_by, reviewed_at)
values ('f1700000-0000-0000-0000-00000000000a', 'vegetarian', 'reviewed', false, true, array['milk'], 'reviewed',
        array['north_indian'], array['lunch', 'dinner'], 'curated', 'reviewer', now()),
       ('f1700000-0000-0000-0000-00000000000b', 'vegan', 'reviewed', true, true, '{}', 'reviewed',
        array['pan_indian'], array['lunch', 'dinner'], 'curated', 'reviewer', now());
insert into public.food_attributes (food_id, diet_class, diet_status, allergens, allergen_status, meal_types)
values ('f1700000-0000-0000-0000-00000000000c', 'vegetarian', 'inferred', array['wheat_gluten'], 'inferred', array['lunch']);

-- ------------------------------------------------------------ attribute aggregation
select results_eq(
  $$ select diet_classes, diet_status, vegan_compatible, jain_compatible, allergens, allergen_status
     from public.recommendation_attributes(array['f1700000-0000-0000-0000-00000000000a', 'f1700000-0000-0000-0000-00000000000b']::uuid[]) $$,
  $$ values (array['vegan', 'vegetarian'], 'reviewed', false, true, array['milk'], 'reviewed') $$,
  'Reviewed foods combine: classes listed, vegan false if any food is not vegan, allergens united');
select is((select vegan_compatible from public.recommendation_attributes(array['f1700000-0000-0000-0000-00000000000b']::uuid[])),
  true, 'Vegan only when every food is vegan');
select results_eq(
  $$ select diet_status, jain_compatible, allergens, allergen_status
     from public.recommendation_attributes(array['f1700000-0000-0000-0000-00000000000a', 'f1700000-0000-0000-0000-00000000000c']::uuid[]) $$,
  $$ values ('inferred', null::boolean, array['milk', 'wheat_gluten'], 'inferred') $$,
  'One inferred food makes the set inferred; Jain unknown is not true');
select results_eq(
  $$ select diet_classes, diet_status, allergen_status
     from public.recommendation_attributes(array['f1700000-0000-0000-0000-00000000000a', 'f1700000-0000-0000-0000-00000000000d']::uuid[]) $$,
  $$ values (array['unknown', 'vegetarian'], 'unknown', 'unknown') $$,
  'A food without attributes makes the set unknown');
select results_eq(
  $$ select diet_classes, diet_status, vegan_compatible from public.recommendation_attributes(array['f1700000-0000-0000-0000-0000000000ff']::uuid[]) $$,
  $$ values (array['unknown'], 'unknown', null::boolean) $$, 'A missing food counts as unknown');
select is((select diet_status from public.recommendation_attributes('{}')), 'unknown', 'An empty set is unknown');

-- ------------------------------------------------------------ catalogue fixtures (recipe, template)
insert into public.recipes (id, slug, name, servings, serving_label, source, source_name)
values ('e1700000-0000-0000-0000-000000000001', 't17-dal-sabzi', 'T17 dal sabzi', 2, '1 katori', 'curated', 'test kitchen'),
       ('e1700000-0000-0000-0000-000000000002', 't17-draft', 'T17 draft', 2, '1 katori', 'curated', 'test kitchen');
insert into public.recipe_category_assignments (recipe_id, category_slug) values
  ('e1700000-0000-0000-0000-000000000001', 'dal'), ('e1700000-0000-0000-0000-000000000001', 'lunch'),
  ('e1700000-0000-0000-0000-000000000001', 'north_indian');
insert into public.recipe_ingredients (recipe_id, position, food_id, quantity, unit, optional) values
  ('e1700000-0000-0000-0000-000000000001', 1, 'f1700000-0000-0000-0000-00000000000b', 50, 'g', false),
  ('e1700000-0000-0000-0000-000000000001', 2, 'f1700000-0000-0000-0000-00000000000a', 100, 'g', false),
  ('e1700000-0000-0000-0000-000000000001', 3, 'f1700000-0000-0000-0000-00000000000c', 5, 'g', true),
  ('e1700000-0000-0000-0000-000000000002', 1, 'f1700000-0000-0000-0000-00000000000a', 100, 'g', false);
select public.publish_recipe('e1700000-0000-0000-0000-000000000001', 'reviewer');

insert into public.meal_templates (id, slug, name, meal_types, regions, status, approved_by, approved_at) values
  ('e1700000-0000-0000-0000-000000000011', 't17-thali', 'T17 thali', array['lunch'], array['north_indian'], 'draft', null, null);
insert into public.meal_templates (id, slug, name, meal_types, regions) values
  ('e1700000-0000-0000-0000-000000000012', 't17-draft-thali', 'T17 draft thali', array['lunch'], '{}');
insert into public.meal_template_components (template_id, position, slot, food_id, default_servings, min_servings, max_servings, optional) values
  ('e1700000-0000-0000-0000-000000000011', 1, 'side', 'f1700000-0000-0000-0000-00000000000b', 1, 0.5, 2, false),
  ('e1700000-0000-0000-0000-000000000011', 2, 'main', 'f1700000-0000-0000-0000-00000000000a', 1, 0.5, 2, false),
  ('e1700000-0000-0000-0000-000000000011', 3, 'accompaniment', 'f1700000-0000-0000-0000-00000000000c', 1, 1, 1, true),
  ('e1700000-0000-0000-0000-000000000012', 1, 'main', 'f1700000-0000-0000-0000-00000000000a', 1, 1, 1, false);
update public.meal_templates set status = 'approved', approved_by = 'reviewer', approved_at = now(), approval_level = 'verified'
where id = 'e1700000-0000-0000-0000-000000000011';

-- ------------------------------------------------------------ as a signed-in user
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1700000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

-- Recipes
select is((select count(*)::int from public.recommendation_recipe_candidates() where slug like 't17-%'), 1,
  'Only the published recipe is a candidate (drafts are not)');
-- dal 100 g: 200 kcal P10; sabzi 50 g: 50 kcal P2.5 -> 250 kcal, P12.5 over 2 servings.
select results_eq(
  $$ select complete, (per_serving ->> 'calories')::numeric, (per_serving ->> 'protein_g')::numeric, main_food_name
     from public.recommendation_recipe_candidates() where slug = 't17-dal-sabzi' $$,
  $$ values (true, 125::numeric, 6.3::numeric, 'T17 dal'::text) $$,
  'Per-serving nutrition comes from recipe_nutrition; the heaviest required ingredient is the main one');
select results_eq(
  $$ select meal_types, regions, dish_types from public.recommendation_recipe_candidates() where slug = 't17-dal-sabzi' $$,
  $$ values (array['lunch'], array['north_indian'], array['dal']) $$,
  'Categories are split into meal types, regions and dish types');
select results_eq(
  $$ select diet_classes, diet_status, allergens, allergen_status, jsonb_array_length(ingredients)
     from public.recommendation_recipe_candidates() where slug = 't17-dal-sabzi' $$,
  $$ values (array['vegan', 'vegetarian'], 'inferred', array['milk', 'wheat_gluten'], 'inferred', 3) $$,
  'Attributes cover every ingredient, optional garnish included (its allergen counts)');

-- Templates
select is((select count(*)::int from public.recommendation_template_candidates() where slug like 't17-%'), 1,
  'Only approved templates are candidates');
select results_eq(
  $$ select complete, main_food_name, jsonb_array_length(components), allergens, diet_status,
            (components -> 1 -> 'per_serving' ->> 'calories')::numeric
     from public.recommendation_template_candidates() where slug = 't17-thali' $$,
  $$ values (true, 'T17 dal'::text, 3, array['milk'], 'reviewed', 300::numeric) $$,
  'Components carry default-serving nutrition; attributes cover required components only; main slot first');

-- Foods
select results_eq(
  $$ select name, serving_label, calories, protein_g, diet_classes, diet_status
     from public.recommendation_food_candidates() where name like 'T17%' order by name $$,
  $$ values ('T17 dal'::text, '1 katori'::text, 300::numeric, 15.0::numeric, array['vegetarian'], 'reviewed'),
            ('T17 garnish', '1 tbsp', 5, 0.2, array['vegetarian'], 'inferred'),
            ('T17 sabzi', '1 katori', 100, 5.0, array['vegan'], 'reviewed'),
            ('T17 snack', '1 plate', 200, 4.0, array['unknown'], 'unknown') $$,
  'Single dishes exclude raw ingredients, packaged products and uncategorised foods; missing attributes are unknown');

-- History and feedback reference recipes
insert into public.recommendation_sets (id, meal_type, mode, local_date, engine_version)
values ('c1700000-0000-0000-0000-000000000001', 'lunch', 'meals', '2026-11-21', 'test');
select lives_ok($$ insert into public.recommendation_items (set_id, rank, kind, recipe_id, score)
  values ('c1700000-0000-0000-0000-000000000001', 1, 'recipe', 'e1700000-0000-0000-0000-000000000001', 0.8) $$,
  'A recommendation can reference a recipe');
select throws_ok($$ insert into public.recommendation_items (set_id, rank, kind, recipe_id, food_id, score)
  values ('c1700000-0000-0000-0000-000000000001', 2, 'recipe', 'e1700000-0000-0000-0000-000000000001', 'f1700000-0000-0000-0000-00000000000a', 0.8) $$,
  '23514', null, 'A recipe row cannot also reference a food');
select throws_ok($$ insert into public.recommendation_items (set_id, rank, kind, food_id, score)
  values ('c1700000-0000-0000-0000-000000000001', 2, 'side_dish', 'f1700000-0000-0000-0000-00000000000a', 0.8) $$,
  '23514', null, 'Kinds are fixed');
select lives_ok($$ insert into public.recommendation_items (set_id, rank, kind, recipe_id, score)
  values ('c1700000-0000-0000-0000-000000000001', 4, 'combo', 'e1700000-0000-0000-0000-000000000001', 0.7) $$,
  'A combination references its main recipe');
select lives_ok($$ insert into public.recommendation_items (set_id, rank, kind, template_id, score)
  values ('c1700000-0000-0000-0000-000000000001', 3, 'meal', null, 0.5) $$,
  'A meal row whose template was deleted (reference set null) is valid');
select lives_ok($$ insert into public.recommendation_feedback (recipe_family_id, feedback)
  values ((select family_id from public.recommendation_recipe_candidates() where slug = 't17-dal-sabzi'), 'never') $$,
  'Feedback can target a recipe family (all versions)');
select throws_ok($$ insert into public.recommendation_feedback (recipe_family_id, feedback)
  values ((select family_id from public.recommendation_recipe_candidates() where slug = 't17-dal-sabzi'), 'liked') $$,
  '23505', null, 'One feedback row per recipe family');
select throws_ok($$ insert into public.recommendation_feedback (food_id, recipe_family_id, feedback)
  values ('f1700000-0000-0000-0000-00000000000a', gen_random_uuid(), 'liked') $$,
  '23514', null, 'Feedback targets exactly one thing');
reset role;

-- A food that can no longer be priced makes its template incomplete (never priced from stale data).
update public.foods set is_active = false where id = 'f1700000-0000-0000-0000-00000000000b';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1700000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
select is((select complete from public.recommendation_template_candidates() where slug = 't17-thali'), false,
  'A template with an unpriceable required component is incomplete');
-- The same food is a recipe ingredient: the recipe must not be priced without it (015 left it out silently).
select results_eq(
  $$ select complete, per_serving is null, missing from public.recommendation_recipe_candidates() where slug = 't17-dal-sabzi' $$,
  $$ values (false, true, array['#1: ingredient is no longer available']) $$,
  'A recipe with a deactivated ingredient is incomplete, not under-counted');
select is(public.recipe_portion('e1700000-0000-0000-0000-000000000001', 1), null, '...and cannot be priced');
select results_eq(
  $$ select food_name from public.recipe_scaled_ingredients('e1700000-0000-0000-0000-000000000001') order by ingredient_no $$,
  $$ values ('(no longer available)'::text), ('T17 dal'), ('T17 garnish') $$,
  'The scaled ingredient list keeps the unavailable ingredient');
select is((select diet_status from public.recommendation_recipe_candidates() where slug = 't17-dal-sabzi'), 'unknown',
  'Attributes of an unavailable ingredient are unknown');
reset role;

-- ------------------------------------------------------------ definitions and access
select is((select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
           and proname in ('recommendation_attributes', 'recommendation_recipe_candidates',
                           'recommendation_template_candidates', 'recommendation_food_candidates')), 0,
  'Candidate functions run as the caller (SECURITY INVOKER)');
set local role anon;
select throws_ok($$ select * from public.recommendation_food_candidates() $$, '42501', null, 'anon cannot list candidates');
select throws_ok($$ select * from public.recommendation_recipe_candidates() $$, '42501', null, 'anon cannot list recipes');
reset role;

select * from finish();
rollback;
