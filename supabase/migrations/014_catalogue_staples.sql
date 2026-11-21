-- Calorie Tracker — catalogue staples (Phase 3)
-- Run after 013_recommendation_foundation.sql. Safe to re-run.
--
-- Lets the catalogue hold basic staples that INDB (a dish database) lacks:
-- milk, curd, fruit, nuts, eggs, vegetables, legumes. Nutrition for them comes
-- from USDA FoodData Central (SR Legacy, public domain), referenced by FDC id.
--   * foods.source gains 'usda_fdc'
--   * foods.category gains 'fruit', 'dairy', 'nuts_seeds', 'vegetable', 'legume', 'grain'
-- Only widens two allowed-value lists: every existing row stays valid, and no
-- other table, function or behaviour changes.

begin;

alter table public.foods drop constraint if exists foods_source_check;
alter table public.foods add constraint foods_source_check
  check (source in ('indb', 'open_food_facts', 'curated', 'manual', 'ai_verified', 'usda_fdc'));

alter table public.foods drop constraint if exists foods_category_check;
alter table public.foods add constraint foods_category_check
  check (category in (
    'beverage', 'soup', 'sweet', 'south_indian', 'bread', 'rice_dish', 'egg_dish',
    'non_veg', 'dal', 'paneer_dish', 'snack', 'side', 'salad', 'sabzi', 'other',
    'fruit', 'dairy', 'nuts_seeds', 'vegetable', 'legume', 'grain'));

commit;

-- Rollback (manual, only if no usda_fdc rows or new categories exist):
--   restore the two constraints with their 007 value lists.
