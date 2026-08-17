import * as ImagePicker from "expo-image-picker";
import { MOCK_MODE, supabase } from "./supabase";

const BUCKET = "avatars";

export interface PickedImage {
  uri: string;
  mimeType: string;
}

/** Opens the photo library. Returns null if the user cancelled or denied access. */
export async function pickAvatarImage(): Promise<PickedImage | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return null;

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    allowsEditing: true,
    aspect: [1, 1],
    // Avatars render at ~56px, so heavy compression is invisible and keeps
    // uploads fast on mobile data.
    quality: 0.6,
  });

  if (result.canceled || !result.assets?.length) return null;
  const asset = result.assets[0];
  return { uri: asset.uri, mimeType: asset.mimeType ?? "image/jpeg" };
}

/**
 * Uploads to `avatars/<userId>/avatar.<ext>` and returns the public URL.
 * The path's first segment is what the storage RLS policy checks, so a user
 * can only ever write inside their own folder.
 */
export async function uploadAvatar(userId: string, image: PickedImage): Promise<string> {
  if (MOCK_MODE) return image.uri;

  const extension = image.mimeType.includes("png") ? "png" : "jpg";
  const path = `${userId}/avatar.${extension}`;

  // React Native's fetch handles file:// URIs; this yields the raw bytes that
  // supabase-js needs, since it can't take a local path directly.
  const response = await fetch(image.uri);
  const blob = await response.blob();
  const arrayBuffer = await new Response(blob).arrayBuffer();

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(path, arrayBuffer, { contentType: image.mimeType, upsert: true });

  if (uploadError) throw uploadError;

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  // Cache-bust so a replaced avatar doesn't keep showing the old image.
  return `${data.publicUrl}?v=${Date.now()}`;
}

export async function deleteAvatar(userId: string): Promise<void> {
  if (MOCK_MODE) return;
  await supabase.storage.from(BUCKET).remove([`${userId}/avatar.jpg`, `${userId}/avatar.png`]);
}
