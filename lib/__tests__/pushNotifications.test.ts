// Push on the device: permission handling, token registration, failures, sign-out, taps.
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { supabase } from "../supabase";
import * as prefsApi from "../notifications";
import {
  disablePush,
  enablePush,
  forgetDevice,
  getPushStatus,
  onPushTapped,
  refreshRegistration,
  targetFromPushData,
} from "../pushNotifications";

jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));
jest.mock("expo-device", () => ({ isDevice: true }));
jest.mock("expo-constants", () => ({ __esModule: true, default: { expoConfig: { extra: { eas: { projectId: "proj-1" } } } } }));
jest.mock("expo-notifications", () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  setNotificationHandler: jest.fn(),
  getLastNotificationResponseAsync: jest.fn(async () => null),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  AndroidImportance: { DEFAULT: 3 },
}));
jest.mock("../supabase", () => ({ MOCK_MODE: false, supabase: { rpc: jest.fn() } }));
jest.mock("../notifications", () => ({
  ...jest.requireActual("../notifications"),
  getNotificationPreferences: jest.fn(),
  saveNotificationPreferences: jest.fn(),
}));

const N = Notifications as jest.Mocked<typeof Notifications>;
const rpc = supabase.rpc as unknown as jest.Mock;
const P = prefsApi as jest.Mocked<typeof prefsApi>;
const TOKEN = "ExponentPushToken[abcdefghij1234]";

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  rpc.mockResolvedValue({ error: null });
  N.getExpoPushTokenAsync.mockResolvedValue({ type: "expo", data: TOKEN });
  P.getNotificationPreferences.mockResolvedValue({ ...prefsApi.DEFAULT_PREFERENCES });
  P.saveNotificationPreferences.mockResolvedValue();
});

it("asks for permission only when enabling, registers the token, and turns push on", async () => {
  N.getPermissionsAsync.mockResolvedValue({ status: "undetermined" } as never);
  N.requestPermissionsAsync.mockResolvedValue({ status: "granted" } as never);
  expect(await enablePush()).toBe("enabled");
  expect(N.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: "proj-1" });
  expect(rpc).toHaveBeenCalledWith("register_push_token", { p_token: TOKEN, p_platform: "ios" });
  expect(P.saveNotificationPreferences).toHaveBeenCalledWith({ ...prefsApi.DEFAULT_PREFERENCES, push_enabled: true });
  expect(await AsyncStorage.getItem("calorie-tracker-push-token-v1")).toBe(TOKEN);
});

it("a refusal is reported, nothing is registered, and push stays off", async () => {
  N.getPermissionsAsync.mockResolvedValue({ status: "denied" } as never);
  N.requestPermissionsAsync.mockResolvedValue({ status: "denied" } as never);
  expect(await enablePush()).toBe("denied");
  expect(rpc).not.toHaveBeenCalled();
  expect(P.saveNotificationPreferences).not.toHaveBeenCalled();
  expect(await getPushStatus()).toBe("denied");
});

it("token or server failures are errors, not crashes, and leave push off", async () => {
  N.getPermissionsAsync.mockResolvedValue({ status: "granted" } as never);
  N.getExpoPushTokenAsync.mockRejectedValueOnce(new Error("no network"));
  expect(await enablePush()).toBe("error");
  rpc.mockResolvedValueOnce({ error: { code: "22023" } });
  expect(await enablePush()).toBe("error");
  expect(P.saveNotificationPreferences).not.toHaveBeenCalled();
});

it("disabling turns the preference off and forgets this device on the server", async () => {
  await AsyncStorage.setItem("calorie-tracker-push-token-v1", TOKEN);
  P.getNotificationPreferences.mockResolvedValue({ ...prefsApi.DEFAULT_PREFERENCES, push_enabled: true });
  await disablePush();
  expect(P.saveNotificationPreferences).toHaveBeenCalledWith({ ...prefsApi.DEFAULT_PREFERENCES, push_enabled: false });
  expect(rpc).toHaveBeenCalledWith("unregister_push_token", { p_token: TOKEN });
  expect(await AsyncStorage.getItem("calorie-tracker-push-token-v1")).toBeNull();
});

it("sign-out forgets the device; without a stored token it does nothing", async () => {
  await forgetDevice();
  expect(rpc).not.toHaveBeenCalled();
});

it("re-registers at start-up only when push is on and allowed", async () => {
  N.getPermissionsAsync.mockResolvedValue({ status: "granted" } as never);
  await refreshRegistration();
  expect(rpc).not.toHaveBeenCalled();                                 // push off
  P.getNotificationPreferences.mockResolvedValue({ ...prefsApi.DEFAULT_PREFERENCES, push_enabled: true });
  await refreshRegistration();
  expect(rpc).toHaveBeenCalledWith("register_push_token", { p_token: TOKEN, p_platform: "ios" });
});

it("tapping a push deep-links from its data", () => {
  expect(targetFromPushData({ kind: "challenge_invite", challenge_id: "c1" }))
    .toEqual({ pathname: "/(tabs)/friends", params: { section: "challenges", challenge: "c1" } });
  expect(targetFromPushData({ kind: "friend_request" })).toEqual({ pathname: "/(tabs)/friends", params: { section: "friends" } });
  expect(targetFromPushData(null)).toEqual({ pathname: "/(tabs)/friends", params: { section: "feed" } });
  const navigate = jest.fn();
  const stop = onPushTapped(navigate);
  const listener = N.addNotificationResponseReceivedListener.mock.calls[0][0];
  listener({ notification: { request: { content: { data: { kind: "comment", event_id: "e1" } } } } } as never);
  expect(navigate).toHaveBeenCalledWith({ pathname: "/(tabs)/friends", params: { section: "feed", event: "e1", comments: "1" } });
  stop();
});

it("refreshes the registration at most once a day", async () => {
  N.getPermissionsAsync.mockResolvedValue({ status: "granted" } as never);
  P.getNotificationPreferences.mockResolvedValue({ ...prefsApi.DEFAULT_PREFERENCES, push_enabled: true });
  const t0 = Date.now();
  await refreshRegistration(t0);
  await refreshRegistration(t0 + 3_600_000);                         // an hour later: skipped
  expect(rpc.mock.calls.filter((c) => c[0] === "register_push_token")).toHaveLength(1);
  await refreshRegistration(t0 + 25 * 3_600_000);                    // next day: refreshed (keeps the device "seen")
  expect(rpc.mock.calls.filter((c) => c[0] === "register_push_token")).toHaveLength(2);
});
