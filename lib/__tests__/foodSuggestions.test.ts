import { deriveFoodSuggestions } from "../foodSuggestions";
import type { FoodLog } from "../types";

let seq = 0;
function log(name: string, calories: number, overrides: Partial<FoodLog> = {}): FoodLog {
  seq += 1;
  return {
    id: `log-${seq}`,
    user_id: "u1",
    logged_date: "2026-11-20",
    meal_type: "breakfast",
    food_name: name,
    calories,
    carbs_g: 1,
    fat_g: 2,
    protein_g: 3,
    serving_g: 100,
    is_quick_add: false,
    ...overrides,
  };
}

describe("deriveFoodSuggestions", () => {
  it("returns empty lists for no logs", () => {
    expect(deriveFoodSuggestions([])).toEqual({ recent: [], frequent: [] });
  });

  it("collapses repeats into one recent entry, newest first", () => {
    // Input is newest-first, as getRecentFoodLogs returns it.
    const { recent } = deriveFoodSuggestions([
      log("Poha", 300),
      log("Oats", 250),
      log("Poha", 300),
    ]);
    expect(recent.map((s) => s.foodName)).toEqual(["Poha", "Oats"]);
    expect(recent[0].timesLogged).toBe(2);
  });

  it("matches names case-insensitively but keeps the most recent spelling", () => {
    const { recent } = deriveFoodSuggestions([log("poha", 300), log("Poha", 300)]);
    expect(recent).toHaveLength(1);
    expect(recent[0].foodName).toBe("poha");
    expect(recent[0].timesLogged).toBe(2);
  });

  it("treats the same food at a different portion as a separate suggestion", () => {
    const { recent } = deriveFoodSuggestions([log("Rice", 200), log("Rice", 400)]);
    expect(recent.map((s) => s.calories)).toEqual([200, 400]);
  });

  it("treats calories that round to the same kcal as the same portion", () => {
    const { recent } = deriveFoodSuggestions([log("Rice", 200.2), log("Rice", 199.8)]);
    expect(recent).toHaveLength(1);
  });

  it("frequent: only foods logged more than once, most-logged first, ties by recency", () => {
    const { frequent } = deriveFoodSuggestions([
      log("Tea", 50),
      log("Oats", 250),
      log("Tea", 50),
      log("Egg", 70),
      log("Oats", 250),
      log("Tea", 50),
    ]);
    expect(frequent.map((s) => [s.foodName, s.timesLogged])).toEqual([
      ["Tea", 3],
      ["Oats", 2],
    ]);
  });

  it("copies the nutrition of the most recent occurrence", () => {
    const { recent } = deriveFoodSuggestions([
      log("Quick", 300, { is_quick_add: true, serving_g: null, carbs_g: 0, fat_g: 0, protein_g: 0 }),
    ]);
    expect(recent[0]).toMatchObject({
      foodName: "Quick",
      calories: 300,
      servingG: null,
      isQuickAdd: true,
      carbsG: 0,
    });
  });

  it("carries provenance so a re-log is computed from the original snapshot", () => {
    const snapshot = { kcal: 520, carbs_g: 58, fat_g: 30.04, protein_g: 2.3 };
    const { recent } = deriveFoodSuggestions([
      log("Banana chips", 192, { source: "open_food_facts", source_ref: "8901234", nutrients_per_100g: snapshot }),
      log("Legacy", 100),
    ]);
    expect(recent[0]).toMatchObject({ sourceRef: "8901234", nutrientsPer100g: snapshot });
    expect(recent[1]).toMatchObject({ sourceRef: null, nutrientsPer100g: null });
  });

  it("respects the limit for both lists", () => {
    const logs = Array.from({ length: 30 }, (_, i) => log(`Food ${i}`, 100));
    const doubled = [...logs, ...logs];
    const { recent, frequent } = deriveFoodSuggestions(doubled, 5);
    expect(recent).toHaveLength(5);
    expect(frequent).toHaveLength(5);
  });
});
