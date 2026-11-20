// lib/recognition.ts: backend calls and user-facing error mapping.
import { thaliResponse } from "../__fixtures__/recognition";

interface Harness {
  rec: typeof import("../recognition");
  fetchMock: jest.Mock;
}

function response(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body) } as unknown as Response;
}

function load(baseUrl: string | undefined = "https://api.example.com"): Harness {
  const fetchMock = jest.fn();
  let h!: Harness;
  jest.isolateModules(() => {
    jest.doMock("../config", () => ({ RAW_API_BASE_URL: baseUrl }));
    jest.doMock("../supabase", () => ({
      MOCK_MODE: false,
      supabase: {
        auth: {
          getSession: jest.fn().mockResolvedValue({ data: { session: { access_token: "tok" } } }),
          refreshSession: jest.fn().mockResolvedValue({ data: { session: { access_token: "tok2" } }, error: null }),
        },
      },
    }));
    h = { rec: require("../recognition"), fetchMock };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return h;
}

/** Minimal XHR double that reports upload progress then responds. */
class FakeXHR {
  static last: FakeXHR | null = null;
  static respond = { status: 201, body: {} as unknown };
  method = "";
  url = "";
  headers: Record<string, string> = {};
  status = 0;
  responseText = "";
  timeout = 0;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  body: unknown;
  constructor() {
    FakeXHR.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(body: unknown) {
    this.body = body;
    this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
    this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
    this.status = FakeXHR.respond.status;
    this.responseText = JSON.stringify(FakeXHR.respond.body);
    this.onload?.();
  }
}

afterEach(() => {
  jest.dontMock("../config");
  jest.dontMock("../supabase");
});

it("is unavailable without a backend", async () => {
  const { rec, fetchMock } = load("");
  expect(rec.recognitionAvailable()).toBe(false);
  await expect(rec.recognizeText("rice")).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("sends the description as JSON and returns candidates + proposal", async () => {
  const { rec, fetchMock } = load();
  fetchMock.mockResolvedValueOnce(response(200, thaliResponse()));
  const result = await rec.recognizeText("  two rotis, one bowl of dal and 150g paneer  ");
  expect(result.recognition.candidates).toHaveLength(3);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("https://api.example.com/v1/recognitions/text");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body)).toEqual({ text: "two rotis, one bowl of dal and 150g paneer" });
  expect(init.headers).toMatchObject({ Authorization: "Bearer tok", "Content-Type": "application/json" });
});

it("refuses empty or overlong descriptions without calling the server", async () => {
  const { rec, fetchMock } = load();
  await expect(rec.recognizeText("   ")).rejects.toThrow("Describe what you ate");
  await expect(rec.recognizeText("x".repeat(rec.MAX_DESCRIPTION_CHARS + 1))).rejects.toThrow("under 1000");
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([
  [503, "isn't available", false],
  [504, "took too long", true],
  [429, "busy", true],
  [422, "couldn't be analysed", false],
  [502, "unusable result", true],
])("maps HTTP %d to a message (retryable=%s)", async (status, text, retryable) => {
  const { rec, fetchMock } = load();
  const detail = {
    503: "AI recognition isn't available right now.",
    504: "Recognition took too long. Please try again.",
    429: "The AI service is busy. Try again shortly.",
    422: "This input couldn't be analysed. Try another photo or describe the meal.",
    502: "Recognition returned an unusable result. Please try again.",
  }[status];
  fetchMock.mockResolvedValueOnce(response(status, { detail }));
  const error = await rec.recognizeText("rice").catch((e) => e);
  expect(error).toBeInstanceOf(rec.RecognitionError);
  expect(error.message).toContain(text);
  expect(error.retryable).toBe(retryable);
});

it("network failures are retryable", async () => {
  const { rec, fetchMock } = load();
  fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
  await expect(rec.recognizeText("rice")).rejects.toMatchObject({ retryable: true, message: expect.stringContaining("connection") });
});

it("uploads the photo with progress, then recognises it by id", async () => {
  const { rec, fetchMock } = load();
  const realXHR = global.XMLHttpRequest;
  global.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
  FakeXHR.respond = { status: 201, body: { id: "11111111-2222-3333-4444-555555555555" } };
  try {
    fetchMock
      .mockResolvedValueOnce({ blob: () => Promise.resolve({ size: 52_000 }) }) // reading the local file
      .mockResolvedValueOnce(response(200, thaliResponse("image")));
    const stages: string[] = [];
    const result = await rec.recognizePhoto("file:///meal.jpg", "image/jpeg", (p) =>
      stages.push(p.fraction === null ? p.stage : `${p.stage} ${p.fraction}`)
    );
    expect(result.recognition.input_type).toBe("image");
    expect(stages).toEqual(["uploading", "uploading 0.5", "uploading 1", "recognizing"]);
    expect(FakeXHR.last?.url).toBe("https://api.example.com/v1/meal-images");
    expect(FakeXHR.last?.headers).toMatchObject({ Authorization: "Bearer tok", "Content-Type": "image/jpeg" });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("https://api.example.com/v1/recognitions/image");
    expect(JSON.parse(init.body)).toEqual({ image_id: "11111111-2222-3333-4444-555555555555" });
  } finally {
    global.XMLHttpRequest = realXHR;
  }
});

it("an unsupported photo format never reaches the server", async () => {
  const { rec, fetchMock } = load();
  await expect(rec.recognizePhoto("file:///x.heic", "image/heic")).rejects.toMatchObject({ retryable: false });
  expect(fetchMock).not.toHaveBeenCalled();
});

it("re-grounds edited items", async () => {
  const { rec, fetchMock } = load();
  fetchMock.mockResolvedValueOnce(response(200, thaliResponse().proposal));
  await rec.groundItems([{ food_name: "dal", quantity: 1, unit: "bowl", quantity_source: "manual" }]);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("https://api.example.com/v1/proposals/ground");
  expect(JSON.parse(init.body)).toEqual({ items: [{ food_name: "dal", quantity: 1, unit: "bowl", quantity_source: "manual" }] });
});
