-- Calorie Tracker — initial schema
-- Run this in the Supabase SQL Editor (or via `supabase db push` with the CLI).

-- ============================================================
-- Profiles
-- ============================================================
create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null unique,
  age int not null,
  height_cm numeric not null,
  weight_kg numeric not null,
  gender text not null check (gender in ('male', 'female')),
  goal text not null check (goal in ('lose', 'maintain', 'gain')),
  daily_target_kcal int not null default 2000,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

create policy "Users can view their own profile"
  on profiles for select
  using (auth.uid() = user_id);

create policy "Users can insert their own profile"
  on profiles for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own profile"
  on profiles for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
-- Daily food logs
-- ============================================================
create table if not exists food_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  logged_date date not null default current_date,
  meal_type text not null check (
    meal_type in ('breakfast', 'lunch', 'dinner', 'morning_snack', 'afternoon_snack', 'evening_snack')
  ),
  food_name text not null,
  calories numeric not null check (calories >= 0),
  carbs_g numeric not null default 0,
  fat_g numeric not null default 0,
  protein_g numeric not null default 0,
  serving_g numeric,
  is_quick_add boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists food_logs_user_date_idx on food_logs (user_id, logged_date);

alter table food_logs enable row level security;

create policy "Users can view their own food logs"
  on food_logs for select
  using (auth.uid() = user_id);

create policy "Users can insert their own food logs"
  on food_logs for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own food logs"
  on food_logs for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own food logs"
  on food_logs for delete
  using (auth.uid() = user_id);

-- ============================================================
-- Streaks / badges
-- ============================================================
create table if not exists user_streaks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null unique,
  current_streak int not null default 0,
  last_logged_date date,
  badges_earned int not null default 0
);

alter table user_streaks enable row level security;

create policy "Users can view their own streak"
  on user_streaks for select
  using (auth.uid() = user_id);

create policy "Users can insert their own streak"
  on user_streaks for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own streak"
  on user_streaks for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
