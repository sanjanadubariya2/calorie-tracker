// Camera / library access for meal photos. Returns null when the user cancels.
// Permission denials are reported, so the screen can say why nothing happened.

import * as ImagePicker from "expo-image-picker";

export interface PickedPhoto {
  uri: string;
  mimeType: string;
}

export class PhotoPermissionError extends Error {
  constructor(what: "camera" | "photos") {
    super(
      what === "camera"
        ? "Camera access is off. Allow it in Settings, or upload a photo instead."
        : "Photo access is off. Allow it in Settings, or describe your meal instead."
    );
    this.name = "PhotoPermissionError";
  }
}

const OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ImagePicker.MediaTypeOptions.Images,
  allowsEditing: false,
  // The backend re-encodes to at most 2048 px; 0.8 keeps uploads small on mobile data.
  quality: 0.8,
  exif: false,
};

function firstAsset(result: ImagePicker.ImagePickerResult): PickedPhoto | null {
  if (result.canceled || !result.assets?.length) return null;
  const asset = result.assets[0];
  return { uri: asset.uri, mimeType: asset.mimeType ?? "image/jpeg" };
}

export async function takeMealPhoto(): Promise<PickedPhoto | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) throw new PhotoPermissionError("camera");
  return firstAsset(await ImagePicker.launchCameraAsync(OPTIONS));
}

export async function pickMealPhoto(): Promise<PickedPhoto | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) throw new PhotoPermissionError("photos");
  return firstAsset(await ImagePicker.launchImageLibraryAsync(OPTIONS));
}
