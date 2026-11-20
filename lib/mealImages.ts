// Meal photos for AI recognition (backend: /v1/meal-images, migration 009).
//
// Uploads always go through the backend, never straight to Supabase Storage:
// the backend validates the image, re-encodes it to JPEG and strips every bit
// of metadata (including GPS) before storing it in the private bucket. So this
// needs EXPO_PUBLIC_API_BASE_URL; without it, uploads are unavailable rather
// than silently falling back to an unvalidated path.

import { BACKEND_ENABLED, BackendError, backendRequest } from "./backend";

export type MealImageStatus = "uploaded" | "analyzing" | "analyzed" | "failed";

export interface MealImage {
  id: string;
  status: MealImageStatus;
  width: number;
  height: number;
  size_bytes: number;
  content_type: "image/jpeg";
  created_at: string;
  expires_at: string;
  /** Short-lived signed URL; fetch a fresh one with getMealImage when it expires. */
  url: string;
  url_expires_in: number;
}

export const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type AcceptedImageType = (typeof ACCEPTED_IMAGE_TYPES)[number];

/** Matches the backend's default upload cap (MEAL_IMAGE_MAX_UPLOAD_BYTES). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const UPLOAD_TIMEOUT_MS = 60_000;

export class MealImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MealImageError";
  }
}

export function mealImagesAvailable(): boolean {
  return BACKEND_ENABLED;
}

function friendlyMessage(error: unknown): never {
  if (error instanceof BackendError) {
    switch (error.status) {
      case 413:
        throw new MealImageError("That photo is too large. Try a smaller one.");
      case 415:
        throw new MealImageError("Use a JPEG, PNG or WebP photo.");
      case 422:
        throw new MealImageError("That photo couldn't be read. Try another one.");
      case 429:
        throw new MealImageError("You've uploaded a lot of photos recently. Try again in a while.");
    }
  }
  throw error;
}

/**
 * Uploads a photo picked or taken on the device (a file://, content:// or
 * blob: URI). Returns the stored image's metadata and a signed URL.
 */
export async function uploadMealImage(
  uri: string,
  mimeType: string,
  onProgress?: (fraction: number) => void
): Promise<MealImage> {
  if (!BACKEND_ENABLED) throw new MealImageError("Photo upload isn't available in this build.");
  const type = mimeType.toLowerCase();
  if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(type)) {
    throw new MealImageError("Use a JPEG, PNG or WebP photo.");
  }

  // React Native's fetch reads local file URIs into a Blob (as in avatarUpload.ts).
  const blob = await (await fetch(uri)).blob();
  if (blob.size === 0) throw new MealImageError("That photo is empty.");
  if (blob.size > MAX_UPLOAD_BYTES) throw new MealImageError("That photo is too large. Try a smaller one.");

  try {
    return await backendRequest<MealImage>("/v1/meal-images", {
      method: "POST",
      body: blob,
      contentType: type,
      timeoutMs: UPLOAD_TIMEOUT_MS,
      onUploadProgress: onProgress,
    });
  } catch (error) {
    return friendlyMessage(error);
  }
}

/** Metadata plus a fresh signed URL. Another user's image is reported as not found. */
export function getMealImage(id: string): Promise<MealImage> {
  return backendRequest<MealImage>(`/v1/meal-images/${encodeURIComponent(id)}`);
}

export async function deleteMealImage(id: string): Promise<void> {
  await backendRequest<null>(`/v1/meal-images/${encodeURIComponent(id)}`, { method: "DELETE" });
}
