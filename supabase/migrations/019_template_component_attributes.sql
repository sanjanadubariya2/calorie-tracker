-- Migration 019: per-component attributes for meal template candidates
-- (Phase 3, template review corrections).
--
-- Optional template components are offered to users as add-ons. Each add-on
-- is filtered against the user's diet, allergies and exclusions on its own,
-- so recommendation_template_candidates() now carries every component's diet
-- class/status, vegan/Jain flags, detected allergens/status and catalogue
-- quality flags (e.g. density_assumed). The template-level attributes still
-- cover required components only (the base meal). Same signature as 017.
--
-- Rollback (local): re-run section 4 of 017_recommendation_candidates.sql.
--
-- Re-runnable: 020 later changes this function's return type, so drop first
-- (re-running 019 must be followed by 020 again, as in the documented order).

drop function if exists public.recommendation_template_candidates();
create or replace function public.recommendation_template_candidates()
returns table (
  template_id uuid, slug text, name text, description text, version int,
  meal_types text[], regions text[],
  components jsonb, complete boolean, main_food_id uuid, main_food_name text,
  diet_classes text[], diet_status text, vegan_compatible boolean, jain_compatible boolean,
  allergens text[], allergen_status text, quality_flags text[])
language sql
stable
security invoker
set search_path = ''
as $$
  select t.id, t.slug, t.name, t.description, t.version, t.meal_types, t.regions,
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
             -- This component's own attributes; a hidden (inactive) food is unknown.
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
