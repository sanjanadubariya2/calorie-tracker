// Nutrition amounts and aggregation, the shared rules for every screen.
//
// The database is authoritative:
//   * food_logs totals for snapshot rows are computed by the
//     food_logs_apply_nutrition trigger (migration 006);
//   * daily numbers come from get_daily_status / get_daily_totals (005).
// These functions apply the *same* rules for portion previews, mock mode,
// and client-side bucketing of get_daily_totals rows. Change both together.

import type { MealType } from "@/constants/theme";
import { roundHalfAwayFromZero, calculateMacroTargets, type MacroSplit } from "./calculations";
import type { FoodSearchResult } from "./types";

/* ------------------------------------------------------------------------- */
/* Provenance and snapshots                                                  */
/* ------------------------------------------------------------------------- */

export type FoodSource =
  | "open_food_facts"
  | "manual"
  | "quick_add"
  | "relog"
  | "ai_assisted"
  /** Picked from the food catalogue (migration 007). */
  | "catalogue"
  | "unknown";

/**
 * Per-100 g snapshot stored with a log. Shape enforced by
 * is_valid_nutrients_per_100g(). A `type` (not an interface) so it is
 * assignable to the generated jsonb `Json` type.
 */
export type NutrientsPer100g = {
  kcal: number;
  carbs_g: number;
  fat_g: number;
  protein_g: number;
  saturated_fat_g?: number;
  sugars_g?: number;
  fiber_g?: number;
  sodium_g?: number;
  salt_g?: number;
};

const OPTIONAL_KEYS = ["saturated_fat_g", "sugars_g", "fiber_g", "sodium_g", "salt_g"] as const;

/** The largest single serving the database accepts (food_logs_serving_valid). */
export const MAX_SERVING_G = 5000;

const inRange = (v: unknown, max: number) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max;

/** Same rules as the database CHECK. */
export function isValidSnapshot(value: unknown): value is NutrientsPer100g {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!inRange(v.kcal, 1000)) return false;
  if (!inRange(v.carbs_g, 100) || !inRange(v.fat_g, 100) || !inRange(v.protein_g, 100)) return false;
  for (const [key, val] of Object.entries(v)) {
    if (key === "kcal" || key === "carbs_g" || key === "fat_g" || key === "protein_g") continue;
    if (!(OPTIONAL_KEYS as readonly string[]).includes(key)) return false;
    if (!inRange(val, 100)) return false;
  }
  return true;
}

/**
 * Snapshot from an Open Food Facts result, or null if OFF's crowd-sourced
 * values are out of range. The log is still saved then, just without a
 * snapshot (its totals are stored as computed for the portion).
 */
export function snapshotFromSearchResult(food: FoodSearchResult): NutrientsPer100g | null {
  const snapshot: NutrientsPer100g = {
    kcal: food.caloriesPer100g,
    carbs_g: food.carbsPer100g,
    fat_g: food.fatPer100g,
    protein_g: food.proteinPer100g,
  };
  const optional: [keyof NutrientsPer100g, number | undefined][] = [
    ["saturated_fat_g", food.saturatedFatPer100g],
    ["sugars_g", food.sugarsPer100g],
    ["fiber_g", food.fiberPer100g],
    ["sodium_g", food.sodiumPer100g],
    ["salt_g", food.saltPer100g],
  ];
  for (const [key, value] of optional) {
    if (value != null && inRange(value, 100)) snapshot[key] = value;
  }
  return isValidSnapshot(snapshot) ? snapshot : null;
}

/* ------------------------------------------------------------------------- */
/* Portion scaling                                                           */
/* ------------------------------------------------------------------------- */

export interface NutritionAmounts {
  calories: number;
  carbsG: number;
  fatG: number;
  proteinG: number;
}

/**
 * Totals for `grams` of a food: calories to whole kcal, macros to 0.1 g,
 * half away from zero. Identical to food_logs_apply_nutrition().
 */
export function scaleNutrients(per100g: NutrientsPer100g, grams: number): NutritionAmounts {
  const g = Number.isFinite(grams) && grams > 0 ? grams : 0;
  return {
    calories: roundHalfAwayFromZero((per100g.kcal * g) / 100),
    carbsG: roundHalfAwayFromZero((per100g.carbs_g * g) / 100, 1),
    fatG: roundHalfAwayFromZero((per100g.fat_g * g) / 100, 1),
    proteinG: roundHalfAwayFromZero((per100g.protein_g * g) / 100, 1),
  };
}

/* ------------------------------------------------------------------------- */
/* Aggregation                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Anything with per-entry or per-group nutrition: a FoodLog, or a
 * get_daily_totals row (which carries entry_count).
 */
export interface NutritionRow {
  logged_date: string;
  meal_type: MealType;
  calories: number;
  carbs_g: number;
  fat_g: number;
  protein_g: number;
  /** Entries the row represents; 1 when omitted (a single log). */
  entry_count?: number;
}

export interface NutritionTotals {
  calories: number;
  carbsG: number;
  fatG: number;
  proteinG: number;
  entryCount: number;
}

const ZERO: NutritionTotals = { calories: 0, carbsG: 0, fatG: 0, proteinG: 0, entryCount: 0 };

/** Sums rows. Empty input gives zeros. Values are summed unrounded, like SQL sum(). */
export function sumNutrition(rows: NutritionRow[]): NutritionTotals {
  return rows.reduce<NutritionTotals>(
    (acc, r) => ({
      calories: acc.calories + r.calories,
      carbsG: acc.carbsG + r.carbs_g,
      fatG: acc.fatG + r.fat_g,
      proteinG: acc.proteinG + r.protein_g,
      entryCount: acc.entryCount + (r.entry_count ?? 1),
    }),
    { ...ZERO }
  );
}

/** Per-date totals. Dates with no rows are absent. */
export function totalsByDate(rows: NutritionRow[]): Map<string, NutritionTotals> {
  const grouped = new Map<string, NutritionRow[]>();
  for (const r of rows) grouped.set(r.logged_date, [...(grouped.get(r.logged_date) ?? []), r]);
  return new Map([...grouped].map(([date, group]) => [date, sumNutrition(group)]));
}

/**
 * Average daily calories over the days that have at least one entry. The one
 * definition of "average" for the dashboard, friends card, reports and the
 * friend summaries in SQL: a day with only 0-kcal entries counts as logged.
 */
export function averageOverLoggedDays(rows: NutritionRow[]): number {
  const days = [...totalsByDate(rows).values()].filter((t) => t.entryCount > 0);
  if (days.length === 0) return 0;
  return days.reduce((sum, t) => sum + t.calories, 0) / days.length;
}

/* ------------------------------------------------------------------------- */
/* Daily status                                                              */
/* ------------------------------------------------------------------------- */

/** One day's targets, consumption and remaining amounts (get_daily_status). */
export interface DailyStatus {
  date: string;
  /** Null until the user has a profile. */
  targetKcal: number | null;
  targetCarbsG: number | null;
  targetFatG: number | null;
  targetProteinG: number | null;
  split: MacroSplit | null;
  consumed: NutritionTotals;
  /** Target minus consumed; negative when over. Null without a target. */
  remainingKcal: number | null;
  remainingCarbsG: number | null;
  remainingFatG: number | null;
  remainingProteinG: number | null;
}

/**
 * Builds a DailyStatus the way get_daily_status() does. Used by mock mode;
 * production reads the RPC.
 */
export function buildDailyStatus(
  date: string,
  rowsForDate: NutritionRow[],
  target: { kcal: number; split: MacroSplit } | null
): DailyStatus {
  const consumed = sumNutrition(rowsForDate.filter((r) => r.logged_date === date));
  if (!target) {
    return {
      date,
      targetKcal: null,
      targetCarbsG: null,
      targetFatG: null,
      targetProteinG: null,
      split: null,
      consumed,
      remainingKcal: null,
      remainingCarbsG: null,
      remainingFatG: null,
      remainingProteinG: null,
    };
  }
  const grams = calculateMacroTargets(target.kcal, target.split);
  return {
    date,
    targetKcal: target.kcal,
    targetCarbsG: grams.carbsG,
    targetFatG: grams.fatG,
    targetProteinG: grams.proteinG,
    split: target.split,
    consumed,
    remainingKcal: target.kcal - consumed.calories,
    remainingCarbsG: grams.carbsG - consumed.carbsG,
    remainingFatG: grams.fatG - consumed.fatG,
    remainingProteinG: grams.proteinG - consumed.proteinG,
  };
}

/* ------------------------------------------------------------------------- */
/* Target band (dashboard bar and report chart)                              */
/* ------------------------------------------------------------------------- */

/** The "on target" band: ±10 % of the calorie target. */
export const TARGET_BAND = 0.1;

export function targetBand(targetKcal: number): { low: number; high: number } {
  return {
    low: Math.round(targetKcal * (1 - TARGET_BAND)),
    high: Math.round(targetKcal * (1 + TARGET_BAND)),
  };
}
