import type { Recommendation, RecommendationDetail, RecommendationList } from "../recommendations";
import type { FoodLogProposal } from "../assistant";

export function rec(name: string, over: Partial<Recommendation> = {}): Recommendation {
  const key = over.key ?? `food:${name.toLowerCase().replace(/\s+/g, "-")}`;
  return {
    id: `id-${key}`, key, rank: 1, kind: "food", name, variant: null, description: null, total_minutes: null,
    equipment: null, image_url: null,
    portions: [{ kind: "food", id: `fid-${name}`, name, servings: 2, serving_label: "1 katori", grams: 300, slot: null,
                 min_servings: 0.5, max_servings: 2 }],
    ingredients: [],
    nutrition: { kcal: 640, protein_g: 32, carbs_g: 80, fat_g: 20 },
    optional_components: [], optional_withheld: [], nutrition_with_optional: null,
    score: { total: 0.91, fit: "strong", components: { calories: 1 }, weights: { calories: 0.3 }, adjustments: {},
             diversity_penalty: 0 },
    reasons: ["About 640 kcal for a 700 kcal lunch budget.", "Usually eaten at lunch."],
    warnings: ["May contain milk (detected from names and ingredients; not a reviewed allergen list)."],
    data: { source: "indb", verification: "curated", approximate: false, diet_classes: ["vegetarian"],
            diet_status: "inferred", allergens_detected: ["milk"], allergen_status: "inferred", quality_flags: [] },
    ...over,
  };
}

export function list(items: Recommendation[], over: Partial<RecommendationList> = {}): RecommendationList {
  return {
    set_id: "set-1", engine_version: "rec-v2", status: "ok", local_date: "2026-11-21",
    budget: { meal_type: "lunch", kcal: 700, protein_g: 35, carbs_g: 88, fat_g: 23, basis: "targets", mode: "planned",
              remaining_kcal: 1800, tolerance: "standard" },
    items, considered: 40, excluded: [], notes: [], ...over,
  };
}

export const RECIPE = rec("Dal tadka", {
  key: "recipe:r1", id: "id-recipe", kind: "recipe", total_minutes: 40, equipment: ["pressure_cooker", "stove"],
  description: "Toor dal with a ghee tempering.",
  portions: [{ kind: "recipe", id: "r1", name: "Dal tadka", servings: 1.5, serving_label: "1 katori", grams: null,
               slot: null, min_servings: 0.5, max_servings: 2 }],
  ingredients: [{ part: 0, name: "Toor dal (raw)", quantity: 56.25, unit: "g", grams: 56.3, preparation: null, optional: false },
                { part: 0, name: "Ghee", quantity: 0.75, unit: "tbsp", grams: 9, preparation: null, optional: false }],
  data: { source: "curated", verification: "unverified", approximate: true, diet_classes: ["vegetarian"],
          diet_status: "inferred", allergens_detected: ["milk"], allergen_status: "inferred", quality_flags: [] },
});

export function detail(item: Recommendation, over: Partial<RecommendationDetail> = {}): RecommendationDetail {
  return {
    id: item.id as string, set_id: "set-1", meal_type: "lunch", local_date: "2026-11-21",
    created_at: "2026-11-21T08:00:00+00:00", available: true, recommended_servings: item.portions.map((p) => p.servings),
    item, instructions: item.kind === "recipe" ? [["Pressure-cook the dal.", "Temper with ghee."]] : [], saved: false,
    selected_optional: [], total_nutrition: item.nutrition,
    ...over,
  };
}

export function proposalFor(item: Recommendation): FoodLogProposal {
  return {
    id: "prop-1", status: "pending", expires_at: new Date(Date.now() + 600_000).toISOString(), meal_type: "lunch",
    logged_date: "2026-11-21",
    items: [{ food_id: null, food_name: item.name, requested_name: item.name, quantity: 1.5, unit: "serving", grams: null,
              quantity_source: "manual", portion_is_estimate: true, portion_explanation: "1.5 x 1 katori",
              nutrition: { calories: 345, protein_g: 18, carbs_g: 45, fat_g: 10.5 }, nutrition_source: "recipe",
              source_ref: null, warnings: [], recipe_id: "r1", recipe_servings: 1.5 }],
    totals: { calories: 345, protein_g: 18, carbs_g: 45, fat_g: 10.5 }, requires_user_confirmation: true, food_log_ids: [],
  };
}
