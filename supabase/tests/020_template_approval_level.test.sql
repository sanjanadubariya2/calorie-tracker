-- 020: approvals record provisional vs verified; candidates expose the level.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

insert into auth.users (id, email) values ('a2000000-0000-0000-0000-0000000000a1', 'p20@test.local');
insert into public.foods (id, name, source, source_ref, category, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
values ('f2000000-0000-0000-0000-00000000000a', 'T20 poha', 'manual', 'T20A', 'snack', 293, 6, 35, 14);
insert into public.food_servings (food_id, label, grams, is_default) values ('f2000000-0000-0000-0000-00000000000a', '1 bowl', 55, true);
insert into public.meal_templates (id, slug, name, meal_types) values
  ('e2000000-0000-0000-0000-000000000001', 't20-poha', 'T20 poha', array['breakfast']),
  ('e2000000-0000-0000-0000-000000000002', 't20-verified', 'T20 verified', array['breakfast']);
insert into public.meal_template_components (template_id, position, slot, food_id, default_servings, min_servings, max_servings)
values ('e2000000-0000-0000-0000-000000000001', 1, 'main', 'f2000000-0000-0000-0000-00000000000a', 1, 1, 2),
       ('e2000000-0000-0000-0000-000000000002', 1, 'main', 'f2000000-0000-0000-0000-00000000000a', 1, 1, 2);

select throws_ok($$ update public.meal_templates set status = 'approved', approved_by = 'r', approved_at = now()
  where slug = 't20-poha' $$, '23514', null, 'An approval must say whether it is provisional or verified');
select throws_ok($$ update public.meal_templates set status = 'approved', approved_by = 'r', approved_at = now(),
  approval_level = 'provisional' where slug = 't20-poha' $$, '23514', null, 'A provisional approval needs a note');
select throws_ok($$ update public.meal_templates set approval_level = 'trusted' where slug = 't20-poha' $$,
  '23514', null, 'Levels are provisional or verified');
select lives_ok($$ update public.meal_templates set status = 'approved', approved_by = 'r', approved_at = now(),
  approval_level = 'provisional', approval_note = 'Bulk approval, not individually verified' where slug = 't20-poha' $$,
  'A provisional approval with a note is accepted');
select lives_ok($$ update public.meal_templates set status = 'approved', approved_by = 'r', approved_at = now(),
  approval_level = 'verified' where slug = 't20-verified' $$, 'A verified approval needs no note');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
select results_eq(
  $$ select slug, approval_level from public.recommendation_template_candidates() where slug like 't20-%' order by slug $$,
  $$ values ('t20-poha'::text, 'provisional'::text), ('t20-verified', 'verified') $$,
  'Candidates carry the approval level');
reset role;

select * from finish();
rollback;
