-- Calorie Tracker — recommendation foundation (Phase 3)
-- Run after 012_assistant_proposals.sql. Safe to re-run. Additive only: no
-- existing table, function, policy or food-logging behaviour is changed.
--
--   food_attributes            diet / allergen / Jain / region / meal-type data per catalogue food,
--                              with an explicit status: 'reviewed' (a person checked it),
--                              'inferred' (keyword classifier) or 'unknown'. Inferred is never verified.
--   meal_templates (+components) curated multi-dish meals built from catalogue foods.
--                              Drafts are invisible to users until approved.
--   food_serving_nutrition     view: nutrition per default serving, computed by the same
--                              functions as logging (portion_nutrition). Never stored, never LLM.
--   recommendation_sets/items  what was recommended to whom, and what happened (user-owned, 90-day retention).
--   recommendation_feedback    "never" / "less often" / "liked" per food or template (user-owned).
--
-- Who writes what:
--   catalogue_writer   food_attributes, meal_templates, meal_template_components (catalogue data only)
--   authenticated      their own recommendation rows and feedback (RLS); read catalogue data
--   assistant_writer   deletes EXPIRED recommendation sets / feedback (retention purge) only
--   anon               nothing

begin;

-- ============================================================
-- 1. Food attributes
-- ============================================================
create table if not exists public.food_attributes (
  food_id uuid primary key references public.foods(id) on delete cascade,

  -- What the dish itself is. 'vegetarian' = no meat/fish/egg (dairy allowed).
  diet_class text not null default 'unknown'
    check (diet_class in ('vegan', 'vegetarian', 'egg', 'fish', 'meat', 'unknown')),
  diet_status text not null default 'unknown' check (diet_status in ('reviewed', 'inferred', 'unknown')),
  -- null = not known. Only a review can make these true; the classifier may only set false.
  vegan_compatible boolean,
  jain_compatible boolean,

  -- Allergens known to be PRESENT. allergen_status says how complete the list is:
  --   reviewed = a person confirmed the full list (absence of others is known)
  --   inferred = keyword detection only (absence of others is NOT known)
  --   unknown  = not assessed
  allergens text[] not null default '{}' check (
    allergens <@ array['peanut', 'tree_nut', 'milk', 'egg', 'wheat_gluten', 'soy', 'fish', 'shellfish', 'sesame', 'mustard']::text[]),
  allergen_status text not null default 'unknown' check (allergen_status in ('reviewed', 'inferred', 'unknown')),

  regions text[] not null default '{}' check (
    regions <@ array['north_indian', 'south_indian', 'east_indian', 'west_indian', 'pan_indian']::text[]),
  meal_types text[] not null default '{}' check (
    meal_types <@ array['breakfast', 'lunch', 'dinner', 'snack']::text[]),
  countable boolean,                                   -- served in pieces (roti, idli) vs bowls/glasses

  source text not null default 'classifier' check (source in ('classifier', 'curated')),
  classifier_version text check (classifier_version is null or char_length(classifier_version) <= 40),
  reasons text[] not null default '{}' check (public.is_valid_text_list(reasons, 12, 120)),
  reviewed_by text check (reviewed_by is null or char_length(reviewed_by) <= 80),
  reviewed_at timestamptz,
  updated_at timestamptz not null default now(),

  -- 'unknown' class <=> 'unknown' status; anything 'reviewed' carries who/when.
  constraint food_attributes_diet_consistent check ((diet_class = 'unknown') = (diet_status = 'unknown')),
  constraint food_attributes_review_recorded check (
    (diet_status <> 'reviewed' and allergen_status <> 'reviewed'
     and coalesce(vegan_compatible, false) = false and coalesce(jain_compatible, false) = false)
    or (reviewed_at is not null and reviewed_by is not null)),
  -- A food can't contradict itself.
  constraint food_attributes_vegan_consistent check (
    vegan_compatible is distinct from true or diet_class = 'vegan'),
  constraint food_attributes_classifier_never_reviews check (
    source = 'curated' or (diet_status <> 'reviewed' and allergen_status <> 'reviewed'))
);

create index if not exists food_attributes_diet_idx on public.food_attributes (diet_class, diet_status);

create or replace function public.food_attributes_touch()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists food_attributes_touch on public.food_attributes;
create trigger food_attributes_touch before update on public.food_attributes
  for each row execute function public.food_attributes_touch();

-- ============================================================
-- 2. Meal templates (curated multi-dish meals)
-- ============================================================
create table if not exists public.meal_templates (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 60),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text check (description is null or char_length(description) <= 300),
  meal_types text[] not null check (
    cardinality(meal_types) >= 1 and meal_types <@ array['breakfast', 'lunch', 'dinner', 'snack']::text[]),
  regions text[] not null default '{}' check (
    regions <@ array['north_indian', 'south_indian', 'east_indian', 'west_indian', 'pan_indian']::text[]),
  status text not null default 'draft' check (status in ('draft', 'approved', 'retired')),
  version int not null default 1 check (version >= 1),
  approved_by text check (approved_by is null or char_length(approved_by) <= 80),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meal_templates_approval_recorded check (
    status <> 'approved' or (approved_at is not null and approved_by is not null))
);

create table if not exists public.meal_template_components (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.meal_templates(id) on delete cascade,
  position smallint not null check (position between 1 and 8),
  slot text not null check (slot in ('main', 'side', 'bread', 'rice', 'drink', 'accompaniment')),
  -- Foods are never deleted (only deactivated); restrict keeps templates honest.
  food_id uuid not null references public.foods(id) on delete restrict,
  default_servings numeric not null check (default_servings > 0 and default_servings <= 10),
  min_servings numeric not null check (min_servings > 0),
  max_servings numeric not null check (max_servings <= 10),
  servings_step numeric not null default 1 check (servings_step in (0.25, 0.5, 1)),
  optional boolean not null default false,
  unique (template_id, position),
  unique (template_id, food_id),
  constraint meal_template_components_range check (min_servings <= default_servings and default_servings <= max_servings)
);
create index if not exists meal_template_components_food_idx on public.meal_template_components (food_id);

-- A component must be priceable: an active, matchable food with a default serving.
create or replace function public.meal_template_components_check()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (
    select 1 from public.foods f join public.food_servings s on s.food_id = f.id and s.is_default
    where f.id = new.food_id and f.is_active and f.is_matchable
  ) then
    raise exception 'Food % is inactive, incomplete or has no default serving', new.food_id using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists meal_template_components_check on public.meal_template_components;
create trigger meal_template_components_check before insert or update on public.meal_template_components
  for each row execute function public.meal_template_components_check();

create or replace function public.meal_templates_touch()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists meal_templates_touch on public.meal_templates;
create trigger meal_templates_touch before update on public.meal_templates
  for each row execute function public.meal_templates_touch();

-- ============================================================
-- 3. Nutrition per default serving (computed, never stored)
-- ============================================================
-- security_invoker: the caller's RLS on foods/food_servings applies.
create or replace view public.food_serving_nutrition with (security_invoker = true) as
select f.id as food_id,
       s.label as serving_label,
       s.grams as serving_grams,
       pn.calories, pn.protein_g, pn.carbs_g, pn.fat_g,
       f.quality_flags
from public.foods f
join public.food_servings s on s.food_id = f.id and s.is_default
cross join lateral (select public.food_snapshot_per_100g(f) as snap) sn
cross join lateral public.portion_nutrition(
  (sn.snap ->> 'kcal')::numeric, (sn.snap ->> 'carbs_g')::numeric,
  (sn.snap ->> 'fat_g')::numeric, (sn.snap ->> 'protein_g')::numeric, s.grams) pn
where f.is_active and f.is_matchable and sn.snap is not null;

-- ============================================================
-- 4. Recommendation history (user-owned, retained 90 days)
-- ============================================================
create table if not exists public.recommendation_sets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  meal_type text not null check (meal_type in ('breakfast', 'lunch', 'dinner', 'snack')),
  mode text not null check (mode in ('meals', 'foods', 'both')),
  local_date date not null,
  engine_version text not null check (char_length(engine_version) <= 40),
  -- Numbers and filter names only (budget, remaining, filters applied); no free text.
  context jsonb not null default '{}' check (jsonb_typeof(context) = 'object' and pg_column_size(context) <= 8192),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '90 days',
  unique (id, user_id),
  check (expires_at > created_at)
);
create index if not exists recommendation_sets_user_idx on public.recommendation_sets (user_id, created_at desc);
create index if not exists recommendation_sets_expires_idx on public.recommendation_sets (expires_at);

create table if not exists public.recommendation_items (
  set_id uuid not null,
  user_id uuid not null default auth.uid(),
  rank smallint not null check (rank between 1 and 20),
  kind text not null check (kind in ('food', 'meal')),
  food_id uuid references public.foods(id) on delete set null,
  template_id uuid references public.meal_templates(id) on delete set null,
  score numeric not null check (score between -10 and 10),
  score_breakdown jsonb not null default '{}' check (jsonb_typeof(score_breakdown) = 'object' and pg_column_size(score_breakdown) <= 4096),
  outcome text not null default 'shown' check (outcome in ('shown', 'proposed', 'logged', 'dismissed')),
  outcome_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (set_id, rank),
  foreign key (set_id, user_id) references public.recommendation_sets (id, user_id) on delete cascade,
  check ((kind = 'food') = (template_id is null))
);
create index if not exists recommendation_items_user_food_idx on public.recommendation_items (user_id, food_id, created_at desc)
  where food_id is not null;
create index if not exists recommendation_items_user_template_idx on public.recommendation_items (user_id, template_id, created_at desc)
  where template_id is not null;

-- ============================================================
-- 5. Feedback (user-owned). "never" lasts until the user removes it;
--    "less_often" / "liked" expire after 180 days.
-- ============================================================
create table if not exists public.recommendation_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  food_id uuid references public.foods(id) on delete cascade,
  template_id uuid references public.meal_templates(id) on delete cascade,
  feedback text not null check (feedback in ('never', 'less_often', 'liked')),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  check ((food_id is null) <> (template_id is null)),
  check ((feedback = 'never') = (expires_at is null))
);
create unique index if not exists recommendation_feedback_food_key
  on public.recommendation_feedback (user_id, food_id) where food_id is not null;
create unique index if not exists recommendation_feedback_template_key
  on public.recommendation_feedback (user_id, template_id) where template_id is not null;
create index if not exists recommendation_feedback_expires_idx on public.recommendation_feedback (expires_at)
  where expires_at is not null;

-- Expiry is set by the database, not the client.
create or replace function public.recommendation_feedback_expiry()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.expires_at := case when new.feedback = 'never' then null else now() + interval '180 days' end;
  return new;
end;
$$;
drop trigger if exists recommendation_feedback_expiry on public.recommendation_feedback;
create trigger recommendation_feedback_expiry before insert or update of feedback on public.recommendation_feedback
  for each row execute function public.recommendation_feedback_expiry();

-- Retention for sets is also set by the database.
create or replace function public.recommendation_sets_retention()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.created_at := now();
  new.expires_at := now() + interval '90 days';
  return new;
end;
$$;
drop trigger if exists recommendation_sets_retention on public.recommendation_sets;
create trigger recommendation_sets_retention before insert on public.recommendation_sets
  for each row execute function public.recommendation_sets_retention();

revoke all on function public.food_attributes_touch(), public.meal_templates_touch(),
  public.meal_template_components_check(), public.recommendation_feedback_expiry(),
  public.recommendation_sets_retention() from public, anon, authenticated;

-- ============================================================
-- 6. RLS and privileges
-- ============================================================
alter table public.food_attributes enable row level security;
alter table public.meal_templates enable row level security;
alter table public.meal_template_components enable row level security;
alter table public.recommendation_sets enable row level security;
alter table public.recommendation_items enable row level security;
alter table public.recommendation_feedback enable row level security;

revoke all on table public.food_attributes, public.meal_templates, public.meal_template_components,
  public.recommendation_sets, public.recommendation_items, public.recommendation_feedback,
  public.food_serving_nutrition from anon, authenticated;

-- Catalogue data: readable by signed-in users (approved templates only).
grant select on table public.food_attributes, public.meal_templates, public.meal_template_components,
  public.food_serving_nutrition to authenticated;

drop policy if exists "Signed-in users read food attributes" on public.food_attributes;
create policy "Signed-in users read food attributes" on public.food_attributes
  for select to authenticated using (true);
drop policy if exists "Signed-in users read approved templates" on public.meal_templates;
create policy "Signed-in users read approved templates" on public.meal_templates
  for select to authenticated using (status = 'approved');
drop policy if exists "Signed-in users read approved template components" on public.meal_template_components;
create policy "Signed-in users read approved template components" on public.meal_template_components
  for select to authenticated using (exists (
    select 1 from public.meal_templates t where t.id = template_id and t.status = 'approved'));

-- User-owned history and feedback.
grant select, insert, delete on table public.recommendation_sets to authenticated;
grant select, insert, delete on table public.recommendation_items to authenticated;
grant update (outcome, outcome_at) on table public.recommendation_items to authenticated;
grant select, insert, delete on table public.recommendation_feedback to authenticated;
grant update (feedback) on table public.recommendation_feedback to authenticated;

drop policy if exists "Users manage their recommendation sets" on public.recommendation_sets;
create policy "Users manage their recommendation sets" on public.recommendation_sets
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "Users manage their recommendation items" on public.recommendation_items;
create policy "Users manage their recommendation items" on public.recommendation_items
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "Users manage their recommendation feedback" on public.recommendation_feedback;
create policy "Users manage their recommendation feedback" on public.recommendation_feedback
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- catalogue_writer: catalogue data only. Templates can be deleted only while drafts.
grant execute on function public.is_valid_text_list(text[], int, int) to catalogue_writer;  -- used by a CHECK
-- Read-only pricing, so template reviews compute nutrition exactly as logging does.
grant execute on function public.food_portion(uuid, numeric) to catalogue_writer;
grant execute on function public.food_snapshot_per_100g(public.foods) to catalogue_writer;   -- used by food_portion
grant execute on function public.portion_nutrition(numeric, numeric, numeric, numeric, numeric) to catalogue_writer;
grant execute on function public.is_valid_nutrients_per_100g(jsonb) to catalogue_writer;
grant select, insert, update on table public.food_attributes, public.meal_templates,
  public.meal_template_components to catalogue_writer;
grant delete on table public.food_attributes, public.meal_template_components to catalogue_writer;
grant delete on table public.meal_templates to catalogue_writer;
drop policy if exists "catalogue_writer manages food attributes" on public.food_attributes;
create policy "catalogue_writer manages food attributes" on public.food_attributes
  for all to catalogue_writer using (true) with check (true);
drop policy if exists "catalogue_writer manages templates" on public.meal_templates;
drop policy if exists "catalogue_writer reads templates" on public.meal_templates;
create policy "catalogue_writer reads templates" on public.meal_templates
  for select to catalogue_writer using (true);
drop policy if exists "catalogue_writer creates templates" on public.meal_templates;
create policy "catalogue_writer creates templates" on public.meal_templates
  for insert to catalogue_writer with check (true);
drop policy if exists "catalogue_writer updates templates" on public.meal_templates;
create policy "catalogue_writer updates templates" on public.meal_templates
  for update to catalogue_writer using (true) with check (true);
drop policy if exists "catalogue_writer deletes draft templates" on public.meal_templates;
create policy "catalogue_writer deletes draft templates" on public.meal_templates
  for delete to catalogue_writer using (status = 'draft');
drop policy if exists "catalogue_writer manages template components" on public.meal_template_components;
create policy "catalogue_writer manages template components" on public.meal_template_components
  for all to catalogue_writer using (true) with check (true);

-- assistant_writer: retention purge of expired user rows only.
grant select, delete on table public.recommendation_sets, public.recommendation_feedback to assistant_writer;
drop policy if exists "assistant_writer purges expired recommendation sets" on public.recommendation_sets;
create policy "assistant_writer purges expired recommendation sets" on public.recommendation_sets
  for all to assistant_writer using (expires_at < now());
drop policy if exists "assistant_writer purges expired feedback" on public.recommendation_feedback;
create policy "assistant_writer purges expired feedback" on public.recommendation_feedback
  for all to assistant_writer using (expires_at is not null and expires_at < now());

commit;

-- Rollback (manual; nothing else depends on these objects):
--   drop view public.food_serving_nutrition;
--   drop table public.recommendation_items, public.recommendation_sets, public.recommendation_feedback,
--     public.meal_template_components, public.meal_templates, public.food_attributes;
--   drop function public.food_attributes_touch(), public.meal_templates_touch(),
--     public.meal_template_components_check(), public.recommendation_feedback_expiry(),
--     public.recommendation_sets_retention();
