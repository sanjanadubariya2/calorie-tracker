// lib/backend.ts and its use by getDailyStatus. Supabase and fetch are mocked.
// A module (not a global script), so helpers don't collide across test files.
export {};

type Session = { access_token: string } | null;

interface Harness {
  backend: typeof import("../backend");
  api: typeof import("../api");
  fetchMock: jest.Mock;
  rpc: jest.Mock;
  getSession: jest.Mock;
  refreshSession: jest.Mock;
}

const STATUS = {
  date: "2026-11-20",
  targets: { kcal: 2759, carbs_g: 276, fat_g: 92, protein_g: 207, macro_split: { carb_pct: 40, fat_pct: 30, protein_pct: 30 } },
  consumed: { kcal: 1470, carbs_g: 98, fat_g: 40, protein_g: 34.3, entry_count: 3 },
  remaining: { kcal: 1289, carbs_g: 178, fat_g: 52, protein_g: 172.7 },
};

function response(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function load(baseUrl: string | undefined, session: Session = { access_token: "token-1" }): Harness {
  const fetchMock = jest.fn();
  const rpc = jest.fn();
  const getSession = jest.fn().mockResolvedValue({ data: { session } });
  const refreshSession = jest.fn().mockResolvedValue({ data: { session: { access_token: "token-2" } }, error: null });
  let h!: Harness;
  jest.isolateModules(() => {
    // EXPO_PUBLIC_* values are inlined at build time, so substitute the config
    // module rather than mutating process.env.
    jest.doMock("../config", () => ({ RAW_API_BASE_URL: baseUrl }));
    jest.doMock("../supabase", () => ({
      MOCK_MODE: false,
      supabase: { auth: { getSession, refreshSession }, rpc },
    }));
    h = {
      backend: require("../backend"),
      api: require("../api"),
      fetchMock,
      rpc,
      getSession,
      refreshSession,
    };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return h;
}

afterEach(() => {
  jest.dontMock("../config");
  jest.dontMock("../supabase");
});

describe("configuration", () => {
  it("is disabled without EXPO_PUBLIC_API_BASE_URL (no hard-coded URL)", () => {
    const { backend } = load(undefined);
    expect(backend.API_BASE_URL).toBeNull();
    expect(backend.BACKEND_ENABLED).toBe(false);
  });

  it("explains why backend features are off, instead of blaming the app version", () => {
    expect(load(undefined).backend.backendOffReason()).toMatch(/isn't configured for this build/);
    expect(load("https://api.example.com").backend.backendOffReason()).toBeNull();
    let demo: typeof import("../backend") | undefined;
    jest.isolateModules(() => {
      jest.doMock("../config", () => ({ RAW_API_BASE_URL: "https://api.example.com" }));
      jest.doMock("../supabase", () => ({ MOCK_MODE: true, supabase: {} }));
      demo = require("../backend");
    });
    expect(demo?.BACKEND_ENABLED).toBe(false);
    expect(demo?.backendOffReason()).toMatch(/off in demo mode.*EXPO_PUBLIC_MOCK_MODE=false/);
  });

  it("trims whitespace and trailing slashes", () => {
    expect(load("  https://api.example.com/// ").backend.API_BASE_URL).toBe("https://api.example.com");
  });
});

describe("backendGet", () => {
  it("attaches the current session's access token and encodes the query", async () => {
    const { backend, fetchMock } = load("https://api.example.com");
    fetchMock.mockResolvedValueOnce(response(200, { ok: true }));
    await backend.backendGet("/v1/me/daily-status", { date: "2026-11-20", skip: undefined });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/me/daily-status?date=2026-11-20");
    expect(init.headers.Authorization).toBe("Bearer token-1");
  });

  it("refreshes the session once on 401 and retries with the new token", async () => {
    const { backend, fetchMock, refreshSession } = load("https://api.example.com");
    fetchMock.mockResolvedValueOnce(response(401, {})).mockResolvedValueOnce(response(200, { ok: true }));
    await expect(backend.backendGet("/x")).resolves.toEqual({ ok: true });
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer token-2");
  });

  it("throws UnauthorizedError when still 401 after refreshing", async () => {
    const { backend, fetchMock } = load("https://api.example.com");
    fetchMock.mockResolvedValue(response(401, {}));
    await expect(backend.backendGet("/x")).rejects.toBeInstanceOf(backend.UnauthorizedError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws UnauthorizedError when the refresh itself fails", async () => {
    const { backend, fetchMock, refreshSession } = load("https://api.example.com");
    refreshSession.mockResolvedValueOnce({ data: { session: null }, error: new Error("invalid refresh token") });
    fetchMock.mockResolvedValue(response(401, {}));
    await expect(backend.backendGet("/x")).rejects.toBeInstanceOf(backend.UnauthorizedError);
  });

  it("never sends a request without a session", async () => {
    const { backend, fetchMock } = load("https://api.example.com", null);
    await expect(backend.backendGet("/x")).rejects.toBeInstanceOf(backend.UnauthorizedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the backend's safe error detail with the status", async () => {
    const { backend, fetchMock } = load("https://api.example.com");
    fetchMock.mockResolvedValueOnce(response(503, { detail: "The database is temporarily unavailable." }));
    await expect(backend.backendGet("/x")).rejects.toMatchObject({
      status: 503,
      message: "The database is temporarily unavailable.",
    });
  });
});

describe("getDailyStatus integration", () => {
  it("uses the backend when configured and maps the response", async () => {
    const { api, fetchMock, rpc } = load("https://api.example.com");
    fetchMock.mockResolvedValueOnce(response(200, STATUS));
    const s = await api.getDailyStatus("2026-11-20");
    expect(rpc).not.toHaveBeenCalled();
    expect(s).toMatchObject({
      date: "2026-11-20",
      targetKcal: 2759,
      targetCarbsG: 276,
      split: { carbPct: 40, fatPct: 30, proteinPct: 30 },
      consumed: { calories: 1470, entryCount: 3 },
      remainingKcal: 1289,
    });
  });

  it("maps a user without a profile (null targets)", async () => {
    const { api, fetchMock } = load("https://api.example.com");
    fetchMock.mockResolvedValueOnce(response(200, { ...STATUS, targets: null, remaining: null }));
    const s = await api.getDailyStatus("2026-11-20");
    expect([s.targetKcal, s.split, s.remainingKcal]).toEqual([null, null, null]);
  });

  it("falls back to the database function when the backend is down", async () => {
    const { api, fetchMock, rpc } = load("https://api.example.com");
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    rpc.mockResolvedValueOnce({
      data: [{
        status_date: "2026-11-20", target_kcal: 2000, target_carbs_g: 275, target_fat_g: 56, target_protein_g: 100,
        macro_carb_pct: 55, macro_fat_pct: 25, macro_protein_pct: 20, consumed_kcal: 0, consumed_carbs_g: 0,
        consumed_fat_g: 0, consumed_protein_g: 0, remaining_kcal: 2000, remaining_carbs_g: 275,
        remaining_fat_g: 56, remaining_protein_g: 100, entry_count: 0,
      }],
      error: null,
    });
    const s = await api.getDailyStatus("2026-11-20");
    expect(rpc).toHaveBeenCalledWith("get_daily_status", { p_date: "2026-11-20" });
    expect(s.targetKcal).toBe(2000);
  });

  it("does not hide an auth failure behind the fallback", async () => {
    const { api, backend, fetchMock, rpc } = load("https://api.example.com");
    fetchMock.mockResolvedValue(response(401, {}));
    await expect(api.getDailyStatus("2026-11-20")).rejects.toBeInstanceOf(backend.UnauthorizedError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("calls the database function directly when no backend is configured", async () => {
    const { api, fetchMock, rpc } = load(undefined);
    rpc.mockResolvedValueOnce({ data: [{ status_date: "2026-11-20", entry_count: 0 }], error: null });
    await api.getDailyStatus("2026-11-20");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("get_daily_status", { p_date: "2026-11-20" });
  });
});
