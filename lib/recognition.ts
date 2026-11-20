// AI food recognition (backend: /v1/recognitions/*, /v1/proposals/ground).
//
// The backend recognises foods (photo or text), matches them to the food
// catalogue and computes nutrition from catalogue data. The model never
// supplies calories or macros. Nothing here saves anything: logs are written
// only after the user confirms on the review screen (lib/recognitionReview.ts).

import { BACKEND_ENABLED, BackendError, UnauthorizedError, backendRequest } from "./backend";
import { MealImageError, uploadMealImage } from "./mealImages";

export const RECOGNITION_UNITS = [
  "g", "kg", "ml", "l", "piece", "bowl", "katori", "cup", "glass", "plate", "slice", "tablespoon", "teaspoon", "serving",
] as const;
export type RecognitionUnit = (typeof RECOGNITION_UNITS)[number];
export type ConfidenceLevel = "high" | "medium" | "low";
export type QuantitySource = "user_stated" | "model_estimate" | "unspecified" | "manual";

/** Matches the backend's RECOGNITION_MAX_TEXT_CHARS default. */
export const MAX_DESCRIPTION_CHARS = 1000;

export interface FoodCandidate {
  candidate_id: string;
  food_name: string;
  original_description: string;
  brand: string | null;
  estimated_quantity: number | null;
  quantity_unit: RecognitionUnit | null;
  quantity_source: "user_stated" | "model_estimate" | "unspecified";
  estimated_weight_g: number | null;
  weight_is_estimate: boolean;
  visible_ingredients: string[];
  preparation: string | null;
  meal_group: string | null;
  recognition_confidence: number;
  confidence_level: ConfidenceLevel;
  notes: string[];
  requires_confirmation: true;
}

export interface RecognitionResult {
  recognition_id: string;
  input_type: "image" | "text";
  status: "recognized" | "no_food_detected" | "unclear_input";
  input_quality: string;
  candidates: FoodCandidate[];
  warnings: string[];
  overall_notes: string | null;
  model: { provider: string; model: string };
}

export interface ProposalItemInput {
  candidate_id?: string | null;
  food_name: string;
  brand?: string | null;
  quantity?: number | null;
  unit?: RecognitionUnit | null;
  quantity_source?: QuantitySource;
  estimated_weight_g?: number | null;
  recognition_confidence?: number | null;
  selected_food_id?: string | null;
}

export interface FoodOption {
  food_id: string;
  name: string;
  brand: string | null;
  source: string;
  source_ref: string | null;
  match_confidence: number | null;
  per_100: { basis: "g" | "ml"; kcal: number; protein_g: number; carbs_g: number; fat_g: number };
  default_serving: { label: string; grams: number } | null;
  quality_flags: string[];
}

export type MatchDecision = "confident" | "ambiguous" | "no_match" | "user_selected";

export interface ProposalItem {
  candidate_id: string | null;
  food_name: string;
  brand: string | null;
  match: { decision: MatchDecision; selected: FoodOption | null; options: FoodOption[] };
  portion: {
    quantity: number | null;
    unit: RecognitionUnit | null;
    grams: number | null;
    source: "user_stated" | "model_estimate" | "catalogue_serving" | "generic_conversion" | "manual" | "unresolved";
    is_estimate: boolean;
    explanation: string;
  };
  nutrition: {
    per_100g: Record<string, number>;
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    missing_nutrients: string[];
    source: string;
    source_ref: string | null;
  } | null;
  confidence: {
    recognition: number | null;
    recognition_level: ConfidenceLevel | null;
    match: number | null;
    match_level: MatchDecision;
    portion_level: ConfidenceLevel | null;
  };
  warnings: string[];
  status: "ready" | "needs_attention";
}

export interface MealProposal {
  items: ProposalItem[];
  totals: { calories: number; protein_g: number; carbs_g: number; fat_g: number; items_counted: number; is_estimate: boolean };
  can_confirm: boolean;
  requires_confirmation: true;
}

export interface RecognitionResponse {
  recognition: RecognitionResult;
  proposal: MealProposal;
}

/** A failure the screen can show as-is. `retryable` false = retrying the same input won't help. */
export class RecognitionError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "RecognitionError";
  }
}

export function recognitionAvailable(): boolean {
  return BACKEND_ENABLED;
}

function toRecognitionError(error: unknown): RecognitionError {
  if (error instanceof RecognitionError) return error;
  if (error instanceof MealImageError) return new RecognitionError(error.message, false);
  if (error instanceof UnauthorizedError) return new RecognitionError(error.message, false);
  if (error instanceof BackendError) {
    // The backend's messages for these are written for people (routes/recognition.py).
    switch (error.status) {
      case 404:
        return new RecognitionError("That photo is no longer available. Take or choose it again.", false);
      case 422:
        return new RecognitionError(error.message, false);
      case 429:
        return new RecognitionError(error.message || "Too many requests. Try again in a while.", true);
      case 503:
        return new RecognitionError("AI recognition isn't available right now. You can still log manually.", false);
      default:
        return new RecognitionError(error.message || "Something went wrong. Please try again.", true);
    }
  }
  return new RecognitionError("Couldn't reach the server. Check your connection and try again.", true);
}

// The backend allows the AI provider RECOGNITION_TIMEOUT_SECONDS (60 s) per
// attempt with one retry, plus catalogue grounding: wait a little longer than that.
const RECOGNITION_TIMEOUT_MS = 150_000;

export async function recognizeText(text: string): Promise<RecognitionResponse> {
  const trimmed = text.trim();
  if (!trimmed) throw new RecognitionError("Describe what you ate.", false);
  if (trimmed.length > MAX_DESCRIPTION_CHARS) {
    throw new RecognitionError(`Keep the description under ${MAX_DESCRIPTION_CHARS} characters.`, false);
  }
  try {
    return await backendRequest<RecognitionResponse>("/v1/recognitions/text", {
      method: "POST",
      json: { text: trimmed },
      timeoutMs: RECOGNITION_TIMEOUT_MS,
    });
  } catch (error) {
    throw toRecognitionError(error);
  }
}

export interface PhotoProgress {
  stage: "uploading" | "recognizing";
  /** Upload fraction 0..1 while uploading, when the platform reports it. */
  fraction: number | null;
}

/** Uploads a photo (validated + metadata-stripped by the backend), then recognises it. */
export async function recognizePhoto(
  uri: string,
  mimeType: string,
  onProgress: (progress: PhotoProgress) => void = () => {}
): Promise<RecognitionResponse> {
  try {
    onProgress({ stage: "uploading", fraction: null });
    const image = await uploadMealImage(uri, mimeType, (fraction) => onProgress({ stage: "uploading", fraction }));
    onProgress({ stage: "recognizing", fraction: null });
    return await backendRequest<RecognitionResponse>("/v1/recognitions/image", {
      method: "POST",
      json: { image_id: image.id },
      timeoutMs: RECOGNITION_TIMEOUT_MS,
    });
  } catch (error) {
    throw toRecognitionError(error);
  }
}

/** Re-prices items after edits. Deterministic on the server (no AI call). */
export async function groundItems(items: ProposalItemInput[]): Promise<MealProposal> {
  try {
    return await backendRequest<MealProposal>("/v1/proposals/ground", { method: "POST", json: { items } });
  } catch (error) {
    throw toRecognitionError(error);
  }
}
