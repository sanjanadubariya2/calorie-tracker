// The photo/text → review → confirm flow, with the backend and camera mocked.
import React from "react";
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { RecognitionTab } from "../RecognitionTab";
import * as recognition from "@/lib/recognition";
import * as picker from "@/lib/mealPhotoPicker";
import {
  DAL_MIXED,
  DAL_MIXED_ID,
  PANEER,
  ROTI,
  proposal,
  readyItem,
  thaliResponse,
} from "@/lib/__fixtures__/recognition";

jest.mock("@/lib/recognition", () => ({
  ...jest.requireActual("@/lib/recognition"),
  recognitionAvailable: jest.fn(() => true),
  recognizeText: jest.fn(),
  recognizePhoto: jest.fn(),
  groundItems: jest.fn(),
}));
jest.mock("@/lib/mealPhotoPicker", () => ({
  ...jest.requireActual("@/lib/mealPhotoPicker"),
  takeMealPhoto: jest.fn(),
  pickMealPhoto: jest.fn(),
}));

// The first test also pays for loading React Native and the screen modules.
jest.setTimeout(20_000);

const rec = recognition as jest.Mocked<typeof recognition>;
const pick = picker as jest.Mocked<typeof picker>;

interface Rendered {
  r: ReactTestRenderer;
  addLog: jest.Mock;
  onDone: jest.Mock;
  onManual: jest.Mock;
}

function render(addLog = jest.fn().mockImplementation(async () => ({ id: `log-${Math.random()}` }))): Rendered {
  const onDone = jest.fn();
  const onManual = jest.fn();
  let r!: ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(
      <RecognitionTab initialMeal="lunch" loggedDate="2026-11-20" addLog={addLog} onDone={onDone} onManual={onManual} />
    );
  });
  return { r, addLog, onDone, onManual };
}

const byId = (r: ReactTestRenderer, id: string): ReactTestInstance => {
  const found = r.root.findAll((n) => n.props.testID === id && typeof n.type !== "string");
  if (!found.length) throw new Error(`No element with testID ${id}`);
  return found[0];
};
const exists = (r: ReactTestRenderer, id: string) => r.root.findAll((n) => n.props.testID === id).length > 0;
const text = (r: ReactTestRenderer) => JSON.stringify(r.toJSON());
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const press = async (r: ReactTestRenderer, id: string) => {
  await act(async () => { byId(r, id).props.onPress(); });
  await flush();
};
const type = (r: ReactTestRenderer, id: string, value: string) => act(() => { byId(r, id).props.onChangeText(value); });

async function describeMeal(r: ReactTestRenderer, description = "two rotis, one bowl of dal and 150g paneer sabzi") {
  type(r, "describe-input", description);
  await press(r, "describe-submit");
}

beforeEach(() => {
  jest.clearAllMocks();
  rec.recognitionAvailable.mockReturnValue(true);
});

it("text → recognition → choose a match → confirm saves each item once", async () => {
  rec.recognizeText.mockResolvedValue(thaliResponse());
  rec.groundItems.mockResolvedValue(proposal([
    { ...readyItem("c2", DAL_MIXED, 180, 198), match: { decision: "user_selected", selected: DAL_MIXED, options: [] } },
  ]));
  const { r, addLog, onDone } = render();

  await describeMeal(r);
  expect(rec.recognizeText).toHaveBeenCalledWith("two rotis, one bowl of dal and 150g paneer sabzi");
  expect(exists(r, "review-item-c1") && exists(r, "review-item-c2") && exists(r, "review-item-c3")).toBe(true);
  expect(text(r)).toContain("Several foods match");
  expect(byId(r, "confirm-save").props.disabled).toBe(true); // dal is ambiguous
  expect(addLog).not.toHaveBeenCalled(); // nothing saved automatically

  await press(r, `option-${DAL_MIXED_ID}`);
  expect(rec.groundItems).toHaveBeenCalledWith([expect.objectContaining({ food_name: "Dal", selected_food_id: DAL_MIXED_ID })]);
  expect(byId(r, "confirm-save").props.disabled).toBe(false);
  expect(text(r)).toContain("826"); // 238 + 198 + 390 kcal

  await press(r, "confirm-save");
  expect(addLog).toHaveBeenCalledTimes(3);
  expect(addLog.mock.calls.map((c) => [c[0].food_id, c[0].serving_g, c[0].source, c[0].meal_type])).toEqual([
    [ROTI.food_id, 80, "ai_assisted", "lunch"],
    [DAL_MIXED_ID, 180, "ai_assisted", "lunch"],
    [PANEER.food_id, 150, "ai_assisted", "lunch"],
  ]);
  expect(onDone).toHaveBeenCalledTimes(1);
});

it("photo → upload progress → recognition → review", async () => {
  pick.takeMealPhoto.mockResolvedValue({ uri: "file:///meal.jpg", mimeType: "image/jpeg" });
  let finish!: (v: recognition.RecognitionResponse) => void;
  rec.recognizePhoto.mockImplementation((_uri, _mime, onProgress) => {
    onProgress?.({ stage: "uploading", fraction: 0.5 });
    return new Promise((resolve) => { finish = resolve; });
  });
  const { r } = render();

  await press(r, "take-photo");
  expect(rec.recognizePhoto).toHaveBeenCalledWith("file:///meal.jpg", "image/jpeg", expect.any(Function));
  expect(exists(r, "recognition-working")).toBe(true);
  expect(text(r)).toContain("Uploading photo");
  expect(text(r)).toContain("50");

  await act(async () => { finish(thaliResponse("image")); });
  await flush();
  expect(exists(r, "review-list")).toBe(true);
});

it("uploading from the library uses the picker", async () => {
  pick.pickMealPhoto.mockResolvedValue({ uri: "file:///p.png", mimeType: "image/png" });
  rec.recognizePhoto.mockResolvedValue(thaliResponse("image"));
  const { r } = render();
  await press(r, "upload-photo");
  expect(rec.recognizePhoto).toHaveBeenCalledWith("file:///p.png", "image/png", expect.any(Function));
});

it("a cancelled picker does nothing", async () => {
  pick.pickMealPhoto.mockResolvedValue(null);
  const { r } = render();
  await press(r, "upload-photo");
  expect(rec.recognizePhoto).not.toHaveBeenCalled();
  expect(exists(r, "describe-input")).toBe(true);
});

it("a denied camera permission explains itself and offers manual logging", async () => {
  pick.takeMealPhoto.mockRejectedValue(new picker.PhotoPermissionError("camera"));
  const { r, onManual } = render();
  await press(r, "take-photo");
  expect(text(r)).toContain("Camera access is off");
  await press(r, "manual-fallback");
  expect(onManual).toHaveBeenCalled();
});

it("editing a portion re-prices the item from the catalogue", async () => {
  rec.recognizeText.mockResolvedValue(thaliResponse());
  rec.groundItems.mockResolvedValue(proposal([
    { ...readyItem("c1", ROTI, 120, 357), portion: { quantity: 3, unit: "piece", grams: 120, source: "manual", is_estimate: true, explanation: "3 x 1 piece (40 g)" } },
  ]));
  const { r } = render();
  await describeMeal(r);

  const card = byId(r, "review-item-c1");
  const quantity = card.findAll((n) => n.props.testID === "item-quantity" && typeof n.type !== "string")[0];
  act(() => quantity.props.onChangeText("3"));
  await act(async () => { quantity.props.onEndEditing(); });
  await flush();

  expect(rec.groundItems).toHaveBeenCalledWith([
    expect.objectContaining({ food_name: "Chapati", quantity: 3, unit: "piece", quantity_source: "manual" }),
  ]);
  expect(text(r)).toContain("357");
});

it("changing units re-prices with the new unit", async () => {
  rec.recognizeText.mockResolvedValue(thaliResponse());
  rec.groundItems.mockResolvedValue(proposal([readyItem("c3", PANEER, 150, 390)]));
  const { r } = render();
  await describeMeal(r);
  const card = byId(r, "review-item-c3");
  const katori = card.findAll((n) => n.props.testID === "unit-katori" && typeof n.type !== "string")[0];
  await act(async () => { katori.props.onPress(); });
  await flush();
  expect(rec.groundItems).toHaveBeenCalledWith([expect.objectContaining({ quantity: 150, unit: "katori", quantity_source: "manual" })]);
});

it("removing items, changing the meal, and saving the rest", async () => {
  rec.recognizeText.mockResolvedValue(thaliResponse());
  const { r, addLog } = render();
  await describeMeal(r);

  const dal = byId(r, "review-item-c2");
  await act(async () => { dal.findAll((n) => n.props.testID === "item-remove" && typeof n.type !== "string")[0].props.onPress(); });
  expect(exists(r, "review-item-c2")).toBe(false);
  await press(r, "meal-dinner");
  await press(r, "confirm-save");

  expect(addLog).toHaveBeenCalledTimes(2);
  expect(addLog.mock.calls.every((c) => c[0].meal_type === "dinner")).toBe(true);
});

it("adds a food manually through the catalogue", async () => {
  rec.recognizeText.mockResolvedValue(thaliResponse());
  rec.groundItems.mockResolvedValue(proposal([readyItem(null, PANEER, 100, 260)]));
  const { r } = render();
  await describeMeal(r);
  type(r, "manual-name", "paneer");
  type(r, "manual-grams", "100");
  await press(r, "manual-add");
  expect(rec.groundItems).toHaveBeenCalledWith([{ food_name: "paneer", quantity: 100, unit: "g", quantity_source: "manual" }]);
  expect(text(r)).toContain("Added by you");
});

it("failed recognition shows the error and retries the same input", async () => {
  rec.recognizeText
    .mockRejectedValueOnce(new recognition.RecognitionError("Recognition took too long. Please try again.", true))
    .mockResolvedValueOnce(thaliResponse());
  const { r } = render();
  await describeMeal(r, "idli sambar");
  expect(exists(r, "recognition-error")).toBe(true);
  expect(text(r)).toContain("took too long");

  await press(r, "recognition-retry");
  expect(rec.recognizeText).toHaveBeenCalledTimes(2);
  expect(rec.recognizeText).toHaveBeenLastCalledWith("idli sambar");
  expect(exists(r, "review-list")).toBe(true);
});

it("a non-retryable failure offers other input and manual logging, not retry", async () => {
  rec.recognizeText.mockRejectedValue(new recognition.RecognitionError("AI recognition isn't available right now.", false));
  const { r, onManual } = render();
  await describeMeal(r);
  expect(exists(r, "recognition-retry")).toBe(false);
  await press(r, "manual-fallback");
  expect(onManual).toHaveBeenCalled();
});

it("no food detected shows an empty state", async () => {
  const empty = thaliResponse("image");
  empty.recognition = { ...empty.recognition, status: "no_food_detected", candidates: [] };
  empty.proposal = proposal([]);
  rec.recognizeText.mockResolvedValue(empty);
  const { r } = render();
  await describeMeal(r, "my desk");
  expect(exists(r, "recognition-empty")).toBe(true);
  expect(text(r)).toContain("No food was found");
  await press(r, "recognition-start-over");
  expect(exists(r, "describe-input")).toBe(true);
});

it("warns about low-confidence items", async () => {
  const low = thaliResponse("image");
  low.proposal.items[0] = readyItem("c1", ROTI, 80, 238, {
    confidence: { recognition: 0.3, recognition_level: "low", match: 0.95, match_level: "confident", portion_level: "low" },
    warnings: ["low_recognition_confidence", "portion_estimated"],
  });
  rec.recognizeText.mockResolvedValue(low);
  const { r } = render();
  await describeMeal(r);
  expect(exists(r, "low-confidence-banner")).toBe(true);
  expect(text(r)).toContain("The AI wasn't sure about this item");
  expect(text(r)).toContain("Recognition: Low");
});

it("failed logging keeps the review and retries only unsaved items", async () => {
  rec.recognizeText.mockResolvedValue(thaliResponse());
  const addLog = jest.fn()
    .mockResolvedValueOnce({ id: "log-1" })
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce({ id: "log-2" });
  const { r, onDone } = render(addLog);
  await describeMeal(r);
  await act(async () => {
    byId(r, "review-item-c2").findAll((n) => n.props.testID === "item-remove" && typeof n.type !== "string")[0].props.onPress();
  });

  await press(r, "confirm-save");
  expect(byId(r, "save-error").props.children).toContain("Saved 1 of 2");
  expect(onDone).not.toHaveBeenCalled();
  expect(text(r)).toContain("Saved"); // the roti is marked saved

  await press(r, "confirm-save");
  expect(addLog).toHaveBeenCalledTimes(3);
  expect(addLog.mock.calls.map((c) => c[0].food_id)).toEqual([ROTI.food_id, PANEER.food_id, PANEER.food_id]);
  expect(onDone).toHaveBeenCalledTimes(1);
});

it("double-tapping confirm saves once", async () => {
  rec.recognizeText.mockResolvedValue(thaliResponse());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const addLog = jest.fn().mockImplementation(async () => { await gate; return { id: "log" }; });
  const { r, onDone } = render(addLog);
  await describeMeal(r);
  await act(async () => {
    byId(r, "review-item-c2").findAll((n) => n.props.testID === "item-remove" && typeof n.type !== "string")[0].props.onPress();
  });

  const confirm = byId(r, "confirm-save").props.onPress;
  await act(async () => { confirm(); confirm(); confirm(); });
  release();
  await flush();
  expect(addLog).toHaveBeenCalledTimes(2); // two items, once each
  expect(onDone).toHaveBeenCalledTimes(1);
});

it("double-submitting a description recognises once", async () => {
  let finish!: (v: recognition.RecognitionResponse) => void;
  rec.recognizeText.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const { r } = render();
  type(r, "describe-input", "poha");
  const submit = byId(r, "describe-submit").props.onPress;
  await act(async () => { submit(); submit(); });
  await act(async () => { finish(thaliResponse()); });
  expect(rec.recognizeText).toHaveBeenCalledTimes(1);
});

it("without a backend it only offers manual logging", async () => {
  rec.recognitionAvailable.mockReturnValue(false);
  const { r, onManual } = render();
  expect(text(r)).toContain("isn't available");
  expect(exists(r, "describe-input")).toBe(false);
  await press(r, "manual-fallback");
  expect(onManual).toHaveBeenCalled();
});

it("picking a unit with no amount means one of that unit", async () => {
  const response = thaliResponse("image");
  response.recognition.candidates[0] = { ...response.recognition.candidates[0], estimated_quantity: null, quantity_unit: null };
  rec.recognizeText.mockResolvedValue(response);
  rec.groundItems.mockResolvedValue(proposal([readyItem("c1", ROTI, 40, 119)]));
  const { r } = render();
  await describeMeal(r);
  const card = byId(r, "review-item-c1");
  const piece = card.findAll((n) => n.props.testID === "unit-piece" && typeof n.type !== "string")[0];
  await act(async () => { piece.props.onPress(); });
  await flush();
  expect(rec.groundItems).toHaveBeenCalledWith([expect.objectContaining({ quantity: 1, unit: "piece", quantity_source: "manual" })]);
});
