import type { MealType } from "@/constants/theme";

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
}

export interface UserStreak {
  id: string;
  user_id: string;
  current_streak: number;
  last_logged_date: string | null;
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
