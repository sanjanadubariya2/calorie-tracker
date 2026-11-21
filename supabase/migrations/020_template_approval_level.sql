-- Migration 020: provisional vs verified template approval (Phase 3).
--
-- 013 recorded an approval only as status = 'approved' + approved_by/at, which
-- cannot say whether a person actually verified the template. Templates can
-- now be approved provisionally (usable by the recommendation engine, NOT
-- individually verified) or verified:
--
--   approval_level  provisional | verified   required once a template is approved
--   approval_note   required for a provisional approval (why, by whom)
--
-- Existing approved templates (if any) become 'provisional': an approval made
-- before this distinction existed is never upgraded to verified silently.
-- recommendation_template_candidates() returns approval_level so cards can say
-- a meal is provisionally approved. No data is loaded or approved here.
--
-- Rollback (local): drop the two columns and the constraint, and re-run
-- 019_template_component_attributes.sql.

alter table public.meal_templates
  add column if not exists approval_level text check (approval_level is null or approval_level in ('provisional', 'verified')),
  add column if not exists approval_note text check (approval_note is null or char_length(btrim(approval_note)) between 1 and 500);

update public.meal_templates set approval_level = 'provisional',
  approval_note = coalesce(approval_note, 'Approved before provisional/verified levels existed (migration 020).')
where status = 'approved' and approval_level is null;

alter table public.meal_templates drop constraint if exists meal_templates_approval_level_recorded;
alter table public.meal_templates add constraint meal_templates_approval_level_recorded check (
  (status <> 'approved' or approval_level is not null)
  and (approval_level is distinct from 'provisional' or approval_note is not null));

drop function if exists public.recommendation_template_candidates();
create function public.recommendation_template_candidates()
returns table (
  template_id uuid, slug text, name text, description text, version int,
  meal_types text[], regions text[], approval_level text,
  components jsonb, complete boolean, main_food_id uuid, main_food_name text,
  diet_classes text[], diet_status text, vegan_compatible boolean, jain_compatible boolean,
  allergens text[], allergen_status text, quality_flags text[])
language sql
stable
security invoker
set search_path = ''
as $$
  select t.id, t.slug, t.name, t.description, t.version, t.meal_types, t.regions, t.approval_level,
         coalesce(comp.components, '[]'::jsonb), coalesce(comp.complete, false), main.food_id, main.food_name,
         attr.diet_classes, attr.diet_status, attr.vegan_compatible, attr.jain_compatible,
         attr.allergens, attr.allergen_status, attr.quality_flags
  from public.meal_templates t
  left join lateral (
    select jsonb_agg(jsonb_build_object(
             'position', c.position, 'slot', c.slot, 'food_id', c.food_id, 'food_name', f.name,
             'category', f.category, 'source', f.source, 'verification', f.verification,
             'default_servings', c.default_servings, 'min_servings', c.min_servings,
             'max_servings', c.max_servings, 'servings_step', c.servings_step, 'optional', c.optional,
             'serving_label', sn.serving_label, 'serving_grams', sn.serving_grams,
             'per_serving', case when sn.food_id is null then null else jsonb_build_object(
               'calories', sn.calories, 'protein_g', sn.protein_g, 'carbs_g', sn.carbs_g, 'fat_g', sn.fat_g) end,
             'diet_class', coalesce(a.diet_class, 'unknown'),
             'diet_status', case when f.id is null then 'unknown' else coalesce(a.diet_status, 'unknown') end,
             'vegan_compatible', a.vegan_compatible, 'jain_compatible', a.jain_compatible,
             'allergens', coalesce(to_jsonb(a.allergens), '[]'::jsonb),
             'allergen_status', case when f.id is null then 'unknown' else coalesce(a.allergen_status, 'unknown') end,
             'quality_flags', coalesce(to_jsonb(f.quality_flags), '[]'::jsonb))
             order by c.position) as components,
           coalesce(bool_and(sn.food_id is not null) filter (where not c.optional), false) as complete,
           array_agg(c.food_id) filter (where not c.optional) as required_ids
    from public.meal_template_components c
    left join public.foods f on f.id = c.food_id
    left join public.food_serving_nutrition sn on sn.food_id = c.food_id
    left join public.food_attributes a on a.food_id = c.food_id
    where c.template_id = t.id
  ) comp on true
  left join lateral (
    select c.food_id, f.name as food_name
    from public.meal_template_components c
    join public.foods f on f.id = c.food_id
    where c.template_id = t.id and not c.optional
    order by (c.slot = 'main') desc, c.position
    limit 1
  ) main on true
  cross join lateral public.recommendation_attributes(comp.required_ids) attr
  where t.status = 'approved'
  order by t.slug, t.id;
$$;

revoke all on function public.recommendation_template_candidates() from public, anon;
grant execute on function public.recommendation_template_candidates() to authenticated;
