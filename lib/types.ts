import type { MealType } from "@/constants/theme";
import type { Database } from "./database.types";
import type { ActivityLevel } from "./calculations";
import type { FoodSource, NutrientsPer100g } from "./nutrition";

export type { ActivityLevel } from "./calculations";
export type { FoodSource, NutrientsPer100g } from "./nutrition";

export type Goal = "lose" | "maintain" | "gain";
export type Gender = "male" | "female";

export interface Profile {
  id: string;
  user_id: string;
  age: number;
  height_cm: number;
  weight_kg: number;
  gender: Gender;
  goal: Goal;
  daily_target_kcal: number;
  created_at: string;
  // Added in migration 002. Optional so existing rows (and mock data) that
  // predate the social features still satisfy the type.
  username?: string | null;
  avatar_url?: string | null;
  // Added in migration 004. IANA zone from the device, used by the server to
  // decide what "today" means for this user's streak. Null until first synced.
  timezone?: string | null;
  // Added in migration 005. Optional so mock data saved before it still loads;
  // macroSplitOf() / DEFAULT_ACTIVITY_LEVEL supply the defaults.
  activity_level?: ActivityLevel;
  macro_carb_pct?: number;
  macro_fat_pct?: number;
  macro_protein_pct?: number;
}

export interface FoodLog {
  id: string;
  user_id: string;
  logged_date: string; // YYYY-MM-DD
  meal_type: MealType;
  food_name: string;
  calories: number;
  carbs_g: number;
  fat_g: number;
  protein_g: number;
  serving_g: number | null;
  is_quick_add: boolean;
  created_at?: string;
  // Provenance, added in migration 006. All optional: older rows (and logs
  // from older app versions) have none. The snapshot is immutable once saved,
  // and when present the database computes the totals above from it.
  food_id?: string | null;
  source?: FoodSource;
  source_ref?: string | null;
  nutrients_per_100g?: NutrientsPer100g | null;
  ai_confidence?: number | null;
}

/** The fields a client sends to create a log. */
export type NewFoodLog = Omit<FoodLog, "id" | "user_id" | "created_at">;

// Read-only for clients: maintained by a trigger on food_logs (migration 004)
// and read through get_my_streak().
export interface UserStreak {
  id: string;
  user_id: string;
  /** Days in the run ending today or yesterday; 0 once that run has lapsed. */
  current_streak: number;
  last_logged_date: string | null;
  /** Longest run of consecutive logged days in the user's history. */
  longest_streak: number;
  /** Milestones reached (3, 7, 14, 30, 60, 100, 180, 365 days). Never decreases. */
  badges_earned: number;
}

// A single result from the Open Food Facts search API, normalized
// down to what the portion customizer needs.
export interface FoodSearchResult {
  id: string;
  name: string;
  brand?: string;
  // Values below are per 100g, matching how Open Food Facts reports them.
  caloriesPer100g: number;
  carbsPer100g: number;
  fatPer100g: number;
  proteinPer100g: number;
  imageUrl?: string;
  // Extra label nutrients. Open Food Facts is crowd-sourced, so any of these
  // may be missing — the nutrition label hides rows it has no value for.
  saturatedFatPer100g?: number;
  sugarsPer100g?: number;
  fiberPer100g?: number;
  sodiumPer100g?: number;
  saltPer100g?: number;
}

/* ------------------------------------------------------------------------- */
/* Database alignment                                                        */
/*                                                                           */
/* lib/database.types.ts is generated from the migrations (npm run           */
/* types:gen). Columns constrained by a SQL CHECK rather than an enum        */
/* (gender, goal, meal_type) come through as plain `string`; the Db* types   */
/* below narrow exactly those columns. The guards then make `tsc` fail if a  */
/* migration renames, drops or retypes a column the app relies on, which is  */
/* what makes the row conversions in lib/api.ts safe.                        */
/* ------------------------------------------------------------------------- */

type PublicSchema = Database["public"];
type Narrow<T, Over> = Omit<T, keyof Over> & Over;

export type DbProfile = Narrow<
  PublicSchema["Tables"]["profiles"]["Row"],
  { gender: Gender; goal: Goal; activity_level: ActivityLevel }
>;
export type DbFoodLog = Narrow<
  PublicSchema["Tables"]["food_logs"]["Row"],
  // nutrients_per_100g is jsonb; its shape is enforced by is_valid_nutrients_per_100g().
  { meal_type: MealType; source: FoodSource; nutrients_per_100g: NutrientsPer100g | null }
>;
export type DbStreak = PublicSchema["Functions"]["get_my_streak"]["Returns"][number];
export type DbDailyStatus = PublicSchema["Functions"]["get_daily_status"]["Returns"][number];
export type DbDailyTotal = Narrow<
  PublicSchema["Functions"]["get_daily_totals"]["Returns"][number],
  { meal_type: MealType }
>;

type Assert<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;

/* eslint-disable @typescript-eslint/no-unused-vars */
type _ProfileRowFitsProfile = Assert<Extends<DbProfile, Profile>>;
type _FoodLogRowFitsFoodLog = Assert<Extends<DbFoodLog, FoodLog>>;
type _StreakRowFitsUserStreak = Assert<Extends<DbStreak, UserStreak>>;
type _NewFoodLogFitsInsert = Assert<
  Extends<NewFoodLog & { user_id: string }, PublicSchema["Tables"]["food_logs"]["Insert"]>
>;
/* eslint-enable @typescript-eslint/no-unused-vars */
