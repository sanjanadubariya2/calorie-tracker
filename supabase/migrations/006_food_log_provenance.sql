-- Calorie Tracker — food log provenance, nutrition snapshots, validation
-- Run after 005_nutrition_targets.sql. Safe to re-run.
--
-- Before: a food log kept only its name and absolute totals. The Open Food
-- Facts barcode and per-100 g values were discarded at save time, edits
-- rescaled already-rounded numbers (drift: 520 -> 192 -> 519 kcal), and the
-- only value check was calories >= 0.
--
-- After:
--   * Provenance columns (all optional, existing rows stay readable):
--       food_id             reserved for a future food catalogue (no FK yet)
--       source             'open_food_facts' | 'manual' | 'quick_add' | 'relog'
--                          | 'ai_assisted' | 'unknown'
--       source_ref         external id, e.g. the OFF barcode
--       nutrients_per_100g snapshot of the per-100 g values used at log time
--       ai_confidence      0–1, only for source = 'ai_assisted'
--   * The snapshot is immutable once logged. Edits can change the portion,
--     meal, name or date, never the snapshot or provenance, so later changes
--     to an external catalogue can't rewrite history.
--   * When a snapshot and serving_g are present, the database computes
--     calories and macros from them (calories to whole kcal, macros to 0.1 g,
--     half away from zero). Client-sent totals are ignored for those rows, so
--     every snapshot row is reproducible from its own columns. Rows without a
--     snapshot (quick add, legacy) keep the totals the client sends.
--   * Range checks on every nutrition column, and future-dated logs are
--     rejected.
--
-- nutrients_per_100g shape (keys other than the first four are optional):
--   {"kcal": 0..1000, "carbs_g": 0..100, "fat_g": 0..100, "protein_g": 0..100,
--    "saturated_fat_g", "sugars_g", "fiber_g", "sodium_g", "salt_g": 0..100}

begin;

-- ============================================================
-- 1. Columns
-- ============================================================
alter table public.food_logs add column if not exists food_id uuid;
alter table public.food_logs add column if not exists source text not null default 'unknown';
alter table public.food_logs add column if not exists source_ref text;
alter table public.food_logs add column if not exists nutrients_per_100g jsonb;
alter table public.food_logs add column if not exists ai_confidence numeric(4, 3);

comment on column public.food_logs.food_id is
  'Reserved for a future food catalogue table; foreign key added when that table exists.';
comment on column public.food_logs.nutrients_per_100g is
  'Immutable per-100 g snapshot used to compute this entry. See 006_food_log_provenance.sql.';

-- Legacy rows: the only provenance we can recover is quick add vs. other.
update public.food_logs
set source = 'quick_add'
where is_quick_add and source = 'unknown';

-- ============================================================
-- 2. Snapshot validation
-- ============================================================
create or replace function public.is_valid_nutrients_per_100g(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
  v_num numeric;
  v_max numeric;
begin
  if p is null then
    return true;
  end if;
  if jsonb_typeof(p) <> 'object' then
    return false;
  end if;
  if not (jsonb_exists(p, 'kcal') and jsonb_exists(p, 'carbs_g')
          and jsonb_exists(p, 'fat_g') and jsonb_exists(p, 'protein_g')) then
    return false;
  end if;

  for v_key in select jsonb_object_keys(p) loop
    if v_key not in ('kcal', 'carbs_g', 'fat_g', 'protein_g',
                     'saturated_fat_g', 'sugars_g', 'fiber_g', 'sodium_g', 'salt_g') then
      return false;
    end if;
    if jsonb_typeof(p -> v_key) <> 'number' then
      return false;
    end if;
    v_num := (p ->> v_key)::numeric;
    v_max := 100;
    if v_key = 'kcal' then
      v_max := 1000;
    end if;
    if v_num < 0 or v_num > v_max then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- ============================================================
-- 3. Constraints
--
-- New columns validate immediately. Constraints on pre-existing columns are
-- added NOT VALID (new writes are checked at once) and validated only when no
-- existing row fails; otherwise the migration warns with a count instead of
-- aborting. Note that a legacy row failing a check cannot be UPDATEd until it is
-- corrected, because CHECK applies to the new row on every update.
-- ============================================================
alter table public.food_logs drop constraint if exists food_logs_source_valid;
alter table public.food_logs add constraint food_logs_source_valid
  check (source in ('open_food_facts', 'manual', 'quick_add', 'relog', 'ai_assisted', 'unknown'));

alter table public.food_logs drop constraint if exists food_logs_source_ref_valid;
alter table public.food_logs add constraint food_logs_source_ref_valid
  check (source_ref is null or char_length(source_ref) between 1 and 200);

alter table public.food_logs drop constraint if exists food_logs_nutrients_valid;
alter table public.food_logs add constraint food_logs_nutrients_valid
  check (public.is_valid_nutrients_per_100g(nutrients_per_100g));

alter table public.food_logs drop constraint if exists food_logs_ai_confidence_valid;
alter table public.food_logs add constraint food_logs_ai_confidence_valid
  check (ai_confidence is null or (ai_confidence between 0 and 1 and source = 'ai_assisted'));

-- Legacy-column constraints: (name, predicate) pairs, added NOT VALID.
do $$
declare
  c record;
  v_bad bigint;
begin
  for c in
    select * from (values
      ('food_logs_calories_range',
       'calories >= 0 and calories <= 20000'),
      ('food_logs_macros_range',
       'carbs_g >= 0 and fat_g >= 0 and protein_g >= 0 and carbs_g <= 5000 and fat_g <= 5000 and protein_g <= 5000'),
      ('food_logs_serving_valid',
       'serving_g is null or (serving_g > 0 and serving_g <= 5000)'),
      ('food_logs_name_valid',
       'char_length(btrim(food_name)) between 1 and 200'),
      ('food_logs_date_valid',
       'logged_date >= date ''2000-01-01''')
    ) as t(name, pred)
  loop
    execute format('alter table public.food_logs drop constraint if exists %I', c.name);
    execute format('alter table public.food_logs add constraint %I check (%s) not valid', c.name, c.pred);
    execute format('select count(*) from public.food_logs where not (%s)', c.pred) into v_bad;
    if v_bad = 0 then
      execute format('alter table public.food_logs validate constraint %I', c.name);
    else
      raise warning '% left NOT VALID: % existing food_logs row(s) fail it', c.name, v_bad;
    end if;
  end loop;
end;
$$;

-- ============================================================
-- 4. Snapshot immutability, server-computed portions, date bound
-- ============================================================
create or replace function public.food_logs_apply_nutrition()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_latest_today date := ((now() at time zone 'utc') + interval '14 hours')::date;
  v_g numeric;
begin
  if tg_op = 'UPDATE' then
    -- Provenance and the snapshot are fixed at log time.
    new.user_id            := old.user_id;
    new.food_id            := old.food_id;
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
  end if;

  -- No date is later than the latest "today" anywhere on Earth (UTC+14). Only
  -- checked when the date is set or changed, so legacy rows stay editable.
  if (tg_op = 'INSERT' or new.logged_date is distinct from old.logged_date)
     and new.logged_date > v_latest_today then
    raise exception 'logged_date % is in the future', new.logged_date
      using errcode = '23514';
  end if;

  -- Compute only from a valid snapshot. An invalid one is left for the
  -- food_logs_nutrients_valid CHECK to reject with a clear 23514, rather than
  -- failing earlier on a NULL macro.
  if new.nutrients_per_100g is not null and new.serving_g is not null
     and public.is_valid_nutrients_per_100g(new.nutrients_per_100g) then
    v_g := new.serving_g;
    new.calories  := round((new.nutrients_per_100g ->> 'kcal')::numeric      * v_g / 100);
    new.carbs_g   := round((new.nutrients_per_100g ->> 'carbs_g')::numeric   * v_g / 100, 1);
    new.fat_g     := round((new.nutrients_per_100g ->> 'fat_g')::numeric     * v_g / 100, 1);
    new.protein_g := round((new.nutrients_per_100g ->> 'protein_g')::numeric * v_g / 100, 1);
  end if;

  return new;
end;
$$;

drop trigger if exists food_logs_apply_nutrition on public.food_logs;
create trigger food_logs_apply_nutrition
  before insert or update on public.food_logs
  for each row execute function public.food_logs_apply_nutrition();

revoke all on function public.food_logs_apply_nutrition() from public, anon, authenticated;
revoke all on function public.is_valid_nutrients_per_100g(jsonb) from public, anon;
-- Evaluated inside the CHECK constraint as the writing role.
grant execute on function public.is_valid_nutrients_per_100g(jsonb) to authenticated;

-- ============================================================
-- 5. Index for the actual query pattern
--
-- getRecentFoodLogs (quick picks): where user_id = ? order by created_at desc
-- limit 200. The existing (user_id, logged_date) index covers the
-- date-range queries, get_daily_status and get_daily_totals.
-- ============================================================
create index if not exists food_logs_user_created_idx
  on public.food_logs (user_id, created_at desc);

commit;

-- ============================================================
-- Rollback notes (manual)
--   drop trigger if exists food_logs_apply_nutrition on public.food_logs;
--   alter table public.food_logs drop constraint if exists <each constraint above>;
--   The new columns are nullable/defaulted and harmless to keep. The app from
--   this change sends them, so roll the app back too.
-- ============================================================
