import type { Gender, Goal } from "./types";

// Nutrition targets.
//
// The database is authoritative: profiles.daily_target_kcal is computed by a
// trigger (supabase/migrations/005_nutrition_targets.sql) and per-day targets
// come from get_daily_status(). The functions here mirror that SQL exactly so
// onboarding can preview the result before saving, and so mock mode behaves
// the same. Keep the constants below in step with the migration.

/* ------------------------------------------------------------------------- */
/* Rounding                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Rounds half away from zero to `decimals` places, matching Postgres round()
 * on numeric. Float noise is stripped first (0.15000000000000002 -> 0.15) so
 * exact .5 boundaries round the same way as in the database.
 */
export function roundHalfAwayFromZero(value: number, decimals = 0): number {
  if (!Number.isFinite(value)) return value;
  const clean = Number(value.toPrecision(12));
  const sign = clean < 0 ? -1 : 1;
  const abs = Math.abs(clean);
  const text = String(abs);
  if (text.includes("e")) {
    const factor = 10 ** decimals;
    return (sign * Math.round(abs * factor)) / factor;
  }
  const shifted = Math.round(Number(`${text}e${decimals}`));
  return sign * Number(`${shifted}e-${decimals}`) || 0;
}

/* ------------------------------------------------------------------------- */
/* Activity level                                                            */
/* ------------------------------------------------------------------------- */

export type ActivityLevel = "sedentary" | "light" | "moderate" | "active" | "very_active";

export const ACTIVITY_LEVELS: {
  value: ActivityLevel;
  label: string;
  description: string;
  factor: number;
}[] = [
  { value: "sedentary", label: "Sedentary", description: "Little or no exercise", factor: 1.2 },
  { value: "light", label: "Lightly active", description: "Light exercise 1–3 days a week", factor: 1.375 },
  { value: "moderate", label: "Moderately active", description: "Exercise 3–5 days a week", factor: 1.55 },
  { value: "active", label: "Very active", description: "Hard exercise 6–7 days a week", factor: 1.725 },
  { value: "very_active", label: "Extra active", description: "Physical job or training twice a day", factor: 1.9 },
];

/** Existing users were created with the old fixed 1.375 factor. */
export const DEFAULT_ACTIVITY_LEVEL: ActivityLevel = "light";

export function activityFactor(level: ActivityLevel): number {
  return ACTIVITY_LEVELS.find((a) => a.value === level)?.factor ?? 1.375;
}

/* ------------------------------------------------------------------------- */
/* Calorie target                                                            */
/* ------------------------------------------------------------------------- */

/** No computed target goes below this (compute_daily_target in 005). */
export const MIN_DAILY_TARGET_KCAL = 1200;

/** Shown only when a user has no profile yet. */
export const DEFAULT_TARGET_KCAL = 2000;

/**
 * Mifflin-St Jeor BMR:
 *   Men:   10*weight(kg) + 6.25*height(cm) - 5*age + 5
 *   Women: 10*weight(kg) + 6.25*height(cm) - 5*age - 161
 */
export function calculateBMR(
  weightKg: number,
  heightCm: number,
  age: number,
  gender: Gender
): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return gender === "male" ? base + 5 : base - 161;
}

export function calculateTDEE(bmr: number, activity: ActivityLevel = DEFAULT_ACTIVITY_LEVEL): number {
  return bmr * activityFactor(activity);
}

export function applyGoalAdjustment(tdee: number, goal: Goal): number {
  switch (goal) {
    case "lose":
      return tdee - 500;
    case "gain":
      return tdee + 300;
    case "maintain":
    default:
      return tdee;
  }
}

/** Same result as the database's compute_daily_target(). */
export function calculateDailyTarget(
  weightKg: number,
  heightCm: number,
  age: number,
  gender: Gender,
  goal: Goal,
  activity: ActivityLevel = DEFAULT_ACTIVITY_LEVEL
): number {
  const bmr = calculateBMR(weightKg, heightCm, age, gender);
  const adjusted = applyGoalAdjustment(calculateTDEE(bmr, activity), goal);
  return Math.max(MIN_DAILY_TARGET_KCAL, roundHalfAwayFromZero(adjusted));
}

/* ------------------------------------------------------------------------- */
/* Macro split                                                               */
/* ------------------------------------------------------------------------- */

/** Percent of calories from each macro. Always sums to 100. */
export interface MacroSplit {
  carbPct: number;
  fatPct: number;
  proteinPct: number;
}

export const DEFAULT_MACRO_SPLIT: MacroSplit = { carbPct: 55, fatPct: 25, proteinPct: 20 };

/** Bounds enforced by profiles_macro_split_valid. */
export const MACRO_PCT_MIN = 10;
export const MACRO_PCT_MAX = 70;

export const MACRO_PRESETS: { key: string; label: string; split: MacroSplit }[] = [
  { key: "balanced", label: "Balanced 55/25/20", split: DEFAULT_MACRO_SPLIT },
  { key: "higher_protein", label: "Higher protein 40/30/30", split: { carbPct: 40, fatPct: 30, proteinPct: 30 } },
  { key: "lower_carb", label: "Lower carb 30/40/30", split: { carbPct: 30, fatPct: 40, proteinPct: 30 } },
];

/** Null if valid, otherwise a message. Mirrors the database CHECK. */
export function validateMacroSplit(split: MacroSplit): string | null {
  const values = [split.carbPct, split.fatPct, split.proteinPct];
  if (values.some((v) => !Number.isInteger(v))) return "Macro percentages must be whole numbers.";
  if (values.some((v) => v < MACRO_PCT_MIN || v > MACRO_PCT_MAX)) {
    return `Each macro must be between ${MACRO_PCT_MIN}% and ${MACRO_PCT_MAX}% of calories.`;
  }
  if (values.reduce((a, b) => a + b, 0) !== 100) return "Macro percentages must add up to 100%.";
  return null;
}

/** A profile's split, falling back to the default for rows that predate migration 005. */
export function macroSplitOf(profile: {
  macro_carb_pct?: number | null;
  macro_fat_pct?: number | null;
  macro_protein_pct?: number | null;
} | null | undefined): MacroSplit {
  if (
    profile?.macro_carb_pct == null ||
    profile.macro_fat_pct == null ||
    profile.macro_protein_pct == null
  ) {
    return DEFAULT_MACRO_SPLIT;
  }
  return {
    carbPct: profile.macro_carb_pct,
    fatPct: profile.macro_fat_pct,
    proteinPct: profile.macro_protein_pct,
  };
}

export interface MacroTargetsGrams {
  carbsG: number;
  fatG: number;
  proteinG: number;
}

/** Same result as the database's macro_targets(). */
export function calculateMacroTargets(
  dailyTargetKcal: number,
  split: MacroSplit = DEFAULT_MACRO_SPLIT
): MacroTargetsGrams {
  return {
    carbsG: roundHalfAwayFromZero((dailyTargetKcal * split.carbPct) / 100 / 4),
    fatG: roundHalfAwayFromZero((dailyTargetKcal * split.fatPct) / 100 / 9),
    proteinG: roundHalfAwayFromZero((dailyTargetKcal * split.proteinPct) / 100 / 4),
  };
}

/* ------------------------------------------------------------------------- */
/* Actuals and scaling                                                       */
/* ------------------------------------------------------------------------- */

export interface MacroActualPercents {
  carbPct: number;
  fatPct: number;
  proteinPct: number;
}

// Actual macro split for the day, as percent of total macro grams'
// calorie contribution — matches the "Actual" row on the nutrition card.
export function calculateActualMacroPercents(
  carbsG: number,
  fatG: number,
  proteinG: number
): MacroActualPercents {
  const carbKcal = carbsG * 4;
  const fatKcal = fatG * 9;
  const proteinKcal = proteinG * 4;
  const total = carbKcal + fatKcal + proteinKcal;

  if (total <= 0) {
    return { carbPct: 0, fatPct: 0, proteinPct: 0 };
  }

  return {
    carbPct: Math.round((carbKcal / total) * 100),
    fatPct: Math.round((fatKcal / total) * 100),
    proteinPct: Math.round((proteinKcal / total) * 100),
  };
}

// Scales a per-100g nutrient value to a chosen serving size in grams.
export function scaleNutrient(per100g: number, servingGrams: number): number {
  return (per100g * servingGrams) / 100;
}
