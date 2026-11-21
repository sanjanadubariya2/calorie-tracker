-- 019: template candidates carry each component's own attributes; the template's cover the base meal only.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

insert into auth.users (id, email) values ('a1900000-0000-0000-0000-0000000000a1', 'p19@test.local');
insert into public.foods (id, name, source, source_ref, category, kcal_per_100, protein_g_per_100, carbs_g_per_100, fat_g_per_100)
values ('f1900000-0000-0000-0000-00000000000a', 'T19 poha', 'manual', 'T19A', 'snack', 293, 6, 35, 14),
       ('f1900000-0000-0000-0000-00000000000b', 'T19 tea', 'manual', 'T19B', 'beverage', 16, 0.4, 2.6, 0.5);
update public.foods set quality_flags = quality_flags || array['density_assumed'] where id = 'f1900000-0000-0000-0000-00000000000b';
insert into public.food_servings (food_id, label, grams, is_default) values
  ('f1900000-0000-0000-0000-00000000000a', '1 bowl', 55, true),
  ('f1900000-0000-0000-0000-00000000000b', '1 tea cup', 210, true);
insert into public.food_attributes (food_id, diet_class, diet_status, allergens, allergen_status, meal_types)
values ('f1900000-0000-0000-0000-00000000000a', 'vegetarian', 'inferred', '{}', 'inferred', array['breakfast']),
       ('f1900000-0000-0000-0000-00000000000b', 'vegetarian', 'inferred', array['milk'], 'inferred', array['breakfast']);
insert into public.meal_templates (id, slug, name, meal_types, regions)
values ('e1900000-0000-0000-0000-000000000001', 't19-poha-tea', 'T19 poha with tea', array['breakfast'], array['west_indian']);
insert into public.meal_template_components (template_id, position, slot, food_id, default_servings, min_servings, max_servings, optional)
values ('e1900000-0000-0000-0000-000000000001', 1, 'main', 'f1900000-0000-0000-0000-00000000000a', 2, 1, 2, false),
       ('e1900000-0000-0000-0000-000000000001', 2, 'drink', 'f1900000-0000-0000-0000-00000000000b', 1, 1, 1, true);
update public.meal_templates set status = 'approved', approved_by = 'reviewer', approved_at = now(), approval_level = 'verified'
where id = 'e1900000-0000-0000-0000-000000000001';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1900000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

select results_eq(
  $$ select allergens, quality_flags from public.recommendation_template_candidates() where slug = 't19-poha-tea' $$,
  $$ values ('{}'::text[], '{}'::text[]) $$,
  'Template-level attributes cover the base meal (required components) only');
select results_eq(
  $$ select (c ->> 'optional')::boolean, c ->> 'diet_class', c ->> 'diet_status', c -> 'allergens', c ->> 'allergen_status', c -> 'quality_flags'
     from public.recommendation_template_candidates() t, jsonb_array_elements(t.components) c
     where t.slug = 't19-poha-tea' order by (c ->> 'position')::int $$,
  $$ values (false, 'vegetarian'::text, 'inferred'::text, '[]'::jsonb, 'inferred'::text, '[]'::jsonb),
            (true, 'vegetarian', 'inferred', '["milk"]'::jsonb, 'inferred', '["density_assumed"]'::jsonb) $$,
  'Each component carries its own diet, allergens (with status) and quality flags');
reset role;

-- A deactivated optional food is hidden from users: its attributes are unknown, not empty.
update public.foods set is_active = false where id = 'f1900000-0000-0000-0000-00000000000b';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1900000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
select results_eq(
  $$ select c ->> 'diet_status', c ->> 'allergen_status', c -> 'per_serving'
     from public.recommendation_template_candidates() t, jsonb_array_elements(t.components) c
     where t.slug = 't19-poha-tea' and (c ->> 'optional')::boolean $$,
  $$ values ('unknown'::text, 'unknown'::text, 'null'::jsonb) $$,
  'An unavailable optional component is unknown and unpriced (never offered)');
select is((select complete from public.recommendation_template_candidates() where slug = 't19-poha-tea'), true,
  '...while the base meal stays complete');
reset role;

select * from finish();
rollback;
