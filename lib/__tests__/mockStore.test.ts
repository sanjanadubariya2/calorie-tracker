// Mock mode must follow the same rules as the database (migrations 005/006),
// so behaviour seen while developing offline matches production.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { todayISO, shiftDate } from "../dates";

type MockStore = typeof import("../mockStore");

async function freshStore(): Promise<MockStore> {
  await AsyncStorage.clear();
  let store!: MockStore;
  jest.isolateModules(() => {
    store = require("../mockStore");
  });
  return store;
}

const SNAPSHOT = { kcal: 520, carbs_g: 58, fat_g: 30.04, protein_g: 2.3 };

function log(overrides: Record<string, unknown> = {}) {
  return {
    logged_date: todayISO(),
    meal_type: "lunch" as const,
    food_name: "Banana chips",
    calories: 1,
    carbs_g: 1,
    fat_g: 1,
    protein_g: 1,
    serving_g: 37,
    is_quick_add: false,
    ...overrides,
  };
}

describe("mock food logs", () => {
  it("computes totals from the snapshot and keeps provenance", async () => {
    const store = await freshStore();
    const saved = await store.mockAddFoodLog(
      log({ source: "open_food_facts", source_ref: "8901234", nutrients_per_100g: SNAPSHOT })
    );
    expect(saved).toMatchObject({
      calories: 192,
      carbs_g: 21.5,
      fat_g: 11.1,
      protein_g: 0.9,
      source: "open_food_facts",
      source_ref: "8901234",
      nutrients_per_100g: SNAPSHOT,
    });
  });

  it("keeps the snapshot immutable and recomputes edits without drift", async () => {
    const store = await freshStore();
    const saved = await store.mockAddFoodLog(
      log({ source: "open_food_facts", source_ref: "8901234", nutrients_per_100g: SNAPSHOT })
    );
    const edited = await store.mockUpdateFoodLog(saved.id, {
      serving_g: 100,
      source: "manual",
      nutrients_per_100g: { kcal: 999, carbs_g: 1, fat_g: 1, protein_g: 1 },
    });
    expect(edited.calories).toBe(520);
    expect(edited.source).toBe("open_food_facts");
    expect(edited.nutrients_per_100g).toEqual(SNAPSHOT);
  });

  it("keeps client totals for quick add and tags it", async () => {
    const store = await freshStore();
    const saved = await store.mockAddFoodLog(
      log({ food_name: "Restaurant meal", calories: 650, carbs_g: 0, fat_g: 0, protein_g: 0, serving_g: null, is_quick_add: true })
    );
    expect(saved).toMatchObject({ calories: 650, source: "quick_add" });
  });

  it.each([
    ["negative macros", { carbs_g: -1, serving_g: null }],
    ["zero serving", { serving_g: 0 }],
    ["oversized serving", { serving_g: 6000 }],
    ["blank name", { food_name: "  ", serving_g: null }],
    ["invalid snapshot", { nutrients_per_100g: { kcal: 2000, carbs_g: 1, fat_g: 1, protein_g: 1 } }],
    ["future date", { logged_date: shiftDate(todayISO(), 3) }],
  ])("rejects %s with code 23514, like the database", async (_label, overrides) => {
    const store = await freshStore();
    await expect(store.mockAddFoodLog(log(overrides))).rejects.toMatchObject({ code: "23514" });
  });
});

describe("mock daily status and totals", () => {
  it("matches get_daily_status: target from the profile formula, sums for the date", async () => {
    const store = await freshStore();
    const before = await store.mockGetDailyStatus(todayISO());
    // Seed profile: female 58 kg/165 cm/22 y, lose, light -> 1343 kcal, 55/25/20.
    expect(before.targetKcal).toBe(1343);
    expect(before.split).toEqual({ carbPct: 55, fatPct: 25, proteinPct: 20 });

    await store.mockAddFoodLog(log({ nutrients_per_100g: SNAPSHOT, source: "open_food_facts" }));
    const after = await store.mockGetDailyStatus(todayISO());
    expect(after.consumed.calories - before.consumed.calories).toBe(192);
    expect(after.consumed.entryCount - before.consumed.entryCount).toBe(1);
    expect(after.remainingKcal).toBe(1343 - after.consumed.calories);
  });

  it("a day with no logs returns zeros", async () => {
    const store = await freshStore();
    const s = await store.mockGetDailyStatus("2020-01-01");
    expect(s.consumed).toEqual({ calories: 0, carbsG: 0, fatG: 0, proteinG: 0, entryCount: 0 });
  });

  it("mockGetDailyTotals groups by date and meal with entry counts", async () => {
    const store = await freshStore();
    const today = todayISO();
    await store.mockAddFoodLog(log({ meal_type: "dinner", serving_g: null, calories: 100 }));
    await store.mockAddFoodLog(log({ meal_type: "dinner", serving_g: null, calories: 50 }));
    const rows = await store.mockGetDailyTotals(today, today);
    const dinner = rows.find((r) => r.meal_type === "dinner");
    expect(dinner).toMatchObject({ logged_date: today, calories: 150, entry_count: 2 });
  });
});

describe("mock profile", () => {
  it("recomputes the target and ignores the value sent, like the database trigger", async () => {
    const store = await freshStore();
    const saved = await store.mockUpsertProfile({
      user_id: store.mockUserId,
      age: 30,
      height_cm: 180,
      weight_kg: 80,
      gender: "male",
      goal: "maintain",
      activity_level: "active",
      daily_target_kcal: 9999,
    });
    expect(saved.daily_target_kcal).toBe(3071);
  });

  it("rejects an invalid macro split", async () => {
    const store = await freshStore();
    await expect(
      store.mockUpsertProfile({
        user_id: store.mockUserId,
        age: 30,
        height_cm: 180,
        weight_kg: 80,
        gender: "male",
        goal: "maintain",
        daily_target_kcal: 0,
        macro_carb_pct: 60,
        macro_fat_pct: 25,
        macro_protein_pct: 20,
      })
    ).rejects.toMatchObject({ code: "23514" });
  });
});
