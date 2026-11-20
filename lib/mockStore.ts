import AsyncStorage from "@react-native-async-storage/async-storage";
import type { FoodLog, NewFoodLog, Profile, UserStreak } from "./types";
import { computeStreakRuns, effectiveCurrentStreak, localISODate, milestoneCount } from "./streaks";
import {
  DEFAULT_ACTIVITY_LEVEL,
  calculateDailyTarget,
  macroSplitOf,
  validateMacroSplit,
} from "./calculations";
import {
  MAX_SERVING_G,
  buildDailyStatus,
  isValidSnapshot,
  scaleNutrients,
  type DailyStatus,
  type NutritionRow,
} from "./nutrition";

// A tiny fake backend that lives in AsyncStorage, so the app is fully
// usable (and keeps your data between reloads) with zero Supabase setup.
// Swap EXPO_PUBLIC_MOCK_MODE to "false" once real credentials are in .env
// and every screen switches to hitting Supabase instead — no UI changes needed.

const STORAGE_KEY = "calorie-tracker-mock-db-v1";
const MOCK_USER_ID = "mock-user-0001";

interface MockDB {
  profile: Profile | null;
  foodLogs: FoodLog[];
  streak: UserStreak;
}

// Local calendar date, matching how real logs get their logged_date.
function todayISO(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return localISODate(d);
}

function seedDB(): MockDB {
  const db: MockDB = {
    profile: {
      id: "mock-profile-0001",
      user_id: MOCK_USER_ID,
      age: 22,
      height_cm: 165,
      weight_kg: 58,
      gender: "female",
      goal: "lose",
      activity_level: DEFAULT_ACTIVITY_LEVEL,
      macro_carb_pct: 55,
      macro_fat_pct: 25,
      macro_protein_pct: 20,
      // Computed by the same formula as the database trigger (1343 kcal).
      daily_target_kcal: calculateDailyTarget(58, 165, 22, "female", "lose", DEFAULT_ACTIVITY_LEVEL),
      created_at: new Date().toISOString(),
    },
    foodLogs: [
      {
        id: "mock-log-0001",
        user_id: MOCK_USER_ID,
        logged_date: todayISO(),
        meal_type: "breakfast",
        food_name: "Rice Idli (Homemade), Sambar, Ladoo",
        calories: 594,
        carbs_g: 92,
        fat_g: 14,
        protein_g: 12,
        serving_g: 250,
        is_quick_add: false,
      },
      {
        id: "mock-log-0002",
        user_id: MOCK_USER_ID,
        logged_date: todayISO(),
        meal_type: "evening_snack",
        food_name: "Banana Chips, Chocolate Chips",
        calories: 476,
        carbs_g: 34.6,
        fat_g: 11.6,
        protein_g: 5.5,
        serving_g: 80,
        is_quick_add: true,
      },
      {
        id: "mock-log-0003",
        user_id: MOCK_USER_ID,
        logged_date: todayISO(-2),
        meal_type: "breakfast",
        food_name: "Poha",
        calories: 460,
        carbs_g: 78,
        fat_g: 10,
        protein_g: 8,
        serving_g: 300,
        is_quick_add: false,
      },
      {
        id: "mock-log-0004",
        user_id: MOCK_USER_ID,
        logged_date: todayISO(-2),
        meal_type: "lunch",
        food_name: "Dal, Rice, Sabzi",
        calories: 59,
        carbs_g: 10,
        fat_g: 1,
        protein_g: 3,
        serving_g: 200,
        is_quick_add: false,
      },
      {
        id: "mock-log-0005",
        user_id: MOCK_USER_ID,
        logged_date: todayISO(-2),
        meal_type: "dinner",
        food_name: "Roti, Paneer Curry",
        calories: 571,
        carbs_g: 55,
        fat_g: 22,
        protein_g: 24,
        serving_g: 350,
        is_quick_add: false,
      },
      {
        id: "mock-log-0006",
        user_id: MOCK_USER_ID,
        logged_date: todayISO(-2),
        meal_type: "evening_snack",
        food_name: "Quick added calories",
        calories: 261,
        carbs_g: 30,
        fat_g: 10,
        protein_g: 4,
        serving_g: null,
        is_quick_add: true,
      },
    ],
    // Derived from the seeded logs below by recomputeStreak().
    streak: {
      id: "mock-streak-0001",
      user_id: MOCK_USER_ID,
      current_streak: 0,
      last_logged_date: null,
      longest_streak: 0,
      badges_earned: 0,
    },
  };
  recomputeStreak(db, true);
  return db;
}

/**
 * Mock-mode twin of recalculate_user_streak() (migration 004): recomputed from
 * distinct logged dates after every log change, never incremented. Stores the
 * run ending at the last active day; mockGetStreak applies the lapse rule.
 * Badges are a high-water mark, so each milestone is awarded once.
 */
function recomputeStreak(db: MockDB, resetBadges = false): void {
  const runs = computeStreakRuns(db.foodLogs.map((l) => l.logged_date), localISODate());
  const earned = milestoneCount(runs.longest);
  db.streak = {
    ...db.streak,
    current_streak: runs.runEndingAtLast,
    last_logged_date: runs.lastLoggedDate,
    longest_streak: runs.longest,
    badges_earned: resetBadges ? earned : Math.max(db.streak.badges_earned ?? 0, earned),
  };
}

let cache: MockDB | null = null;

async function loadDB(): Promise<MockDB> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    cache = raw ? (JSON.parse(raw) as MockDB) : seedDB();
    // Mock DBs saved before server-side streaks have no longest_streak and
    // badge counts from the old per-day logic. Rebuild them once, the same
    // way migration 004 backfills real users.
    if (raw && cache.streak.longest_streak === undefined) recomputeStreak(cache, true);
  } catch {
    cache = seedDB();
  }
  return cache;
}

async function saveDB(db: MockDB): Promise<void> {
  cache = db;
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(db));
}

export const mockUserId = MOCK_USER_ID;

export async function mockGetProfile(): Promise<Profile | null> {
  const db = await loadDB();
  return db.profile;
}

/** Mirrors the database's CHECK violations so callers can handle both alike. */
function checkViolation(message: string): Error {
  return Object.assign(new Error(message), { code: "23514" });
}

export async function mockUpsertProfile(profile: Omit<Profile, "id" | "created_at">): Promise<Profile> {
  const db = await loadDB();
  const split = macroSplitOf(profile);
  const splitError = validateMacroSplit(split);
  if (splitError) throw checkViolation(splitError);
  const activity = profile.activity_level ?? DEFAULT_ACTIVITY_LEVEL;
  const saved: Profile = {
    ...profile,
    activity_level: activity,
    macro_carb_pct: split.carbPct,
    macro_fat_pct: split.fatPct,
    macro_protein_pct: split.proteinPct,
    // As in the database, the target is always recomputed, never taken from the caller.
    daily_target_kcal: calculateDailyTarget(
      profile.weight_kg, profile.height_cm, profile.age, profile.gender, profile.goal, activity
    ),
    id: db.profile?.id ?? `mock-profile-${Date.now()}`,
    created_at: db.profile?.created_at ?? new Date().toISOString(),
  };
  db.profile = saved;
  await saveDB(db);
  return saved;
}

export async function mockGetFoodLogsForDate(date: string): Promise<FoodLog[]> {
  const db = await loadDB();
  return db.foodLogs.filter((l) => l.logged_date === date);
}

export async function mockGetFoodLogsInRange(startDate: string, endDate: string): Promise<FoodLog[]> {
  const db = await loadDB();
  return db.foodLogs.filter((l) => l.logged_date >= startDate && l.logged_date <= endDate);
}

/**
 * Mock twin of food_logs_apply_nutrition() and the 006 CHECKs: provenance and
 * snapshot are fixed after insert, snapshot rows get computed totals, invalid
 * values and future dates are rejected.
 */
function applyFoodLogRules(next: FoodLog, previous?: FoodLog): FoodLog {
  const row: FoodLog = { ...next, source: next.source ?? "unknown" };
  if (previous) {
    row.food_id = previous.food_id;
    row.source = previous.source ?? "unknown";
    row.source_ref = previous.source_ref;
    row.nutrients_per_100g = previous.nutrients_per_100g;
    row.ai_confidence = previous.ai_confidence;
    row.created_at = previous.created_at;
  } else if (row.source === "unknown" && row.is_quick_add) {
    row.source = "quick_add";
  }

  // Latest "today" anywhere on Earth (UTC+14), as in the database trigger.
  const latestToday = new Date(Date.now() + 14 * 3600 * 1000).toISOString().slice(0, 10);
  if ((!previous || row.logged_date !== previous.logged_date) && row.logged_date > latestToday) {
    throw checkViolation(`logged_date ${row.logged_date} is in the future`);
  }

  if (row.nutrients_per_100g != null && !isValidSnapshot(row.nutrients_per_100g)) {
    throw checkViolation("nutrients_per_100g is invalid");
  }
  if (row.nutrients_per_100g && row.serving_g != null) {
    const t = scaleNutrients(row.nutrients_per_100g, row.serving_g);
    row.calories = t.calories;
    row.carbs_g = t.carbsG;
    row.fat_g = t.fatG;
    row.protein_g = t.proteinG;
  }

  if ([row.calories, row.carbs_g, row.fat_g, row.protein_g].some((v) => !(v >= 0))) {
    throw checkViolation("Nutrition values cannot be negative");
  }
  if (row.calories > 20000 || Math.max(row.carbs_g, row.fat_g, row.protein_g) > 5000) {
    throw checkViolation("Nutrition values are implausibly large");
  }
  if (row.serving_g != null && !(row.serving_g > 0 && row.serving_g <= MAX_SERVING_G)) {
    throw checkViolation("Serving must be between 0 and 5000 g");
  }
  const nameLength = row.food_name.trim().length;
  if (nameLength < 1 || nameLength > 200) throw checkViolation("Food name must be 1–200 characters");
  return row;
}

export async function mockAddFoodLog(log: NewFoodLog): Promise<FoodLog> {
  const db = await loadDB();
  const saved = applyFoodLogRules({
    ...log,
    id: `mock-log-${Date.now()}`,
    user_id: MOCK_USER_ID,
    created_at: new Date().toISOString(),
  });
  db.foodLogs.push(saved);
  recomputeStreak(db);
  await saveDB(db);
  return saved;
}

export async function mockGetRecentFoodLogs(limit: number): Promise<FoodLog[]> {
  const db = await loadDB();
  // Seeded rows have no created_at, so fall back to the logged date to keep
  // ordering stable and newest-first.
  return [...db.foodLogs]
    .sort((a, b) => (b.created_at ?? b.logged_date).localeCompare(a.created_at ?? a.logged_date))
    .slice(0, limit);
}

export async function mockUpdateFoodLog(
  id: string,
  changes: Partial<FoodLog>
): Promise<FoodLog> {
  const db = await loadDB();
  const index = db.foodLogs.findIndex((l) => l.id === id);
  if (index === -1) throw new Error(`No food log with id ${id}`);

  const previous = db.foodLogs[index];
  const updated = applyFoodLogRules({ ...previous, ...changes }, previous);
  db.foodLogs[index] = updated;
  recomputeStreak(db);
  await saveDB(db);
  return updated;
}

export async function mockDeleteFoodLog(id: string): Promise<void> {
  const db = await loadDB();
  db.foodLogs = db.foodLogs.filter((l) => l.id !== id);
  recomputeStreak(db);
  await saveDB(db);
}

/** Same shape and lapse rule as the get_my_streak() RPC. */
export async function mockGetStreak(): Promise<UserStreak> {
  const db = await loadDB();
  const today = localISODate();
  const runs = computeStreakRuns(db.foodLogs.map((l) => l.logged_date), today);
  return { ...db.streak, current_streak: effectiveCurrentStreak(runs, today) };
}

/** Same rules as get_daily_status(). Mock mode keeps no target history: the current target applies. */
export async function mockGetDailyStatus(date: string): Promise<DailyStatus> {
  const db = await loadDB();
  const p = db.profile;
  const target = p
    ? {
        kcal: calculateDailyTarget(
          p.weight_kg, p.height_cm, p.age, p.gender, p.goal, p.activity_level ?? DEFAULT_ACTIVITY_LEVEL
        ),
        split: macroSplitOf(p),
      }
    : null;
  return buildDailyStatus(date, db.foodLogs, target);
}

/** Same shape as get_daily_totals(): one row per (date, meal) with entry_count. */
export async function mockGetDailyTotals(startDate: string, endDate: string): Promise<NutritionRow[]> {
  const db = await loadDB();
  const groups = new Map<string, NutritionRow>();
  for (const l of db.foodLogs) {
    if (l.logged_date < startDate || l.logged_date > endDate) continue;
    const key = `${l.logged_date}|${l.meal_type}`;
    const g = groups.get(key) ?? {
      logged_date: l.logged_date,
      meal_type: l.meal_type,
      calories: 0,
      carbs_g: 0,
      fat_g: 0,
      protein_g: 0,
      entry_count: 0,
    };
    g.calories += l.calories;
    g.carbs_g += l.carbs_g;
    g.fat_g += l.fat_g;
    g.protein_g += l.protein_g;
    g.entry_count = (g.entry_count ?? 0) + 1;
    groups.set(key, g);
  }
  return [...groups.values()].sort(
    (a, b) => a.logged_date.localeCompare(b.logged_date) || a.meal_type.localeCompare(b.meal_type)
  );
}

export async function mockResetDB(): Promise<void> {
  await saveDB(seedDB());
}
