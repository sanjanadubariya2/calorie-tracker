-- Calorie Tracker — catalogue search: raw ingredients rank below dishes (Phase 3)
-- Run after 015_recipes.sql. Safe to re-run.
--
-- Recipe ingredients (raw pulses, grains, vegetables, meat, spices) are flagged
-- 'raw_ingredient'. Without this, "toor dal" matched "Toor dal (raw)" confidently,
-- so a logged bowl of cooked dal would be priced as dry lentils. Such foods now
-- score x0.75 unless the query itself asks for them (raw, dry, flour, powder, ...),
-- so cooked dishes win and a raw-only match is never "confident" by accident.
-- The function is otherwise identical to 007; its grants are unchanged.

begin;

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
        -- 016: raw cooking ingredients rank below dishes unless the query asks for them.
        * (case when 'raw_ingredient' = any(f.quality_flags)
                 and v_q !~ '\m(raw|dry|uncooked|flour|atta|besan|rava|sooji|powder|seeds{0,1}|whole)\M' then 0.75 else 1 end)
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

commit;

-- Rollback: re-run the search_food_catalogue definition from 007_food_catalogue.sql.
