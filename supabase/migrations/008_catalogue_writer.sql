-- Calorie Tracker — catalogue_writer role
-- Run after 007_food_catalogue.sql. Safe to re-run.
--
-- The only principal that may write the shared food catalogue. Used by the
-- backend's catalogue tools (INDB loader, Open Food Facts import), never by the
-- app, and never for user data. It can't read or write food_logs, profiles or
-- anything else, can't bypass RLS on other tables, and can't delete foods
-- (deactivate them with is_active = false).
--
-- The role is created WITHOUT a password, so it can't log in until an admin
-- sets one outside version control:
--   alter role catalogue_writer password '<generated secret>';
-- Connect through the pooler as  catalogue_writer.<project-ref>  (Supabase).

begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'catalogue_writer') then
    create role catalogue_writer login noinherit connection limit 5;
  end if;
end;
$$;

grant usage on schema public to catalogue_writer;
grant usage on schema extensions to catalogue_writer;

grant select, insert, update on table public.foods, public.food_aliases, public.food_servings to catalogue_writer;
grant delete on table public.food_aliases, public.food_servings to catalogue_writer;

-- Used by generated columns, CHECK constraints and the quality trigger.
grant execute on function public.normalize_food_name(text) to catalogue_writer;
grant execute on function public.normalize_brand(text) to catalogue_writer;
grant execute on function public.is_valid_micronutrients(jsonb) to catalogue_writer;

-- unaccent is executable by PUBLIC by default; this explicit grant is only a
-- safeguard. On hosted Supabase the extension may be owned by an admin role
-- that postgres can't grant on, so don't let that abort the migration.
do $$
begin
  grant execute on function extensions.unaccent(regdictionary, text) to catalogue_writer;
exception when insufficient_privilege then
  raise notice 'unaccent grant skipped (not owner); PUBLIC execute applies';
end;
$$;

-- RLS stays on; these policies admit catalogue_writer to the catalogue only.
drop policy if exists "catalogue_writer manages foods" on public.foods;
create policy "catalogue_writer manages foods" on public.foods
  for all to catalogue_writer using (true) with check (true);

drop policy if exists "catalogue_writer manages aliases" on public.food_aliases;
create policy "catalogue_writer manages aliases" on public.food_aliases
  for all to catalogue_writer using (true) with check (true);

drop policy if exists "catalogue_writer manages servings" on public.food_servings;
create policy "catalogue_writer manages servings" on public.food_servings
  for all to catalogue_writer using (true) with check (true);

commit;

-- Rollback (manual): drop the three policies, revoke the grants,
-- `drop role catalogue_writer;`
