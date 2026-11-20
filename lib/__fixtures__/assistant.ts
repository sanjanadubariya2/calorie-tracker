// Backend-shaped assistant responses for tests.
import type { AssistantMessage, AssistantResponse, Conversation, FoodLogProposal, Turn } from "../assistant";

export const CONV: Conversation = {
  id: "c0000000-0000-0000-0000-000000000001", title: "How many calories have I consumed today?", message_count: 2,
  created_at: "2026-11-21T08:00:00Z", updated_at: "2026-11-21T08:00:05Z", expires_at: "2027-02-19T08:00:05Z",
};

export const STATUS_RESPONSE: AssistantResponse = {
  type: "nutrition_summary", message: "You've had 1,240 kcal today, 860 left.", sources: ["food_log"],
  daily_status: {
    date: "2026-11-21", has_targets: true, entries_logged: 3,
    calories_kcal: { consumed: 1240, target: 2100, remaining: 860 },
    protein_g: { consumed: 60, target: 105, remaining: 45 },
    carbs_g: { consumed: 150, target: 289, remaining: 139 },
    fat_g: { consumed: 40, target: 58, remaining: 18 },
  },
  history: null, targets: null,
};

export function proposal(overrides: Partial<FoodLogProposal> = {}): FoodLogProposal {
  return {
    id: "p0000000-0000-0000-0000-000000000001", status: "pending",
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), meal_type: "breakfast", logged_date: "2026-11-21",
    items: [{
      food_id: "f0000000-0000-0000-0000-0000000000e9", food_name: "Boiled egg", requested_name: "boiled egg",
      quantity: 2, unit: "piece", grams: 100, quantity_source: "user_stated", portion_is_estimate: true,
      portion_explanation: "2 x 1 piece (50 g)", nutrition: { calories: 155, protein_g: 12.6, carbs_g: 1.1, fat_g: 10.6 },
      nutrition_source: "indb", source_ref: "ASC056", warnings: [],
    }],
    totals: { calories: 155, protein_g: 12.6, carbs_g: 1.1, fat_g: 10.6 },
    requires_user_confirmation: true, food_log_ids: [], ...overrides,
  };
}

export const PROPOSAL_RESPONSE = (p: FoodLogProposal = proposal()): AssistantResponse => ({
  type: "proposed_action", message: "Here's 2 boiled eggs for breakfast. Tap Confirm to log it.", sources: ["catalogue"],
  action: { kind: "log_food", requires_user_confirmation: true, proposal: p },
});

let seq = 0;
export function msg(role: "user" | "assistant", content: string, response: AssistantResponse | null = null,
                    clientId: string | null = null): AssistantMessage {
  seq += 1;
  return { id: `m-${seq}`, seq, role, content, response, outcome: role === "assistant" ? "complete" : null,
           client_message_id: clientId, created_at: "2026-11-21T08:00:00Z" };
}

export function turn(userText: string, clientId: string, response: AssistantResponse, conv: Conversation = CONV): Turn {
  return { conversation: conv, user_message: msg("user", userText, null, clientId),
           assistant_message: msg("assistant", response.message, response) };
}
