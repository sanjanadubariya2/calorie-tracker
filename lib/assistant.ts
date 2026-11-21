// AI nutrition assistant client (backend: /v1/assistant/*).
//
// The assistant reads your data through backend tools and can only PROPOSE a
// food log; logging happens only when the user taps Confirm on a proposal
// (confirmProposal). Types mirror backend/app/assistant/{responses,proposals}.py.

import { BACKEND_ENABLED, BackendError, UnauthorizedError, backendRequest } from "./backend";
import { todayISO } from "./dates";

/* ------------------------------------------------------------------------- */
/* Response shapes                                                           */
/* ------------------------------------------------------------------------- */

export interface NutrientStatus {
  consumed: number;
  target: number | null;
  remaining: number | null;
}

export interface DailyStatusCard {
  date: string;
  has_targets: boolean;
  calories_kcal: NutrientStatus;
  protein_g: NutrientStatus;
  carbs_g: NutrientStatus;
  fat_g: NutrientStatus;
  entries_logged: number;
}

export interface HistoryPeriod {
  start: string;
  end: string;
  days: number;
  days_logged: number;
  entries: number;
  total_kcal: number;
  avg_kcal_per_logged_day: number | null;
  avg_protein_g: number | null;
  avg_carbs_g: number | null;
  avg_fat_g: number | null;
}

export interface HistoryCard {
  start_date: string;
  end_date: string;
  group_by: "day" | "week";
  periods: HistoryPeriod[];
  overall: {
    days_in_range: number;
    days_logged: number;
    avg_kcal_per_logged_day: number | null;
    avg_protein_g: number | null;
    avg_carbs_g: number | null;
    avg_fat_g: number | null;
    current_target_kcal: number | null;
    logged_days_within_10pct_of_target: number | null;
  };
  notes: string[];
}

export interface TargetsCard {
  has_targets: boolean;
  daily_targets: { calories_kcal: number; protein_g: number; carbs_g: number; fat_g: number } | null;
  goal: string | null;
}

export interface FoodResult {
  food_id: string;
  name: string;
  brand: string | null;
  category: string | null;
  source: string;
  source_ref: string | null;
  per_100: { basis: string; kcal: number; protein_g: number; carbs_g: number; fat_g: number };
  default_serving: { label: string; grams: number } | null;
  match: { confidence: number; match_type: string };
}

/** One recommend_meals result (the same engine and numbers as the Meals tab). */
export interface Recommendation {
  key: string;
  kind: "recipe" | "combo" | "meal" | "food";
  name: string;
  variant: string | null;
  food_id: string | null;
  portions: { name: string; servings: number; serving_label: string; grams: number | null }[];
  nutrition: { calories_kcal: number; protein_g: number; carbs_g: number; fat_g: number };
  total_minutes: number | null;
  score: number;
  fit: "strong" | "good" | "fair";
  reasons: string[];
  warnings: string[];
}

export interface RecommendationsCard {
  meal_type: string;
  status: string;
  meal_target: { calories_kcal: number; protein_g: number; carbs_g: number; fat_g: number; basis: string };
  recommendations: Recommendation[];
  excluded: { reason: string; label: string; count: number }[];
  notes: string[];
}

export type ProposalStatus = "pending" | "confirming" | "confirmed" | "rejected" | "expired";
export const MEAL_TYPES = ["breakfast", "lunch", "dinner", "morning_snack", "afternoon_snack", "evening_snack"] as const;
export type AssistantMealType = (typeof MEAL_TYPES)[number];

export interface ProposedFood {
  food_id: string | null;                 // null for a recipe
  food_name: string;
  requested_name: string;
  quantity: number | null;
  unit: string | null;
  grams: number | null;                   // null for a recipe (priced by servings)
  recipe_id?: string | null;
  recipe_servings?: number | null;
  quantity_source: string;
  portion_is_estimate: boolean;
  portion_explanation: string;
  nutrition: { calories: number; protein_g: number; carbs_g: number; fat_g: number };
  nutrition_source: string;
  source_ref: string | null;
  warnings: string[];
}

export interface FoodLogProposal {
  id: string;
  status: ProposalStatus;
  expires_at: string;
  meal_type: AssistantMealType;
  logged_date: string;
  items: ProposedFood[];
  totals: { calories: number; protein_g: number; carbs_g: number; fat_g: number };
  requires_user_confirmation: true;
  food_log_ids: string[];
}

export interface FoodIssue {
  requested_name: string;
  issue: string;
  question: string;
  options: { food_id: string; name: string; kcal_per_100: number; default_serving: string | null }[];
}

interface Base {
  message: string;
  sources: string[];
}

export type AssistantResponse =
  | (Base & { type: "text" })
  | (Base & { type: "nutrition_summary"; daily_status: DailyStatusCard | null; history: HistoryCard | null; targets: TargetsCard | null })
  | (Base & { type: "meal_recommendation"; recommendations: RecommendationsCard })
  | (Base & { type: "food_search_results"; search: { query: string; decision: string; results: FoodResult[] } })
  | (Base & { type: "proposed_action"; action: { kind: "log_food"; requires_user_confirmation: true; proposal: FoodLogProposal } })
  | (Base & { type: "clarification"; options: string[]; food_issues: FoodIssue[] })
  | (Base & { type: "error"; code: string; retryable: boolean });

export interface AssistantMessage {
  id: string;
  seq: number;
  role: "user" | "assistant";
  content: string;
  response: AssistantResponse | null;
  outcome: string | null;
  client_message_id: string | null;
  created_at: string;
}

export interface Conversation {
  id: string;
  title: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface Turn {
  conversation: Conversation;
  user_message: AssistantMessage;
  assistant_message: AssistantMessage;
}

export interface SavedLog {
  id: string;
  food_name: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  meal_type: string;
}

export interface ItemEdit {
  index: number;
  quantity?: number;
  unit?: string;
  remove?: boolean;
}

/* ------------------------------------------------------------------------- */
/* Errors                                                                    */
/* ------------------------------------------------------------------------- */

export type AssistantErrorKind = "auth" | "network" | "rate_limit" | "busy" | "unavailable" | "not_found" | "gone" | "conflict" | "invalid" | "server";

export class AssistantError extends Error {
  constructor(
    message: string,
    readonly kind: AssistantErrorKind,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "AssistantError";
  }
}

export function toAssistantError(error: unknown): AssistantError {
  if (error instanceof AssistantError) return error;
  if (error instanceof UnauthorizedError) return new AssistantError("Your session has expired. Sign in again.", "auth", false);
  if (error instanceof BackendError) {
    const m = error.message;
    switch (error.status) {
      case 404:
        return new AssistantError(m || "Not found.", "not_found", false);
      case 409:
        return new AssistantError(m || "That was already handled.", "conflict", false);
      case 410:
        return new AssistantError(m || "This has expired.", "gone", false);
      case 422:
        return new AssistantError(m || "That request wasn't valid.", "invalid", false);
      case 429:
        return new AssistantError(m || "Too many requests. Wait a moment.", "rate_limit", true);
      case 503:
        return new AssistantError("The assistant isn't available right now.", "unavailable", false);
      case 504:
        return new AssistantError(m || "The assistant took too long. Try again.", "busy", true);
      default:
        return new AssistantError(m || "Something went wrong. Try again.", "server", true);
    }
  }
  return new AssistantError("Couldn't reach the server. Check your connection and try again.", "network", true);
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toAssistantError(error);
  }
}

/* ------------------------------------------------------------------------- */
/* API                                                                       */
/* ------------------------------------------------------------------------- */

const TURN_TIMEOUT_MS = 120_000; // the backend caps a turn at 75 s

export function assistantAvailable(): boolean {
  return BACKEND_ENABLED;
}

/** A UUID v4 identifying one message across retries. */
export function newClientMessageId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  const variant = (8 + Math.floor(Math.random() * 4)).toString(16);
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}

export const listConversations = (before?: string, limit = 20) =>
  call(() => backendRequest<{ items: Conversation[]; next_before: string | null }>("/v1/assistant/conversations", {
    query: { limit: String(limit), before },
  }));

export const createConversation = () =>
  call(() => backendRequest<Conversation>("/v1/assistant/conversations", { method: "POST", json: {} }));

export const deleteConversation = (id: string) =>
  call(() => backendRequest<null>(`/v1/assistant/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }));

export const listMessages = (conversationId: string, beforeSeq?: number, limit = 30) =>
  call(() => backendRequest<{ items: AssistantMessage[]; next_before_seq: number | null }>(
    `/v1/assistant/conversations/${encodeURIComponent(conversationId)}/messages`,
    { query: { limit: String(limit), before_seq: beforeSeq === undefined ? undefined : String(beforeSeq) } }
  ));

/** Retrying with the same clientMessageId never creates a duplicate message. */
export const sendMessage = (conversationId: string, content: string, clientMessageId: string) =>
  call(() => backendRequest<Turn>(`/v1/assistant/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: "POST",
    json: { content, client_message_id: clientMessageId, local_date: todayISO() },
    timeoutMs: TURN_TIMEOUT_MS,
  }));

export const getProposal = (id: string) =>
  call(() => backendRequest<FoodLogProposal>(`/v1/assistant/proposals/${encodeURIComponent(id)}`));

export const confirmProposal =(id: string, edits: { meal_type?: string; items?: ItemEdit[] } = {}) =>
  call(() => backendRequest<{ proposal: FoodLogProposal; food_logs: SavedLog[] }>(
    `/v1/assistant/proposals/${encodeURIComponent(id)}/confirm`, { method: "POST", json: edits }
  ));

export const rejectProposal = (id: string) =>
  call(() => backendRequest<FoodLogProposal>(`/v1/assistant/proposals/${encodeURIComponent(id)}/reject`, { method: "POST", json: {} }));
