-- Calorie Tracker — food catalogue and nutrition matching foundation
-- Run after 006_food_log_provenance.sql. Safe to re-run.
--
-- Adds a shared, read-only (for users) catalogue of foods with per-100 g or
-- per-100 ml nutrition, aliases (synonyms, transliterations, common names) and
-- household servings; a matching function that ranks catalogue foods for a
-- free-text name (e.g. an AI-recognised dish); and links food_logs to it.
--
-- Principles
--   * Nutrition values come only from catalogue rows (INDB, Open Food Facts,
--     curated). Nothing an AI model or client says is stored as nutrition.
--   * Logging a catalogue food copies its values into food_logs'
--     immutable snapshot (006): later catalogue edits never change history.
--   * Users can read active foods; only the catalogue_writer role (008) and
--     migrations write them.
--   * Portion maths has one implementation, portion_nutrition(), shared with
--     the food_logs trigger.

begin;

create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;

-- ============================================================
-- 1. Normalisation
--
-- One definition, used for stored names, aliases and queries alike, so a
-- query and a catalogue entry are always compared in the same form:
--   lower-case, accents removed, '&' -> 'and', apostrophes dropped,
--   punctuation -> space, quantities ("200g", "2 pcs", "1 katori") removed,
--   filler words removed, simple plurals singularised (idlis -> idli),
--   whitespace collapsed.
-- Spelling variants (chapathi/chapati, sabji/sabzi) are NOT handled by rules;
-- they are aliases, so no clever regex can merge different foods.
-- IMMUTABLE so it can drive generated columns and indexes. If this function
-- changes, re-run `update public.foods set name = name` (and aliases) to
-- refresh the stored forms.
-- ============================================================
create or replace function public.normalize_food_name(p text)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  s text;
begin
  if p is null then
    return null;
  end if;
  s := lower(extensions.unaccent('extensions.unaccent'::regdictionary, p));
  s := replace(s, '&', ' and ');
  s := regexp_replace(s, '[''`’]', '', 'g');
  s := regexp_replace(s, '[^a-z0-9]+', ' ', 'g');
  -- quantities: number + optional unit
  s := regexp_replace(s,
    '\m[0-9]+( [0-9]+)?\s*(g|gm|gms|gram|grams|kg|ml|l|ltr|litre|liter|pc|pcs|piece|pieces|cup|cups|katori|katoris|bowl|bowls|plate|plates|tbsp|tsp|slice|slices|glass|glasses)?\M',
    ' ', 'g');
  -- filler words that never distinguish foods
  s := regexp_replace(s,
    '\m(homemade|home made|home style|homestyle|fresh|freshly|tasty|special|style|recipe|delicious)\M',
    ' ', 'g');
  -- simple plurals: a word of 4+ letters ending in s, not -ss / -us
  s := regexp_replace(s, '\m([a-z0-9]{2,}[^su ])s\M', '\1', 'g');
  s := btrim(regexp_replace(s, '\s+', ' ', 'g'));
  return nullif(s, '');
end;
$$;

create or replace function public.normalize_brand(p text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select nullif(btrim(regexp_replace(
    regexp_replace(public.normalize_food_name(p),
      '\m(pvt|private|ltd|limited|inc|co|company|foods|food|india|products|industries)\M', ' ', 'g'),
    '\s+', ' ', 'g')), '');
$$;

-- ============================================================
-- 2. Validation helpers
-- ============================================================

-- Micronutrients: a flat object of non-negative numbers whose keys end in
-- their unit, e.g. {"calcium_mg": 40, "vitb12_ug": 0.2}.
create or replace function public.is_valid_micronutrients(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
begin
  if p is null then
    return true;
  end if;
  if jsonb_typeof(p) <> 'object' then
    return false;
  end if;
  for v_key in select jsonb_object_keys(p) loop
    if v_key !~ '^[a-z0-9]+(_[a-z0-9]+)*_(g|mg|ug)$' then
      return false;
    end if;
    if jsonb_typeof(p -> v_key) <> 'number' or (p ->> v_key)::numeric < 0 then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- ============================================================
-- 3. foods
-- ============================================================
create table if not exists public.foods (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  normalized_name text generated always as (public.normalize_food_name(name)) stored,
  brand text check (brand is null or char_length(btrim(brand)) between 1 and 120),
  normalized_brand text generated always as (public.normalize_brand(brand)) stored,

  food_kind text not null default 'generic_dish'
    check (food_kind in ('packaged', 'generic_dish', 'ingredient', 'beverage')),
  category text check (category in (
    'beverage', 'soup', 'sweet', 'south_indian', 'bread', 'rice_dish', 'egg_dish',
    'non_veg', 'dal', 'paneer_dish', 'snack', 'side', 'salad', 'sabzi', 'other')),
  cuisine_tags text[] not null default '{}',
  variant_group uuid,

  source text not null check (source in ('indb', 'open_food_facts', 'curated', 'manual', 'ai_verified')),
  source_ref text check (source_ref is null or char_length(source_ref) between 1 and 200),
  source_version text,
  source_retrieved_at timestamptz,

  -- Nutrition per 100 g (basis 'g') or per 100 ml (basis 'ml').
  basis text not null default 'g' check (basis in ('g', 'ml')),
  density_g_per_ml numeric check (density_g_per_ml is null or (density_g_per_ml > 0.3 and density_g_per_ml <= 2)),
  kcal_per_100 numeric check (kcal_per_100 between 0 and 1000),
  protein_g_per_100 numeric check (protein_g_per_100 between 0 and 100),
  carbs_g_per_100 numeric check (carbs_g_per_100 between 0 and 100),
  fat_g_per_100 numeric check (fat_g_per_100 between 0 and 100),
  fiber_g_per_100 numeric check (fiber_g_per_100 between 0 and 100),
  sugars_g_per_100 numeric check (sugars_g_per_100 between 0 and 100),
  saturated_fat_g_per_100 numeric check (saturated_fat_g_per_100 between 0 and 100),
  sodium_g_per_100 numeric check (sodium_g_per_100 between 0 and 100),
  salt_g_per_100 numeric check (salt_g_per_100 between 0 and 100),
  micronutrients jsonb check (public.is_valid_micronutrients(micronutrients)),

  -- Quality (completeness and system flags are maintained by trigger).
  completeness numeric(3, 2) not null default 0 check (completeness between 0 and 1),
  quality_flags text[] not null default '{}',
  verification text not null default 'unverified'
    check (verification in ('unverified', 'auto_checked', 'curated', 'expert_reviewed')),
  is_active boolean not null default true,
  is_matchable boolean generated always as (
    kcal_per_100 is not null and protein_g_per_100 is not null
    and carbs_g_per_100 is not null and fat_g_per_100 is not null
  ) stored,

  search_tsv tsvector generated always as (
    setweight(to_tsvector('simple', coalesce(public.normalize_food_name(name), '')), 'A')
    || setweight(to_tsvector('simple', coalesce(public.normalize_brand(brand), '')), 'B')
  ) stored,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Physical consistency of a per-100 basis (small tolerance for rounding).
  constraint foods_macros_fit check (
    coalesce(protein_g_per_100, 0) + coalesce(carbs_g_per_100, 0)
      + coalesce(fat_g_per_100, 0) + coalesce(fiber_g_per_100, 0) <= 105),
  constraint foods_sugars_within_carbs check (
    sugars_g_per_100 is null or carbs_g_per_100 is null or sugars_g_per_100 <= carbs_g_per_100 + 1),
  constraint foods_satfat_within_fat check (
    saturated_fat_g_per_100 is null or fat_g_per_100 is null or saturated_fat_g_per_100 <= fat_g_per_100 + 1)
);

create unique index if not exists foods_source_ref_key
  on public.foods (source, source_ref) where source_ref is not null;
create index if not exists foods_name_trgm_idx
  on public.foods using gin (normalized_name extensions.gin_trgm_ops);
create index if not exists foods_search_tsv_idx on public.foods using gin (search_tsv);
create index if not exists foods_brand_idx on public.foods (normalized_brand);
create index if not exists foods_category_idx on public.foods (category);

-- ============================================================
-- 4. Aliases and servings
-- ============================================================
create table if not exists public.food_aliases (
  id uuid primary key default gen_random_uuid(),
  food_id uuid not null references public.foods(id) on delete cascade,
  alias text not null check (char_length(btrim(alias)) between 1 and 200),
  normalized_alias text generated always as (public.normalize_food_name(alias)) stored,
  kind text not null default 'synonym'
    check (kind in ('name_variant', 'synonym', 'transliteration', 'regional', 'misspelling', 'common_name')),
  source text not null default 'curated',
  created_at timestamptz not null default now()
);
create unique index if not exists food_aliases_food_alias_key
  on public.food_aliases (food_id, normalized_alias);
create index if not exists food_aliases_trgm_idx
  on public.food_aliases using gin (normalized_alias extensions.gin_trgm_ops);
create index if not exists food_aliases_exact_idx on public.food_aliases (normalized_alias);

create table if not exists public.food_servings (
  id uuid primary key default gen_random_uuid(),
  food_id uuid not null references public.foods(id) on delete cascade,
  label text not null check (char_length(btrim(label)) between 1 and 80),   -- "1 bowl", "1 medium roti"
  grams numeric not null check (grams > 0 and grams <= 5000),
  ml numeric check (ml is null or (ml > 0 and ml <= 5000)),
  is_default boolean not null default false,
  source text not null default 'curated',
  created_at timestamptz not null default now()
);
create unique index if not exists food_servings_food_label_key on public.food_servings (food_id, label);
create unique index if not exists food_servings_one_default
  on public.food_servings (food_id) where is_default;

-- ============================================================
-- 5. Quality trigger
--
-- completeness = 0.7 x (share of the four core values present)
--              + 0.3 x (share of fiber, sugars, saturated fat, sodium present)
-- System flags (recomputed on every write; other flags are kept):
--   kcal_derived     kcal was missing and is computed from macros (Atwater)
--   energy_mismatch  stated kcal differs from 4c+4p+9f (with or without
--                    2 kcal/g fiber) by more than max(20 kcal, 15 %)
-- An Open Food Facts row with energy_mismatch is never more than 'unverified'.
-- ============================================================
create or replace function public.foods_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_core int;
  v_extra int;
  v_atwater numeric;
  v_atwater_fiber numeric;
  v_tol numeric;
  v_flags text[];
begin
  v_flags := array(
    select f from unnest(coalesce(new.quality_flags, '{}')) f
    where f not in ('kcal_derived', 'energy_mismatch')
  );

  if new.kcal_per_100 is null
     and new.protein_g_per_100 is not null and new.carbs_g_per_100 is not null and new.fat_g_per_100 is not null then
    new.kcal_per_100 := round(4 * new.carbs_g_per_100 + 4 * new.protein_g_per_100 + 9 * new.fat_g_per_100, 1);
    v_flags := array_append(v_flags, 'kcal_derived');
  elsif tg_op = 'UPDATE' and 'kcal_derived' = any(coalesce(old.quality_flags, '{}'))
        and new.kcal_per_100 is not distinct from old.kcal_per_100 then
    v_flags := array_append(v_flags, 'kcal_derived');
  end if;

  if new.kcal_per_100 is not null and new.protein_g_per_100 is not null
     and new.carbs_g_per_100 is not null and new.fat_g_per_100 is not null then
    v_atwater := 4 * new.carbs_g_per_100 + 4 * new.protein_g_per_100 + 9 * new.fat_g_per_100;
    v_atwater_fiber := v_atwater + 2 * coalesce(new.fiber_g_per_100, 0);
    v_tol := greatest(20, 0.15 * new.kcal_per_100);
    if abs(v_atwater - new.kcal_per_100) > v_tol and abs(v_atwater_fiber - new.kcal_per_100) > v_tol then
      v_flags := array_append(v_flags, 'energy_mismatch');
    end if;
  end if;

  v_core := (new.kcal_per_100 is not null)::int + (new.protein_g_per_100 is not null)::int
          + (new.carbs_g_per_100 is not null)::int + (new.fat_g_per_100 is not null)::int;
  v_extra := (new.fiber_g_per_100 is not null)::int + (new.sugars_g_per_100 is not null)::int
           + (new.saturated_fat_g_per_100 is not null)::int + (new.sodium_g_per_100 is not null)::int;
  new.completeness := round(0.7 * v_core / 4 + 0.3 * v_extra / 4, 2);

  if new.source = 'open_food_facts' and 'energy_mismatch' = any(v_flags)
     and new.verification in ('auto_checked', 'curated', 'expert_reviewed') then
    new.verification := 'unverified';
  end if;

  if new.basis = 'ml' and new.density_g_per_ml is null and not ('density_unknown' = any(v_flags)) then
    v_flags := array_append(v_flags, 'density_unknown');
  elsif new.density_g_per_ml is not null then
    v_flags := array_remove(v_flags, 'density_unknown');
  end if;

  new.quality_flags := array(select distinct f from unnest(v_flags) f order by f);
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

drop trigger if exists foods_before_write on public.foods;
create trigger foods_before_write
  before insert or update on public.foods
  for each row execute function public.foods_before_write();

-- ============================================================
-- 6. Access: users read active foods; nobody else writes here (see 008)
-- ============================================================
alter table public.foods enable row level security;
alter table public.food_aliases enable row level security;
alter table public.food_servings enable row level security;

drop policy if exists "Active foods are readable" on public.foods;
create policy "Active foods are readable" on public.foods
  for select to authenticated using (is_active);

drop policy if exists "Aliases of active foods are readable" on public.food_aliases;
create policy "Aliases of active foods are readable" on public.food_aliases
  for select to authenticated
  using (exists (select 1 from public.foods f where f.id = food_id and f.is_active));

drop policy if exists "Servings of active foods are readable" on public.food_servings;
create policy "Servings of active foods are readable" on public.food_servings
  for select to authenticated
  using (exists (select 1 from public.foods f where f.id = food_id and f.is_active));

revoke all on table public.foods, public.food_aliases, public.food_servings from anon, authenticated;
grant select on table public.foods, public.food_aliases, public.food_servings to authenticated;

-- ============================================================
-- 7. Portion maths — the single implementation
--
-- Totals for `grams` of a food given per-100 g values: calories to whole kcal,
-- macros to 0.1 g, half away from zero (Postgres round on numeric). The
-- food_logs trigger and the matching function both use it; lib/nutrition.ts
-- scaleNutrients mirrors it for previews (parity-tested).
-- ============================================================
create or replace function public.portion_nutrition(
  p_kcal_per_100g numeric,
  p_carbs_g_per_100g numeric,
  p_fat_g_per_100g numeric,
  p_protein_g_per_100g numeric,
  p_grams numeric,
  out calories numeric,
  out carbs_g numeric,
  out fat_g numeric,
  out protein_g numeric
)
language sql
immutable
parallel safe
set search_path = ''
as $$
  select round(p_kcal_per_100g * p_grams / 100),
         round(p_carbs_g_per_100g * p_grams / 100, 1),
         round(p_fat_g_per_100g * p_grams / 100, 1),
         round(p_protein_g_per_100g * p_grams / 100, 1);
$$;

-- Per-100 g snapshot (006 shape) for a food. Foods on a per-100 ml basis are
-- converted with their density; NULL if that isn't possible or the food
-- lacks core values.
create or replace function public.food_snapshot_per_100g(f public.foods)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_factor numeric := 1;
  v jsonb;
begin
  if not f.is_matchable then
    return null;
  end if;
  if f.basis = 'ml' then
    if f.density_g_per_ml is null then
      return null;
    end if;
    v_factor := 1 / f.density_g_per_ml;   -- per 100 ml -> per 100 g
  end if;
  v := jsonb_build_object(
    'kcal', round(f.kcal_per_100 * v_factor, 2),
    'carbs_g', round(f.carbs_g_per_100 * v_factor, 2),
    'fat_g', round(f.fat_g_per_100 * v_factor, 2),
    'protein_g', round(f.protein_g_per_100 * v_factor, 2));
  if f.fiber_g_per_100 is not null then v := v || jsonb_build_object('fiber_g', round(f.fiber_g_per_100 * v_factor, 2)); end if;
  if f.sugars_g_per_100 is not null then v := v || jsonb_build_object('sugars_g', round(f.sugars_g_per_100 * v_factor, 2)); end if;
  if f.saturated_fat_g_per_100 is not null then v := v || jsonb_build_object('saturated_fat_g', round(f.saturated_fat_g_per_100 * v_factor, 2)); end if;
  if f.sodium_g_per_100 is not null then v := v || jsonb_build_object('sodium_g', round(f.sodium_g_per_100 * v_factor, 3)); end if;
  if f.salt_g_per_100 is not null then v := v || jsonb_build_object('salt_g', round(f.salt_g_per_100 * v_factor, 3)); end if;
  if not public.is_valid_nutrients_per_100g(v) then
    return null;   -- e.g. a low-density liquid pushed over 1000 kcal/100 g
  end if;
  return v;
end;
$$;

-- ============================================================
-- 8. food_logs: link to the catalogue
--
--   * food_id -> foods(id), ON DELETE SET NULL (foods are deactivated, not
--     deleted; if one ever is, the log keeps its own snapshot).
--   * New source value 'catalogue' (picked from catalogue search, no AI).
--   * When a log is created with a food_id, the snapshot is taken from the
--     catalogue row, never from the client, so provenance can't be faked.
--     The food must be active and have core values.
--   * Same immutability as 006, except food_id may be cleared (needed for
--     ON DELETE SET NULL).
-- ============================================================
alter table public.food_logs drop constraint if exists food_logs_food_id_fkey;
alter table public.food_logs
  add constraint food_logs_food_id_fkey foreign key (food_id)
  references public.foods(id) on delete set null;
create index if not exists food_logs_food_id_idx on public.food_logs (food_id) where food_id is not null;

alter table public.food_logs drop constraint if exists food_logs_source_valid;
alter table public.food_logs add constraint food_logs_source_valid
  check (source in ('open_food_facts', 'manual', 'quick_add', 'relog', 'ai_assisted', 'unknown', 'catalogue'));

create or replace function public.food_logs_apply_nutrition()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_latest_today date := ((now() at time zone 'utc') + interval '14 hours')::date;
  v_food public.foods;
  v_portion record;
begin
  if tg_op = 'UPDATE' then
    -- Provenance and the snapshot are fixed at log time. food_id may only be
    -- cleared (ON DELETE SET NULL), never changed.
    new.user_id            := old.user_id;
    new.food_id            := case when new.food_id is null then null else old.food_id end;
    new.source             := old.source;
    new.source_ref         := old.source_ref;
    new.nutrients_per_100g := old.nutrients_per_100g;
    new.ai_confidence      := old.ai_confidence;
    new.created_at         := old.created_at;
  else
    -- Older app versions send is_quick_add but no source.
    if new.source = 'unknown' and new.is_quick_add then
      new.source := 'quick_add';
    end if;

    -- A catalogue food: the server, not the client, provides the snapshot.
    if new.food_id is not null then
      select * into v_food from public.foods f where f.id = new.food_id and f.is_active;
      if not found then
        raise exception 'Food % is not available', new.food_id using errcode = '23503';
      end if;
      new.nutrients_per_100g := public.food_snapshot_per_100g(v_food);
      if new.nutrients_per_100g is null then
        raise exception 'Food % has incomplete nutrition and cannot be logged', new.food_id
          using errcode = '23514';
      end if;
      new.source_ref := coalesce(v_food.source_ref, v_food.id::text);
    end if;
  end if;

  if (tg_op = 'INSERT' or new.logged_date is distinct from old.logged_date)
     and new.logged_date > v_latest_today then
    raise exception 'logged_date % is in the future', new.logged_date
      using errcode = '23514';
  end if;

  if new.nutrients_per_100g is not null and new.serving_g is not null
     and public.is_valid_nutrients_per_100g(new.nutrients_per_100g) then
    select * into v_portion from public.portion_nutrition(
      (new.nutrients_per_100g ->> 'kcal')::numeric,
      (new.nutrients_per_100g ->> 'carbs_g')::numeric,
      (new.nutrients_per_100g ->> 'fat_g')::numeric,
      (new.nutrients_per_100g ->> 'protein_g')::numeric,
      new.serving_g);
    new.calories  := v_portion.calories;
    new.carbs_g   := v_portion.carbs_g;
    new.fat_g     := v_portion.fat_g;
    new.protein_g := v_portion.protein_g;
  end if;

  return new;
end;
$$;

-- ============================================================
-- 9. Matching
--
-- search_food_catalogue(query, brand, quantity, unit, limit) ranks active,
-- matchable foods for a free-text name. Runs as the caller (RLS applies).
--
-- Candidate generation (normalised query vs normalised name/aliases):
--   exact name 1.00 | exact alias 0.95 | trigram/word similarity on names
--   (capped 0.92) and aliases (capped 0.90) | full-text, any word (<= 0.5)
-- name_score = best of those
-- quality   = (0.6 + 0.4 * completeness) * (0.8 if energy_mismatch)
-- trust     = expert_reviewed 1.0 | curated 0.97 | auto_checked 0.9 | unverified 0.8
-- brand     = brand given:   +0.10 on match, x0.6 other brand, x0.85 generic
--             no brand:      +0.05 generic, x0.9 branded
-- score     = least(1, name_score * quality * trust (+ brand bonus))
--
-- Portion: when p_quantity is given, per-portion values are computed with
-- portion_nutrition(); 'ml' quantities on a per-100 g food (or the reverse)
-- are converted with the food's density, otherwise the portion is NULL.
-- ============================================================
create or replace function public.search_food_catalogue(
  p_query text,
  p_brand text default null,
  p_quantity numeric default null,
  p_unit text default 'g',
  p_limit int default 10
)
returns table (
  food_id uuid,
  name text,
  brand text,
  category text,
  food_kind text,
  source text,
  source_ref text,
  verification text,
  completeness numeric,
  quality_flags text[],
  basis text,
  density_g_per_ml numeric,
  kcal_per_100 numeric,
  protein_g_per_100 numeric,
  carbs_g_per_100 numeric,
  fat_g_per_100 numeric,
  fiber_g_per_100 numeric,
  sugars_g_per_100 numeric,
  saturated_fat_g_per_100 numeric,
  sodium_g_per_100 numeric,
  match_type text,
  matched_text text,
  name_score numeric,
  score numeric,
  portion_grams numeric,
  portion_kcal numeric,
  portion_carbs_g numeric,
  portion_fat_g numeric,
  portion_protein_g numeric,
  default_serving_label text,
  default_serving_g numeric
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_q text := public.normalize_food_name(p_query);
  v_brand text := public.normalize_brand(p_brand);
  v_tsq tsquery;
begin
  if v_q is null then
    return;
  end if;
  if p_unit is null or p_unit not in ('g', 'ml') then
    raise exception 'unit must be g or ml' using errcode = '22023';
  end if;
  if p_quantity is not null and (p_quantity <= 0 or p_quantity > 5000) then
    raise exception 'quantity must be between 0 and 5000' using errcode = '22023';
  end if;
  v_tsq := to_tsquery('simple', array_to_string(regexp_split_to_array(v_q, ' '), ' | '));

  return query
  with cand as (
    select f.id as fid, 'exact'::text as mt, f.name as mtext, 1.0::numeric as s
    from public.foods f where f.normalized_name = v_q
    union all
    select a.food_id, 'alias', a.alias, 0.95
    from public.food_aliases a where a.normalized_alias = v_q
    union all
    -- Fuzzy scores are capped below the exact ones (name 1.0, alias 0.95) so
    -- an exact hit always outranks a fuzzy one.
    select f.id, 'fuzzy', f.name,
           least(0.92, greatest(extensions.similarity(f.normalized_name, v_q),
                    0.6 * extensions.word_similarity(v_q, f.normalized_name)
                      + 0.4 * extensions.similarity(f.normalized_name, v_q)))::numeric
    from public.foods f
    where f.normalized_name operator(extensions.%) v_q
       or v_q operator(extensions.<%) f.normalized_name
    union all
    select a.food_id, 'fuzzy_alias', a.alias,
           least(0.90, greatest(extensions.similarity(a.normalized_alias, v_q),
                           0.6 * extensions.word_similarity(v_q, a.normalized_alias)
                             + 0.4 * extensions.similarity(a.normalized_alias, v_q)))::numeric
    from public.food_aliases a
    where a.normalized_alias operator(extensions.%) v_q
       or v_q operator(extensions.<%) a.normalized_alias
    union all
    select f.id, 'fulltext', f.name, least(0.5, extensions.similarity(f.normalized_name, v_q) + 0.2)::numeric
    from public.foods f where f.search_tsv @@ v_tsq
  ),
  best as (
    select distinct on (fid) fid, mt, mtext, s
    from cand order by fid, s desc
  ),
  scored as (
    select f.*, b.mt, b.mtext, b.s,
      least(1.0,
        b.s
        * (0.6 + 0.4 * f.completeness) * (case when 'energy_mismatch' = any(f.quality_flags) then 0.8 else 1 end)
        * (case f.verification when 'expert_reviewed' then 1.0 when 'curated' then 0.97
                               when 'auto_checked' then 0.9 else 0.8 end)
        * (case
             when v_brand is not null and f.normalized_brand is null then 0.85
             when v_brand is not null and f.normalized_brand <> v_brand
                  and extensions.similarity(f.normalized_brand, v_brand) < 0.6 then 0.6
             when v_brand is null and f.normalized_brand is not null then 0.9
             else 1 end)
        + (case
             when v_brand is not null and f.normalized_brand is not null
                  and (f.normalized_brand = v_brand or extensions.similarity(f.normalized_brand, v_brand) >= 0.6) then 0.10
             when v_brand is null and f.normalized_brand is null then 0.05
             else 0 end)
      )::numeric as sc
    from best b
    join public.foods f on f.id = b.fid
    where f.is_active and f.is_matchable
  ),
  ranked as (
    select * from scored order by sc desc, s desc, char_length(name) asc
    limit greatest(1, least(coalesce(p_limit, 10), 50))
  )
  select
    r.id, r.name, r.brand, r.category, r.food_kind, r.source, r.source_ref, r.verification,
    r.completeness, r.quality_flags, r.basis, r.density_g_per_ml,
    r.kcal_per_100, r.protein_g_per_100, r.carbs_g_per_100, r.fat_g_per_100,
    r.fiber_g_per_100, r.sugars_g_per_100, r.saturated_fat_g_per_100, r.sodium_g_per_100,
    r.mt, r.mtext, round(r.s, 3), round(r.sc, 3),
    pg.grams,
    pn.calories, pn.carbs_g, pn.fat_g, pn.protein_g,
    sv.label, sv.grams
  from ranked r
  left join lateral (
    select fs.label, fs.grams from public.food_servings fs
    where fs.food_id = r.id and fs.is_default limit 1
  ) sv on true
  left join lateral (
    -- grams of the requested portion, and the matching per-100 g factor
    select
      case
        when p_quantity is null then null
        when p_unit = 'g' then p_quantity
        when r.density_g_per_ml is not null then round(p_quantity * r.density_g_per_ml, 1)
        else null
      end as grams
  ) pg on true
  left join lateral (
    select * from public.portion_nutrition(
      case when r.basis = 'ml' then r.kcal_per_100 / r.density_g_per_ml else r.kcal_per_100 end,
      case when r.basis = 'ml' then r.carbs_g_per_100 / r.density_g_per_ml else r.carbs_g_per_100 end,
      case when r.basis = 'ml' then r.fat_g_per_100 / r.density_g_per_ml else r.fat_g_per_100 end,
      case when r.basis = 'ml' then r.protein_g_per_100 / r.density_g_per_ml else r.protein_g_per_100 end,
      pg.grams)
    where pg.grams is not null and (r.basis = 'g' or r.density_g_per_ml is not null)
  ) pn on true
  order by r.sc desc, r.s desc, char_length(r.name) asc;
end;
$$;

-- ============================================================
-- 10. Function privileges
-- ============================================================
revoke all on function public.normalize_food_name(text) from public, anon;
grant execute on function public.normalize_food_name(text) to authenticated;
revoke all on function public.normalize_brand(text) from public, anon;
grant execute on function public.normalize_brand(text) to authenticated;
revoke all on function public.is_valid_micronutrients(jsonb) from public, anon;
grant execute on function public.is_valid_micronutrients(jsonb) to authenticated;
revoke all on function public.portion_nutrition(numeric, numeric, numeric, numeric, numeric) from public, anon;
grant execute on function public.portion_nutrition(numeric, numeric, numeric, numeric, numeric) to authenticated;
revoke all on function public.food_snapshot_per_100g(public.foods) from public, anon;
grant execute on function public.food_snapshot_per_100g(public.foods) to authenticated;
revoke all on function public.search_food_catalogue(text, text, numeric, text, int) from public, anon;
grant execute on function public.search_food_catalogue(text, text, numeric, text, int) to authenticated;
revoke all on function public.foods_before_write() from public, anon, authenticated;
revoke all on function public.food_logs_apply_nutrition() from public, anon, authenticated;

commit;

-- ============================================================
-- Rollback notes (manual)
--   Re-run food_logs_apply_nutrition and the source constraint from
--   006_food_log_provenance.sql; alter table public.food_logs drop constraint
--   food_logs_food_id_fkey; drop table food_servings, food_aliases, foods;
--   drop the functions above. The app does not depend on this migration yet.
-- ============================================================
