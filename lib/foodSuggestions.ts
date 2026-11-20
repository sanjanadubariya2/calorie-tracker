import type { FoodLog } from "./types";
import type { NutrientsPer100g } from "./nutrition";

// One previously-logged food, collapsed across all the times it was logged.
// Re-logging one of these copies its nutrition straight into a new entry, so
// a usual breakfast goes in without a search.
export interface LoggedFoodSuggestion {
  key: string;
  foodName: string;
  calories: number;
  carbsG: number;
  fatG: number;
  proteinG: number;
  servingG: number | null;
  isQuickAdd: boolean;
  timesLogged: number;
  /** Provenance of the original log, copied onto the re-log. */
  sourceRef: string | null;
  nutrientsPer100g: NutrientsPer100g | null;
}

// Same food name logged at two different portions is genuinely two different
// suggestions, so the identity includes the calorie count.
function suggestionKey(log: FoodLog): string {
  return `${log.food_name.toLowerCase()}|${Math.round(log.calories)}`;
}

function toSuggestion(log: FoodLog, timesLogged: number): LoggedFoodSuggestion {
  return {
    key: suggestionKey(log),
    foodName: log.food_name,
    calories: log.calories,
    carbsG: log.carbs_g,
    fatG: log.fat_g,
    proteinG: log.protein_g,
    servingG: log.serving_g,
    isQuickAdd: log.is_quick_add,
    timesLogged,
    sourceRef: log.source_ref ?? null,
    nutrientsPer100g: log.nutrients_per_100g ?? null,
  };
}

/**
 * Splits logs into the two quick-pick lists.
 * `logs` must already be newest-first, which is how `getRecentFoodLogs` returns them.
 */
export function deriveFoodSuggestions(
  logs: FoodLog[],
  limit = 12
): { recent: LoggedFoodSuggestion[]; frequent: LoggedFoodSuggestion[] } {
  const counts = new Map<string, number>();
  for (const log of logs) {
    const key = suggestionKey(log);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const seen = new Set<string>();
  const recent: LoggedFoodSuggestion[] = [];
  for (const log of logs) {
    const key = suggestionKey(log);
    if (seen.has(key)) continue;
    seen.add(key);
    recent.push(toSuggestion(log, counts.get(key) ?? 1));
  }

  // Frequent is the same set re-sorted; ties keep recency order because sort
  // is stable and `recent` is already newest-first.
  const frequent = [...recent]
    .filter((s) => s.timesLogged > 1)
    .sort((a, b) => b.timesLogged - a.timesLogged);

  return { recent: recent.slice(0, limit), frequent: frequent.slice(0, limit) };
}
