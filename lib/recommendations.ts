// Client for the meal recommendation API (backend Phase 3). Every number shown
// comes from these responses: nutrition is priced by the database, scores by
// the backend's deterministic engine. Nothing here computes nutrition.

import { BACKEND_ENABLED, BackendError, UnauthorizedError, backendRequest } from "./backend";
import type { FoodLogProposal } from "./assistant";

export type RecMealType = "breakfast" | "lunch" | "dinner" | "snack";
export type RecKind = "recipe" | "combo" | "meal" | "food";
export type RecStatus = "ok" | "partial" | "empty_catalogue" | "insufficient_data" | "excluded_by_constraints" | "no_fit";
export type FeedbackAction = "viewed" | "selected" | "rejected" | "planned" | "saved" | "unsaved" | "not_interested" | "never";

export interface RecPortion {
  kind: "food" | "recipe";
  id: string;
  name: string;
  servings: number;
  serving_label: string;
  grams: number | null;
  slot: string | null;
  min_servings: number;
  max_servings: number;
}

export interface RecIngredient {
  part: number;
  name: string;
  quantity: number | null;
  unit: string | null;
  grams: number | null;
  preparation: string | null;
  optional: boolean;
}

export interface RecNutrition {
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

/** An optional template component this user may add (filtered on its own). */
export interface RecOptional {
  id: string;
  name: string;
  slot: string | null;
  servings: number;
  serving_label: string;
  grams: number | null;
  nutrition: RecNutrition;
  diet_classes: string[];
  diet_status: "reviewed" | "inferred" | "unknown";
  allergens_detected: string[];
  allergen_status: "reviewed" | "inferred" | "unknown";
  quality_flags: string[];
}

export interface Recommendation {
  id: string | null;
  key: string;
  rank: number;
  kind: RecKind;
  name: string;
  variant: string | null;
  description: string | null;
  total_minutes: number | null;
  equipment: string[] | null;
  image_url: null;
  portions: RecPortion[];
  ingredients: RecIngredient[];
  /** The base meal (required components only). */
  nutrition: RecNutrition;
  optional_components: RecOptional[];
  optional_withheld: { name: string; reason: string; label: string }[];
  nutrition_with_optional: RecNutrition | null;
  score: {
    total: number;
    fit: "strong" | "good" | "fair";
    components: Record<string, number>;
    weights: Record<string, number>;
    adjustments: Record<string, number>;
    diversity_penalty: number;
  };
  reasons: string[];
  warnings: string[];
  data: {
    source: string;
    verification: string;
    approximate: boolean;
    diet_classes: string[];
    diet_status: "reviewed" | "inferred" | "unknown";
    allergens_detected: string[];
    allergen_status: "reviewed" | "inferred" | "unknown";
    quality_flags: string[];
    /** Meal templates: "provisional" = not individually verified by a person. */
    approval_level?: "provisional" | "verified" | null;
  };
}

export interface RecommendationList {
  set_id: string | null;
  engine_version: string;
  status: RecStatus;
  local_date: string;
  budget: {
    meal_type: RecMealType;
    kcal: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    basis: "targets" | "assumed";
    mode: "planned" | "capped" | "light" | "requested";
    remaining_kcal: number | null;
    tolerance: string;
  };
  items: Recommendation[];
  considered: number;
  excluded: { reason: string; label: string; count: number }[];
  notes: string[];
}

export interface RecommendationDetail {
  id: string;
  set_id: string;
  meal_type: RecMealType;
  local_date: string;
  created_at: string;
  available: true;
  recommended_servings: number[];
  item: Recommendation;
  instructions: string[][];
  saved: boolean;
  selected_optional: string[];
  /** Base meal + selected optional components, priced by the database. */
  total_nutrition: RecNutrition;
}

export interface SavedFeedback {
  id: string;
  feedback: "never" | "less_often" | "liked" | "saved";
  kind: "food" | "meal" | "recipe";
  target_id: string;
  name: string | null;
  item_id: string | null;
  created_at: string;
  expires_at: string | null;
}

export interface RecommendationQuery {
  meal_type: RecMealType;
  count?: number;
  mode?: "meals" | "foods" | "both";
  protein?: "normal" | "high";
  max_kcal?: number;
  cuisine?: string;
  exclude?: string[];
}

export type RecErrorKind = "auth" | "network" | "not_found" | "gone" | "invalid" | "unavailable" | "server";

export class RecommendationError extends Error {
  constructor(message: string, readonly kind: RecErrorKind, readonly retryable: boolean) {
    super(message);
    this.name = "RecommendationError";
  }
}

export function toRecommendationError(error: unknown): RecommendationError {
  if (error instanceof RecommendationError) return error;
  if (error instanceof UnauthorizedError) return new RecommendationError("Your session has expired. Sign in again.", "auth", false);
  if (error instanceof BackendError) {
    switch (error.status) {
      case 404: return new RecommendationError("This recommendation isn't available.", "not_found", false);
      case 410: return new RecommendationError("This meal is no longer available.", "gone", false);
      case 422: return new RecommendationError(error.message || "That request wasn't valid.", "invalid", false);
      case 503: return new RecommendationError("Recommendations aren't available right now. Try again shortly.", "unavailable", true);
      default: return new RecommendationError("Something went wrong. Try again.", "server", true);
    }
  }
  return new RecommendationError("Couldn't reach the server. Check your connection and try again.", "network", true);
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toRecommendationError(error);
  }
}

export function recommendationsAvailable(): boolean {
  return BACKEND_ENABLED;
}

/** Fills fields a slightly older backend may not send, so a version mismatch
 *  degrades (no add-ons shown) instead of crashing the screen. */
export function normalizeItem(item: Recommendation): Recommendation {
  return {
    ...item,
    optional_components: item.optional_components ?? [],
    optional_withheld: item.optional_withheld ?? [],
    nutrition_with_optional: item.nutrition_with_optional ?? null,
    ingredients: item.ingredients ?? [],
    reasons: item.reasons ?? [],
    warnings: item.warnings ?? [],
  };
}

function normalizeList(list: RecommendationList): RecommendationList {
  return { ...list, items: (list.items ?? []).map(normalizeItem), notes: list.notes ?? [], excluded: list.excluded ?? [] };
}

function normalizeDetail(d: RecommendationDetail): RecommendationDetail {
  if (!d?.item) return d;
  const item = normalizeItem(d.item);
  return { ...d, item, instructions: d.instructions ?? [], selected_optional: d.selected_optional ?? [],
           total_nutrition: d.total_nutrition ?? item.nutrition };
}

export const listRecommendations = (q: RecommendationQuery) =>
  call(async () => normalizeList(await backendRequest<RecommendationList>("/v1/me/recommendations", {
    query: {
      meal_type: q.meal_type,
      count: String(q.count ?? 5),
      mode: q.mode ?? "both",
      protein: q.protein ?? "normal",
      max_kcal: q.max_kcal === undefined ? undefined : String(q.max_kcal),
      cuisine: q.cuisine,
      exclude: q.exclude && q.exclude.length ? q.exclude : undefined,
    },
  })));

export const getRecommendation = (id: string, servings?: number[], optional?: string[]) =>
  call(async () => normalizeDetail(await backendRequest<RecommendationDetail>(`/v1/me/recommendations/${encodeURIComponent(id)}`, {
    query: { servings: servings?.map(String), optional: optional && optional.length ? optional : undefined },
  })));

export const sendFeedback = (id: string, action: FeedbackAction) =>
  call(() => backendRequest<{ recommendation_id: string; action: FeedbackAction; event_recorded: boolean; feedback: SavedFeedback | null }>(
    `/v1/me/recommendations/${encodeURIComponent(id)}/feedback`, { method: "POST", json: { action } }));

/** A pending proposal: nothing is logged until the user confirms it. */
export const prepareLog = (id: string, body: { servings?: number[]; optional?: string[]; meal_type?: string } = {}) =>
  call(() => backendRequest<FoodLogProposal>(`/v1/me/recommendations/${encodeURIComponent(id)}/log-proposal`, {
    method: "POST", json: body,
  }));

export const listFeedback = (feedback?: SavedFeedback["feedback"]) =>
  call(() => backendRequest<SavedFeedback[]>("/v1/me/recommendation-feedback", { query: { feedback } }));

export const deleteFeedback = (id: string) =>
  call(() => backendRequest<null>(`/v1/me/recommendation-feedback/${encodeURIComponent(id)}`, { method: "DELETE" }));
