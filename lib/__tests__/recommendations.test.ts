// The recommendations client: request shapes and error mapping (backendRequest mocked).
import { BackendError, UnauthorizedError, backendRequest } from "../backend";
import {
  getRecommendation,
  listRecommendations,
  prepareLog,
  sendFeedback,
  toRecommendationError,
} from "../recommendations";

jest.mock("../backend", () => ({
  ...jest.requireActual("../backend"),
  BACKEND_ENABLED: true,
  backendRequest: jest.fn(),
}));
const request = backendRequest as jest.MockedFunction<typeof backendRequest>;

beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue({} as never);
});

it("sends validated filters and repeats exclude keys; never a user id", async () => {
  await listRecommendations({ meal_type: "dinner", protein: "high", max_kcal: 500, exclude: ["food:a", "recipe:b"] });
  const [path, options] = request.mock.calls[0];
  expect(path).toBe("/v1/me/recommendations");
  expect(options?.query).toEqual({ meal_type: "dinner", count: "5", mode: "both", protein: "high", max_kcal: "500",
                                   cuisine: undefined, exclude: ["food:a", "recipe:b"] });
  expect(JSON.stringify(options)).not.toMatch(/user/);
});

it("asks for re-priced servings, feedback and a pending proposal", async () => {
  await getRecommendation("rec 1", [1.5, 3]);
  expect(request.mock.calls[0]).toEqual(["/v1/me/recommendations/rec%201", { query: { servings: ["1.5", "3"] } }]);
  await sendFeedback("r1", "not_interested");
  expect(request.mock.calls[1]).toEqual(["/v1/me/recommendations/r1/feedback", { method: "POST", json: { action: "not_interested" } }]);
  await prepareLog("r1", { servings: [2] });
  expect(request.mock.calls[2]).toEqual(["/v1/me/recommendations/r1/log-proposal", { method: "POST", json: { servings: [2] } }]);
});

it("maps errors to messages the screen can show", async () => {
  expect(toRecommendationError(new BackendError(410, "x")).message).toBe("This meal is no longer available.");
  expect(toRecommendationError(new BackendError(404, "x")).kind).toBe("not_found");
  expect(toRecommendationError(new BackendError(500, "x")).retryable).toBe(true);
  expect(toRecommendationError(new UnauthorizedError()).kind).toBe("auth");
  expect(toRecommendationError(new TypeError("Network request failed")).kind).toBe("network");
  request.mockRejectedValueOnce(new BackendError(503, "down"));
  await expect(listRecommendations({ meal_type: "lunch" })).rejects.toMatchObject({ kind: "unavailable", retryable: true });
});


it("a response from an older backend without add-on fields does not crash the screen", async () => {
  const old = { status: "ok", items: [{ key: "food:a", name: "Dal", nutrition: { kcal: 1, protein_g: 1, carbs_g: 1, fat_g: 1 } }],
                notes: [], excluded: [] };
  request.mockResolvedValueOnce(old as never);
  const list = await listRecommendations({ meal_type: "lunch" });
  expect(list.items[0].optional_components).toEqual([]);
  expect(list.items[0].optional_withheld).toEqual([]);
  request.mockResolvedValueOnce({ id: "x", item: old.items[0], instructions: [] } as never);
  const d = await getRecommendation("x");
  expect(d.selected_optional).toEqual([]);
  expect(d.total_nutrition).toEqual(old.items[0].nutrition);
});
