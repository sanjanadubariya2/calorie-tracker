// Notifications client: paging, read state, preferences writes, text and deep links.
// Creation, eligibility, duplicates and authorization: supabase/tests/026_notifications.test.sql.
import { supabase } from "../supabase";
import {
  DEFAULT_PREFERENCES,
  describeNotification,
  getNotifications,
  markNotificationsRead,
  notificationTarget,
  saveNotificationPreferences,
  type AppNotification,
} from "../notifications";

jest.mock("../supabase", () => ({ MOCK_MODE: false, supabase: { rpc: jest.fn(), from: jest.fn() } }));
const rpc = supabase.rpc as unknown as jest.Mock;
const from = supabase.from as unknown as jest.Mock;
beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
  rpc.mockResolvedValue({ data: null, error: null });
});

const n = (over: Partial<AppNotification> = {}): AppNotification => ({
  id: "n1", kind: "reaction", actor_id: "u", actor_username: "meera", actor_avatar_url: null, reaction: "celebrate",
  event_id: "e1", event_kind: "streak_milestone", event_payload: { days: 7 }, challenge_id: null, friendship_id: null,
  payload: {}, comment_preview: null, created_at: "2026-11-21T10:00:00Z", is_read: false, ...over,
});

it("pages with a keyset cursor and drops unknown kinds", async () => {
  rpc.mockResolvedValue({ data: [n({ id: "a" }), n({ id: "b", kind: "future" as never }),
                                  n({ id: "c", created_at: "2026-11-20T00:00:00Z" })], error: null });
  const page = await getNotifications(null, 3);
  expect(rpc).toHaveBeenCalledWith("get_notifications", { p_before_at: null, p_before_id: null, p_limit: 3 });
  expect(page.items.map((x) => x.id)).toEqual(["a", "c"]);
  expect(page.next).toEqual({ beforeAt: "2026-11-20T00:00:00Z", beforeId: "c" });
  rpc.mockResolvedValue({ data: [n()], error: null });
  expect((await getNotifications(page.next, 3)).next).toBeNull();
  expect(rpc).toHaveBeenLastCalledWith("get_notifications",
    { p_before_at: "2026-11-20T00:00:00Z", p_before_id: "c", p_limit: 3 });
});

it("marks one, all, or nothing", async () => {
  await markNotificationsRead(["n1"]);
  await markNotificationsRead();
  await markNotificationsRead([]);
  expect(rpc.mock.calls).toEqual([
    ["mark_notifications_read", { p_ids: ["n1"] }],
    ["mark_notifications_read", { p_ids: null }],
  ]);
});

it("saves preferences without a user id (auth.uid() on the server)", async () => {
  const upsert = jest.fn().mockResolvedValue({ error: null });
  from.mockReturnValue({ upsert });
  await saveNotificationPreferences({ ...DEFAULT_PREFERENCES, reactions: false });
  const [values, opts] = upsert.mock.calls[0];
  expect(values).not.toHaveProperty("user_id");
  expect(values.reactions).toBe(false);
  expect(opts).toEqual({ onConflict: "user_id" });
  expect(DEFAULT_PREFERENCES.push_enabled).toBe(false);
});

it.each([
  [n(), "@meera reacted 🎉 to your 7-day streak"],
  [n({ kind: "comment", comment_preview: "Nice" }), "@meera commented on your 7-day streak: Nice"],
  [n({ kind: "friend_request" }), "@meera sent you a friend request"],
  [n({ kind: "friend_accepted" }), "@meera accepted your friend request"],
  [n({ kind: "challenge_invite", payload: { title: "Walk on 5 days" } }), "@meera invited you to “Walk on 5 days”"],
  [n({ kind: "challenge_starting", payload: { title: "Walk", starts_on: "2026-11-22" } }), "“Walk” starts tomorrow"],
  [n({ kind: "challenge_starting", payload: { title: "Walk", starts_on: "2026-11-21" } }), "“Walk” starts today"],
  [n({ kind: "challenge_completed", payload: { title: "Walk" } }), "You completed “Walk”. Nice consistency!"],
  [n({ kind: "achievement_unlocked", payload: { title: "First week" } }), "Achievement unlocked: First week"],
  [n({ kind: "friend_milestone", payload: { days: 14 } }), "@meera reached a 14-day logging streak"],
])("describes %#", (x, text) => {
  expect(describeNotification(x, "2026-11-21")).toBe(text);
  expect(describeNotification(x, "2026-11-21")).not.toMatch(/kcal|calorie|weight/i);
});

it("deep-links each kind to the right screen", () => {
  expect(notificationTarget(n({ kind: "friend_request" }))).toEqual({ pathname: "/(tabs)/friends", params: { section: "friends" } });
  expect(notificationTarget(n({ kind: "challenge_invite", challenge_id: "c1" })))
    .toEqual({ pathname: "/(tabs)/friends", params: { section: "challenges", challenge: "c1" } });
  expect(notificationTarget(n({ kind: "achievement_unlocked" }))).toEqual({ pathname: "/modals/achievements" });
  expect(notificationTarget(n({ kind: "comment" })))
    .toEqual({ pathname: "/(tabs)/friends", params: { section: "feed", event: "e1", comments: "1" } });
  expect(notificationTarget(n({ kind: "reaction" }))).toEqual({ pathname: "/(tabs)/friends", params: { section: "feed", event: "e1" } });
});
