// lib/recognitionReview.ts: review state, confirmation rules and saving.
import {
  canConfirm,
  hasLowConfidence,
  itemsFromRecognition,
  newManualItem,
  reviewReducer,
  reviewTotals,
  saveReviewItems,
  toFoodLog,
  warningText,
  type ReviewState,
} from "../recognitionReview";
import {
  DAL_MIXED,
  DAL_MIXED_ID,
  PANEER,
  ROTI,
  readyItem,
  thaliResponse,
} from "../__fixtures__/recognition";

function initial(): ReviewState {
  const { recognition, proposal } = thaliResponse();
  return { items: itemsFromRecognition(recognition.candidates, proposal), mealType: "lunch" };
}

it("pairs each candidate with its grounded item and keeps what the user said", () => {
  const s = initial();
  expect(s.items.map((i) => [i.key, i.grounded?.match.decision, i.input.quantity, i.input.unit, i.input.quantity_source])).toEqual([
    ["c1", "confident", 2, "piece", "user_stated"],
    ["c2", "ambiguous", 1, "bowl", "user_stated"],
    ["c3", "confident", 150, "g", "user_stated"],
  ]);
  expect(s.items[1].options.map((o) => o.name)).toEqual(["Moong dal", "Mixed dal"]);
});

it("can't be confirmed while an item is ambiguous", () => {
  const s = initial();
  expect(canConfirm(s)).toBe(false);
  // Only ready items count toward totals: roti 238 + paneer 390.
  expect(reviewTotals(s.items).calories).toBe(628);
});

it("replacing a match records the user's choice and keeps the options", () => {
  let s = reviewReducer(initial(), { type: "selectFood", key: "c2", foodId: DAL_MIXED_ID });
  expect(s.items[1].input.selected_food_id).toBe(DAL_MIXED_ID);
  expect(s.items[1].pending).toBe(true);
  s = reviewReducer(s, {
    type: "grounded", key: "c2",
    item: { ...readyItem("c2", DAL_MIXED, 180, 198), match: { decision: "user_selected", selected: DAL_MIXED, options: [] } },
  });
  expect(s.items[1].options.map((o) => o.name)).toEqual(["Moong dal", "Mixed dal"]);
  expect(canConfirm(s)).toBe(true);
  expect(reviewTotals(s.items).calories).toBe(238 + 198 + 390);
});

it("editing a portion marks it manual and pending until re-priced", () => {
  const s = reviewReducer(initial(), { type: "setPortion", key: "c1", quantity: 3, unit: "piece" });
  expect(s.items[0].input).toMatchObject({ quantity: 3, unit: "piece", quantity_source: "manual" });
  expect(s.items[0].pending).toBe(true);
  expect(canConfirm(s)).toBe(false); // never save numbers computed for the old portion
});

it("renaming starts a fresh search", () => {
  let s = reviewReducer(initial(), { type: "selectFood", key: "c2", foodId: DAL_MIXED_ID });
  s = reviewReducer(s, { type: "rename", key: "c2", foodName: "  sambar " });
  expect(s.items[1].input).toMatchObject({ food_name: "sambar", selected_food_id: null });
  expect(s.items[1].options).toEqual([]);
});

it("removing the ambiguous item allows confirming the rest", () => {
  const s = reviewReducer(initial(), { type: "remove", key: "c2" });
  expect(s.items.map((i) => i.key)).toEqual(["c1", "c3"]);
  expect(canConfirm(s)).toBe(true);
});

it("changes the meal type", () => {
  expect(reviewReducer(initial(), { type: "setMeal", mealType: "dinner" }).mealType).toBe("dinner");
});

it("an empty review can't be confirmed", () => {
  expect(canConfirm({ items: [], mealType: "lunch" })).toBe(false);
});

it("flags low confidence from recognition or portion", () => {
  const s = initial();
  expect(hasLowConfidence(s.items)).toBe(false);
  const low = reviewReducer(s, {
    type: "grounded", key: "c1",
    item: readyItem("c1", ROTI, 80, 238, { confidence: { recognition: 0.3, recognition_level: "low", match: 0.95, match_level: "confident", portion_level: "medium" } }),
  });
  expect(hasLowConfidence(low.items)).toBe(true);
});

it("builds the log with provenance; the catalogue food id drives the database snapshot", () => {
  const s = initial();
  const log = toFoodLog(s.items[0], "dinner", "2026-11-20");
  expect(log).toEqual({
    logged_date: "2026-11-20", meal_type: "dinner", food_name: "Chapati/Roti",
    calories: 238, carbs_g: 37, fat_g: 6, protein_g: 7.8, serving_g: 80, is_quick_add: false,
    source: "ai_assisted", source_ref: "ASC096", food_id: ROTI.food_id,
    nutrients_per_100g: { kcal: 297.4, carbs_g: 40, fat_g: 7, protein_g: 10 }, ai_confidence: 0.9,
  });
  expect(() => toFoodLog(s.items[1], "lunch", "2026-11-20")).toThrow("isn't ready");
});

it("manual items are logged as catalogue picks without an AI confidence", () => {
  let s = reviewReducer(initial(), { type: "add", item: { ...newManualItem("Paneer", 100, "g"), key: "m1" } });
  s = reviewReducer(s, { type: "grounded", key: "m1", item: readyItem(null, PANEER, 100, 260) });
  const log = toFoodLog(s.items[3], "lunch", "2026-11-20");
  expect(log.source).toBe("catalogue");
  expect(log.ai_confidence).toBeNull();
});

it("partial save failures are retried without duplicating saved items", async () => {
  let s = reviewReducer(initial(), { type: "remove", key: "c2" });
  const addLog = jest.fn()
    .mockResolvedValueOnce({ id: "log-1" })
    .mockRejectedValueOnce(new Error("network"));
  const first = await saveReviewItems(s, "2026-11-20", addLog);
  expect(first).toEqual({ saved: [{ key: "c1", logId: "log-1" }], failed: [{ key: "c3", message: "Couldn't save this item." }] });
  for (const saved of first.saved) s = reviewReducer(s, { type: "saved", key: saved.key, logId: saved.logId });

  // A saved item can't be removed from the review (it's in the log already).
  expect(reviewReducer(s, { type: "remove", key: "c1" }).items).toHaveLength(2);

  addLog.mockResolvedValueOnce({ id: "log-2" });
  const second = await saveReviewItems(s, "2026-11-20", addLog);
  expect(second.saved).toEqual([{ key: "c3", logId: "log-2" }]);
  expect(addLog).toHaveBeenCalledTimes(3);
  expect(addLog.mock.calls.map((c) => c[0].food_name)).toEqual(["Chapati/Roti", "Paneer bhurji", "Paneer bhurji"]);
});

it("explains warnings in plain words", () => {
  expect(warningText("choose_food")).toMatch(/Choose the closest/);
  expect(warningText("something_new")).toBe("something new");
});
