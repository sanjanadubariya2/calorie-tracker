// Shared nutrition rules. Fixtures match supabase/tests/005_* and 006_* so the
// client preview and the database compute identical numbers.
import {
  MAX_SERVING_G,
  averageOverLoggedDays,
  buildDailyStatus,
  isValidSnapshot,
  scaleNutrients,
  snapshotFromSearchResult,
  sumNutrition,
  targetBand,
  totalsByDate,
  type NutritionRow,
} from "../nutrition";
import type { FoodSearchResult } from "../types";

const BANANA_CHIPS = { kcal: 520, carbs_g: 58, fat_g: 30.04, protein_g: 2.3 };

function row(date: string, calories: number, extra: Partial<NutritionRow> = {}): NutritionRow {
  return { logged_date: date, meal_type: "lunch", calories, carbs_g: 0, fat_g: 0, protein_g: 0, ...extra };
}

describe("scaleNutrients (portion scaling, same as food_logs_apply_nutrition)", () => {
  it("37 g of banana chips: 192 kcal, 21.5 / 11.1 / 0.9 g", () => {
    expect(scaleNutrients(BANANA_CHIPS, 37)).toEqual({ calories: 192, carbsG: 21.5, fatG: 11.1, proteinG: 0.9 });
  });

  it("100 g returns the per-100 g values", () => {
    expect(scaleNutrients(BANANA_CHIPS, 100)).toEqual({ calories: 520, carbsG: 58, fatG: 30, proteinG: 2.3 });
  });

  it("computing from the snapshot never drifts (old rescale gave 519 for 37 g -> 100 g)", () => {
    const at37 = scaleNutrients(BANANA_CHIPS, 37);
    const oldRescale = Math.round(at37.calories * (100 / 37));
    expect(oldRescale).toBe(519);
    expect(scaleNutrients(BANANA_CHIPS, 100).calories).toBe(520);
  });

  it("rounds exact .5 boundaries away from zero, like Postgres", () => {
    expect(scaleNutrients({ kcal: 250, carbs_g: 5, fat_g: 15, protein_g: 1.5 }, 3)).toEqual({
      calories: 8,
      carbsG: 0.2,
      fatG: 0.5,
      proteinG: 0,
    });
  });

  it("treats zero, negative or non-numeric grams as zero", () => {
    for (const g of [0, -50, Number.NaN]) {
      expect(scaleNutrients(BANANA_CHIPS, g)).toEqual({ calories: 0, carbsG: 0, fatG: 0, proteinG: 0 });
    }
  });

  it("caps servings at the database limit", () => {
    expect(MAX_SERVING_G).toBe(5000);
  });
});

describe("snapshots", () => {
  const offResult: FoodSearchResult = {
    id: "8901234",
    name: "Banana chips",
    caloriesPer100g: 520,
    carbsPer100g: 58,
    fatPer100g: 30.04,
    proteinPer100g: 2.3,
    saturatedFatPer100g: 26,
    sodiumPer100g: 0.1,
  };

  it("captures the per-100 g values (and present label nutrients) from a search result", () => {
    expect(snapshotFromSearchResult(offResult)).toEqual({
      ...BANANA_CHIPS,
      saturated_fat_g: 26,
      sodium_g: 0.1,
    });
  });

  it("returns null for out-of-range crowd-sourced data, so the log still saves without one", () => {
    expect(snapshotFromSearchResult({ ...offResult, caloriesPer100g: 3500 })).toBeNull();
    expect(snapshotFromSearchResult({ ...offResult, fatPer100g: -1 })).toBeNull();
  });

  it("drops an out-of-range optional nutrient instead of the whole snapshot", () => {
    expect(snapshotFromSearchResult({ ...offResult, sugarsPer100g: 250 })).not.toHaveProperty("sugars_g");
  });

  it("validates like the database CHECK", () => {
    expect(isValidSnapshot(BANANA_CHIPS)).toBe(true);
    expect(isValidSnapshot({ ...BANANA_CHIPS, fiber_g: 3 })).toBe(true);
    expect(isValidSnapshot({ kcal: 100, carbs_g: 1, fat_g: 1 })).toBe(false); // missing protein
    expect(isValidSnapshot({ ...BANANA_CHIPS, kcal: 1001 })).toBe(false);
    expect(isValidSnapshot({ ...BANANA_CHIPS, carbs_g: -1 })).toBe(false);
    expect(isValidSnapshot({ ...BANANA_CHIPS, kcal: "100" })).toBe(false);
    expect(isValidSnapshot({ ...BANANA_CHIPS, vitamin_q: 3 })).toBe(false);
    expect(isValidSnapshot(null)).toBe(false);
    expect(isValidSnapshot([1, 2])).toBe(false);
  });
});

describe("aggregation", () => {
  it("no logs -> zeros", () => {
    expect(sumNutrition([])).toEqual({ calories: 0, carbsG: 0, fatG: 0, proteinG: 0, entryCount: 0 });
    expect(averageOverLoggedDays([])).toBe(0);
  });

  it("sums several logs", () => {
    expect(
      sumNutrition([
        row("2026-04-10", 300, { carbs_g: 50, fat_g: 6, protein_g: 10 }),
        row("2026-04-10", 650.5, { carbs_g: 90.2, fat_g: 15, protein_g: 22.3 }),
      ])
    ).toEqual({ calories: 950.5, carbsG: 140.2, fatG: 21, proteinG: 32.3, entryCount: 2 });
  });

  it("uses entry_count from aggregated get_daily_totals rows", () => {
    expect(sumNutrition([row("2026-04-10", 900, { entry_count: 3 })]).entryCount).toBe(3);
  });

  it("groups by date", () => {
    const byDate = totalsByDate([row("2026-04-09", 100), row("2026-04-10", 200), row("2026-04-10", 50)]);
    expect(byDate.get("2026-04-10")?.calories).toBe(250);
    expect(byDate.get("2026-04-09")?.entryCount).toBe(1);
    expect(byDate.has("2026-04-08")).toBe(false);
  });

  it("averages over days with at least one entry, including a 0-kcal day", () => {
    // Before Task 4 the dashboard skipped the 0-kcal day (avg 1500); SQL counted it (1000).
    const rows = [row("2026-04-08", 1000), row("2026-04-09", 2000), row("2026-04-10", 0)];
    expect(averageOverLoggedDays(rows)).toBe(1000);
  });

  it("ignores days with no entries", () => {
    expect(averageOverLoggedDays([row("2026-04-08", 1200), row("2026-04-10", 1800)])).toBe(1500);
  });
});

describe("buildDailyStatus (same as get_daily_status)", () => {
  const split = { carbPct: 50, fatPct: 30, proteinPct: 20 };

  it("no logs: zero consumption, remaining = target", () => {
    const s = buildDailyStatus("2026-04-10", [], { kcal: 1800, split });
    expect(s.consumed).toEqual({ calories: 0, carbsG: 0, fatG: 0, proteinG: 0, entryCount: 0 });
    expect([s.targetKcal, s.targetCarbsG, s.targetFatG, s.targetProteinG]).toEqual([1800, 225, 60, 90]);
    expect(s.remainingKcal).toBe(1800);
  });

  it("several logs: only that date counts; remaining = target - consumed", () => {
    const s = buildDailyStatus(
      "2026-04-10",
      [
        row("2026-04-10", 300, { carbs_g: 50, fat_g: 6, protein_g: 10 }),
        row("2026-04-10", 650.5, { carbs_g: 90.2, fat_g: 15, protein_g: 22.3 }),
        row("2026-04-09", 999, { carbs_g: 1, fat_g: 1, protein_g: 1 }),
      ],
      { kcal: 1800, split }
    );
    expect(s.consumed.calories).toBe(950.5);
    expect(s.remainingKcal).toBe(849.5);
    expect(s.remainingCarbsG).toBeCloseTo(84.8, 9);
    expect(s.remainingFatG).toBe(39);
    expect(s.remainingProteinG).toBeCloseTo(57.7, 9);
  });

  it("no profile: null targets but real consumption", () => {
    const s = buildDailyStatus("2026-04-10", [row("2026-04-10", 400)], null);
    expect(s.targetKcal).toBeNull();
    expect(s.remainingKcal).toBeNull();
    expect(s.consumed.calories).toBe(400);
  });

  it("remaining goes negative when over target", () => {
    expect(buildDailyStatus("2026-04-10", [row("2026-04-10", 2500)], { kcal: 2000, split }).remainingKcal).toBe(-500);
  });
});

describe("targetBand", () => {
  it("is ±10 % of the target", () => {
    expect(targetBand(2000)).toEqual({ low: 1800, high: 2200 });
  });
});
