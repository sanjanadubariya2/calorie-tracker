import {
  assistantPrompt,
  budgetText,
  defaultMealType,
  emptyTitle,
  minutesText,
  portionText,
  qualityBadges,
  servingsText,
  stepServings,
} from "../recommendationsView";
import { RECIPE, list, rec } from "../__fixtures__/recommendations";

describe("recommendation view helpers", () => {
  it("formats portions without inventing grams", () => {
    expect(portionText(rec("Dal").portions[0])).toBe("2 × katori (300 g)");
    expect(portionText({ ...RECIPE.portions[0], servings: 1 })).toBe("1 katori");
    expect(portionText(RECIPE.portions[0])).toBe("1.5 × katori");                // recipes: no grams
    expect(servingsText(rec("Thali", { portions: [
      { kind: "food", id: "a", name: "Roti", servings: 3, serving_label: "1 roti", grams: 108, slot: "bread", min_servings: 1, max_servings: 4 },
      { kind: "food", id: "b", name: "Dal", servings: 1, serving_label: "1 katori", grams: 150, slot: "main", min_servings: 0.5, max_servings: 2 },
    ] }))).toBe("3 × roti (108 g) + 1 katori (150 g)");
  });

  it("shows data-quality indicators and never claims unreviewed allergens are verified", () => {
    const labels = qualityBadges(RECIPE).map((b) => b.label);
    expect(labels).toEqual(["Unverified values", "Approximate", "Diet not reviewed", "May contain allergens"]);
    const reviewed = rec("X", { data: { ...rec("X").data, verification: "expert_reviewed", diet_status: "reviewed",
                                        allergen_status: "reviewed" } });
    expect(qualityBadges(reviewed).map((b) => b.label)).toEqual(["Expert reviewed"]);
    // Nothing detected but not reviewed: flagged, never shown as allergen-free.
    const noneDetected = rec("Y", { data: { ...rec("Y").data, allergens_detected: [], allergen_status: "inferred" } });
    expect(qualityBadges(noneDetected).map((b) => b.label)).toContain("Allergens not reviewed");
    // Provisionally approved meal templates are labelled; verified ones and dishes are not.
    const meal = (level: "provisional" | "verified" | null) =>
      qualityBadges(rec("Thali", { kind: "meal", data: { ...rec("Thali").data, approval_level: level } })).map((b) => b.label);
    expect(meal("provisional")).toContain("Provisional meal");
    expect(meal(null)).toContain("Provisional meal");
    expect(meal("verified")).not.toContain("Provisional meal");
    expect(qualityBadges(rec("Dal")).map((b) => b.label)).not.toContain("Provisional meal");
  });

  it("steps servings within the range the API accepts", () => {
    const countable = { ...rec("Roti").portions[0], min_servings: 1, max_servings: 4 };
    expect(stepServings(countable, 2, 1)).toBe(3);
    expect(stepServings(countable, 1, -1)).toBe(1);
    expect(stepServings(countable, 8, 1)).toBe(8);
    const divisible = rec("Dal").portions[0];
    expect(stepServings(divisible, 1, 1)).toBe(1.5);
    expect(stepServings(divisible, 0.5, -1)).toBe(0.5);
  });

  it("describes budgets, times and empty states", () => {
    expect(budgetText(list([]))).toBe("About 700 kcal for lunch");
    expect(budgetText(list([], { budget: { ...list([]).budget, kcal: 150, mode: "light" } }))).toBe("About 150 kcal for lunch (light options)");
    expect(minutesText(40)).toBe("40 min");
    expect(minutesText(90)).toBe("1 h 30 min");
    expect(minutesText(null)).toBeNull();
    expect(emptyTitle("insufficient_data")).toBe("Not enough checked information");
    expect(emptyTitle("excluded_by_constraints")).toBe("Nothing matches your preferences");
  });

  it("picks a meal for the time of day", () => {
    expect(defaultMealType(new Date(2026, 10, 21, 8))).toBe("breakfast");
    expect(defaultMealType(new Date(2026, 10, 21, 13))).toBe("lunch");
    expect(defaultMealType(new Date(2026, 10, 21, 17))).toBe("snack");
    expect(defaultMealType(new Date(2026, 10, 21, 20))).toBe("dinner");
  });

  it("builds the assistant prompt from the backend's numbers only", () => {
    expect(assistantPrompt(rec("Dal"), "lunch")).toBe(
      "Tell me about this lunch recommendation: Dal (2 × katori (300 g), 640 kcal, P 32 g, C 80 g, F 20 g). " +
      "Why does it fit my day, and what are good alternatives?");
  });
});
