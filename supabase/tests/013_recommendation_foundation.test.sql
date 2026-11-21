-- 013: food attributes, meal templates, per-serving nutrition view, recommendation history and feedback.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

-- Test-only (rolled back): switch to the writer roles and let them call pgTAP.
grant catalogue_writer to postgres;
grant assistant_writer to postgres;
grant usage on schema extensions to assistant_writer;

insert into auth.users (id, email) values
  ('a1300000-0000-0000-0000-0000000000a1', 'rec-a@test.local'),
  ('b1300000-0000-0000-0000-0000000000b1', 'rec-b@test.local');

insert into public.foods (id, name, source, source_ref, verification, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
values ('f1300000-0000-0000-0000-000000000001', 'Test roti 13', 'indb', 'R13A', 'curated', 202.3, 5.88, 35.65, 3.56),
       ('f1300000-0000-0000-0000-000000000002', 'Test dal 13', 'indb', 'R13B', 'curated', 110, 7, 15, 3),
       ('f1300000-0000-0000-0000-000000000003', 'Inactive 13', 'indb', 'R13C', 'curated', 100, 1, 1, 1);
update public.foods set is_active = false where id = 'f1300000-0000-0000-0000-000000000003';
insert into public.food_servings (food_id, label, grams, is_default) values
  ('f1300000-0000-0000-0000-000000000001', '1 chapati', 36, true),
  ('f1300000-0000-0000-0000-000000000002', '1 bowl', 180, true),
  ('f1300000-0000-0000-0000-000000000003', '1 piece', 50, true);

-- ------------------------------------------------------------ catalogue_writer
set local role catalogue_writer;
select lives_ok($$ insert into public.food_attributes (food_id, diet_class, diet_status, allergens, allergen_status, regions, meal_types, countable, classifier_version, reasons)
  values ('f1300000-0000-0000-0000-000000000001', 'vegetarian', 'inferred', array['wheat_gluten'], 'inferred', array['north_indian'], array['lunch','dinner'], true, 'v1', array['name: roti']) $$,
  'The classifier writes inferred attributes');
select throws_ok($$ insert into public.food_attributes (food_id, diet_class, diet_status, allergen_status)
  values ('f1300000-0000-0000-0000-000000000002', 'vegetarian', 'reviewed', 'unknown') $$,
  '23514', null, 'The classifier can never mark anything reviewed');
select throws_ok($$ insert into public.food_attributes (food_id, diet_class, diet_status, allergen_status, source)
  values ('f1300000-0000-0000-0000-000000000002', 'vegetarian', 'reviewed', 'unknown', 'curated') $$,
  '23514', null, 'A curated review must record who and when');
select lives_ok($$ insert into public.food_attributes (food_id, diet_class, diet_status, allergens, allergen_status, source, reviewed_by, reviewed_at, vegan_compatible)
  values ('f1300000-0000-0000-0000-000000000002', 'vegan', 'reviewed', '{}', 'reviewed', 'curated', 'reviewer', now(), true) $$,
  'A recorded review can mark a food reviewed and vegan');
select throws_ok($$ update public.food_attributes set vegan_compatible = true where food_id = 'f1300000-0000-0000-0000-000000000001' $$,
  '23514', null, 'vegan_compatible requires a vegan diet class (and a review)');
select throws_ok($$ update public.food_attributes set allergens = array['strawberry'] where food_id = 'f1300000-0000-0000-0000-000000000001' $$,
  '23514', null, 'Allergens come from the fixed list');
select throws_ok($$ update public.food_attributes set diet_class = 'unknown' where food_id = 'f1300000-0000-0000-0000-000000000001' $$,
  '23514', null, 'Unknown class and status go together');

insert into public.meal_templates (id, slug, name, meal_types, regions) values
  ('e1300000-0000-0000-0000-000000000001', 'roti-dal-test', 'Roti and dal', array['lunch','dinner'], array['north_indian']),
  ('e1300000-0000-0000-0000-000000000002', 'approved-test', 'Approved test', array['lunch'], '{}');
select lives_ok($$ insert into public.meal_template_components (template_id, position, slot, food_id, default_servings, min_servings, max_servings)
  values ('e1300000-0000-0000-0000-000000000001', 1, 'bread', 'f1300000-0000-0000-0000-000000000001', 2, 1, 4),
         ('e1300000-0000-0000-0000-000000000001', 2, 'main', 'f1300000-0000-0000-0000-000000000002', 1, 0.5, 2),
         ('e1300000-0000-0000-0000-000000000002', 1, 'main', 'f1300000-0000-0000-0000-000000000002', 1, 1, 1) $$,
  'Components reference priceable foods');
select throws_ok($$ insert into public.meal_template_components (template_id, position, slot, food_id, default_servings, min_servings, max_servings)
  values ('e1300000-0000-0000-0000-000000000001', 3, 'side', 'f1300000-0000-0000-0000-000000000003', 1, 1, 1) $$,
  '23514', null, 'Inactive foods cannot be template components');
select throws_ok($$ insert into public.meal_template_components (template_id, position, slot, food_id, default_servings, min_servings, max_servings)
  values ('e1300000-0000-0000-0000-000000000002', 2, 'side', 'f1300000-0000-0000-0000-000000000001', 5, 1, 4) $$,
  '23514', null, 'Default servings must lie within min..max');
select throws_ok($$ update public.meal_templates set status = 'approved' where slug = 'approved-test' $$,
  '23514', null, 'Approval must record who and when');
update public.meal_templates set status = 'approved', approved_by = 'reviewer', approved_at = now(), approval_level = 'verified' where slug = 'approved-test';
delete from public.meal_templates where slug = 'approved-test';
select is((select count(*)::int from public.meal_templates where slug = 'approved-test'), 1, 'Approved templates cannot be deleted (retire them)');
select throws_ok($$ select * from public.food_logs $$, '42501', null, 'catalogue_writer still cannot read food logs');
select throws_ok($$ select * from public.recommendation_sets $$, '42501', null, 'catalogue_writer cannot read recommendation history');
reset role;

-- ------------------------------------------------------------ user A
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1300000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

select results_eq($$ select diet_class, diet_status from public.food_attributes where food_id = 'f1300000-0000-0000-0000-000000000001' $$,
  $$ values ('vegetarian', 'inferred') $$, 'Users read food attributes, including their status');
select results_eq($$ select slug from public.meal_templates where slug in ('roti-dal-test', 'approved-test') $$,
  $$ values ('approved-test') $$, 'Draft templates are invisible to users');
select is((select count(*)::int from public.meal_template_components where template_id = 'e1300000-0000-0000-0000-000000000001'), 0,
  'Components of draft templates are invisible too');
select throws_ok($$ insert into public.food_attributes (food_id) values ('f1300000-0000-0000-0000-000000000003') $$,
  '42501', null, 'Users cannot write food attributes');
select throws_ok($$ update public.meal_templates set status = 'approved' $$, '42501', null, 'Users cannot approve templates');

select results_eq(
  $$ select serving_label, serving_grams, calories, carbs_g, fat_g, protein_g from public.food_serving_nutrition
     where food_id = 'f1300000-0000-0000-0000-000000000001' $$,
  $$ select '1 chapati'::text, 36::numeric, calories, carbs_g, fat_g, protein_g
     from public.food_portion('f1300000-0000-0000-0000-000000000001', 36) $$,
  'Per-serving nutrition equals food_portion (the logging path)');
select is_empty($$ select 1 from public.food_serving_nutrition where food_id = 'f1300000-0000-0000-0000-000000000003' $$,
  'Inactive foods have no serving nutrition');

insert into public.recommendation_sets (id, user_id, meal_type, mode, local_date, engine_version, expires_at)
values ('d1300000-0000-0000-0000-00000000000a', 'a1300000-0000-0000-0000-0000000000a1', 'lunch', 'both', current_date, 'v1',
        now() + interval '50 years');
select ok((select expires_at < now() + interval '91 days' from public.recommendation_sets where id = 'd1300000-0000-0000-0000-00000000000a'),
  'Retention is set by the database, not the client');
insert into public.recommendation_items (set_id, user_id, rank, kind, food_id, score)
values ('d1300000-0000-0000-0000-00000000000a', 'a1300000-0000-0000-0000-0000000000a1', 1, 'food', 'f1300000-0000-0000-0000-000000000001', 0.8);
select lives_ok($$ update public.recommendation_items set outcome = 'dismissed', outcome_at = now() where rank = 1 $$,
  'Users record outcomes');
select throws_ok($$ update public.recommendation_items set score = 9 where rank = 1 $$, '42501', null,
  'Users cannot rewrite scores');
select throws_ok(
  $$ insert into public.recommendation_sets (user_id, meal_type, mode, local_date, engine_version)
     values ('b1300000-0000-0000-0000-0000000000b1', 'lunch', 'both', current_date, 'v1') $$,
  '42501', null, 'Users cannot write history for someone else');
select throws_ok(
  $$ insert into public.recommendation_items (set_id, user_id, rank, kind, template_id, score)
     values ('d1300000-0000-0000-0000-00000000000a', 'a1300000-0000-0000-0000-0000000000a1', 2, 'food', 'e1300000-0000-0000-0000-000000000002', 0.5) $$,
  '23514', null, 'Kind and reference must agree');

insert into public.recommendation_feedback (food_id, feedback) values ('f1300000-0000-0000-0000-000000000001', 'never');
insert into public.recommendation_feedback (template_id, feedback, expires_at)
values ('e1300000-0000-0000-0000-000000000002', 'less_often', now() + interval '50 years');
select results_eq($$ select feedback, expires_at is null from public.recommendation_feedback order by feedback $$,
  $$ values ('less_often', false), ('never', true) $$, '"never" never expires; others do');
select ok((select expires_at < now() + interval '181 days' from public.recommendation_feedback where feedback = 'less_often'),
  'Feedback expiry is set by the database');
select throws_ok($$ insert into public.recommendation_feedback (food_id, feedback) values ('f1300000-0000-0000-0000-000000000001', 'liked') $$,
  '23505', null, 'One feedback per food per user');
select throws_ok($$ insert into public.recommendation_feedback (feedback) values ('liked') $$,
  '23514', null, 'Feedback is about exactly one food or template');
reset role;

-- ------------------------------------------------------------ user B
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1300000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
select is_empty($$ select 1 from public.recommendation_sets $$, 'B cannot see A''s recommendations');
select is_empty($$ select 1 from public.recommendation_items $$, 'B cannot see A''s recommendation items');
select is_empty($$ select 1 from public.recommendation_feedback $$, 'B cannot see A''s feedback');
delete from public.recommendation_feedback;
reset role;
select is((select count(*)::int from public.recommendation_feedback where user_id = 'a1300000-0000-0000-0000-0000000000a1'), 2,
  'B cannot delete A''s feedback');

-- ------------------------------------------------------------ deletion and retention purge
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1300000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
delete from public.recommendation_feedback where feedback = 'never';
select is((select count(*)::int from public.recommendation_feedback), 1, 'Users can remove their own feedback');
reset role;

set local role assistant_writer;
delete from public.recommendation_sets;
reset role;
select is((select count(*)::int from public.recommendation_sets where id = 'd1300000-0000-0000-0000-00000000000a'), 1,
  'The purge role cannot delete unexpired history');
update public.recommendation_sets set expires_at = now() - interval '1 second', created_at = now() - interval '1 day'
  where id = 'd1300000-0000-0000-0000-00000000000a';
set local role assistant_writer;
select is((select count(*)::int from public.recommendation_feedback), 0, 'The purge role cannot even see unexpired feedback');
delete from public.recommendation_sets;
reset role;
select is((select count(*)::int from public.recommendation_sets where id = 'd1300000-0000-0000-0000-00000000000a'), 0,
  'Expired history is purged');
select is((select count(*)::int from public.recommendation_items where set_id = 'd1300000-0000-0000-0000-00000000000a'), 0,
  '...with its items');

set local role anon;
select throws_ok($$ select * from public.food_attributes $$, '42501', null, 'anon: no catalogue attributes');
select throws_ok($$ select * from public.food_serving_nutrition $$, '42501', null, 'anon: no serving nutrition');
reset role;

select * from finish();
rollback;
