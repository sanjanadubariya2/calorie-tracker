-- Migration 018: recommendation personalization, interactions and logging hand-off
-- (Phase 3, Tasks 4-6)
--
--   1. user_dietary_preferences: excluded ingredients (hard), preferred meal
--      styles, preparation time, budget, cooking equipment. Everything here is
--      entered by the user; nothing is inferred from behaviour or conversation.
--   2. recipes.equipment: what a recipe needs (curated; immutable once published).
--   3. recommendation_items.id: a stable id per recommendation.
--   4. recommendation_events: viewed / selected / rejected / saved / unsaved /
--      planned / logged. User-owned; deleted with their set (90-day retention).
--   5. recommendation_feedback: 'saved' (bookmark, no expiry), the item it came
--      from and a display name.
--   6. assistant_proposals: proposals can come from a recommendation (no
--      conversation), so confirming one reuses the single logging path.
--   7. recommendation_recipe_candidates(): adds description, times, equipment.
--
-- Rollback (local): drop recommendation_events; drop the added columns; restore
-- 013's feedback checks and expiry trigger, 015's recipes_before_update, 017's
-- recommendation_recipe_candidates, and make assistant_proposals.conversation_id
-- not null again (only valid while no recommendation proposals exist).

-- ============================================================
-- 1. Preferences
-- ============================================================
alter table public.user_dietary_preferences
  add column if not exists excluded_ingredients text[] not null default '{}'
    check (public.is_valid_text_list(excluded_ingredients, 20, 40)),
  add column if not exists preferred_meal_styles text[] not null default '{}'
    check (preferred_meal_styles <@ array['dal_rice', 'roti_sabzi', 'curry', 'one_pot', 'tiffin', 'egg',
                                          'salad', 'soup', 'snack', 'thali']::text[]
           and cardinality(preferred_meal_styles) <= 10),
  add column if not exists max_prep_minutes int check (max_prep_minutes is null or max_prep_minutes between 5 and 240),
  add column if not exists budget text check (budget is null or budget in ('low', 'medium', 'high')),
  -- null: not provided (no equipment filter); an array: what the user has.
  add column if not exists equipment text[] check (equipment is null or (
    equipment <@ array['stove', 'pressure_cooker', 'tawa', 'kadai', 'oven', 'microwave', 'blender', 'steamer',
                       'air_fryer']::text[] and cardinality(equipment) <= 10));

-- ============================================================
-- 2. Recipe equipment
-- ============================================================
-- null: not recorded (no equipment filter applies); an array: what it needs.
alter table public.recipes add column if not exists equipment text[] check (equipment is null or (
  equipment <@ array['stove', 'pressure_cooker', 'tawa', 'kadai', 'oven', 'microwave', 'blender', 'steamer',
                     'air_fryer']::text[] and cardinality(equipment) <= 10));

-- 015's immutability check, now covering equipment, description and times too.
create or replace function public.recipes_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'draft' and (
       new.name, new.variant, new.slug, new.servings, new.serving_label, new.cooked_weight_g, new.instructions,
       new.source, new.source_name, new.source_url, new.source_ref, new.verification, new.quantities_estimated,
       new.owner_id, new.family_id, new.version, new.nutrition_snapshot, new.published_at, new.published_by,
       new.equipment, new.description, new.prep_minutes, new.cook_minutes
     ) is distinct from (
       old.name, old.variant, old.slug, old.servings, old.serving_label, old.cooked_weight_g, old.instructions,
       old.source, old.source_name, old.source_url, old.source_ref, old.verification, old.quantities_estimated,
       old.owner_id, old.family_id, old.version, old.nutrition_snapshot, old.published_at, old.published_by,
       old.equipment, old.description, old.prep_minutes, old.cook_minutes) then
    raise exception 'Published recipes are immutable; create a new version' using errcode = '55000';
  end if;
  if old.status = 'retired' and new.status <> 'retired' then
    raise exception 'Retired recipes cannot be republished' using errcode = '55000';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- new_recipe_version (015) copies columns explicitly; carry equipment over.
create or replace function public.recipes_copy_equipment()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.equipment is null and new.version > 1 then
    select r.equipment into new.equipment from public.recipes r
    where r.family_id = new.family_id and r.version = new.version - 1;
  end if;
  return new;
end;
$$;
drop trigger if exists recipes_copy_equipment on public.recipes;
create trigger recipes_copy_equipment before insert on public.recipes
  for each row execute function public.recipes_copy_equipment();
revoke all on function public.recipes_copy_equipment() from public, anon, authenticated;

-- ============================================================
-- 3. A stable id per recommendation
-- ============================================================
alter table public.recommendation_items add column if not exists id uuid not null default gen_random_uuid();
create unique index if not exists recommendation_items_id_key on public.recommendation_items (id);

-- ============================================================
-- 4. Interaction events
-- ============================================================
-- What the user did with a recommendation. 'viewed' is recorded but never
-- read as liking; 'logged' is written by the backend when a proposal made
-- from the recommendation is confirmed.
create table if not exists public.recommendation_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  set_id uuid not null,
  rank smallint not null,
  event text not null check (event in ('viewed', 'selected', 'rejected', 'saved', 'unsaved', 'planned', 'logged')),
  created_at timestamptz not null default now(),
  -- Both keys: the item must exist AND belong to this user's set.
  foreign key (set_id, rank) references public.recommendation_items (set_id, rank) on delete cascade,
  foreign key (set_id, user_id) references public.recommendation_sets (id, user_id) on delete cascade
);
create index if not exists recommendation_events_user_idx on public.recommendation_events (user_id, created_at desc);
create index if not exists recommendation_events_item_idx on public.recommendation_events (set_id, rank);

create or replace function public.recommendation_events_stamp()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.created_at := now();      -- the database's clock, not the client's
  return new;
end;
$$;
drop trigger if exists recommendation_events_stamp on public.recommendation_events;
create trigger recommendation_events_stamp before insert on public.recommendation_events
  for each row execute function public.recommendation_events_stamp();
revoke all on function public.recommendation_events_stamp() from public, anon, authenticated;

alter table public.recommendation_events enable row level security;
revoke all on table public.recommendation_events from anon, authenticated;
grant select, insert, delete on table public.recommendation_events to authenticated;
drop policy if exists "Users manage their recommendation events" on public.recommendation_events;
create policy "Users manage their recommendation events" on public.recommendation_events
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ============================================================
-- 5. Feedback: saved (bookmarks), origin item, display name
-- ============================================================
alter table public.recommendation_feedback
  add column if not exists item_id uuid references public.recommendation_items (id) on delete set null,
  add column if not exists name text check (name is null or char_length(btrim(name)) between 1 and 200);

alter table public.recommendation_feedback drop constraint if exists recommendation_feedback_feedback_check;
alter table public.recommendation_feedback add constraint recommendation_feedback_feedback_check
  check (feedback in ('never', 'less_often', 'liked', 'saved'));
alter table public.recommendation_feedback drop constraint if exists recommendation_feedback_check1;
alter table public.recommendation_feedback drop constraint if exists recommendation_feedback_expiry_check;
alter table public.recommendation_feedback add constraint recommendation_feedback_expiry_check
  check ((feedback in ('never', 'saved')) = (expires_at is null));

-- 'never' and 'saved' last until the user removes them; others expire after 180 days.
create or replace function public.recommendation_feedback_expiry()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.expires_at := case when new.feedback in ('never', 'saved') then null else now() + interval '180 days' end;
  new.created_at := now();
  return new;
end;
$$;

grant update (feedback, item_id, name) on table public.recommendation_feedback to authenticated;

-- ============================================================
-- 6. Proposals made from a recommendation
-- ============================================================
-- origin is explicit: an assistant proposal always has its conversation; a
-- recommendation proposal keeps a reference to its item only while the item
-- exists (history is purged after 90 days; the proposal stays valid).
alter table public.assistant_proposals alter column conversation_id drop not null;
alter table public.assistant_proposals
  add column if not exists origin text not null default 'assistant' check (origin in ('assistant', 'recommendation')),
  add column if not exists recommendation_item_id uuid references public.recommendation_items (id) on delete set null;
alter table public.assistant_proposals drop constraint if exists assistant_proposals_origin_check;
alter table public.assistant_proposals add constraint assistant_proposals_origin_check
  check ((origin = 'assistant') = (conversation_id is not null)
         and (origin = 'recommendation' or recommendation_item_id is null));

-- ============================================================
-- 7. Recipe candidates with description, times and equipment
-- ============================================================
drop function if exists public.recommendation_recipe_candidates();
create function public.recommendation_recipe_candidates()
returns table (
  recipe_id uuid, family_id uuid, version int, slug text, name text, variant text, description text,
  servings numeric, serving_label text, prep_minutes int, cook_minutes int, equipment text[],
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
  select r.id, r.family_id, r.version, r.slug, r.name, r.variant, r.description, r.servings, r.serving_label,
         r.prep_minutes, r.cook_minutes, r.equipment,
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
    left join public.foods f on f.id = i.food_id
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
revoke all on function public.recommendation_recipe_candidates() from public, anon;
grant execute on function public.recommendation_recipe_candidates() to authenticated;
