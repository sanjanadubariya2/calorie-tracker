// Review state for AI-recognised meals: pure logic, no UI, no network.
//
// Every item is shown to the user and must be ready (a catalogue food, a
// portion in grams, catalogue nutrition) before anything can be saved. Saving
// goes through lib/api.ts addFoodLog, the same path as every other log, so the
// database takes the nutrition snapshot from the catalogue and updates the
// streak. Items already saved are remembered, so retrying after a partial
// failure never logs the same item twice.

import type { MealType } from "@/constants/theme";
import type { NewFoodLog } from "./types";
import { isValidSnapshot } from "./nutrition";
import type {
  ConfidenceLevel,
  FoodCandidate,
  FoodOption,
  MealProposal,
  ProposalItem,
  ProposalItemInput,
  RecognitionUnit,
} from "./recognition";

export interface ReviewItem {
  key: string;
  /** "ai": from recognition; "manual": added by the user on the review screen. */
  origin: "ai" | "manual";
  /** What is sent for grounding: the user's edits live here. */
  input: ProposalItemInput;
  grounded: ProposalItem | null;
  /** Catalogue options seen for this item, kept when the user picks one. */
  options: FoodOption[];
  /** The model's notes and what the user originally said/showed. */
  candidate: FoodCandidate | null;
  pending: boolean;
  error: string | null;
  savedLogId: string | null;
}

export interface ReviewState {
  items: ReviewItem[];
  mealType: MealType;
}

let counter = 0;
const nextKey = () => `item-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** Builds review items from a recognition response, pairing candidates with grounded items. */
export function itemsFromRecognition(candidates: FoodCandidate[], proposal: MealProposal): ReviewItem[] {
  return candidates.map((c, i) => {
    const grounded = proposal.items.find((p) => p.candidate_id === c.candidate_id) ?? proposal.items[i] ?? null;
    return {
      key: c.candidate_id || nextKey(),
      origin: "ai",
      input: {
        candidate_id: c.candidate_id,
        food_name: c.food_name,
        brand: c.brand,
        quantity: c.estimated_quantity,
        unit: c.quantity_unit,
        quantity_source: c.quantity_source,
        estimated_weight_g: c.estimated_weight_g,
        recognition_confidence: c.recognition_confidence,
        selected_food_id: null,
      },
      grounded,
      options: grounded?.match.options ?? [],
      candidate: c,
      pending: false,
      error: null,
      savedLogId: null,
    };
  });
}

export function newManualItem(foodName: string, quantity: number | null, unit: RecognitionUnit | null): ReviewItem {
  return {
    key: nextKey(),
    origin: "manual",
    input: {
      food_name: foodName.trim(),
      quantity,
      unit,
      quantity_source: quantity ? "manual" : "unspecified",
    },
    grounded: null,
    options: [],
    candidate: null,
    pending: true,
    error: null,
    savedLogId: null,
  };
}

export type ReviewAction =
  | { type: "reset"; items: ReviewItem[]; mealType: MealType }
  | { type: "add"; item: ReviewItem }
  | { type: "remove"; key: string }
  | { type: "setMeal"; mealType: MealType }
  | { type: "rename"; key: string; foodName: string }
  | { type: "selectFood"; key: string; foodId: string }
  | { type: "setPortion"; key: string; quantity: number; unit: RecognitionUnit }
  | { type: "groundStart"; key: string }
  | { type: "grounded"; key: string; item: ProposalItem }
  | { type: "groundFailed"; key: string; message: string }
  | { type: "saved"; key: string; logId: string };

function update(state: ReviewState, key: string, fn: (item: ReviewItem) => ReviewItem): ReviewState {
  return { ...state, items: state.items.map((it) => (it.key === key ? fn(it) : it)) };
}

/** Edits change the input and mark the item pending; the caller then re-grounds it. */
export function reviewReducer(state: ReviewState, action: ReviewAction): ReviewState {
  switch (action.type) {
    case "reset":
      return { items: action.items, mealType: action.mealType };
    case "add":
      return { ...state, items: [...state.items, action.item] };
    case "remove":
      // Saved items stay: they are already in the log.
      return { ...state, items: state.items.filter((it) => it.key !== action.key || it.savedLogId !== null) };
    case "setMeal":
      return { ...state, mealType: action.mealType };
    case "rename":
      return update(state, action.key, (it) => ({
        ...it,
        // A new name is a new search: forget the chosen food and its options.
        input: { ...it.input, food_name: action.foodName.trim(), selected_food_id: null },
        options: [],
        pending: true,
        error: null,
      }));
    case "selectFood":
      return update(state, action.key, (it) => ({
        ...it,
        input: { ...it.input, selected_food_id: action.foodId },
        pending: true,
        error: null,
      }));
    case "setPortion":
      return update(state, action.key, (it) => ({
        ...it,
        input: { ...it.input, quantity: action.quantity, unit: action.unit, quantity_source: "manual" },
        pending: true,
        error: null,
      }));
    case "groundStart":
      return update(state, action.key, (it) => ({ ...it, pending: true, error: null }));
    case "grounded":
      return update(state, action.key, (it) => {
        const item = action.item;
        return {
          ...it,
          grounded: item,
          // Keep earlier options visible after the user picks one of them.
          options: item.match.options.length ? item.match.options : it.options,
          pending: false,
          error: null,
        };
      });
    case "groundFailed":
      return update(state, action.key, (it) => ({ ...it, pending: false, error: action.message }));
    case "saved":
      return update(state, action.key, (it) => ({ ...it, savedLogId: action.logId }));
  }
}

export function isReady(item: ReviewItem): boolean {
  return (
    !item.pending &&
    item.error === null &&
    item.grounded?.status === "ready" &&
    item.grounded.match.selected !== null &&
    item.grounded.nutrition !== null &&
    item.grounded.portion.grams !== null
  );
}

export interface ReviewTotals {
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  isEstimate: boolean;
}

/** Sums the server-computed values of ready items. */
export function reviewTotals(items: ReviewItem[]): ReviewTotals {
  const totals: ReviewTotals = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, isEstimate: false };
  for (const it of items) {
    if (!isReady(it) || !it.grounded?.nutrition) continue;
    const n = it.grounded.nutrition;
    totals.calories += n.calories;
    totals.protein_g += n.protein_g;
    totals.carbs_g += n.carbs_g;
    totals.fat_g += n.fat_g;
    totals.isEstimate ||= it.grounded.portion.is_estimate;
  }
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return { ...totals, protein_g: r1(totals.protein_g), carbs_g: r1(totals.carbs_g), fat_g: r1(totals.fat_g) };
}

/** Saving needs at least one item and every unsaved item ready. */
export function canConfirm(state: ReviewState): boolean {
  const unsaved = state.items.filter((it) => it.savedLogId === null);
  return unsaved.length > 0 && unsaved.every(isReady);
}

export function hasLowConfidence(items: ReviewItem[]): boolean {
  return items.some(
    (it) => it.grounded?.confidence.recognition_level === "low" || it.grounded?.confidence.portion_level === "low"
  );
}

/** The log row for a confirmed item. The database recomputes nutrition from food_id. */
export function toFoodLog(item: ReviewItem, mealType: MealType, loggedDate: string): NewFoodLog {
  const g = item.grounded;
  if (!g || !isReady(item) || !g.match.selected || !g.nutrition || g.portion.grams === null) {
    throw new Error("Item isn't ready to log");
  }
  const snapshot = isValidSnapshot(g.nutrition.per_100g) ? g.nutrition.per_100g : null;
  const ai = item.origin === "ai";
  const confidence = item.input.recognition_confidence;
  return {
    logged_date: loggedDate,
    meal_type: mealType,
    food_name: g.match.selected.name,
    calories: g.nutrition.calories,
    carbs_g: g.nutrition.carbs_g,
    fat_g: g.nutrition.fat_g,
    protein_g: g.nutrition.protein_g,
    serving_g: g.portion.grams,
    is_quick_add: false,
    source: ai ? "ai_assisted" : "catalogue",
    source_ref: g.nutrition.source_ref,
    food_id: g.match.selected.food_id,
    nutrients_per_100g: snapshot,
    ai_confidence: ai && typeof confidence === "number" ? Math.round(confidence * 1000) / 1000 : null,
  };
}

export interface SaveOutcome {
  saved: { key: string; logId: string }[];
  failed: { key: string; message: string }[];
}

/**
 * Saves unsaved ready items one by one. Stops nothing on a failure: the rest
 * are still attempted, and the caller records which succeeded so a retry
 * saves only the remainder.
 */
export async function saveReviewItems(
  state: ReviewState,
  loggedDate: string,
  addLog: (log: NewFoodLog) => Promise<{ id: string }>
): Promise<SaveOutcome> {
  const outcome: SaveOutcome = { saved: [], failed: [] };
  for (const item of state.items) {
    if (item.savedLogId !== null) continue;
    try {
      const log = await addLog(toFoodLog(item, state.mealType, loggedDate));
      outcome.saved.push({ key: item.key, logId: log.id });
    } catch {
      outcome.failed.push({ key: item.key, message: "Couldn't save this item." });
    }
  }
  return outcome;
}

/* ------------------------------------------------------------------------- */
/* Display text                                                              */
/* ------------------------------------------------------------------------- */

const WARNING_TEXT: Record<string, string> = {
  choose_food: "Several foods match. Choose the closest one.",
  no_catalogue_match: "No match in the food database. Rename it or remove it.",
  portion_required: "Enter how much you had.",
  portion_needs_food: "Choose a food first to convert this amount.",
  portion_estimated: "The portion is an estimate from the photo or description.",
  serving_size_assumed: "No amount given: one standard serving assumed.",
  density_assumed: "Volume converted assuming water-like density.",
  generic_unit_conversion: "Converted with a typical household measure.",
  portion_out_of_range: "That amount looks too large. Check it.",
  nutrition_unavailable: "This food has no usable nutrition data. Choose another.",
  some_nutrients_missing: "Some nutrients aren't available for this food.",
  catalogue_data_inconsistent: "The database values for this food look inconsistent.",
  low_recognition_confidence: "The AI wasn't sure about this item. Check it.",
};

export function warningText(code: string): string {
  return WARNING_TEXT[code] ?? code.replace(/_/g, " ");
}

export function levelLabel(level: ConfidenceLevel | null | undefined): string {
  return level ? level[0].toUpperCase() + level.slice(1) : "Unknown";
}

export const MATCH_LABEL: Record<string, string> = {
  confident: "Strong match",
  ambiguous: "Several possible matches",
  no_match: "No match",
  user_selected: "Chosen by you",
};

const SOURCE_LABEL: Record<string, string> = {
  indb: "Indian Nutrient Databank",
  open_food_facts: "Open Food Facts",
  curated: "Curated",
  manual: "Manual entry",
  ai_verified: "Verified",
};

export function sourceLabel(source: string | undefined | null, ref?: string | null): string {
  const name = (source && SOURCE_LABEL[source]) || source || "Unknown source";
  return ref ? `${name} · ${ref}` : name;
}
