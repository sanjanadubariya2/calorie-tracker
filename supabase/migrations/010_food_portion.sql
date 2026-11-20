-- Calorie Tracker — portion nutrition for meal proposals
-- Run after 009_meal_images.sql. Safe to re-run.
--
-- food_portion(food_id, grams) returns exactly what logging that food would
-- store: the per-100 g snapshot (food_snapshot_per_100g, migration 007) and the
-- portion totals (portion_nutrition). AI meal proposals use it, so the numbers
-- a user reviews are the numbers that get saved, from one implementation.
--
-- SECURITY INVOKER: runs as the caller, so only active foods are visible (RLS).
-- Returns no row for an unknown/inactive food, and a row with NULL nutrition
-- when the food can't be logged (missing core values, or a per-100 ml food
-- without a density).

begin;

create or replace function public.food_portion(p_food_id uuid, p_grams numeric)
returns table (
  food_id uuid,
  nutrients_per_100g jsonb,
  calories numeric,
  carbs_g numeric,
  fat_g numeric,
  protein_g numeric
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_food public.foods;
  v_snapshot jsonb;
  v record;
begin
  if p_food_id is null or p_grams is null or p_grams <= 0 or p_grams > 5000 then
    raise exception 'grams must be between 0 and 5000' using errcode = '22023';
  end if;

  select * into v_food from public.foods f where f.id = p_food_id and f.is_active;
  if not found then
    return;
  end if;

  v_snapshot := public.food_snapshot_per_100g(v_food);
  if v_snapshot is null then
    return query select v_food.id, null::jsonb, null::numeric, null::numeric, null::numeric, null::numeric;
    return;
  end if;

  select * into v from public.portion_nutrition(
    (v_snapshot ->> 'kcal')::numeric,
    (v_snapshot ->> 'carbs_g')::numeric,
    (v_snapshot ->> 'fat_g')::numeric,
    (v_snapshot ->> 'protein_g')::numeric,
    p_grams);

  return query select v_food.id, v_snapshot, v.calories, v.carbs_g, v.fat_g, v.protein_g;
end;
$$;

revoke all on function public.food_portion(uuid, numeric) from public, anon;
grant execute on function public.food_portion(uuid, numeric) to authenticated;

commit;
