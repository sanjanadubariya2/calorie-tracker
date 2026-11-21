-- Calorie Tracker — recipes (Phase 3, Task 2)
-- Run after 014_catalogue_staples.sql. Safe to re-run. Additive: no existing
-- table or food-logging behaviour changes.
--
--   recipe_categories              lookup: meal types, dish types, regions
--   recipes                        a versioned recipe: servings, yield, instructions, provenance
--   recipe_ingredients             ordered ingredients referencing catalogue foods (quantity, unit, grams)
--   recipe_category_assignments    recipe <-> category
--
-- Nutrition is never stored as typed-in numbers: recipe_nutrition() sums
-- ingredient grams x the catalogue's per-100 g values (food_snapshot_per_100g,
-- the same values logging uses). An ingredient without grams or nutrition makes
-- the recipe INCOMPLETE (no totals), never estimated.
--
-- Versioning: a published recipe and its ingredients are immutable, and it keeps
-- a frozen nutrition_snapshot taken at publish time. Changes (e.g. replacing an
-- ingredient) go into a new version via new_recipe_version(); older versions and
-- anything that referenced them are unaffected.
--
-- Who writes: catalogue_writer (curated/imported recipes). Users can read
-- published curated recipes; owner_id is ready for future user recipes (read
-- own only; no user write access is granted yet).

begin;

-- ============================================================
-- 1. Categories
-- ============================================================
create table if not exists public.recipe_categories (
  slug text primary key check (slug ~ '^[a-z0-9_]+$' and char_length(slug) <= 40),
  label text not null check (char_length(label) between 1 and 60),
  kind text not null check (kind in ('meal_type', 'dish_type', 'region'))
);
insert into public.recipe_categories (slug, label, kind) values
  ('breakfast', 'Breakfast', 'meal_type'), ('lunch', 'Lunch', 'meal_type'),
  ('dinner', 'Dinner', 'meal_type'), ('snack', 'Snack', 'meal_type'),
  ('bread', 'Bread', 'dish_type'), ('rice', 'Rice', 'dish_type'), ('dal', 'Dal', 'dish_type'),
  ('sabzi', 'Sabzi', 'dish_type'), ('curry', 'Curry', 'dish_type'), ('breakfast_dish', 'Breakfast dish', 'dish_type'),
  ('one_pot', 'One-pot meal', 'dish_type'), ('side', 'Side', 'dish_type'), ('egg_dish', 'Egg dish', 'dish_type'),
  ('north_indian', 'North Indian', 'region'), ('south_indian', 'South Indian', 'region'),
  ('east_indian', 'East Indian', 'region'), ('west_indian', 'West Indian', 'region'), ('pan_indian', 'Pan-Indian', 'region')
on conflict (slug) do update set label = excluded.label, kind = excluded.kind;

-- ============================================================
-- 2. Recipes
-- ============================================================
create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null default gen_random_uuid(),     -- all versions of one recipe
  version int not null default 1 check (version >= 1),
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 80),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  normalized_name text generated always as (public.normalize_food_name(name)) stored,
  -- Regional or style variant; variants are separate recipes, never assumed identical.
  variant text check (variant is null or char_length(btrim(variant)) between 1 and 60),
  description text check (description is null or char_length(description) <= 500),
  servings numeric not null check (servings > 0 and servings <= 100),          -- what the recipe yields
  serving_label text not null check (char_length(btrim(serving_label)) between 1 and 60),
  cooked_weight_g numeric check (cooked_weight_g is null or (cooked_weight_g > 0 and cooked_weight_g <= 20000)),
  instructions text[] not null default '{}' check (public.is_valid_text_list(instructions, 30, 500)),
  prep_minutes int check (prep_minutes is null or prep_minutes between 0 and 1440),
  cook_minutes int check (cook_minutes is null or cook_minutes between 0 and 1440),

  -- Provenance and trust.
  source text not null check (source in ('curated', 'imported', 'user')),
  source_name text check (source_name is null or char_length(source_name) <= 120),
  source_url text check (source_url is null or (source_url ~ '^https?://' and char_length(source_url) <= 500)),
  source_ref text check (source_ref is null or char_length(source_ref) <= 120),
  verification text not null default 'unverified' check (verification in ('unverified', 'curated', 'expert_reviewed')),
  quantities_estimated boolean not null default true,        -- typical home quantities, not measured
  owner_id uuid references auth.users(id) on delete cascade,  -- user recipes (future); null for catalogue recipes

  status text not null default 'draft' check (status in ('draft', 'published', 'retired')),
  is_current boolean not null default true,
  published_at timestamptz,
  published_by text check (published_by is null or char_length(published_by) <= 80),
  nutrition_snapshot jsonb check (nutrition_snapshot is null or (jsonb_typeof(nutrition_snapshot) = 'object'
    and pg_column_size(nutrition_snapshot) <= 65536)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (family_id, version),
  constraint recipes_user_ownership check ((source = 'user') = (owner_id is not null)),
  constraint recipes_publication_recorded check (
    status = 'draft' or (published_at is not null and published_by is not null and nutrition_snapshot is not null))
);

-- One current version per recipe family; no two current recipes with the same name and variant (duplicates).
create unique index if not exists recipes_one_current_per_family on public.recipes (family_id) where is_current;
create unique index if not exists recipes_current_slug on public.recipes
  (slug, coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid)) where is_current;
create unique index if not exists recipes_no_duplicates on public.recipes
  (normalized_name, coalesce(lower(variant), ''), coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where is_current and status <> 'retired';
create index if not exists recipes_status_idx on public.recipes (status) where is_current;

create table if not exists public.recipe_category_assignments (
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  category_slug text not null references public.recipe_categories(slug),
  primary key (recipe_id, category_slug)
);

-- ============================================================
-- 3. Ingredients
-- ============================================================
create table if not exists public.recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  position smallint not null check (position between 1 and 60),
  food_id uuid not null references public.foods(id) on delete restrict,
  quantity numeric not null check (quantity > 0 and quantity <= 10000),
  unit text not null check (unit in ('g', 'kg', 'ml', 'l', 'piece', 'cup', 'tbsp', 'tsp', 'katori', 'bowl', 'pinch', 'clove', 'bunch')),
  -- Weight used for nutrition. g/kg: derived from the quantity. ml/l: derived from the food's density.
  -- Other units: stated per ingredient, or NULL (=> the recipe's nutrition is incomplete).
  grams numeric check (grams is null or (grams > 0 and grams <= 20000)),
  grams_source text check (grams_source in ('unit', 'density', 'stated')),
  preparation text check (preparation is null or char_length(btrim(preparation)) between 1 and 80),
  optional boolean not null default false,        -- garnish etc.; excluded from nutrition
  is_estimate boolean not null default true,      -- quantity is typical, not measured
  unique (recipe_id, position),
  check ((grams is null) = (grams_source is null))
);
create index if not exists recipe_ingredients_food_idx on public.recipe_ingredients (food_id);

-- Resolve grams from the unit, reject inconsistent units and inactive foods,
-- and keep published recipes immutable.
create or replace function public.recipe_ingredients_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
  v_food public.foods;
  v_ml numeric;
  v_grams numeric;
begin
  select r.status into v_status from public.recipes r
  where r.id = case when tg_op = 'DELETE' then old.recipe_id else new.recipe_id end;
  if v_status is distinct from 'draft' and v_status is not null then
    raise exception 'Published recipes are immutable; create a new version' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;

  select * into v_food from public.foods f where f.id = new.food_id;
  if not found or not v_food.is_active then
    raise exception 'Ingredient food % is not an active catalogue food', new.food_id using errcode = '23503';
  end if;

  if new.unit in ('g', 'kg') then
    v_grams := new.quantity * case new.unit when 'kg' then 1000 else 1 end;
    if new.grams is not null and abs(new.grams - v_grams) > 0.001 then
      raise exception 'Inconsistent units: % % is % g, not % g', new.quantity, new.unit, v_grams, new.grams
        using errcode = '22023';
    end if;
    new.grams := v_grams;
    new.grams_source := 'unit';
  elsif new.unit in ('ml', 'l') then
    v_ml := new.quantity * case new.unit when 'l' then 1000 else 1 end;
    if v_food.density_g_per_ml is not null then
      v_grams := round(v_ml * v_food.density_g_per_ml, 2);
      if new.grams is not null and abs(new.grams - v_grams) > greatest(0.5, v_grams * 0.02) then
        raise exception 'Inconsistent units: % ml of this food is % g, not % g', v_ml, v_grams, new.grams
          using errcode = '22023';
      end if;
      new.grams := v_grams;
      new.grams_source := 'density';
    else
      new.grams_source := case when new.grams is null then null else 'stated' end;
    end if;
  else
    new.grams_source := case when new.grams is null then null else 'stated' end;
  end if;
  return new;
end;
$$;
drop trigger if exists recipe_ingredients_before_write on public.recipe_ingredients;
create trigger recipe_ingredients_before_write
  before insert or update or delete on public.recipe_ingredients
  for each row execute function public.recipe_ingredients_before_write();

-- Published recipes: only status (published -> retired) and is_current may change.
create or replace function public.recipes_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'draft' and (
       new.name, new.variant, new.slug, new.servings, new.serving_label, new.cooked_weight_g, new.instructions,
       new.source, new.source_name, new.source_url, new.source_ref, new.verification, new.quantities_estimated,
       new.owner_id, new.family_id, new.version, new.nutrition_snapshot, new.published_at, new.published_by
     ) is distinct from (
       old.name, old.variant, old.slug, old.servings, old.serving_label, old.cooked_weight_g, old.instructions,
       old.source, old.source_name, old.source_url, old.source_ref, old.verification, old.quantities_estimated,
       old.owner_id, old.family_id, old.version, old.nutrition_snapshot, old.published_at, old.published_by) then
    raise exception 'Published recipes are immutable; create a new version' using errcode = '55000';
  end if;
  if old.status = 'retired' and new.status <> 'retired' then
    raise exception 'Retired recipes cannot be republished' using errcode = '55000';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists recipes_before_update on public.recipes;
create trigger recipes_before_update before update on public.recipes
  for each row execute function public.recipes_before_update();

-- ============================================================
-- 4. Nutrition (deterministic, from catalogue values)
-- ============================================================
-- Exact sums for a recipe scaled by p_scale. Optional ingredients are excluded.
-- missing: required ingredients without grams or without nutrition data.
-- An optional nutrient (fibre, sugars, saturated fat, sodium) is reported only
-- when every counted ingredient has it.
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
    select i.position, i.grams as ing_grams, f.name as food_name, public.food_snapshot_per_100g(f) as snap
    from public.recipe_ingredients i join public.foods f on f.id = i.food_id
    where i.recipe_id = p_recipe_id and not i.optional
    order by i.position
  loop
    v_count := v_count + 1;
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

-- Rounded like portion_nutrition: kcal to whole, grams to 0.1, sodium to 0.001.
create or replace function public.recipe_nutrition_json(s record, p_divisor numeric)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb;
begin
  v := jsonb_build_object(
    'calories', round(s.kcal / p_divisor), 'protein_g', round(s.protein_g / p_divisor, 1),
    'carbs_g', round(s.carbs_g / p_divisor, 1), 'fat_g', round(s.fat_g / p_divisor, 1),
    'grams', round(s.grams / p_divisor, 1));
  if s.fiber_g is not null then v := v || jsonb_build_object('fiber_g', round(s.fiber_g / p_divisor, 1)); end if;
  if s.sugars_g is not null then v := v || jsonb_build_object('sugars_g', round(s.sugars_g / p_divisor, 1)); end if;
  if s.saturated_fat_g is not null then v := v || jsonb_build_object('saturated_fat_g', round(s.saturated_fat_g / p_divisor, 1)); end if;
  if s.sodium_g is not null then v := v || jsonb_build_object('sodium_g', round(s.sodium_g / p_divisor, 3)); end if;
  return v;
end;
$$;

-- Nutrition for the recipe made to p_servings servings (default: as written).
-- total = the whole batch; per_serving = one serving. Both null if incomplete.
create or replace function public.recipe_nutrition(p_recipe_id uuid, p_servings numeric default null)
returns table (recipe_id uuid, servings numeric, scale numeric, complete boolean, missing text[],
               missing_nutrients text[], total jsonb, per_serving jsonb)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  r public.recipes;
  v_servings numeric;
  v_scale numeric;
  s record;
begin
  select * into r from public.recipes x where x.id = p_recipe_id;    -- RLS applies
  if not found then
    return;
  end if;
  if p_servings is not null and (p_servings <= 0 or p_servings > 1000) then
    raise exception 'Servings must be between 0 and 1000' using errcode = '22023';
  end if;
  v_servings := coalesce(p_servings, r.servings);
  v_scale := v_servings / r.servings;
  select * into s from public.recipe_sums(p_recipe_id, v_scale);
  if cardinality(s.missing) > 0 then
    return query select r.id, v_servings, v_scale, false, s.missing, s.missing_nutrients, null::jsonb, null::jsonb;
    return;
  end if;
  return query select r.id, v_servings, v_scale, true, s.missing, s.missing_nutrients,
    public.recipe_nutrition_json(s, 1), public.recipe_nutrition_json(s, v_servings);
end;
$$;

-- Nutrition for EATING p_portions servings (computed from exact sums, then rounded).
create or replace function public.recipe_portion(p_recipe_id uuid, p_portions numeric)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  r public.recipes;
  s record;
begin
  select * into r from public.recipes x where x.id = p_recipe_id;
  if not found then
    return null;
  end if;
  if p_portions is null or p_portions <= 0 or p_portions > 20 then
    raise exception 'Portions must be between 0 and 20' using errcode = '22023';
  end if;
  select * into s from public.recipe_sums(p_recipe_id, p_portions / r.servings);
  if cardinality(s.missing) > 0 then
    return null;
  end if;
  return public.recipe_nutrition_json(s, 1);
end;
$$;

-- Ingredients scaled to p_servings servings.
create or replace function public.recipe_scaled_ingredients(p_recipe_id uuid, p_servings numeric default null)
returns table (ingredient_no smallint, food_id uuid, food_name text, quantity numeric, unit text, grams numeric,
               preparation text, optional boolean)
language sql
stable
security invoker
set search_path = ''
as $$
  select i.position, i.food_id, f.name,
         round(i.quantity * coalesce(p_servings, r.servings) / r.servings, 2), i.unit,
         round(i.grams * coalesce(p_servings, r.servings) / r.servings, 1),
         i.preparation, i.optional
  from public.recipes r
  join public.recipe_ingredients i on i.recipe_id = r.id
  join public.foods f on f.id = i.food_id
  where r.id = p_recipe_id
  order by i.position;
$$;

-- ============================================================
-- 5. Publishing and versioning (catalogue_writer)
-- ============================================================
create or replace function public.publish_recipe(p_recipe_id uuid, p_reviewer text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r public.recipes;
  n record;
  v_snapshot jsonb;
begin
  select * into r from public.recipes x where x.id = p_recipe_id for update;
  if not found then
    raise exception 'Recipe % not found', p_recipe_id using errcode = 'P0002';
  end if;
  if r.status <> 'draft' then
    raise exception 'Only drafts can be published' using errcode = '55000';
  end if;
  if p_reviewer is null or char_length(btrim(p_reviewer)) = 0 then
    raise exception 'A reviewer is required' using errcode = '22023';
  end if;
  select * into n from public.recipe_nutrition(p_recipe_id);
  if not n.complete then
    raise exception 'Recipe nutrition is incomplete: %', array_to_string(n.missing, '; ') using errcode = '23514';
  end if;
  v_snapshot := jsonb_build_object(
    'computed_at', now(), 'method', 'sum of ingredient grams x catalogue per-100 g values',
    'servings', r.servings, 'serving_label', r.serving_label,
    'total', n.total, 'per_serving', n.per_serving, 'missing_nutrients', to_jsonb(n.missing_nutrients),
    'ingredients', (
      select jsonb_agg(jsonb_build_object(
        'position', i.position, 'food_id', i.food_id, 'food_name', f.name, 'source', f.source,
        'source_ref', f.source_ref, 'grams', i.grams, 'optional', i.optional,
        'per_100g', public.food_snapshot_per_100g(f)) order by i.position)
      from public.recipe_ingredients i join public.foods f on f.id = i.food_id
      where i.recipe_id = p_recipe_id));
  update public.recipes set is_current = false where family_id = r.family_id and id <> r.id and is_current;
  update public.recipes set status = 'published', is_current = true, published_at = now(),
    published_by = btrim(p_reviewer), nutrition_snapshot = v_snapshot
  where id = p_recipe_id;
  return v_snapshot;
end;
$$;

-- A new draft version (copy of any version of the family). Not current until published.
create or replace function public.new_recipe_version(p_recipe_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r public.recipes;
  v_id uuid := gen_random_uuid();
begin
  select * into r from public.recipes x where x.id = p_recipe_id;
  if not found then
    raise exception 'Recipe % not found', p_recipe_id using errcode = 'P0002';
  end if;
  insert into public.recipes (id, family_id, version, slug, name, variant, description, servings, serving_label,
    cooked_weight_g, instructions, prep_minutes, cook_minutes, source, source_name, source_url, source_ref,
    verification, quantities_estimated, owner_id, status, is_current)
  select v_id, r.family_id, (select max(version) + 1 from public.recipes where family_id = r.family_id), r.slug, r.name,
    r.variant, r.description, r.servings, r.serving_label, r.cooked_weight_g, r.instructions, r.prep_minutes,
    r.cook_minutes, r.source, r.source_name, r.source_url, r.source_ref, r.verification, r.quantities_estimated,
    r.owner_id, 'draft', false;
  insert into public.recipe_ingredients (recipe_id, position, food_id, quantity, unit, grams, preparation, optional, is_estimate)
  select v_id, i.position, i.food_id, i.quantity, i.unit,
         case when i.grams_source = 'stated' then i.grams end, i.preparation, i.optional, i.is_estimate
  from public.recipe_ingredients i where i.recipe_id = p_recipe_id;
  insert into public.recipe_category_assignments (recipe_id, category_slug)
  select v_id, a.category_slug from public.recipe_category_assignments a where a.recipe_id = p_recipe_id;
  return v_id;
end;
$$;

-- ============================================================
-- 6. RLS and privileges
-- ============================================================
alter table public.recipe_categories enable row level security;
alter table public.recipes enable row level security;
alter table public.recipe_ingredients enable row level security;
alter table public.recipe_category_assignments enable row level security;

revoke all on table public.recipe_categories, public.recipes, public.recipe_ingredients,
  public.recipe_category_assignments from anon, authenticated;
grant select on table public.recipe_categories, public.recipes, public.recipe_ingredients,
  public.recipe_category_assignments to authenticated;

drop policy if exists "Signed-in users read recipe categories" on public.recipe_categories;
create policy "Signed-in users read recipe categories" on public.recipe_categories
  for select to authenticated using (true);
drop policy if exists "Users read published recipes and their own" on public.recipes;
create policy "Users read published recipes and their own" on public.recipes
  for select to authenticated
  using ((owner_id is null and status = 'published') or owner_id = (select auth.uid()));
drop policy if exists "Users read ingredients of visible recipes" on public.recipe_ingredients;
create policy "Users read ingredients of visible recipes" on public.recipe_ingredients
  for select to authenticated using (exists (select 1 from public.recipes r where r.id = recipe_id));
drop policy if exists "Users read categories of visible recipes" on public.recipe_category_assignments;
create policy "Users read categories of visible recipes" on public.recipe_category_assignments
  for select to authenticated using (exists (select 1 from public.recipes r where r.id = recipe_id));

-- catalogue_writer: catalogue recipes only (never user recipes). Drafts only can be deleted.
grant select on table public.recipe_categories to catalogue_writer;
grant select, insert, update, delete on table public.recipes, public.recipe_ingredients,
  public.recipe_category_assignments to catalogue_writer;
drop policy if exists "catalogue_writer reads categories" on public.recipe_categories;
create policy "catalogue_writer reads categories" on public.recipe_categories for select to catalogue_writer using (true);
drop policy if exists "catalogue_writer reads catalogue recipes" on public.recipes;
create policy "catalogue_writer reads catalogue recipes" on public.recipes
  for select to catalogue_writer using (owner_id is null);
drop policy if exists "catalogue_writer creates catalogue recipes" on public.recipes;
create policy "catalogue_writer creates catalogue recipes" on public.recipes
  for insert to catalogue_writer with check (owner_id is null and source <> 'user');
drop policy if exists "catalogue_writer updates catalogue recipes" on public.recipes;
create policy "catalogue_writer updates catalogue recipes" on public.recipes
  for update to catalogue_writer using (owner_id is null) with check (owner_id is null);
drop policy if exists "catalogue_writer deletes draft recipes" on public.recipes;
create policy "catalogue_writer deletes draft recipes" on public.recipes
  for delete to catalogue_writer using (owner_id is null and status = 'draft');
drop policy if exists "catalogue_writer manages recipe ingredients" on public.recipe_ingredients;
create policy "catalogue_writer manages recipe ingredients" on public.recipe_ingredients
  for all to catalogue_writer
  using (exists (select 1 from public.recipes r where r.id = recipe_id))
  with check (exists (select 1 from public.recipes r where r.id = recipe_id));
drop policy if exists "catalogue_writer manages recipe categories" on public.recipe_category_assignments;
create policy "catalogue_writer manages recipe categories" on public.recipe_category_assignments
  for all to catalogue_writer
  using (exists (select 1 from public.recipes r where r.id = recipe_id))
  with check (exists (select 1 from public.recipes r where r.id = recipe_id));

revoke all on function public.recipe_ingredients_before_write(), public.recipes_before_update()
  from public, anon, authenticated;
revoke all on function public.recipe_sums(uuid, numeric), public.recipe_nutrition_json(record, numeric),
  public.recipe_nutrition(uuid, numeric), public.recipe_portion(uuid, numeric),
  public.recipe_scaled_ingredients(uuid, numeric), public.publish_recipe(uuid, text),
  public.new_recipe_version(uuid) from public, anon;
grant execute on function public.recipe_sums(uuid, numeric), public.recipe_nutrition_json(record, numeric),
  public.recipe_nutrition(uuid, numeric), public.recipe_portion(uuid, numeric),
  public.recipe_scaled_ingredients(uuid, numeric) to authenticated, catalogue_writer;
grant execute on function public.publish_recipe(uuid, text), public.new_recipe_version(uuid) to catalogue_writer;
revoke execute on function public.publish_recipe(uuid, text), public.new_recipe_version(uuid) from authenticated;

commit;

-- Rollback (manual; nothing else depends on these objects yet):
--   drop function public.new_recipe_version(uuid), public.publish_recipe(uuid, text),
--     public.recipe_scaled_ingredients(uuid, numeric), public.recipe_portion(uuid, numeric),
--     public.recipe_nutrition(uuid, numeric), public.recipe_nutrition_json(record, numeric),
--     public.recipe_sums(uuid, numeric), public.recipes_before_update(), public.recipe_ingredients_before_write();
--   drop table public.recipe_category_assignments, public.recipe_ingredients, public.recipes, public.recipe_categories;
