// searchFoods() is tested through a mocked fetch: normalization, filtering,
// the per-platform fallback chain, and error handling. No network access.

type FetchMock = jest.Mock<Promise<Partial<Response>>, [string, RequestInit?]>;

function jsonResponse(body: unknown, init: { status?: number; contentType?: string } = {}) {
  const status = init.status ?? 200;
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => init.contentType ?? "application/json; charset=utf-8" } as unknown as Headers,
    json: () => Promise.resolve(body),
  });
}

const product = (overrides: Record<string, unknown> = {}) => ({
  code: "8901234",
  product_name: "Banana chips",
  brands: "Haldiram's",
  image_front_small_url: "https://img.example/1.jpg",
  nutriments: {
    "energy-kcal_100g": 520,
    carbohydrates_100g: 58,
    fat_100g: 30.04,
    proteins_100g: 2.3,
    "saturated-fat_100g": 25.96,
    sugars_100g: 3.5,
    sodium_100g: 0.123,
  },
  ...overrides,
});

/**
 * Loads the module fresh with a given Platform.OS. The strategy order is fixed
 * at import, but requestInit() reads Platform.OS on every call. react-native
 * exposes Platform through a lazy getter, so calls made after isolateModules()
 * resolve it from the main registry. Set OS in both.
 */
function loadModule(os: "ios" | "android" | "web") {
  require("react-native").Platform.OS = os;
  let mod!: typeof import("../openFoodFacts");
  jest.isolateModules(() => {
    require("react-native").Platform.OS = os;
    mod = require("../openFoodFacts");
  });
  return mod;
}

let fetchMock: FetchMock;
const realFetch = global.fetch;

beforeEach(() => {
  fetchMock = jest.fn() as FetchMock;
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = realFetch;
});

describe("searchFoods: input handling", () => {
  it("returns [] without a request for queries shorter than 2 characters", async () => {
    const { searchFoods } = loadModule("android");
    await expect(searchFoods(" a ")).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("trims and URL-encodes the query", async () => {
    const { searchFoods } = loadModule("android");
    fetchMock.mockReturnValueOnce(jsonResponse({ hits: [] }));
    await searchFoods("  dal & rice ");
    expect(fetchMock.mock.calls[0][0]).toContain("q=dal%20%26%20rice&");
  });
});

describe("searchFoods: normalization", () => {
  it("maps Search-a-licious hits to FoodSearchResult (per 100 g)", async () => {
    const { searchFoods } = loadModule("android");
    fetchMock.mockReturnValueOnce(jsonResponse({ hits: [product({ brands: ["Haldiram's", "Snacko"] })] }));

    const [r] = await searchFoods("banana chips");
    expect(r).toEqual({
      id: "8901234",
      name: "Banana chips",
      brand: "Haldiram's, Snacko",
      caloriesPer100g: 520,
      carbsPer100g: 58,
      fatPer100g: 30.04,
      proteinPer100g: 2.3,
      imageUrl: "https://img.example/1.jpg",
      saturatedFatPer100g: 26, // optional nutrients are rounded to 1 dp
      sugarsPer100g: 3.5,
      fiberPer100g: undefined, // missing stays undefined so the label hides the row
      sodiumPer100g: 0.1,
      saltPer100g: undefined,
    });
  });

  it("accepts the legacy comma-joined brands string and blanks", async () => {
    const { searchFoods } = loadModule("web");
    fetchMock.mockReturnValueOnce(
      jsonResponse({ products: [product({ brands: "Amul" }), product({ code: "2", brands: "  " })] })
    );
    const results = await searchFoods("butter");
    expect(results.map((r) => r.brand)).toEqual(["Amul", undefined]);
  });

  it("drops products with no name or no kcal, and defaults missing macros to 0", async () => {
    const { searchFoods } = loadModule("android");
    fetchMock.mockReturnValueOnce(
      jsonResponse({
        hits: [
          product({ code: "no-name", product_name: undefined }),
          product({ code: "no-kcal", nutriments: { fat_100g: 1 } }),
          product({ code: "zero-kcal", nutriments: { "energy-kcal_100g": 0 } }),
        ],
      })
    );
    const results = await searchFoods("water");
    expect(results.map((r) => r.id)).toEqual(["zero-kcal"]);
    expect(results[0]).toMatchObject({ carbsPer100g: 0, fatPer100g: 0, proteinPer100g: 0, brand: "Haldiram's" });
  });
});

describe("searchFoods: platform strategy order", () => {
  it("native: tries Search-a-licious first and sends a User-Agent", async () => {
    const { searchFoods } = loadModule("android");
    fetchMock.mockReturnValueOnce(jsonResponse({ hits: [] }));
    await searchFoods("idli");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/^https:\/\/search\.openfoodfacts\.org\/search\?/);
    expect((init?.headers as Record<string, string>)["User-Agent"]).toMatch(/^CalorieTracker\//);
  });

  it("web: starts at the CORS-enabled mirror and sends no custom headers", async () => {
    const { searchFoods } = loadModule("web");
    fetchMock.mockReturnValueOnce(jsonResponse({ products: [] }));
    await searchFoods("idli");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/^https:\/\/world\.openfoodfacts\.net\/cgi\/search\.pl\?/);
    expect(init?.headers).toBeUndefined();
  });

  it("native: falls back to mirror, then legacy, on failure", async () => {
    const { searchFoods } = loadModule("ios");
    fetchMock
      .mockReturnValueOnce(jsonResponse({}, { status: 503 }))
      .mockReturnValueOnce(jsonResponse("<html>", { contentType: "text/html" }))
      .mockReturnValueOnce(jsonResponse({ products: [product()] }));

    const results = await searchFoods("chips");
    expect(results).toHaveLength(1);
    expect(fetchMock.mock.calls.map(([u]) => new URL(u).host)).toEqual([
      "search.openfoodfacts.org",
      "world.openfoodfacts.net",
      "world.openfoodfacts.org",
    ]);
  });

  it("throws the last error when every source fails", async () => {
    const { searchFoods } = loadModule("web");
    fetchMock
      .mockReturnValueOnce(jsonResponse({}, { status: 500 }))
      .mockReturnValueOnce(jsonResponse("<html>", { status: 200, contentType: "text/html" }));
    await expect(searchFoods("chips")).rejects.toThrow(
      "Open Food Facts legacy search returned text/html, not JSON"
    );
  });

  it("does not retry other sources after an abort", async () => {
    const { searchFoods } = loadModule("android");
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    fetchMock.mockRejectedValueOnce(abort);
    await expect(searchFoods("chips")).rejects.toBe(abort);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("debounce", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("runs once with the last arguments after the delay", () => {
    const { debounce } = loadModule("android");
    const fn = jest.fn();
    const debounced = debounce(fn, 450);
    debounced("a");
    debounced("ab");
    jest.advanceTimersByTime(449);
    expect(fn).not.toHaveBeenCalled();
    debounced("abc");
    jest.advanceTimersByTime(450);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("abc");
  });
});
