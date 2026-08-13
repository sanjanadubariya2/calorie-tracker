import AsyncStorage from "@react-native-async-storage/async-storage";
import type { FoodLog, Profile, UserStreak } from "./types";

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

function todayISO(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function seedDB(): MockDB {
  return {
    profile: {
      id: "mock-profile-0001",
      user_id: MOCK_USER_ID,
      age: 22,
      height_cm: 165,
      weight_kg: 58,
      gender: "female",
      goal: "lose",
      daily_target_kcal: 1616,
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
    streak: {
      id: "mock-streak-0001",
      user_id: MOCK_USER_ID,
      current_streak: 2,
      last_logged_date: todayISO(-1),
      badges_earned: 2,
    },
  };
}

let cache: MockDB | null = null;

async function loadDB(): Promise<MockDB> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    cache = raw ? (JSON.parse(raw) as MockDB) : seedDB();
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

export async function mockUpsertProfile(profile: Omit<Profile, "id" | "created_at">): Promise<Profile> {
  const db = await loadDB();
  const saved: Profile = {
    ...profile,
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

export async function mockAddFoodLog(log: Omit<FoodLog, "id" | "user_id">): Promise<FoodLog> {
  const db = await loadDB();
  const saved: FoodLog = { ...log, id: `mock-log-${Date.now()}`, user_id: MOCK_USER_ID };
  db.foodLogs.push(saved);
  await updateStreakInternal(db);
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

  const updated = { ...db.foodLogs[index], ...changes };
  db.foodLogs[index] = updated;
  await saveDB(db);
  return updated;
}

export async function mockDeleteFoodLog(id: string): Promise<void> {
  const db = await loadDB();
  db.foodLogs = db.foodLogs.filter((l) => l.id !== id);
  await saveDB(db);
}

export async function mockGetStreak(): Promise<UserStreak> {
  const db = await loadDB();
  return db.streak;
}

async function updateStreakInternal(db: MockDB): Promise<void> {
  const today = todayISO();
  if (db.streak.last_logged_date === today) return; // already logged today

  const yesterday = todayISO(-1);
  const continuing = db.streak.last_logged_date === yesterday;

  db.streak = {
    ...db.streak,
    current_streak: continuing ? db.streak.current_streak + 1 : 1,
    last_logged_date: today,
    badges_earned: continuing ? db.streak.badges_earned : db.streak.badges_earned,
  };
}

export async function mockResetDB(): Promise<void> {
  await saveDB(seedDB());
}
