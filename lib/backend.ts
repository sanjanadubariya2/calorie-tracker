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

async function send(url: string, token: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** GET a backend path as the signed-in user. */
export async function backendGet<T>(path: string, query: Record<string, string | undefined> = {}): Promise<T> {
  if (!API_BASE_URL) throw new Error("EXPO_PUBLIC_API_BASE_URL is not set");

  const params = Object.entries(query)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const url = `${API_BASE_URL}${path}${params ? `?${params}` : ""}`;

  let response = await send(url, await currentAccessToken());
  if (response.status === 401) {
    // Usually an access token that expired between refreshes: refresh once and retry.
    response = await send(url, await refreshedAccessToken());
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
  return (await response.json()) as T;
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
