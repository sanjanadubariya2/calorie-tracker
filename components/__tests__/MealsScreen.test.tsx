// The Meals tab: loading, results, filters, feedback, alternatives, details, logging via proposals.
import React from "react";
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { router } from "expo-router";
import * as recs from "@/lib/recommendations";
import * as assistantApi from "@/lib/assistant";
import MealsScreen from "@/app/(tabs)/meals";
import { RECIPE, detail, list, proposalFor, rec } from "@/lib/__fixtures__/recommendations";

const mockCompose = jest.fn();
jest.mock("@/lib/assistant-context", () => ({ useAssistant: () => ({ available: true, compose: mockCompose }) }));
jest.mock("expo-router", () => ({ router: { push: jest.fn(), replace: jest.fn() } }));
jest.mock("@/lib/recognition", () => ({ groundItems: jest.fn() }));
jest.mock("@/lib/assistant", () => ({
  ...jest.requireActual("@/lib/assistant"),
  confirmProposal: jest.fn(),
  rejectProposal: jest.fn(),
}));
jest.mock("@/lib/recommendations", () => ({
  ...jest.requireActual("@/lib/recommendations"),
  recommendationsAvailable: jest.fn(() => true),
  listRecommendations: jest.fn(),
  getRecommendation: jest.fn(),
  sendFeedback: jest.fn(),
  prepareLog: jest.fn(),
}));

jest.setTimeout(20_000);
const m = recs as jest.Mocked<typeof recs>;
const a = assistantApi as jest.Mocked<typeof assistantApi>;
const { RecommendationError } = jest.requireActual("@/lib/recommendations") as typeof recs;

let r: ReactTestRenderer;
const all = (id: string) => r.root.findAll((n) => n.props.testID === id && typeof n.type !== "string");
const byId = (id: string): ReactTestInstance => {
  const found = all(id);
  if (!found.length) throw new Error(`No element with testID ${id}`);
  return found[0];
};
const exists = (id: string) => all(id).length > 0;
const text = (): string => {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === "object" && "children" in node) {
      const kids = (node as { children: unknown[] | null }).children ?? [];
      if ((node as { type?: string }).type === "Text") out.push(kids.flat(Infinity).filter((k) => typeof k === "string").join(""));
      else kids.forEach(walk);
    }
  };
  walk(r.toJSON());
  return out.join(" | ");
};
const flush = () => act(async () => { await new Promise((res) => setTimeout(res, 0)); });
const press = async (id: string) => { await act(async () => { byId(id).props.onPress(); }); await flush(); };

async function render() {
  await act(async () => { r = TestRenderer.create(<MealsScreen />); });
  await flush();
}

const DAL = rec("Dal makhani");
const RAJMA = rec("Rajma chawal", { nutrition: { kcal: 610, protein_g: 22, carbs_g: 95, fat_g: 12 } });

beforeEach(() => {
  jest.clearAllMocks();
  m.recommendationsAvailable.mockReturnValue(true);
  m.listRecommendations.mockResolvedValue(list([DAL, RAJMA]));
  m.sendFeedback.mockResolvedValue({ recommendation_id: "x", action: "viewed", event_recorded: true, feedback: null });
});

it("shows skeletons while loading, then cards with the backend's numbers", async () => {
  let resolve!: (v: recs.RecommendationList) => void;
  m.listRecommendations.mockReturnValueOnce(new Promise((res) => { resolve = res; }));
  await render();
  expect(exists("rec-skeleton-0")).toBe(true);
  await act(async () => resolve(list([DAL, RAJMA])));
  await flush();
  expect(exists("rec-skeleton-0")).toBe(false);
  expect(byId("meals-budget").props.children).toBe("About 700 kcal for lunch");
  const t = text();
  expect(t).toContain("Dal makhani");
  expect(t).toContain("640 kcal");
  expect(t).toContain("2 × katori (300 g)");
  expect(t).toContain("About 640 kcal for a 700 kcal lunch budget.");
  expect(t).toContain("May contain allergens");             // data-quality indicator
  expect(exists(`rec-badge-${DAL.key}-diet`)).toBe(true);
});

it("meal type, high protein and calorie limit refetch with those filters", async () => {
  await render();
  await press("meals-tab-dinner");
  await press("meals-high-protein");
  await press("meals-limit-500");
  const last = m.listRecommendations.mock.calls.at(-1)?.[0];
  expect(last).toMatchObject({ meal_type: "dinner", protein: "high", max_kcal: 500 });
});

it("empty results explain why, using the backend's notes", async () => {
  m.listRecommendations.mockResolvedValue(list([], {
    status: "insufficient_data",
    notes: ["No option has reviewed allergen information yet, so nothing can be recommended safely for your allergies."],
  }));
  await render();
  expect(exists("meals-empty")).toBe(true);
  expect(text()).toContain("Not enough checked information");
  expect(text()).toContain("nothing can be recommended safely");
});

it("errors can be retried", async () => {
  m.listRecommendations.mockRejectedValueOnce(new RecommendationError("Couldn't reach the server.", "network", true));
  await render();
  expect(exists("meals-error")).toBe(true);
  await press("meals-retry");
  expect(exists("meals-error")).toBe(false);
  expect(text()).toContain("Dal makhani");
});

it("save and not interested send feedback; not interested removes the card", async () => {
  await render();
  await press(`rec-save-${DAL.key}`);
  expect(m.sendFeedback).toHaveBeenCalledWith(DAL.id, "saved");
  expect(text()).toContain("★ Saved");
  await press(`rec-hide-${RAJMA.key}`);
  expect(m.sendFeedback).toHaveBeenCalledWith(RAJMA.id, "not_interested");
  expect(exists(`rec-card-${RAJMA.key}`)).toBe(false);
  expect(text()).toContain("less often");
});

it("alternatives exclude what is shown; refresh reloads", async () => {
  await render();
  await press("meals-alternatives");
  expect(m.listRecommendations.mock.calls.at(-1)?.[0].exclude).toEqual([DAL.key, RAJMA.key]);
  await press("meals-refresh");
  expect(m.listRecommendations.mock.calls.at(-1)?.[0].exclude).toBeUndefined();
});

it("sends a recommendation to the assistant without sending a message", async () => {
  await render();
  await press(`rec-ask-${DAL.key}`);
  expect(mockCompose).toHaveBeenCalledWith(expect.stringContaining("Dal makhani (2 × katori (300 g), 640 kcal"));
  expect(router.push).toHaveBeenCalledWith("/(tabs)/assistant");
});

it("details: ingredients, instructions, re-priced servings, and logging only after confirmation", async () => {
  m.listRecommendations.mockResolvedValue(list([RECIPE]));
  m.getRecommendation.mockImplementation(async (_id, servings) => {
    if (!servings) return detail(RECIPE);
    return detail({ ...RECIPE, portions: [{ ...RECIPE.portions[0], servings: servings[0] }],
                    nutrition: { kcal: 460, protein_g: 24, carbs_g: 60, fat_g: 14 } });
  });
  m.prepareLog.mockResolvedValue(proposalFor(RECIPE));
  a.confirmProposal.mockResolvedValue({ proposal: { ...proposalFor(RECIPE), status: "confirmed" }, food_logs: [] });
  await render();
  await press(`rec-details-${RECIPE.key}`);
  expect(m.getRecommendation).toHaveBeenCalledWith(RECIPE.id, undefined, undefined);
  expect(m.sendFeedback).toHaveBeenCalledWith(RECIPE.id, "viewed");
  let t = text();
  expect(t).toContain("Toor dal (raw) — 56.25 g");
  expect(t).toContain("1. Pressure-cook the dal.");
  expect(t).toContain("Needs: pressure cooker, stove");
  expect(t).toContain("Approximate");                          // data-quality indicator for estimated quantities

  await press("rec-more-0");                                   // 1.5 -> 2 servings, re-priced by the API
  expect(m.getRecommendation).toHaveBeenLastCalledWith(RECIPE.id, [2], []);
  expect(text()).toContain("460 kcal");

  await press("rec-detail-log");
  expect(m.prepareLog).toHaveBeenCalledWith(RECIPE.id, { servings: [2], optional: [] });
  expect(a.confirmProposal).not.toHaveBeenCalled();             // nothing logged yet
  expect(exists("proposal-prop-1")).toBe(true);
  await press("proposal-confirm");
  expect(a.confirmProposal).toHaveBeenCalledWith("prop-1", { meal_type: undefined, items: undefined });
  t = text();
  expect(t).toContain("Logged. It will show on your Today tab.");
});

it("an unavailable meal is reported, not shown", async () => {
  m.getRecommendation.mockRejectedValue(new RecommendationError("This meal is no longer available.", "gone", false));
  await render();
  await press(`rec-details-${DAL.key}`);
  expect(byId("rec-detail-error").props.children).toBe("This meal is no longer available.");
  expect(exists("rec-detail-log")).toBe(false);
});

it("says when recommendations are unavailable", async () => {
  m.recommendationsAvailable.mockReturnValue(false);
  await render();
  expect(exists("meals-unavailable")).toBe(true);
  expect(m.listRecommendations).not.toHaveBeenCalled();
});


it("optional add-ons are offered separately, re-priced when toggled, and logged only if chosen", async () => {
  const TEA = { id: "tea-1", name: "Hot tea", slot: "drink", servings: 1, serving_label: "1 tea cup", grams: 210,
                nutrition: { kcal: 34, protein_g: 1, carbs_g: 5, fat_g: 1 }, diet_classes: ["vegetarian"],
                diet_status: "inferred" as const, allergens_detected: ["milk"], allergen_status: "inferred" as const,
                quality_flags: ["density_assumed"] };
  const THALI = rec("Poha with tea", {
    key: "meal:t1", id: "id-thali", kind: "meal", optional_components: [TEA],
    optional_withheld: [{ name: "Boiled egg", reason: "diet_conflict", label: "Not suitable for your diet" }],
    nutrition: { kcal: 322, protein_g: 7, carbs_g: 38, fat_g: 15 },
    nutrition_with_optional: { kcal: 356, protein_g: 8, carbs_g: 43, fat_g: 16 },
  });
  m.listRecommendations.mockResolvedValue(list([THALI]));
  m.getRecommendation.mockImplementation(async (_id, _s, optional) => detail(THALI, {
    selected_optional: optional ?? [],
    total_nutrition: optional?.length ? { kcal: 356, protein_g: 8, carbs_g: 43, fat_g: 16 } : THALI.nutrition,
  }));
  m.prepareLog.mockResolvedValue(proposalFor(THALI));
  await render();
  expect(text()).toContain("Optional: Hot tea +34 kcal");
  expect(text()).toContain("322 kcal");                                  // the card shows the base meal
  await press(`rec-details-${THALI.key}`);
  let t = text();
  expect(t).toContain("Optional add-ons");
  expect(t).toContain("may contain milk");
  expect(t).toContain("allergens not reviewed");
  expect(t).toContain("volume-based estimate");
  expect(t).toContain("Not offered: Boiled egg (not suitable for your diet)");
  await press("rec-optional-tea-1");
  expect(m.getRecommendation).toHaveBeenLastCalledWith(THALI.id, [2], ["tea-1"]);
  t = text();
  expect(t).toContain("356 kcal");
  expect(t).toContain("Base meal 322 kcal + 1 add-on.");
  await press("rec-detail-log");
  expect(m.prepareLog).toHaveBeenCalledWith(THALI.id, { servings: [2], optional: ["tea-1"] });
});
