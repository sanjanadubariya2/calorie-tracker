-- 018: personalization preferences, recipe equipment, interaction events, bookmarks, recommendation proposals.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

grant assistant_writer to postgres;
grant usage on schema extensions to assistant_writer;

insert into auth.users (id, email) values
  ('a1800000-0000-0000-0000-0000000000a1', 'p18-a@test.local'),
  ('b1800000-0000-0000-0000-0000000000b1', 'p18-b@test.local');

insert into public.foods (id, name, source, source_ref, category, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
values ('f1800000-0000-0000-0000-00000000000a', 'T18 dal', 'manual', 'T18A', 'dal', 200, 10, 20, 8);

-- ------------------------------------------------------------ recipes: equipment
insert into public.recipes (id, slug, name, servings, serving_label, source, source_name, prep_minutes, cook_minutes,
                            description, equipment)
values ('e1800000-0000-0000-0000-000000000001', 't18-dal', 'T18 dal', 2, '1 katori', 'curated', 'test', 10, 20,
        'A dal.', array['stove', 'pressure_cooker']);
insert into public.recipe_category_assignments (recipe_id, category_slug) values
  ('e1800000-0000-0000-0000-000000000001', 'dal'), ('e1800000-0000-0000-0000-000000000001', 'lunch');
insert into public.recipe_ingredients (recipe_id, position, food_id, quantity, unit)
values ('e1800000-0000-0000-0000-000000000001', 1, 'f1800000-0000-0000-0000-00000000000a', 100, 'g');
select throws_ok($$ update public.recipes set equipment = array['spaceship'] where slug = 't18-dal' $$,
  '23514', null, 'Equipment comes from the fixed list');
select public.publish_recipe('e1800000-0000-0000-0000-000000000001', 'reviewer');
select throws_ok($$ update public.recipes set equipment = array['stove'] where slug = 't18-dal' $$,
  '55000', null, 'A published recipe''s equipment is immutable');
select throws_ok($$ update public.recipes set prep_minutes = 5 where slug = 't18-dal' $$,
  '55000', null, '...and so are its times');

-- ------------------------------------------------------------ user A
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1800000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

select results_eq(
  $$ select description, prep_minutes, cook_minutes, equipment from public.recommendation_recipe_candidates()
     where slug = 't18-dal' $$,
  $$ values ('A dal.'::text, 10, 20, array['stove', 'pressure_cooker']) $$,
  'Recipe candidates carry description, times and equipment');

-- Preferences
select lives_ok($$ insert into public.user_dietary_preferences (user_id, excluded_ingredients, preferred_meal_styles,
    max_prep_minutes, budget, equipment)
  values ('a1800000-0000-0000-0000-0000000000a1', array['onion'], array['tiffin', 'dal_rice'], 30, 'low',
          array['stove', 'tawa']) $$, 'The new preference fields are stored');
select throws_ok($$ update public.user_dietary_preferences set preferred_meal_styles = array['brunch'] $$,
  '23514', null, 'Meal styles come from the fixed list');
select throws_ok($$ update public.user_dietary_preferences set equipment = array['laser'] $$,
  '23514', null, 'Equipment comes from the fixed list');
select throws_ok($$ update public.user_dietary_preferences set max_prep_minutes = 1 $$,
  '23514', null, 'Preparation time is bounded');
select throws_ok($$ update public.user_dietary_preferences set budget = 'free' $$,
  '23514', null, 'Budget is low, medium or high');
select lives_ok($$ update public.user_dietary_preferences set equipment = null $$,
  'Equipment may be "not provided" (null)');

-- History: a set with two items
insert into public.recommendation_sets (id, meal_type, mode, local_date, engine_version)
values ('c1800000-0000-0000-0000-00000000000a', 'lunch', 'both', '2026-11-21', 'rec-v2');
insert into public.recommendation_items (id, set_id, rank, kind, food_id, score)
values ('d1800000-0000-0000-0000-000000000001', 'c1800000-0000-0000-0000-00000000000a', 1, 'food',
        'f1800000-0000-0000-0000-00000000000a', 0.9);
insert into public.recommendation_items (set_id, rank, kind, food_id, score)
values ('c1800000-0000-0000-0000-00000000000a', 2, 'recipe', null, 0.8);
select isnt((select id from public.recommendation_items where rank = 2), null, 'Each recommendation gets an id');

-- Events
select lives_ok($$ insert into public.recommendation_events (set_id, rank, event, created_at)
  values ('c1800000-0000-0000-0000-00000000000a', 1, 'viewed', '2000-01-01') $$, 'Events are recorded on own items');
select ok((select created_at > now() - interval '1 minute' from public.recommendation_events limit 1),
  'Event time comes from the database clock, not the client');
select throws_ok($$ insert into public.recommendation_events (set_id, rank, event)
  values ('c1800000-0000-0000-0000-00000000000a', 1, 'loved') $$, '23514', null, 'Event kinds are fixed');
select throws_ok($$ insert into public.recommendation_events (set_id, rank, event)
  values ('c1800000-0000-0000-0000-00000000000a', 9, 'viewed') $$, '23503', null, 'Events need an existing item');

-- Feedback: saved bookmarks do not expire; less_often does
select lives_ok($$ insert into public.recommendation_feedback (food_id, feedback, item_id, name)
  values ('f1800000-0000-0000-0000-00000000000a', 'saved',
          (select id from public.recommendation_items where rank = 1), 'T18 dal') $$, 'A bookmark is feedback');
select results_eq($$ select feedback, expires_at is null, name from public.recommendation_feedback $$,
  $$ values ('saved'::text, true, 'T18 dal'::text) $$, 'Bookmarks last until removed');
update public.recommendation_feedback set feedback = 'less_often';
select ok((select expires_at > now() + interval '179 days' from public.recommendation_feedback),
  'Changing to less_often sets an expiry');
reset role;

-- ------------------------------------------------------------ user B
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1800000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
select is((select count(*)::int from public.recommendation_events), 0, 'B cannot see A''s events');
select throws_ok($$ insert into public.recommendation_events (set_id, rank, event)
  values ('c1800000-0000-0000-0000-00000000000a', 1, 'selected') $$, '23503', null,
  'B cannot record events on A''s recommendations (foreign key on the owner''s set)');
select throws_ok($$ insert into public.recommendation_events (user_id, set_id, rank, event)
  values ('a1800000-0000-0000-0000-0000000000a1', 'c1800000-0000-0000-0000-00000000000a', 1, 'selected') $$,
  '42501', null, 'B cannot write events as A');
select is((select count(*)::int from public.user_dietary_preferences), 0, 'B cannot see A''s preferences');
reset role;

-- ------------------------------------------------------------ proposals from a recommendation
set local role assistant_writer;
select lives_ok($$ insert into public.assistant_proposals (user_id, origin, conversation_id, recommendation_item_id, payload, expires_at)
  values ('a1800000-0000-0000-0000-0000000000a1', 'recommendation', null,
          'd1800000-0000-0000-0000-000000000001', '{}', now() + interval '30 minutes') $$,
  'A proposal can come from a recommendation, without a conversation');
select throws_ok($$ insert into public.assistant_proposals (user_id, conversation_id, payload, expires_at)
  values ('a1800000-0000-0000-0000-0000000000a1', null, '{}', now() + interval '30 minutes') $$,
  '23514', null, 'An assistant proposal needs its conversation');
select throws_ok($$ insert into public.assistant_proposals (user_id, origin, conversation_id, payload, expires_at)
  values ('a1800000-0000-0000-0000-0000000000a1', 'recommendation', gen_random_uuid(), '{}', now() + interval '30 minutes') $$,
  '23514', null, 'A recommendation proposal has no conversation');
reset role;

-- Deleting the set removes its items and events (retention).
delete from public.recommendation_sets where id = 'c1800000-0000-0000-0000-00000000000a';
select is((select count(*)::int from public.recommendation_events where set_id = 'c1800000-0000-0000-0000-00000000000a'),
  0, 'Events go with their set');
select is((select recommendation_item_id from public.assistant_proposals where user_id = 'a1800000-0000-0000-0000-0000000000a1'),
  null, 'A proposal outlives the purged recommendation (reference cleared)');

set local role anon;
select throws_ok($$ select * from public.recommendation_events $$, '42501', null, 'anon: no events');
reset role;

select * from finish();
rollback;
