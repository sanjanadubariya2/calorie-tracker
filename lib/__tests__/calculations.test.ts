import {
  ACTIVITY_LEVELS,
  DEFAULT_MACRO_SPLIT,
  MACRO_PRESETS,
  MIN_DAILY_TARGET_KCAL,
  activityFactor,
  applyGoalAdjustment,
  calculateActualMacroPercents,
  calculateBMR,
  calculateDailyTarget,
  calculateMacroTargets,
  calculateTDEE,
  macroSplitOf,
  roundHalfAwayFromZero,
  scaleNutrient,
  validateMacroSplit,
} from "../calculations";

describe("calculateBMR (Mifflin-St Jeor)", () => {
  it("uses +5 for men", () => {
    // 10*80 + 6.25*180 - 5*30 + 5
    expect(calculateBMR(80, 180, 30, "male")).toBe(1780);
  });

  it("uses -161 for women", () => {
    // 10*58 + 6.25*165 - 5*22 - 161
    expect(calculateBMR(58, 165, 22, "female")).toBeCloseTo(1340.25, 10);
  });

  it("differs by exactly 166 kcal between genders for the same body", () => {
    expect(calculateBMR(70, 170, 40, "male") - calculateBMR(70, 170, 40, "female")).toBe(166);
  });
});

describe("calculateTDEE / applyGoalAdjustment", () => {
  it("defaults to the light (1.375) factor existing users were created with", () => {
    expect(calculateTDEE(2000)).toBe(2750);
  });

  it.each([
    ["sedentary", 1.2, 2136],
    ["light", 1.375, 2447.5],
    ["moderate", 1.55, 2759],
    ["active", 1.725, 3070.5],
    ["very_active", 1.9, 3382],
  ] as const)("%s multiplies BMR by %d", (level, factor, tdee) => {
    expect(activityFactor(level)).toBe(factor);
    expect(calculateTDEE(1780, level)).toBeCloseTo(tdee, 9);
  });

  it("lists every activity level exactly once, in increasing order", () => {
    const factors = ACTIVITY_LEVELS.map((a) => a.factor);
    expect(factors).toEqual([...factors].sort((a, b) => a - b));
    expect(new Set(ACTIVITY_LEVELS.map((a) => a.value)).size).toBe(5);
  });

  it("subtracts 500 to lose, adds 300 to gain, keeps maintain", () => {
    expect(applyGoalAdjustment(2500, "lose")).toBe(2000);
    expect(applyGoalAdjustment(2500, "gain")).toBe(2800);
    expect(applyGoalAdjustment(2500, "maintain")).toBe(2500);
  });
});

describe("calculateDailyTarget", () => {
  it("chains BMR -> TDEE -> goal and rounds to a whole kcal", () => {
    // 1340.25 * 1.375 = 1842.84375; -500 = 1342.84375
    expect(calculateDailyTarget(58, 165, 22, "female", "lose")).toBe(1343);
    // 1780 * 1.375 = 2447.5 -> 2448 (Math.round rounds .5 up)
    expect(calculateDailyTarget(80, 180, 30, "male", "maintain")).toBe(2448);
  });

  it("always returns an integer", () => {
    expect(Number.isInteger(calculateDailyTarget(63.3, 171.7, 37, "female", "gain"))).toBe(true);
  });

  // Same fixtures as supabase/tests/005_nutrition_targets.test.sql (compute_daily_target).
  it.each([
    ["sedentary", "maintain", 2136],
    ["light", "maintain", 2448],
    ["moderate", "maintain", 2759],
    ["active", "maintain", 3071],
    ["very_active", "maintain", 3382],
    ["light", "lose", 1948],
    ["light", "gain", 2748],
  ] as const)("male 80 kg/180 cm/30 y, %s, %s -> %d (matches SQL)", (activity, goal, expected) => {
    expect(calculateDailyTarget(80, 180, 30, "male", goal, activity)).toBe(expected);
  });

  it("never goes below the 1200 kcal floor", () => {
    // 926.5 * 1.2 - 500 = 611.8
    expect(calculateDailyTarget(45, 150, 60, "female", "lose", "sedentary")).toBe(MIN_DAILY_TARGET_KCAL);
    expect(MIN_DAILY_TARGET_KCAL).toBe(1200);
  });
});

describe("calculateMacroTargets", () => {
  it("splits 55/25/20 by calories, using 4/9/4 kcal per gram", () => {
    expect(calculateMacroTargets(2000)).toEqual({ carbsG: 275, fatG: 56, proteinG: 100 });
  });

  it("returns zeros for a zero target", () => {
    expect(calculateMacroTargets(0)).toEqual({ carbsG: 0, fatG: 0, proteinG: 0 });
  });

  it("keeps the documented default split", () => {
    expect(DEFAULT_MACRO_SPLIT).toEqual({ carbPct: 55, fatPct: 25, proteinPct: 20 });
  });

  it("uses a custom split (matches SQL macro_targets)", () => {
    expect(calculateMacroTargets(2000, { carbPct: 40, fatPct: 30, proteinPct: 30 })).toEqual({
      carbsG: 200,
      fatG: 67,
      proteinG: 150,
    });
    expect(calculateMacroTargets(1800, { carbPct: 50, fatPct: 30, proteinPct: 20 })).toEqual({
      carbsG: 225,
      fatG: 60,
      proteinG: 90,
    });
  });
});

describe("validateMacroSplit", () => {
  it("accepts the defaults and every preset", () => {
    expect(validateMacroSplit(DEFAULT_MACRO_SPLIT)).toBeNull();
    for (const p of MACRO_PRESETS) expect(validateMacroSplit(p.split)).toBeNull();
  });

  it.each([
    [{ carbPct: 60, fatPct: 25, proteinPct: 20 }, "add up to 100"],
    [{ carbPct: 50, fatPct: 25, proteinPct: 20 }, "add up to 100"],
    [{ carbPct: 75, fatPct: 5, proteinPct: 20 }, "between 10% and 70%"],
    [{ carbPct: -10, fatPct: 60, proteinPct: 50 }, "between 10% and 70%"],
    [{ carbPct: 55.5, fatPct: 24.5, proteinPct: 20 }, "whole numbers"],
  ])("rejects %j", (split, message) => {
    expect(validateMacroSplit(split)).toContain(message);
  });
});

describe("macroSplitOf", () => {
  it("reads the profile's split", () => {
    expect(macroSplitOf({ macro_carb_pct: 40, macro_fat_pct: 30, macro_protein_pct: 30 })).toEqual({
      carbPct: 40,
      fatPct: 30,
      proteinPct: 30,
    });
  });
  it("falls back to the default for profiles that predate migration 005", () => {
    expect(macroSplitOf({})).toEqual(DEFAULT_MACRO_SPLIT);
    expect(macroSplitOf(null)).toEqual(DEFAULT_MACRO_SPLIT);
  });
});

describe("roundHalfAwayFromZero (matches Postgres round on numeric)", () => {
  it.each([
    [2447.5, 0, 2448],
    [7.5, 0, 8],
    [0.15, 1, 0.2],
    [0.45, 1, 0.5],
    [0.045, 1, 0],
    [1.005, 2, 1.01],
    [-2.5, 0, -3],
    [192.4, 0, 192],
    [11.1148, 1, 11.1],
  ])("round(%d, %d) = %d", (value, dp, expected) => {
    expect(roundHalfAwayFromZero(value, dp)).toBe(expected);
  });

  it("strips float noise before rounding", () => {
    expect(roundHalfAwayFromZero(0.1 + 0.05, 1)).toBe(0.2); // 0.15000000000000002
    expect(roundHalfAwayFromZero((1.5 * 3) / 100, 2)).toBe(0.05); // 0.045 -> 0.05 at 2 dp
  });
});

describe("calculateActualMacroPercents", () => {
  it("weights grams by calories before taking percentages", () => {
    // 50g carb = 200, 10g fat = 90, 25g protein = 100 -> total 390
    expect(calculateActualMacroPercents(50, 10, 25)).toEqual({ carbPct: 51, fatPct: 23, proteinPct: 26 });
  });

  it("returns zeros instead of NaN when nothing was eaten", () => {
    expect(calculateActualMacroPercents(0, 0, 0)).toEqual({ carbPct: 0, fatPct: 0, proteinPct: 0 });
  });

  it("gives 100% to a single macro", () => {
    expect(calculateActualMacroPercents(0, 20, 0)).toEqual({ carbPct: 0, fatPct: 100, proteinPct: 0 });
  });
});

describe("scaleNutrient", () => {
  it("scales a per-100g value linearly by grams", () => {
    expect(scaleNutrient(250, 100)).toBe(250);
    expect(scaleNutrient(250, 40)).toBe(100);
    expect(scaleNutrient(12.5, 250)).toBeCloseTo(31.25, 10);
    expect(scaleNutrient(250, 0)).toBe(0);
  });
});
