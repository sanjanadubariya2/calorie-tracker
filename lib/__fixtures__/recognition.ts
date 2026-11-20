// Shared fixtures for recognition tests: backend-shaped responses (no network).

import type {
  FoodCandidate,
  FoodOption,
  MealProposal,
  ProposalItem,
  RecognitionResponse,
} from "../recognition";

export const ROTI_ID = "f0000000-0000-0000-0000-000000000001";
export const DAL_MOONG_ID = "f0000000-0000-0000-0000-000000000002";
export const DAL_MIXED_ID = "f0000000-0000-0000-0000-000000000003";
export const PANEER_ID = "f0000000-0000-0000-0000-000000000004";

export function option(food_id: string, name: string, kcal: number, ref = "ASC001", match = 0.95): FoodOption {
  return {
    food_id, name, brand: null, source: "indb", source_ref: ref, match_confidence: match,
    per_100: { basis: "g", kcal, protein_g: 10, carbs_g: 40, fat_g: 7 },
    default_serving: { label: "1 piece", grams: 40 }, quality_flags: [],
  };
}

export const ROTI = option(ROTI_ID, "Chapati/Roti", 297.4, "ASC096");
export const DAL_MOONG = option(DAL_MOONG_ID, "Moong dal", 104, "ASC120", 0.8);
export const DAL_MIXED = option(DAL_MIXED_ID, "Mixed dal", 110, "ASC121", 0.79);
export const PANEER = option(PANEER_ID, "Paneer bhurji", 260, "ASC222");

export function candidate(id: string, name: string, overrides: Partial<FoodCandidate> = {}): FoodCandidate {
  return {
    candidate_id: id, food_name: name, original_description: name, brand: null, estimated_quantity: null,
    quantity_unit: null, quantity_source: "unspecified", estimated_weight_g: null, weight_is_estimate: true,
    visible_ingredients: [], preparation: null, meal_group: null, recognition_confidence: 0.9,
    confidence_level: "high", notes: [], requires_confirmation: true, ...overrides,
  };
}

export function readyItem(
  candidate_id: string | null,
  food: FoodOption,
  grams: number,
  kcal: number,
  overrides: Partial<ProposalItem> = {}
): ProposalItem {
  return {
    candidate_id, food_name: food.name, brand: null,
    match: { decision: "confident", selected: food, options: [food] },
    portion: { quantity: grams, unit: "g", grams, source: "user_stated", is_estimate: false, explanation: `${grams} g as stated` },
    nutrition: {
      per_100g: { kcal: food.per_100.kcal, carbs_g: 40, fat_g: 7, protein_g: 10 },
      calories: kcal, protein_g: 7.8, carbs_g: 37, fat_g: 6, missing_nutrients: [], source: "indb", source_ref: food.source_ref,
    },
    confidence: { recognition: 0.9, recognition_level: "high", match: 0.95, match_level: "confident", portion_level: "high" },
    warnings: [], status: "ready", ...overrides,
  };
}

export function ambiguousItem(candidate_id: string | null, name: string, options: FoodOption[]): ProposalItem {
  return {
    candidate_id, food_name: name, brand: null,
    match: { decision: "ambiguous", selected: null, options },
    portion: { quantity: 1, unit: "bowl", grams: null, source: "unresolved", is_estimate: true, explanation: "Choose a food first" },
    nutrition: null,
    confidence: { recognition: 0.7, recognition_level: "medium", match: 0.8, match_level: "ambiguous", portion_level: null },
    warnings: ["choose_food"], status: "needs_attention",
  };
}

export function proposal(items: ProposalItem[]): MealProposal {
  return {
    items,
    totals: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, items_counted: 0, is_estimate: false },
    can_confirm: items.every((i) => i.status === "ready") && items.length > 0,
    requires_confirmation: true,
  };
}

/** "two rotis, one bowl of dal and 150 g paneer": roti ready, dal ambiguous, paneer ready. */
export function thaliResponse(inputType: "text" | "image" = "text"): RecognitionResponse {
  const candidates = [
    candidate("c1", "Chapati", { original_description: "two rotis", estimated_quantity: 2, quantity_unit: "piece", quantity_source: "user_stated" }),
    candidate("c2", "Dal", { original_description: "one bowl of dal", estimated_quantity: 1, quantity_unit: "bowl", quantity_source: "user_stated", recognition_confidence: 0.7, confidence_level: "medium" }),
    candidate("c3", "Paneer sabzi", { original_description: "150g paneer sabzi", estimated_quantity: 150, quantity_unit: "g", quantity_source: "user_stated" }),
  ];
  return {
    recognition: {
      recognition_id: "r1", input_type: inputType, status: "recognized", input_quality: "clear", candidates,
      warnings: [], overall_notes: null, model: { provider: "gemini", model: "gemini-3.8-flash" },
    },
    proposal: proposal([
      readyItem("c1", ROTI, 80, 238),
      ambiguousItem("c2", "Dal", [DAL_MOONG, DAL_MIXED]),
      readyItem("c3", PANEER, 150, 390),
    ]),
  };
}
