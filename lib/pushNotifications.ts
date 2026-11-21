// Expo push on this device: permission, token registration, and taps.
//
// Push is opt-in (notification_preferences.push_enabled, off by default) and
// the app works fully without it: everything also appears in the in-app
// notification center. The token goes to register_push_token (026); the
// server decides what may be pushed. Nothing here throws into the UI: every
// outcome is a status the settings screen can explain.
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { MOCK_MODE, supabase } from "./supabase";
import {
  getNotificationPreferences,
  notificationTarget,
  saveNotificationPreferences,
  type NotificationKind,
  type NotificationTarget,
} from "./notifications";

const TOKEN_KEY = "calorie-tracker-push-token-v1";
const REGISTERED_AT_KEY = "calorie-tracker-push-registered-at-v1";
/** Re-registration keeps the device "seen" (the server disables devices unseen for 90 days). */
const REFRESH_EVERY_MS = 24 * 3600 * 1000;

export type PushStatus =
  | "enabled"            // permission granted and the device is registered
  | "denied"             // the person (or the OS) said no; Settings can change it
  | "unsupported"        // web, simulator, or no Expo project id in this build
  | "error";             // couldn't reach the push service or the server

export function pushSupported(): boolean {
  return !MOCK_MODE && (Platform.OS === "ios" || Platform.OS === "android") && Device.isDevice;
}

function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;
}

let handlerSet = false;
/** Show pushes that arrive while the app is open as a banner, without sound. */
export function configureForegroundHandling(): void {
  if (handlerSet || !pushSupported()) return;
  handlerSet = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: false, shouldSetBadge: false }),
  });
}

async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync("default", {
    name: "Friends and challenges",
    importance: Notifications.AndroidImportance.DEFAULT,
  });
}

async function registerToken(): Promise<PushStatus> {
  const id = projectId();
  if (!id) return "unsupported";
  try {
    await ensureAndroidChannel();
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: id });
    const { error } = await supabase.rpc("register_push_token", {
      p_token: token, p_platform: Platform.OS === "ios" ? "ios" : "android",
    });
    if (error) return "error";
    await AsyncStorage.setItem(TOKEN_KEY, token).catch(() => undefined);
    await AsyncStorage.setItem(REGISTERED_AT_KEY, String(Date.now())).catch(() => undefined);
    return "enabled";
  } catch {
    return "error";
  }
}

export async function getPushStatus(): Promise<PushStatus> {
  if (!pushSupported() || !projectId()) return "unsupported";
  try {
    const { status } = await Notifications.getPermissionsAsync();
    return status === "granted" ? "enabled" : "denied";
  } catch {
    return "error";
  }
}

/** Asks for permission (once the person chose to), registers, and turns push on. */
export async function enablePush(): Promise<PushStatus> {
  if (!pushSupported() || !projectId()) return "unsupported";
  try {
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted") ({ status } = await Notifications.requestPermissionsAsync());
    if (status !== "granted") return "denied";
  } catch {
    return "error";
  }
  const result = await registerToken();
  if (result !== "enabled") return result;
  try {
    const prefs = await getNotificationPreferences();
    await saveNotificationPreferences({ ...prefs, push_enabled: true });
  } catch {
    return "error";
  }
  return "enabled";
}

/** Turns push off and forgets this device on the server. In-app notifications continue. */
export async function disablePush(): Promise<void> {
  try {
    const prefs = await getNotificationPreferences();
    await saveNotificationPreferences({ ...prefs, push_enabled: false });
  } catch {
    // the token removal below still stops delivery to this device
  }
  await forgetDevice();
}

/** On sign-out: this device must not keep receiving the previous account's pushes. */
export async function forgetDevice(): Promise<void> {
  const token = await AsyncStorage.getItem(TOKEN_KEY).catch(() => null);
  if (!token || MOCK_MODE) return;
  await supabase.rpc("unregister_push_token", { p_token: token }).then(() => undefined, () => undefined);
  await AsyncStorage.multiRemove([TOKEN_KEY, REGISTERED_AT_KEY]).catch(() => undefined);
}

/**
 * At start-up: Expo tokens can rotate, so re-register when push is on and
 * allowed, at most once a day (the server rate-limits registrations).
 */
export async function refreshRegistration(now: number = Date.now()): Promise<void> {
  if (!pushSupported()) return;
  try {
    const last = Number(await AsyncStorage.getItem(REGISTERED_AT_KEY).catch(() => null)) || 0;
    if (last && now - last < REFRESH_EVERY_MS) return;
    const prefs = await getNotificationPreferences();
    if (!prefs.push_enabled) return;
    const { status } = await Notifications.getPermissionsAsync();
    if (status === "granted") await registerToken();
  } catch {
    // push is optional; the in-app center still works
  }
}

/** Where a tapped push leads, from its data payload. Unknown kinds open the notification list. */
export function targetFromPushData(data: unknown): NotificationTarget {
  const d = (data ?? {}) as { kind?: string; challenge_id?: string; event_id?: string };
  const kind = (d.kind ?? "") as NotificationKind;
  if (!kind) return { pathname: "/(tabs)/friends", params: { section: "feed" } };
  return notificationTarget({ kind, challenge_id: d.challenge_id ?? null, event_id: d.event_id ?? null });
}

/** Subscribes to taps on pushes (including the one that opened the app). Returns an unsubscribe. */
export function onPushTapped(navigate: (t: NotificationTarget) => void): () => void {
  if (!pushSupported()) return () => undefined;
  Notifications.getLastNotificationResponseAsync()
    .then((r) => { if (r) navigate(targetFromPushData(r.notification.request.content.data)); })
    .catch(() => undefined);
  const sub = Notifications.addNotificationResponseReceivedListener((r) =>
    navigate(targetFromPushData(r.notification.request.content.data)));
  return () => sub.remove();
}
