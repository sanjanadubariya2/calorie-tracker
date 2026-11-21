-- Migration 017: recommendation candidates (Phase 3, Task 3)
--
-- Read-only candidate sources for the deterministic recommendation engine
-- (backend/app/recommendations). Nothing here scores or ranks; the functions
-- only gather what the engine needs: catalogue nutrition (never estimated),
-- portions, ingredients and diet/allergen attributes combined over every
-- ingredient.
--
--   recommendation_attributes(uuid[])        diet/allergen attributes of a set of foods
--   recommendation_recipe_candidates()       published, current catalogue recipes
--   recommendation_template_candidates()     approved meal templates
--   recommendation_food_candidates()         single dishes with a default serving
--
-- All functions are SECURITY INVOKER with an empty search_path: the caller's
-- RLS applies (users see published recipes, approved templates, active foods).
-- Recipe candidates exclude user-owned recipes so the result is the same for
-- every user (the backend may cache it).
--
-- Also: recommendation history and feedback can reference recipes, and
-- 015's recipe_sums / recipe_scaled_ingredients no longer drop ingredients the
-- caller cannot see (see 1b).
--
-- Rollback (local): drop the four functions; drop the recipe columns and
-- restore 013's checks (only valid while no recipe rows exist):
--   alter table public.recommendation_items drop constraint recommendation_items_reference_check,
--     drop column recipe_id, drop constraint recommendation_items_kind_check,
--     add constraint recommendation_items_kind_check check (kind in ('food','meal')),
--     add constraint recommendation_items_check check ((kind = 'food') = (template_id is null));
--   alter table public.recommendation_feedback drop constraint recommendation_feedback_target_check,
--     drop column recipe_family_id,
--     add constraint recommendation_feedback_check check ((food_id is null) <> (template_id is null));

-- ============================================================
-- 1. Recipes in recommendation history and feedback
-- ============================================================
alter table public.recommendation_items
  add column if not exists recipe_id uuid references public.recipes(id) on delete set null;

alter table public.recommendation_items drop constraint if exists recommendation_items_kind_check;
alter table public.recommendation_items add constraint recommendation_items_kind_check
  check (kind in ('food', 'meal', 'recipe', 'combo'));

-- 013's check, (kind = 'food') = (template_id is null), rejected a meal row whose
-- template had been deleted (on delete set null). A row now only has to avoid
-- referencing another kind; its own reference may become null. A 'combo'
-- (a main recipe served with a rice or bread recipe) references its main
-- recipe; the other recipe is recorded in score_breakdown.
alter table public.recommendation_items drop constraint if exists recommendation_items_check;
alter table public.recommendation_items drop constraint if exists recommendation_items_reference_check;
alter table public.recommendation_items add constraint recommendation_items_reference_check check (
  case kind
    when 'food' then template_id is null and recipe_id is null
    when 'meal' then food_id is null and recipe_id is null
    else food_id is null and template_id is null
  end);

create index if not exists recommendation_items_recipe_idx
  on public.recommendation_items (recipe_id) where recipe_id is not null;

-- Feedback on a recipe applies to every version, so it references the family.
-- (No foreign key: family_id is shared by versions and is not unique.)
alter table public.recommendation_feedback add column if not exists recipe_family_id uuid;
alter table public.recommendation_feedback drop constraint if exists recommendation_feedback_check;
alter table public.recommendation_feedback drop constraint if exists recommendation_feedback_target_check;
alter table public.recommendation_feedback add constraint recommendation_feedback_target_check
  check (num_nonnulls(food_id, template_id, recipe_family_id) = 1);
create unique index if not exists recommendation_feedback_recipe_family_key
  on public.recommendation_feedback (user_id, recipe_family_id) where recipe_family_id is not null;

-- ============================================================
-- 1b. Fix (015): ingredients a user cannot see
-- ============================================================
-- Users only see active foods (RLS). 015's recipe_sums inner-joined foods, so
-- after an ingredient was deactivated a user saw the recipe as complete with
-- that ingredient silently left out of the totals (under-reported nutrition).
-- An ingredient that is not visible now makes the recipe incomplete.
create or replace function public.recipe_sums(p_recipe_id uuid, p_scale numeric)
returns table (grams numeric, kcal numeric, protein_g numeric, carbs_g numeric, fat_g numeric,
               fiber_g numeric, sugars_g numeric, saturated_fat_g numeric, sodium_g numeric,
               ingredient_count int, missing text[], missing_nutrients text[])
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  ing record;
  g numeric;
  v_missing text[] := '{}';
  v_count int := 0;
  s_g numeric := 0; s_kcal numeric := 0; s_p numeric := 0; s_c numeric := 0; s_f numeric := 0;
  s_fib numeric := 0; s_sug numeric := 0; s_sat numeric := 0; s_sod numeric := 0;
  all_fib boolean := true; all_sug boolean := true; all_sat boolean := true; all_sod boolean := true;
begin
  for ing in
    select i.position, i.grams as ing_grams, f.id as visible_id, f.name as food_name,
           case when f.id is null then null else public.food_snapshot_per_100g(f) end as snap
    from public.recipe_ingredients i left join public.foods f on f.id = i.food_id
    where i.recipe_id = p_recipe_id and not i.optional
    order by i.position
  loop
    v_count := v_count + 1;
    if ing.visible_id is null then
      v_missing := v_missing || format('#%s: ingredient is no longer available', ing.position);
      continue;
    end if;
    if ing.ing_grams is null then
      v_missing := v_missing || format('#%s %s: no weight in grams', ing.position, ing.food_name);
      continue;
    end if;
    if ing.snap is null then
      v_missing := v_missing || format('#%s %s: no usable nutrition data', ing.position, ing.food_name);
      continue;
    end if;
    g := ing.ing_grams * p_scale;
    s_g := s_g + g;
    s_kcal := s_kcal + (ing.snap ->> 'kcal')::numeric * g / 100;
    s_p := s_p + (ing.snap ->> 'protein_g')::numeric * g / 100;
    s_c := s_c + (ing.snap ->> 'carbs_g')::numeric * g / 100;
    s_f := s_f + (ing.snap ->> 'fat_g')::numeric * g / 100;
    if (ing.snap ->> 'fiber_g') is null then all_fib := false; else s_fib := s_fib + (ing.snap ->> 'fiber_g')::numeric * g / 100; end if;
    if (ing.snap ->> 'sugars_g') is null then all_sug := false; else s_sug := s_sug + (ing.snap ->> 'sugars_g')::numeric * g / 100; end if;
    if (ing.snap ->> 'saturated_fat_g') is null then all_sat := false; else s_sat := s_sat + (ing.snap ->> 'saturated_fat_g')::numeric * g / 100; end if;
    if (ing.snap ->> 'sodium_g') is null then all_sod := false; else s_sod := s_sod + (ing.snap ->> 'sodium_g')::numeric * g / 100; end if;
  end loop;
  if v_count = 0 then
    v_missing := v_missing || 'no required ingredients'::text;
  end if;
  return query select s_g, s_kcal, s_p, s_c, s_f,
    case when all_fib then s_fib end, case when all_sug then s_sug end,
    case when all_sat then s_sat end, case when all_sod then s_sod end,
    v_count, v_missing,
    array_remove(array[case when not all_fib then 'fiber_g' end, case when not all_sug then 'sugars_g' end,
                       case when not all_sat then 'saturated_fat_g' end, case when not all_sod then 'sodium_g' end], null);
end;
$$;

-- Same fix for the scaled ingredient list: a hidden ingredient stays listed.
create or replace function public.recipe_scaled_ingredients(p_recipe_id uuid, p_servings numeric default null)
returns table (ingredient_no smallint, food_id uuid, food_name text, quantity numeric, unit text, grams numeric,
               preparation text, optional boolean)
language sql
stable
security invoker
set search_path = ''
as $$
  select i.position, i.food_id, coalesce(f.name, '(no longer available)'),
         round(i.quantity * coalesce(p_servings, r.servings) / r.servings, 2), i.unit,
         round(i.grams * coalesce(p_servings, r.servings) / r.servings, 1),
         i.preparation, i.optional
  from public.recipes r
  join public.recipe_ingredients i on i.recipe_id = r.id
  left join public.foods f on f.id = i.food_id
  where r.id = p_recipe_id
  order by i.position;
$$;

-- ============================================================
-- 2. Attributes of a set of foods
-- ============================================================
-- One row describing every food in p_food_ids together:
--   diet_classes     the distinct diet classes ('unknown' if any food lacks attributes)
--   diet_status      reviewed only if every food is reviewed; unknown if any is unknown
--   vegan/jain       false if any food is false; true only if every food is true; else null
--   allergens        the union of detected allergens
--   allergen_status  as diet_status
--   quality_flags    the union of catalogue quality flags
-- A food that is missing or not visible counts as unknown.
create or replace function public.recommendation_attributes(p_food_ids uuid[])
returns table (diet_classes text[], diet_status text, vegan_compatible boolean, jain_compatible boolean,
               allergens text[], allergen_status text, quality_flags text[])
language sql
stable
security invoker
set search_path = ''
as $$
  with ids as (
    select distinct u.id from unnest(coalesce(p_food_ids, '{}'::uuid[])) as u(id) where u.id is not null
  ), x as (
    select f.id, f.quality_flags,
           coalesce(a.diet_class, 'unknown') as diet_class,
           coalesce(a.diet_status, 'unknown') as diet_status,
           a.vegan_compatible, a.jain_compatible,
           coalesce(a.allergens, '{}'::text[]) as allergens,
           coalesce(a.allergen_status, 'unknown') as allergen_status
    from ids
    join public.foods f on f.id = ids.id
    left join public.food_attributes a on a.food_id = f.id
  ), n as (
    select (select count(*) from ids) as wanted, (select count(*) from x) as found
  )
  select
    case when n.found < n.wanted or n.wanted = 0
         then array(select distinct c from (select x.diet_class as c from x union all select 'unknown') s order by 1)
         else array(select distinct x.diet_class from x order by 1) end,
    case when n.found < n.wanted or n.wanted = 0 or exists (select 1 from x where x.diet_status = 'unknown') then 'unknown'
         when not exists (select 1 from x where x.diet_status <> 'reviewed') then 'reviewed'
         else 'inferred' end,
    case when exists (select 1 from x where x.vegan_compatible is false) then false
         when n.found = n.wanted and n.wanted > 0 and not exists (select 1 from x where x.vegan_compatible is not true) then true
    end,
    case when exists (select 1 from x where x.jain_compatible is false) then false
         when n.found = n.wanted and n.wanted > 0 and not exists (select 1 from x where x.jain_compatible is not true) then true
    end,
    array(select distinct e from x cross join unnest(x.allergens) as e order by 1),
    case when n.found < n.wanted or n.wanted = 0 or exists (select 1 from x where x.allergen_status = 'unknown') then 'unknown'
         when not exists (select 1 from x where x.allergen_status <> 'reviewed') then 'reviewed'
         else 'inferred' end,
    array(select distinct q from x cross join unnest(x.quality_flags) as q order by 1)
  from n;
$$;

-- ============================================================
-- 3. Recipe candidates: published, current catalogue recipes
-- ============================================================
-- per_serving comes from recipe_nutrition() (sum of ingredient grams x
-- catalogue values); it is null when the recipe is incomplete. Attributes
-- cover every ingredient, optional ones included (a garnish can still carry
-- an allergen). The main ingredient is the heaviest required ingredient.
create or replace function public.recommendation_recipe_candidates()
returns table (
  recipe_id uuid, family_id uuid, version int, slug text, name text, variant text,
  servings numeric, serving_label text,
  meal_types text[], regions text[], dish_types text[],
  source text, verification text, quantities_estimated boolean,
  complete boolean, missing text[], missing_nutrients text[], per_serving jsonb,
  ingredients jsonb, main_food_id uuid, main_food_name text,
  diet_classes text[], diet_status text, vegan_compatible boolean, jain_compatible boolean,
  allergens text[], allergen_status text, quality_flags text[])
language sql
stable
security invoker
set search_path = ''
as $$
  select r.id, r.family_id, r.version, r.slug, r.name, r.variant, r.servings, r.serving_label,
         coalesce(cats.meal_types, '{}'), coalesce(cats.regions, '{}'), coalesce(cats.dish_types, '{}'),
         r.source, r.verification, r.quantities_estimated,
         coalesce(n.complete, false), coalesce(n.missing, array['no nutrition']), n.missing_nutrients, n.per_serving,
         coalesce(ing.ingredients, '[]'::jsonb), main.food_id, main.food_name,
         attr.diet_classes, attr.diet_status, attr.vegan_compatible, attr.jain_compatible,
         attr.allergens, attr.allergen_status, attr.quality_flags
  from public.recipes r
  left join lateral (
    select array_agg(c.slug order by c.slug) filter (where c.kind = 'meal_type') as meal_types,
           array_agg(c.slug order by c.slug) filter (where c.kind = 'region') as regions,
           array_agg(c.slug order by c.slug) filter (where c.kind = 'dish_type') as dish_types
    from public.recipe_category_assignments ca
    join public.recipe_categories c on c.slug = ca.category_slug
    where ca.recipe_id = r.id
  ) cats on true
  left join lateral public.recipe_nutrition(r.id) n on true
  left join lateral (
    select jsonb_agg(jsonb_build_object(
             'position', i.position, 'food_id', i.food_id, 'food_name', coalesce(f.name, '(no longer available)'),
             'quantity', i.quantity, 'unit', i.unit, 'grams', i.grams, 'preparation', i.preparation,
             'optional', i.optional)
             order by i.position) as ingredients,
           array_agg(i.food_id) as food_ids
    from public.recipe_ingredients i
    left join public.foods f on f.id = i.food_id    -- hidden (inactive) foods stay listed
    where i.recipe_id = r.id
  ) ing on true
  left join lateral (
    select i.food_id, f.name as food_name
    from public.recipe_ingredients i
    join public.foods f on f.id = i.food_id
    where i.recipe_id = r.id and not i.optional and i.grams is not null
    order by i.grams desc, i.position
    limit 1
  ) main on true
  cross join lateral public.recommendation_attributes(ing.food_ids) attr
  where r.status = 'published' and r.is_current and r.owner_id is null
  order by r.slug, r.id;
$$;

-- ============================================================
-- 4. Template candidates: approved meal templates
-- ============================================================
-- Each component carries its default-serving nutrition from
-- food_serving_nutrition (null when the food can no longer be priced, in
-- which case the template is incomplete). Attributes cover required
-- components only: optional components are never part of a recommendation.
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
               'calories', sn.calories, 'protein_g', sn.protein_g, 'carbs_g', sn.carbs_g, 'fat_g', sn.fat_g) end)
             order by c.position) as components,
           coalesce(bool_and(sn.food_id is not null) filter (where not c.optional), false) as complete,
           array_agg(c.food_id) filter (where not c.optional) as required_ids
    from public.meal_template_components c
    -- left join: an inactive food is invisible under RLS and must make the
    -- template incomplete, not silently drop out of it.
    left join public.foods f on f.id = c.food_id
    left join public.food_serving_nutrition sn on sn.food_id = c.food_id
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

-- ============================================================
-- 5. Single-dish candidates
-- ============================================================
-- Active foods with a default serving and complete core nutrition, excluding
-- packaged products, recipe-only ingredients ('raw_ingredient') and foods
-- without a meaningful category (their meal suitability is unknown).
create or replace function public.recommendation_food_candidates()
returns table (
  food_id uuid, name text, category text, food_kind text, source text, verification text, completeness numeric,
  serving_label text, serving_grams numeric, calories numeric, protein_g numeric, carbs_g numeric, fat_g numeric,
  regions text[], meal_types text[], countable boolean,
  diet_classes text[], diet_status text, vegan_compatible boolean, jain_compatible boolean,
  allergens text[], allergen_status text, quality_flags text[])
language sql
stable
security invoker
set search_path = ''
as $$
  select f.id, f.name, f.category, f.food_kind, f.source, f.verification, f.completeness,
         n.serving_label, n.serving_grams, n.calories, n.protein_g, n.carbs_g, n.fat_g,
         coalesce(a.regions, '{}'), coalesce(a.meal_types, '{}'), a.countable,
         array[coalesce(a.diet_class, 'unknown')], coalesce(a.diet_status, 'unknown'),
         a.vegan_compatible, a.jain_compatible,
         coalesce(a.allergens, '{}'), coalesce(a.allergen_status, 'unknown'), f.quality_flags
  from public.food_serving_nutrition n
  join public.foods f on f.id = n.food_id
  left join public.food_attributes a on a.food_id = f.id
  where f.food_kind <> 'packaged'
    and f.category is not null and f.category <> 'other'
    and not ('raw_ingredient' = any(f.quality_flags))
  order by f.name, f.id;
$$;

-- ============================================================
-- 6. Access
-- ============================================================
revoke all on function public.recommendation_attributes(uuid[]) from public, anon;
revoke all on function public.recommendation_recipe_candidates() from public, anon;
revoke all on function public.recommendation_template_candidates() from public, anon;
revoke all on function public.recommendation_food_candidates() from public, anon;
grant execute on function public.recommendation_attributes(uuid[]) to authenticated;
grant execute on function public.recommendation_recipe_candidates() to authenticated;
grant execute on function public.recommendation_template_candidates() to authenticated;
grant execute on function public.recommendation_food_candidates() to authenticated;
