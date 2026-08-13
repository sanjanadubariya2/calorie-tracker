import AsyncStorage from "@react-native-async-storage/async-storage";
import { MEAL_SLOTS, type MealType } from "@/constants/theme";

// Which of the 6 meal slots the user wants to see on the Today screen and
// Log meal card — matches Samsung Health's "Meal types to show" setting.
// Local-only (AsyncStorage), independent of MOCK_MODE/Supabase.

const STORAGE_KEY = "calorie-tracker-visible-meal-types-v1";
const ALL_MEAL_TYPES = MEAL_SLOTS.map((s) => s.key);

export async function getVisibleMealTypes(): Promise<MealType[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return ALL_MEAL_TYPES;
    const parsed = JSON.parse(raw) as MealType[];
    return parsed.length > 0 ? parsed : ALL_MEAL_TYPES;
  } catch {
    return ALL_MEAL_TYPES;
  }
}

export async function setVisibleMealTypes(types: MealType[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(types));
}
