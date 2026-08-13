import { MOCK_MODE, supabase } from "./supabase";
import * as mock from "./mockStore";
import type { FoodLog, Profile, UserStreak } from "./types";

// Every screen calls through this file rather than touching supabase or
// mockStore directly. MOCK_MODE is decided once, in supabase.ts, from
// EXPO_PUBLIC_MOCK_MODE / missing credentials.

export async function getProfile(userId: string): Promise<Profile | null> {
  if (MOCK_MODE) return mock.mockGetProfile();

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function upsertProfile(
  userId: string,
  profile: Omit<Profile, "id" | "user_id" | "created_at">
): Promise<Profile> {
  if (MOCK_MODE) return mock.mockUpsertProfile({ ...profile, user_id: userId });

  const { data, error } = await supabase
    .from("profiles")
    .upsert({ user_id: userId, ...profile }, { onConflict: "user_id" })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function getFoodLogsForDate(userId: string, date: string): Promise<FoodLog[]> {
  if (MOCK_MODE) return mock.mockGetFoodLogsForDate(date);

  const { data, error } = await supabase
    .from("food_logs")
    .select("*")
    .eq("user_id", userId)
    .eq("logged_date", date)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function getFoodLogsInRange(
  userId: string,
  startDate: string,
  endDate: string
): Promise<FoodLog[]> {
  if (MOCK_MODE) return mock.mockGetFoodLogsInRange(startDate, endDate);

  const { data, error } = await supabase
    .from("food_logs")
    .select("*")
    .eq("user_id", userId)
    .gte("logged_date", startDate)
    .lte("logged_date", endDate);

  if (error) throw error;
  return data ?? [];
}

export async function addFoodLog(
  userId: string,
  log: Omit<FoodLog, "id" | "user_id">
): Promise<FoodLog> {
  if (MOCK_MODE) return mock.mockAddFoodLog(log);

  const { data, error } = await supabase
    .from("food_logs")
    .insert({ user_id: userId, ...log })
    .select()
    .single();

  if (error) throw error;

  // Best-effort streak bump — failures here shouldn't block the food log save.
  try {
    await bumpStreak(userId);
  } catch {
    // non-fatal
  }

  return data;
}

// Backs the "Recently added" / "Frequently added" quick picks. Pulls the most
// recent logs and lets the caller derive both lists from one round trip.
export async function getRecentFoodLogs(userId: string, limit = 200): Promise<FoodLog[]> {
  if (MOCK_MODE) return mock.mockGetRecentFoodLogs(limit);

  const { data, error } = await supabase
    .from("food_logs")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

export type FoodLogUpdate = Partial<
  Pick<
    FoodLog,
    | "meal_type"
    | "food_name"
    | "calories"
    | "carbs_g"
    | "fat_g"
    | "protein_g"
    | "serving_g"
    | "logged_date"
  >
>;

export async function updateFoodLog(
  userId: string,
  id: string,
  changes: FoodLogUpdate
): Promise<FoodLog> {
  if (MOCK_MODE) return mock.mockUpdateFoodLog(id, changes);

  const { data, error } = await supabase
    .from("food_logs")
    .update(changes)
    .eq("id", id)
    .eq("user_id", userId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deleteFoodLog(userId: string, id: string): Promise<void> {
  if (MOCK_MODE) return mock.mockDeleteFoodLog(id);

  const { error } = await supabase.from("food_logs").delete().eq("id", id).eq("user_id", userId);
  if (error) throw error;
}

export async function getStreak(userId: string): Promise<UserStreak | null> {
  if (MOCK_MODE) return mock.mockGetStreak();

  const { data, error } = await supabase
    .from("user_streaks")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function bumpStreak(userId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const existing = await getStreak(userId);

  if (existing?.last_logged_date === today) return;

  const continuing = existing?.last_logged_date === yesterday;
  const nextStreak = continuing ? (existing?.current_streak ?? 0) + 1 : 1;
  const crossedNewBadge = Math.floor(nextStreak / 1) > (existing?.badges_earned ?? 0);

  const { error } = await supabase.from("user_streaks").upsert(
    {
      user_id: userId,
      current_streak: nextStreak,
      last_logged_date: today,
      badges_earned: crossedNewBadge ? (existing?.badges_earned ?? 0) + 1 : existing?.badges_earned ?? 0,
    },
    { onConflict: "user_id" }
  );

  if (error) throw error;
}

// The 7-day window ending on (and including) the given local date.
// Dates are built in local time — toISOString() would shift the day
// for anyone not on UTC.
export function rangeEndingOn(endDate: string): { start: string; end: string; days: string[] } {
  const [y, m, d] = endDate.split("-").map(Number);
  const days: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date(y, m - 1, d - i);
    days.push(
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
        date.getDate()
      ).padStart(2, "0")}`
    );
  }
  return { start: days[0], end: days[days.length - 1], days };
}
