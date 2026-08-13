import type { Gender, Goal } from "./types";

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

// Sedentary-to-lightly-active default multiplier. Kept simple on purpose —
// this app intentionally does not track activity/exercise.
const ACTIVITY_FACTOR = 1.375;

export function calculateTDEE(bmr: number): number {
  return bmr * ACTIVITY_FACTOR;
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

export function calculateDailyTarget(
  weightKg: number,
  heightCm: number,
  age: number,
  gender: Gender,
  goal: Goal
): number {
  const bmr = calculateBMR(weightKg, heightCm, age, gender);
  const tdee = calculateTDEE(bmr);
  return Math.round(applyGoalAdjustment(tdee, goal));
}

// Default macro split: 55% carb / 25% fat / 20% protein
export const MACRO_SPLIT = { carb: 0.55, fat: 0.25, protein: 0.2 };

export interface MacroTargetsGrams {
  carbsG: number;
  fatG: number;
  proteinG: number;
}

export function calculateMacroTargets(dailyTargetKcal: number): MacroTargetsGrams {
  return {
    carbsG: Math.round((dailyTargetKcal * MACRO_SPLIT.carb) / 4),
    fatG: Math.round((dailyTargetKcal * MACRO_SPLIT.fat) / 9),
    proteinG: Math.round((dailyTargetKcal * MACRO_SPLIT.protein) / 4),
  };
}

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
