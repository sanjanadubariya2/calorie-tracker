// Client for the FastAPI backend (backend/).
//
// Optional: when EXPO_PUBLIC_API_BASE_URL is unset (or in mock mode) the app
// keeps talking to Supabase directly, exactly as before. Only endpoints that
// exist on the backend go through here; everything else stays on supabase-js.
//
// Auth: the backend accepts the user's Supabase access token, which is
// attached on every request. On a 401 the session is refreshed once and the
// request retried; if it still fails, UnauthorizedError is thrown and the
// caller decides (screens show their error state; signing in again recovers).

import { MOCK_MODE, supabase } from "./supabase";
import { RAW_API_BASE_URL } from "./config";

const REQUEST_TIMEOUT_MS = 10_000;

/** e.g. https://api.example.com — no hard-coded default; unset disables the backend. */
export const API_BASE_URL: string | null = (RAW_API_BASE_URL ?? "").trim().replace(/\/+$/, "") || null;

export const BACKEND_ENABLED = API_BASE_URL !== null && !MOCK_MODE;

export class BackendError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "BackendError";
  }
}

/** The backend rejected the session even after a refresh. */
export class UnauthorizedError extends BackendError {
  constructor(message = "Your session has expired. Sign in again.") {
    super(401, message);
    this.name = "UnauthorizedError";
  }
}

async function currentAccessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new UnauthorizedError("You're not signed in.");
  return token;
}

async function refreshedAccessToken(): Promise<string> {
  const { data, error } = await supabase.auth.refreshSession();
  const token = data.session?.access_token;
  if (error || !token) throw new UnauthorizedError();
  return token;
}

interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  /** JSON-serialised as the body (sets Content-Type). */
  json?: unknown;
  query?: Record<string, string | undefined>;
  body?: Blob | ArrayBuffer | string;
  contentType?: string;
  timeoutMs?: number;
  /** Upload progress 0..1. Uses XMLHttpRequest (fetch can't report upload progress). */
  onUploadProgress?: (fraction: number) => void;
}

/** The parts of a fetch Response this client reads; XHR responses are adapted to it. */
type MinimalResponse = Pick<Response, "status" | "ok" | "json">;

function sendWithProgress(url: string, token: string, options: RequestOptions): Promise<MinimalResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(options.method ?? "GET", url);
    xhr.timeout = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("Accept", "application/json");
    if (options.contentType) xhr.setRequestHeader("Content-Type", options.contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) options.onUploadProgress?.(event.loaded / event.total);
    };
    xhr.onload = () =>
      resolve({
        status: xhr.status,
        ok: xhr.status >= 200 && xhr.status < 300,
        json: async () => JSON.parse(xhr.responseText),
      });
    xhr.onerror = () => reject(new TypeError("Network request failed"));
    xhr.ontimeout = () => reject(new DOMException("The request timed out", "AbortError"));
    xhr.send((options.body ?? null) as XMLHttpRequestBodyInit | null);
  });
}

async function send(url: string, token: string, options: RequestOptions): Promise<MinimalResponse> {
  if (options.onUploadProgress && typeof XMLHttpRequest !== "undefined") {
    return sendWithProgress(url, token, options);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(options.contentType ? { "Content-Type": options.contentType } : {}),
      },
      body: options.body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Calls a backend path as the signed-in user. Returns null for 204 No Content. */
export async function backendRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (!API_BASE_URL) throw new Error("EXPO_PUBLIC_API_BASE_URL is not set");

  const params = Object.entries(options.query ?? {})
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const url = `${API_BASE_URL}${path}${params ? `?${params}` : ""}`;

  if (options.json !== undefined) {
    options = { ...options, body: JSON.stringify(options.json), contentType: "application/json" };
  }
  let response = await send(url, await currentAccessToken(), options);
  if (response.status === 401) {
    // Usually an access token that expired between refreshes: refresh once and retry.
    response = await send(url, await refreshedAccessToken(), options);
  }
  if (response.status === 401) throw new UnauthorizedError();
  if (!response.ok) {
    let detail = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      // Non-JSON error body: keep the generic message.
    }
    throw new BackendError(response.status, detail);
  }
  if (response.status === 204) return null as T;
  return (await response.json()) as T;
}

/** GET a backend path as the signed-in user. */
export function backendGet<T>(path: string, query: Record<string, string | undefined> = {}): Promise<T> {
  return backendRequest<T>(path, { query });
}

/* ------------------------------------------------------------------------- */
/* Endpoint shapes                                                           */
/* ------------------------------------------------------------------------- */

/** GET /v1/me/daily-status (backend/app/schemas/daily_status.py). */
export interface BackendDailyStatus {
  date: string;
  targets: {
    kcal: number;
    carbs_g: number;
    fat_g: number;
    protein_g: number;
    macro_split: { carb_pct: number; fat_pct: number; protein_pct: number };
  } | null;
  consumed: { kcal: number; carbs_g: number; fat_g: number; protein_g: number; entry_count: number };
  remaining: { kcal: number; carbs_g: number; fat_g: number; protein_g: number } | null;
}
