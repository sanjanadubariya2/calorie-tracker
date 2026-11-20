// lib/mealImages.ts: always via the backend, with client-side pre-checks.
// A module (not a global script), so helpers don't collide across test files.
export {};

interface Harness {
  images: typeof import("../mealImages");
  fetchMock: jest.Mock;
}

function response(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body) } as unknown as Response;
}

function blobOf(size: number): Blob {
  return { size } as Blob;
}

function load(baseUrl: string | undefined): Harness {
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
    h = { images: require("../mealImages"), fetchMock };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return h;
}

afterEach(() => {
  jest.dontMock("../config");
  jest.dontMock("../supabase");
});

const STORED = {
  id: "11111111-2222-3333-4444-555555555555", status: "uploaded", width: 640, height: 480, size_bytes: 52000,
  content_type: "image/jpeg", created_at: "2026-11-20T10:00:00Z", expires_at: "2026-12-20T10:00:00Z",
  url: "https://x.supabase.co/storage/v1/object/sign/meal-images/u/i.jpg?token=t", url_expires_in: 300,
};

it("is unavailable without a backend (no direct-to-storage fallback)", async () => {
  const { images, fetchMock } = load(undefined);
  expect(images.mealImagesAvailable()).toBe(false);
  await expect(images.uploadMealImage("file:///photo.jpg", "image/jpeg")).rejects.toThrow("isn't available");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("uploads the raw bytes with the user's token and the image content type", async () => {
  const { images, fetchMock } = load("https://api.example.com");
  const blob = blobOf(52_000);
  fetchMock
    .mockResolvedValueOnce({ blob: () => Promise.resolve(blob) })          // reading the local file
    .mockResolvedValueOnce(response(201, STORED));                          // POST /v1/meal-images
  await expect(images.uploadMealImage("file:///photo.jpg", "image/JPEG")).resolves.toEqual(STORED);
  const [url, init] = fetchMock.mock.calls[1];
  expect(url).toBe("https://api.example.com/v1/meal-images");
  expect(init.method).toBe("POST");
  expect(init.body).toBe(blob);
  expect(init.headers).toMatchObject({ Authorization: "Bearer tok", "Content-Type": "image/jpeg" });
});

it.each(["image/gif", "image/heic", "text/html"])("refuses %s before uploading", async (type) => {
  const { images, fetchMock } = load("https://api.example.com");
  await expect(images.uploadMealImage("file:///x", type)).rejects.toThrow("JPEG, PNG or WebP");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("refuses empty and oversized files before uploading", async () => {
  const { images, fetchMock } = load("https://api.example.com");
  fetchMock.mockResolvedValueOnce({ blob: () => Promise.resolve(blobOf(0)) });
  await expect(images.uploadMealImage("file:///x", "image/jpeg")).rejects.toThrow("empty");
  fetchMock.mockResolvedValueOnce({ blob: () => Promise.resolve(blobOf(images.MAX_UPLOAD_BYTES + 1)) });
  await expect(images.uploadMealImage("file:///x", "image/jpeg")).rejects.toThrow("too large");
  expect(fetchMock).toHaveBeenCalledTimes(2); // only the local reads
});

it.each([
  [413, "too large"],
  [415, "JPEG, PNG or WebP"],
  [422, "couldn't be read"],
  [429, "uploaded a lot"],
])("maps HTTP %d to a friendly message", async (status, text) => {
  const { images, fetchMock } = load("https://api.example.com");
  fetchMock
    .mockResolvedValueOnce({ blob: () => Promise.resolve(blobOf(1000)) })
    .mockResolvedValueOnce(response(status, { detail: "server detail" }));
  await expect(images.uploadMealImage("file:///x", "image/png")).rejects.toThrow(text);
});

it("gets a fresh signed URL and deletes", async () => {
  const { images, fetchMock } = load("https://api.example.com");
  fetchMock.mockResolvedValueOnce(response(200, STORED)).mockResolvedValueOnce(response(204, null));
  await expect(images.getMealImage(STORED.id)).resolves.toMatchObject({ url: STORED.url });
  await expect(images.deleteMealImage(STORED.id)).resolves.toBeUndefined();
  expect(fetchMock.mock.calls[1][1].method).toBe("DELETE");
});
