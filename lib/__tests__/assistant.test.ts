// lib/assistant.ts: requests and user-facing error mapping.
import { STATUS_RESPONSE, turn } from "../__fixtures__/assistant";

interface Harness {
  api: typeof import("../assistant");
  fetchMock: jest.Mock;
  refresh: jest.Mock;
}

function response(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body) } as unknown as Response;
}

function load(): Harness {
  const fetchMock = jest.fn();
  const refresh = jest.fn().mockResolvedValue({ data: { session: { access_token: "tok2" } }, error: null });
  let h!: Harness;
  jest.isolateModules(() => {
    jest.doMock("../config", () => ({ RAW_API_BASE_URL: "https://api.example.com" }));
    jest.doMock("../supabase", () => ({
      MOCK_MODE: false,
      supabase: { auth: { getSession: jest.fn().mockResolvedValue({ data: { session: { access_token: "tok" } } }), refreshSession: refresh } },
    }));
    h = { api: require("../assistant"), fetchMock, refresh };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return h;
}

afterEach(() => {
  jest.dontMock("../config");
  jest.dontMock("../supabase");
});

it("sends a message with its client id and local date", async () => {
  const { api, fetchMock } = load();
  fetchMock.mockResolvedValueOnce(response(200, turn("hi", "cm1", STATUS_RESPONSE)));
  await api.sendMessage("conv-1", "How am I doing?", "cm1");
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("https://api.example.com/v1/assistant/conversations/conv-1/messages");
  const body = JSON.parse(init.body);
  expect(body).toMatchObject({ content: "How am I doing?", client_message_id: "cm1" });
  expect(body.local_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(init.headers.Authorization).toBe("Bearer tok");
});

it("confirms a specific proposal with the user's edits", async () => {
  const { api, fetchMock } = load();
  fetchMock.mockResolvedValueOnce(response(200, { proposal: {}, food_logs: [] }));
  await api.confirmProposal("p1", { meal_type: "lunch", items: [{ index: 0, quantity: 3 }] });
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("https://api.example.com/v1/assistant/proposals/p1/confirm");
  expect(JSON.parse(init.body)).toEqual({ meal_type: "lunch", items: [{ index: 0, quantity: 3 }] });
});

it.each([
  [409, "conflict", false], [410, "gone", false], [404, "not_found", false], [422, "invalid", false],
  [429, "rate_limit", true], [503, "unavailable", false], [504, "busy", true], [502, "server", true],
])("maps HTTP %d to %s", async (status, kind, retryable) => {
  const { api, fetchMock } = load();
  fetchMock.mockResolvedValueOnce(response(status, { detail: "server says" }));
  await expect(api.sendMessage("c", "x", "id")).rejects.toMatchObject({ kind, retryable });
});

it("an expired session that can't be refreshed is reported as auth", async () => {
  const { api, fetchMock, refresh } = load();
  refresh.mockResolvedValueOnce({ data: { session: null }, error: new Error("expired") });
  fetchMock.mockResolvedValueOnce(response(401, {}));
  await expect(api.listConversations()).rejects.toMatchObject({ kind: "auth", retryable: false });
});

it("network failures are retryable", async () => {
  const { api, fetchMock } = load();
  fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
  await expect(api.listMessages("c")).rejects.toMatchObject({ kind: "network", retryable: true });
});

it("client message ids are UUIDs", () => {
  const { api } = load();
  const ids = new Set(Array.from({ length: 50 }, () => api.newClientMessageId()));
  expect(ids.size).toBe(50);
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
