import { MOCK_MODE, supabase } from "./supabase";
import * as mock from "./mockStore";
import type {
  DbDailyStatus,
  DbDailyTotal,
  DbFoodLog,
  DbProfile,
  FoodLog,
  NewFoodLog,
  Profile,
  UserStreak,
} from "./types";
import type { DailyStatus, NutritionRow } from "./nutrition";
import { rangeEndingOn as rangeEndingOnDates } from "./dates";
import { BACKEND_ENABLED, UnauthorizedError, backendGet, type BackendDailyStatus } from "./backend";

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
  return data as DbProfile | null;
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
  return data as DbProfile;
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
  return (data ?? []) as DbFoodLog[];
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
  return (data ?? []) as DbFoodLog[];
}

/**
 * Saves a log. Pass provenance (source, source_ref, nutrients_per_100g) when
 * known: with a snapshot and serving_g, the database computes the totals
 * itself and the values sent here are only the client's preview.
 */
export async function addFoodLog(userId: string, log: NewFoodLog): Promise<FoodLog> {
  if (MOCK_MODE) return mock.mockAddFoodLog(log);

  const { data, error } = await supabase
    .from("food_logs")
    .insert({ user_id: userId, ...log })
    .select()
    .single();

  if (error) throw error;
  // The streak is recalculated by a database trigger in this same transaction.
  return data as DbFoodLog;
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
  return (data ?? []) as DbFoodLog[];
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
  return data as DbFoodLog;
}

export async function deleteFoodLog(userId: string, id: string): Promise<void> {
  if (MOCK_MODE) return mock.mockDeleteFoodLog(id);

  const { error } = await supabase.from("food_logs").delete().eq("id", id).eq("user_id", userId);
  if (error) throw error;
}

/**
 * The signed-in user's streak, computed by the database from their food logs
 * (migration 004). `current_streak` already accounts for a lapsed streak.
 * `userId` is kept for interface compatibility; the server uses the session.
 */
export async function getStreak(userId: string): Promise<UserStreak | null> {
  if (MOCK_MODE) return mock.mockGetStreak();

  const { data, error } = await supabase.rpc("get_my_streak");
  if (error) throw error;
  return data?.[0] ?? null;
}

/** The device's IANA time zone, e.g. "Asia/Kolkata", or null if unavailable. */
export function deviceTimeZone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" && tz.length > 0 ? tz : null;
  } catch {
    return null;
  }
}

/**
 * Stores the device's time zone on the profile when it differs, so the server
 * evaluates "today" for streaks in the user's local calendar. Best-effort: the
 * server falls back to lenient bounds while this is unset.
 */
export async function syncProfileTimezone(userId: string, profile: Profile): Promise<void> {
  if (MOCK_MODE) return;
  const tz = deviceTimeZone();
  if (!tz || tz === profile.timezone) return;

  const { error } = await supabase.from("profiles").update({ timezone: tz }).eq("user_id", userId);
  if (error) throw error;
}

/** The 7-day window ending on the given local date. Kept here for existing imports. */
export function rangeEndingOn(endDate: string): { start: string; end: string; days: string[] } {
  return rangeEndingOnDates(endDate, 7);
}

/* ------------------------------------------------------------------------- */
/* Daily nutrition (migration 005)                                           */
/* ------------------------------------------------------------------------- */

const num = (v: number | string | null | undefined): number => Number(v ?? 0) || 0;
const numOrNull = (v: number | string | null | undefined): number | null =>
  v == null ? null : Number(v);

/** Maps a get_daily_status() row to the app's DailyStatus. */
export function toDailyStatus(row: DbDailyStatus): DailyStatus {
  const hasSplit =
    row.macro_carb_pct != null && row.macro_fat_pct != null && row.macro_protein_pct != null;
  return {
    date: row.status_date,
    targetKcal: numOrNull(row.target_kcal),
    targetCarbsG: numOrNull(row.target_carbs_g),
    targetFatG: numOrNull(row.target_fat_g),
    targetProteinG: numOrNull(row.target_protein_g),
    split: hasSplit
      ? { carbPct: row.macro_carb_pct, fatPct: row.macro_fat_pct, proteinPct: row.macro_protein_pct }
      : null,
    consumed: {
      calories: num(row.consumed_kcal),
      carbsG: num(row.consumed_carbs_g),
      fatG: num(row.consumed_fat_g),
      proteinG: num(row.consumed_protein_g),
      entryCount: num(row.entry_count),
    },
    remainingKcal: numOrNull(row.remaining_kcal),
    remainingCarbsG: numOrNull(row.remaining_carbs_g),
    remainingFatG: numOrNull(row.remaining_fat_g),
    remainingProteinG: numOrNull(row.remaining_protein_g),
  };
}

/** Maps the backend's GET /v1/me/daily-status response to the app's DailyStatus. */
export function fromBackendDailyStatus(b: BackendDailyStatus): DailyStatus {
  const t = b.targets;
  return {
    date: b.date,
    targetKcal: t?.kcal ?? null,
    targetCarbsG: t?.carbs_g ?? null,
    targetFatG: t?.fat_g ?? null,
    targetProteinG: t?.protein_g ?? null,
    split: t
      ? { carbPct: t.macro_split.carb_pct, fatPct: t.macro_split.fat_pct, proteinPct: t.macro_split.protein_pct }
      : null,
    consumed: {
      calories: b.consumed.kcal,
      carbsG: b.consumed.carbs_g,
      fatG: b.consumed.fat_g,
      proteinG: b.consumed.protein_g,
      entryCount: b.consumed.entry_count,
    },
    remainingKcal: b.remaining?.kcal ?? null,
    remainingCarbsG: b.remaining?.carbs_g ?? null,
    remainingFatG: b.remaining?.fat_g ?? null,
    remainingProteinG: b.remaining?.protein_g ?? null,
  };
}

/**
 * Targets, consumption and remaining amounts for one local date, from the
 * database's get_daily_status(): the single source for daily numbers.
 *
 * With EXPO_PUBLIC_API_BASE_URL set, this goes through the FastAPI backend
 * (which calls the same function as the user). If the backend is unreachable
 * or errors, it falls back to calling the function directly: same numbers,
 * same RLS. An auth failure is not retried that way; it is the caller's to show.
 */
export async function getDailyStatus(date: string): Promise<DailyStatus> {
  if (MOCK_MODE) return mock.mockGetDailyStatus(date);

  if (BACKEND_ENABLED) {
    try {
      return fromBackendDailyStatus(await backendGet<BackendDailyStatus>("/v1/me/daily-status", { date }));
    } catch (error) {
      if (error instanceof UnauthorizedError) throw error;
      // Network failure, timeout or 5xx: use the database function directly.
    }
  }

  const { data, error } = await supabase.rpc("get_daily_status", { p_date: date });
  if (error) throw error;
  const row = data?.[0];
  if (!row) throw new Error("get_daily_status returned no row");
  return toDailyStatus(row);
}

/**
 * Per-day, per-meal sums for an inclusive local date range (at most 400 days),
 * from get_daily_totals(). Each row carries entry_count.
 */
export async function getDailyTotals(startDate: string, endDate: string): Promise<NutritionRow[]> {
  if (MOCK_MODE) return mock.mockGetDailyTotals(startDate, endDate);

  const { data, error } = await supabase.rpc("get_daily_totals", { p_start: startDate, p_end: endDate });
  if (error) throw error;
  return ((data ?? []) as DbDailyTotal[]).map((r) => ({
    logged_date: r.logged_date,
    meal_type: r.meal_type,
    calories: num(r.calories),
    carbs_g: num(r.carbs_g),
    fat_g: num(r.fat_g),
    protein_g: num(r.protein_g),
    entry_count: num(r.entry_count),
  }));
}
