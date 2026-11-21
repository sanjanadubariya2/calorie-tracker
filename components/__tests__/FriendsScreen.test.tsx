// The Friends tab: activity feed (loading, empty, error, paging, refresh,
// visibility), challenges (discover, join, check-in, duplicate taps, details,
// start with friends, completed) and blocking a friend.
import React from "react";
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import * as feedApi from "@/lib/socialActivity";
import * as chApi from "@/lib/challenges";
import * as socialApi from "@/lib/social";
import * as ixApi from "@/lib/interactions";
import * as ntApi from "@/lib/notifications";
import * as pushApi from "@/lib/pushNotifications";
import { router } from "expo-router";
import FriendsScreen from "@/app/(tabs)/friends";

const mockParams: Record<string, string | undefined> = {};
jest.mock("expo-router", () => ({ router: { push: jest.fn(), replace: jest.fn() }, useLocalSearchParams: () => mockParams }));
jest.mock("@/lib/pushNotifications", () => ({
  pushSupported: jest.fn(() => true),
  getPushStatus: jest.fn(async () => "denied"),
  enablePush: jest.fn(async () => "enabled"),
  disablePush: jest.fn(async () => undefined),
}));
jest.mock("@react-navigation/native", () => {
  const React = jest.requireActual("react");
  return { useFocusEffect: (cb: () => void) => React.useEffect(cb, [cb]) };
});
jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ userId: "me" }) }));
jest.mock("@/lib/api", () => ({
  getProfile: jest.fn(async () => ({ username: "me_user", avatar_url: null })),
  getDailyStatus: jest.fn(async () => ({ consumed: { calories: 0, carbsG: 0, fatG: 0, proteinG: 0 }, targetKcal: 2000 })),
  getDailyTotals: jest.fn(async () => []),
  getStreak: jest.fn(async () => ({ current_streak: 0 })),
}));
jest.mock("@/lib/social", () => ({
  ...jest.requireActual("@/lib/social"),
  getFriendSummaries: jest.fn(),
  getPendingRequests: jest.fn(async () => []),
  getOutgoingRequests: jest.fn(async () => []),
}));
jest.mock("@/lib/socialActivity", () => ({
  ...jest.requireActual("@/lib/socialActivity"),
  getActivityFeed: jest.fn(),
  getSocialSettings: jest.fn(),
  saveSocialSettings: jest.fn(),
  getBlockedUsers: jest.fn(),
  unblockUser: jest.fn(),
  blockUser: jest.fn(),
}));
jest.mock("@/lib/challenges", () => ({
  ...jest.requireActual("@/lib/challenges"),
  getChallengeCatalog: jest.fn(),
  getMyChallenges: jest.fn(),
  getChallengeParticipants: jest.fn(),
  startChallenge: jest.fn(),
  joinChallenge: jest.fn(),
  declineChallenge: jest.fn(),
  leaveChallenge: jest.fn(),
  checkInChallenge: jest.fn(),
}));

jest.setTimeout(20_000);
const f = feedApi as jest.Mocked<typeof feedApi>;
const c = chApi as jest.Mocked<typeof chApi>;
const s = socialApi as jest.Mocked<typeof socialApi>;
const { SocialFeatureUnavailable, DEFAULT_SETTINGS } = jest.requireActual("@/lib/socialActivity") as typeof feedApi;

let r: ReactTestRenderer;
const all = (id: string) => r.root.findAll((n) => n.props.testID === id && typeof n.type !== "string");
const byId = (id: string): ReactTestInstance => {
  const found = all(id);
  if (!found.length) throw new Error(`No element with testID ${id}`);
  return found[0];
};
const exists = (id: string) => all(id).length > 0;
const text = (): string => {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === "object" && "children" in node) {
      const kids = (node as { children: unknown[] | null }).children ?? [];
      if ((node as { type?: string }).type === "Text") out.push(kids.flat(Infinity).filter((k) => typeof k === "string").join(""));
      else kids.forEach(walk);
    }
  };
  walk(r.toJSON());
  return out.join(" | ");
};
const flush = () => act(async () => { await new Promise((res) => setTimeout(res, 0)); });
const press = async (id: string) => { await act(async () => { byId(id).props.onPress(); }); await flush(); };

const event = (i: number, over: Partial<feedApi.ActivityEvent> = {}): feedApi.ActivityEvent => ({
  id: `e${i}`, actor_id: "f1", actor_username: "meera", actor_avatar_url: null, is_me: false,
  kind: "streak_milestone", payload: { days: 7 }, created_at: new Date(Date.now() - i * 3_600_000).toISOString(), ...over,
});

const entry = (over: Partial<chApi.CatalogEntry> = {}): chApi.CatalogEntry => ({
  template_code: "water-5-days", title: "Drink water regularly", description: "Sip water on 5 of 7 days.",
  metric: "checkin_days", cadence: "weekly", duration_days: 7, target_days: 5, checkin_label: "I drank water regularly today",
  safety_note: "Drink to thirst.", app_challenge_id: "app1", starts_on: "2026-11-16", ends_on: "2026-11-22",
  participant_count: 4, my_state: null, ...over,
});

const mineOf = (over: Partial<chApi.MyChallenge> = {}): chApi.MyChallenge => ({
  challenge_id: "c1", template_code: "walk-5-days", title: "Walk on 5 days", description: "A comfortable walk.",
  metric: "checkin_days", cadence: "weekly", kind: "group", starts_on: "2026-11-20", ends_on: "2099-11-26",
  target_days: 5, progress_days: 2, state: "active", checkin_label: "I took a walk today", safety_note: "Rest days are fine.",
  checked_in_today: false, participant_count: 2, invited_by_username: null, completed_at: null, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  f.getActivityFeed.mockResolvedValue({ items: [event(1), event(2, { is_me: true, kind: "achievement", payload: { title: "Logged a first day" } })], next: null });
  f.getSocialSettings.mockResolvedValue({ ...DEFAULT_SETTINGS });
  f.saveSocialSettings.mockResolvedValue();
  f.getBlockedUsers.mockResolvedValue([]);
  f.blockUser.mockResolvedValue();
  c.getChallengeCatalog.mockResolvedValue([entry(), entry({ template_code: "log-today", title: "Log a meal today", app_challenge_id: null, metric: "logged_days", cadence: "daily", duration_days: 1, target_days: 1, checkin_label: null })]);
  c.getMyChallenges.mockResolvedValue([]);
  c.getChallengeParticipants.mockResolvedValue([]);
  s.getFriendSummaries.mockResolvedValue([
    { user_id: "f1", username: "meera", avatar_url: null, current_streak: 3 },
    { user_id: "f2", username: "priya", avatar_url: null, current_streak: null },
  ]);
});

async function render() {
  await act(async () => { r = TestRenderer.create(<FriendsScreen />); });
  await flush();
}

describe("activity feed", () => {
  it("shows skeletons first, then friends' and my milestones with relative times", async () => {
    let resolve!: (p: feedApi.FeedPage) => void;
    f.getActivityFeed.mockReturnValueOnce(new Promise((res) => { resolve = res; }));
    await act(async () => { r = TestRenderer.create(<FriendsScreen />); });
    expect(exists("feed-loading")).toBe(true);
    await act(async () => { resolve({ items: [event(1)], next: null }); });
    await flush();
    expect(exists("feed-loading")).toBe(false);
    expect(text()).toContain("@meera");
    expect(text()).toContain("Reached a 7-day logging streak");
    expect(text()).toContain("1h ago");
    expect(text()).toContain("You're all caught up");
  });

  it("labels my own events as You and says when my activity is private", async () => {
    await render();
    expect(text()).toContain("You");
    expect(text()).toContain("Earned “Logged a first day”");
    expect(text()).toContain("Your activity is private");
  });

  it("has an empty state that leads to finding friends", async () => {
    f.getActivityFeed.mockResolvedValue({ items: [], next: null });
    await render();
    expect(exists("feed-empty")).toBe(true);
    expect(text()).toMatch(/Meals, calories and weight are never shared/);
    await press("feed-find-friends");
    expect(exists("section-friends")).toBe(true);
    expect(text()).toContain("Friends (2)");
  });

  it("shows an error with retry, and a friendly state when the server lacks the feature", async () => {
    f.getActivityFeed.mockRejectedValueOnce(new Error("network"));
    await render();
    expect(exists("feed-error")).toBe(true);
    await press("feed-retry");
    expect(exists("feed-list")).toBe(true);

    f.getActivityFeed.mockRejectedValue(new SocialFeatureUnavailable());
    await render();
    expect(exists("feed-unavailable")).toBe(true);
  });

  it("loads older pages with the cursor and never duplicates an event", async () => {
    const cursor = { beforeAt: "2026-11-20T00:00:00Z", beforeId: "e2" };
    f.getActivityFeed
      .mockResolvedValueOnce({ items: [event(1), event(2)], next: cursor })
      .mockResolvedValueOnce({ items: [event(2), event(3)], next: null });
    await render();
    await press("feed-load-more");
    expect(f.getActivityFeed).toHaveBeenLastCalledWith(cursor);
    expect(all("activity-e2")).toHaveLength(1);
    expect(exists("activity-e3")).toBe(true);
    expect(exists("feed-load-more")).toBe(false);
  });

  it("pull-to-refresh reloads the first page", async () => {
    await render();
    f.getActivityFeed.mockResolvedValueOnce({ items: [event(9, { actor_username: "priya" })], next: null });
    const list = byId("feed-list");
    await act(async () => { await list.props.refreshControl.props.onRefresh(); });
    await flush();
    expect(f.getActivityFeed).toHaveBeenLastCalledWith(null);
    expect(text()).toContain("@priya");
    expect(exists("activity-e1")).toBe(false);
  });

  it("visibility settings: opt-in switch, per-kind switches, and the never-shared note", async () => {
    await render();
    await press("feed-visibility");
    expect(exists("sharing-settings")).toBe(true);
    expect(byId("share-activity").props.value).toBe(false);
    expect(byId("share_streaks").props.disabled).toBe(true);           // off until sharing is on
    expect(text()).toMatch(/Never shared: what you eat, calories, nutrition, weight/);
    await act(async () => { byId("share-activity").props.onValueChange(true); });
    await flush();
    expect(f.saveSocialSettings).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, share_activity: true });
    expect(byId("share_streaks").props.disabled).toBe(false);
    await act(async () => { byId("share_habits").props.onValueChange(false); });
    await flush();
    expect(f.saveSocialSettings).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, share_activity: true, share_habits: false });
    await press("sharing-close");
    expect(f.getActivityFeed).toHaveBeenCalledTimes(2);               // reloaded after a change
  });

  it("reverts a switch when saving fails", async () => {
    f.saveSocialSettings.mockRejectedValue(new Error("x"));
    await render();
    await press("feed-visibility");
    await act(async () => { byId("share-activity").props.onValueChange(true); });
    await flush();
    expect(byId("share-activity").props.value).toBe(false);
    expect(text()).toContain("Couldn't save");
  });

  it("lists blocked users and unblocks them", async () => {
    f.getBlockedUsers.mockResolvedValue([{ user_id: "b1", username: "pest", avatar_url: null }]);
    f.unblockUser.mockResolvedValue();
    await render();
    await press("feed-visibility");
    expect(text()).toContain("@pest");
    await press("unblock-b1");
    expect(f.unblockUser).toHaveBeenCalledWith("b1");
    expect(text()).not.toContain("@pest");
  });
});

describe("challenges", () => {
  async function openChallenges() {
    await render();
    await press("section-challenges");
  }

  it("discover shows this week's app challenges, own-start templates and the safety framing", async () => {
    await openChallenges();
    expect(exists("catalog-water-5-days")).toBe(true);
    expect(exists("catalog-log-today")).toBe(true);
    expect(text()).toContain("4 taking part");
    expect(text()).toContain("Drink to thirst.");
    expect(text()).toMatch(/no calorie, weight or exercise-amount goals, and nobody is ranked/);
  });

  it("joins an app challenge once even if tapped twice", async () => {
    let finish!: () => void;
    c.joinChallenge.mockReturnValueOnce(new Promise<void>((res) => { finish = res; }));
    await openChallenges();
    await act(async () => { byId("join-water-5-days").props.onPress(); byId("join-water-5-days").props.onPress(); });
    expect(c.joinChallenge).toHaveBeenCalledTimes(1);
    expect(c.joinChallenge).toHaveBeenCalledWith("app1");
    c.getChallengeCatalog.mockResolvedValue([entry({ my_state: "active" })]);
    await act(async () => { finish(); });
    await flush();
    expect(exists("joined-water-5-days")).toBe(true);
    expect(text()).toContain("Joined “Drink water regularly”.");
  });

  it("joined list: progress dots, check-in, then 'checked in today'", async () => {
    c.getMyChallenges.mockResolvedValue([mineOf()]);
    c.checkInChallenge.mockResolvedValue(3);
    await openChallenges();
    await press("challenges-tab-joined");
    expect(text()).toContain("2/5");
    expect(text()).toContain("3 more days to go");
    c.getMyChallenges.mockResolvedValue([mineOf({ progress_days: 3, checked_in_today: true })]);
    await press("checkin-c1");
    expect(c.checkInChallenge).toHaveBeenCalledWith("c1");
    expect(exists("checked-in-c1")).toBe(true);
    expect(exists("checkin-c1")).toBe(false);
    expect(text()).toContain("3/5");
  });

  it("log-tracked challenges have no check-in button", async () => {
    c.getMyChallenges.mockResolvedValue([mineOf({ metric: "logged_days", checkin_label: null })]);
    await openChallenges();
    await press("challenges-tab-joined");
    expect(exists("checkin-c1")).toBe(false);
    expect(text()).toContain("Tracked from your meal logs");
  });

  it("shows server errors (e.g. an ended challenge) without crashing", async () => {
    c.getMyChallenges.mockResolvedValue([mineOf()]);
    c.checkInChallenge.mockRejectedValue({ code: "55000", message: "ended" });
    await openChallenges();
    await press("challenges-tab-joined");
    await press("checkin-c1");
    expect(text()).toContain("This challenge has already finished.");
  });

  it("invitations can be accepted or declined", async () => {
    c.getMyChallenges.mockResolvedValue([mineOf({ state: "invited", invited_by_username: "meera" })]);
    c.joinChallenge.mockResolvedValue();
    c.declineChallenge.mockResolvedValue();
    await openChallenges();
    expect(text()).toContain("Invitations");
    expect(text()).toContain("from @meera");
    await press("accept-c1");
    expect(c.joinChallenge).toHaveBeenCalledWith("c1");
    await press("decline-c1");
    expect(c.declineChallenge).toHaveBeenCalledWith("c1");
  });

  it("details list members alphabetically with day counts, and leaving asks first", async () => {
    c.getMyChallenges.mockResolvedValue([mineOf()]);
    c.getChallengeParticipants.mockResolvedValue([
      { user_id: "me", username: "me_user", avatar_url: null, is_me: true, state: "active", progress_days: 2, target_days: 5 },
      { user_id: "f1", username: "meera", avatar_url: null, is_me: false, state: "active", progress_days: 4, target_days: 5 },
    ]);
    c.leaveChallenge.mockResolvedValue();
    await openChallenges();
    await press("challenges-tab-joined");
    await press("challenge-c1");
    expect(exists("challenge-detail")).toBe(true);
    expect(c.getChallengeParticipants).toHaveBeenCalledWith("c1");
    expect(text()).toContain("4/5 days");
    expect(text()).toContain("Rest days are fine.");
    await press("detail-leave");
    expect(c.leaveChallenge).not.toHaveBeenCalled();
    expect(text()).toContain("Leave this challenge?");
  });

  it("app challenges never list other participants", async () => {
    c.getMyChallenges.mockResolvedValue([mineOf({ kind: "app" })]);
    await openChallenges();
    await press("challenges-tab-joined");
    await press("challenge-c1");
    expect(c.getChallengeParticipants).not.toHaveBeenCalled();
    expect(text()).toMatch(/other participants aren't listed/);
  });

  it("starts a challenge with an invited friend, using names only", async () => {
    c.startChallenge.mockResolvedValue("new");
    await openChallenges();
    await press("start-log-today");
    expect(exists("start-challenge")).toBe(true);
    expect(text()).toContain("@meera");
    expect(text()).not.toMatch(/1200|1,200|kcal/);
    await press("invite-f1");
    await press("start-tomorrow");
    await press("start-confirm");
    expect(c.startChallenge).toHaveBeenCalledWith("log-today", ["f1"], expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(exists("start-challenge")).toBe(false);
    expect(exists("joined-empty")).toBe(true);                           // switched to Joined
  });

  it("completed and ended challenges are kept in history", async () => {
    c.getMyChallenges.mockResolvedValue([
      mineOf({ challenge_id: "d1", state: "completed", progress_days: 5, title: "Done one" }),
      mineOf({ challenge_id: "x1", state: "expired", progress_days: 3, title: "Ended one" }),
    ]);
    await openChallenges();
    await press("challenges-tab-completed");
    expect(text()).toContain("Done one");
    expect(text()).toContain("Completed. Nice consistency!");
    expect(text()).toContain("Ended one");
    expect(text()).toContain("Finished with 3 of 5 days");
  });

  it("empty and unavailable states", async () => {
    await openChallenges();
    await press("challenges-tab-joined");
    expect(exists("joined-empty")).toBe(true);
    await press("challenges-tab-completed");
    expect(exists("completed-empty")).toBe(true);
    c.getChallengeCatalog.mockRejectedValue(new SocialFeatureUnavailable());
    await openChallenges();
    expect(exists("challenges-unavailable")).toBe(true);
  });
});

describe("friends section", () => {
  it("long-press offers block, which asks first and then calls block_user", async () => {
    await render();
    await press("section-friends");
    await act(async () => { byId("friend-f1").props.onLongPress(); });
    await press("friend-action-block");
    expect(text()).toContain("Block this person?");
    expect(f.blockUser).not.toHaveBeenCalled();
    const confirm = r.root.findAll((n) => n.props.onConfirm && n.props.visible === true)[0];
    await act(async () => { await confirm.props.onConfirm(); });
    await flush();
    expect(f.blockUser).toHaveBeenCalledWith("f1");
  });
});

// ---------------------------------------------------------------- interactions (Task 5)
jest.mock("@/lib/interactions", () => ({
  ...jest.requireActual("@/lib/interactions"),
  getInteractions: jest.fn(),
  setReaction: jest.fn(),
  removeReaction: jest.fn(),
  getComments: jest.fn(),
  addComment: jest.fn(),
  deleteComment: jest.fn(),
  reportContent: jest.fn(),
}));
jest.mock("@/lib/notifications", () => ({
  ...jest.requireActual("@/lib/notifications"),
  getNotifications: jest.fn(),
  getUnreadCount: jest.fn(),
  markNotificationsRead: jest.fn(),
  getNotificationPreferences: jest.fn(),
  saveNotificationPreferences: jest.fn(),
}));
const nt = ntApi as jest.Mocked<typeof ntApi>;
const pu = pushApi as jest.Mocked<typeof pushApi>;
const ix = ixApi as jest.Mocked<typeof ixApi>;
const counts = (over: Partial<ixApi.EventInteractions> = {}): ixApi.EventInteractions => ({
  counts: { like: 1, celebrate: 0, support: 0, fire: 0 }, mine: null, comments: 0, ...over,
});
const comment = (id: string, over: Partial<ixApi.ActivityComment> = {}): ixApi.ActivityComment => ({
  id, author_id: "f1", author_username: "meera", author_avatar_url: null, is_mine: false, can_delete: false,
  body: `comment ${id}`, created_at: new Date().toISOString(), ...over,
});

beforeEach(() => {
  ix.getInteractions.mockResolvedValue({ e1: counts(), e2: counts({ counts: { like: 0, celebrate: 2, support: 0, fire: 0 } }) });
  ix.setReaction.mockResolvedValue();
  ix.removeReaction.mockResolvedValue();
  ix.getComments.mockResolvedValue([]);
  ix.addComment.mockResolvedValue("new");
  ix.deleteComment.mockResolvedValue();
  ix.reportContent.mockResolvedValue();
  nt.getNotifications.mockResolvedValue({ items: [], next: null });
  nt.getUnreadCount.mockResolvedValue(0);
  nt.markNotificationsRead.mockResolvedValue();
  nt.getNotificationPreferences.mockResolvedValue({ ...ntApi.DEFAULT_PREFERENCES });
  nt.saveNotificationPreferences.mockResolvedValue();
  for (const k of Object.keys(mockParams)) delete mockParams[k];
});

describe("reactions and comments", () => {
  it("shows counts and reacts optimistically", async () => {
    await render();
    expect(ix.getInteractions).toHaveBeenCalledWith(["e1", "e2"]);
    await press("react-e1-fire");
    expect(ix.setReaction).toHaveBeenCalledWith("e1", "fire");
    expect(byId("react-e1-fire").props.accessibilityState).toEqual({ selected: true });
    await press("react-e1-fire");                                    // tap again: unlike
    expect(ix.removeReaction).toHaveBeenCalledWith("e1");
    expect(byId("react-e1-fire").props.accessibilityState).toEqual({ selected: false });
  });

  it("rolls back and explains when the server refuses", async () => {
    ix.setReaction.mockRejectedValue({ code: "P0429" });
    await render();
    await press("react-e1-like");
    expect(byId("react-e1-like").props.accessibilityState).toEqual({ selected: false });
    expect(text()).toContain("You're going a bit fast");
  });

  it("ignores a second tap while the first is in flight", async () => {
    let finish!: () => void;
    ix.setReaction.mockReturnValueOnce(new Promise<void>((res) => { finish = res; }));
    await render();
    await act(async () => { byId("react-e1-like").props.onPress(); byId("react-e1-support").props.onPress(); });
    expect(ix.setReaction).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
  });

  it("my own events show counts but can't be reacted to", async () => {
    await render();
    expect(byId("react-e2-celebrate").props.disabled).toBe(true);
    expect(exists("react-e2-like")).toBe(false);                    // zero counts hidden on my own
  });

  it("comments: validation, posting, deleting my own and reporting others", async () => {
    ix.getComments.mockResolvedValueOnce([comment("c1"), comment("c2", { is_mine: true, can_delete: true, author_username: "me_user" })]);
    await render();
    await press("comments-e1");
    expect(exists("comments-sheet")).toBe(true);
    expect(text()).toContain("comment c1");
    expect(exists("delete-comment-c1")).toBe(false);
    expect(exists("report-comment-c2")).toBe(false);

    expect(byId("comment-post").props.disabled).toBe(true);
    await act(async () => { byId("comment-input").props.onChangeText("x".repeat(281)); });
    expect(byId("comment-post").props.disabled).toBe(true);
    expect(text()).toContain("281/280");
    await act(async () => { byId("comment-input").props.onChangeText("  Keep going!  "); });
    ix.getComments.mockResolvedValueOnce([comment("c3", { is_mine: true, can_delete: true, body: "Keep going!" })]);
    await press("comment-post");
    expect(ix.addComment).toHaveBeenCalledWith("e1", "Keep going!");
    expect(text()).toContain("Keep going!");
    await press("delete-comment-c3");
    expect(ix.deleteComment).toHaveBeenCalledWith("c3");
    expect(exists("comment-c3")).toBe(false);
  });

  it("says who will see a comment before it is posted", async () => {
    await render();
    await press("comments-e1");                                       // meera's milestone
    expect(byId("comment-audience").props.children).toBe(
      "👥 Visible to @meera and to your friends who can see this milestone. Others won't see it.");
    await press("comments-close");
    await press("comments-e2");                                       // my own
    expect(byId("comment-audience").props.children).toBe("👥 Visible to your friends who can see this milestone.");
  });

  it("reports a comment, which then disappears for me", async () => {
    ix.getComments.mockResolvedValue([comment("c1")]);
    await render();
    await press("comments-e1");
    await press("report-comment-c1");
    expect(byId("report-submit").props.disabled).toBe(true);        // a reason is required
    await press("report-harassment");
    await press("report-submit");
    expect(ix.reportContent).toHaveBeenCalledWith("comment", "c1", "harassment");
    expect(text()).toContain("A moderator will review it");
    await press("report-done");
    expect(exists("comment-c1")).toBe(false);
  });

  it("shows server errors when posting (e.g. rate limit) and keeps the draft", async () => {
    ix.addComment.mockRejectedValue({ code: "P0429" });
    await render();
    await press("comments-e1");
    await act(async () => { byId("comment-input").props.onChangeText("Hi"); });
    await press("comment-post");
    expect(byId("comment-error").props.children).toMatch(/a bit fast/);
    expect(byId("comment-input").props.value).toBe("Hi");
  });
});

const notif = (id: string, over: Partial<ntApi.AppNotification> = {}): ntApi.AppNotification => ({
  id, kind: "reaction", actor_id: "f1", actor_username: "meera", actor_avatar_url: null, reaction: "fire",
  event_id: "e2", event_kind: "achievement", event_payload: { title: "First week" }, challenge_id: null, friendship_id: null,
  payload: {}, comment_preview: null, created_at: new Date().toISOString(), is_read: false, ...over,
});

describe("notification center", () => {
  it("shows an unread badge and lists every kind with friendly text", async () => {
    nt.getUnreadCount.mockResolvedValueOnce(2).mockResolvedValue(0);
    nt.getNotifications.mockResolvedValue({ next: null, items: [
      notif("n1"),
      notif("n2", { kind: "friend_request", event_id: null, event_kind: null, event_payload: null, friendship_id: "fr1" }),
      notif("n3", { kind: "challenge_invite", challenge_id: "c1", payload: { title: "Walk on 5 days" } }),
      notif("n4", { kind: "achievement_unlocked", actor_id: null, actor_username: null, payload: { title: "First week" } }),
      notif("n5", { kind: "friend_milestone", payload: { days: 14 }, is_read: true }),
    ] });
    await render();
    expect(exists("unread-badge")).toBe(true);
    await press("open-notifications");
    const t = text();
    expect(t).toContain("@meera reacted 🔥 to “First week”");
    expect(t).toContain("@meera sent you a friend request");
    expect(t).toContain("@meera invited you to “Walk on 5 days”");
    expect(t).toContain("Achievement unlocked: First week");
    expect(t).toContain("@meera reached a 14-day logging streak");
    expect(t).toMatch(/never include what you eat, calories or weight/);
    expect(nt.markNotificationsRead).not.toHaveBeenCalled();          // opening doesn't mark everything read
    expect(exists("unread-n1")).toBe(true);
    expect(exists("unread-n5")).toBe(false);
  });

  it("mark all as read", async () => {
    nt.getNotifications.mockResolvedValue({ next: null, items: [notif("n1")] });
    await render();
    await press("open-notifications");
    await press("mark-all-read");
    expect(nt.markNotificationsRead).toHaveBeenCalledWith();
    expect(exists("unread-n1")).toBe(false);
  });

  it("tapping one marks it read and deep-links to the challenge", async () => {
    nt.getNotifications.mockResolvedValue({ next: null, items: [
      notif("n3", { kind: "challenge_invite", challenge_id: "c1", payload: { title: "Walk on 5 days" } })] });
    c.getMyChallenges.mockResolvedValue([mineOf({ state: "invited", invited_by_username: "meera" })]);
    await render();
    await press("open-notifications");
    await press("notification-n3");
    expect(nt.markNotificationsRead).toHaveBeenCalledWith(["n3"]);
    expect(exists("notifications")).toBe(false);                     // the center closes
    await flush();
    expect(exists("challenge-detail")).toBe(true);                    // opened the challenge
  });

  it("achievement notifications open the achievements screen", async () => {
    nt.getNotifications.mockResolvedValue({ next: null, items: [notif("n4", { kind: "achievement_unlocked", actor_id: null })] });
    await render();
    await press("open-notifications");
    await press("notification-n4");
    expect(router.push).toHaveBeenCalledWith("/modals/achievements");
  });

  it("a comment notification opens that event's comments", async () => {
    nt.getNotifications.mockResolvedValue({ next: null, items: [notif("n6", { kind: "comment", event_id: "e1", comment_preview: "Go!" })] });
    await render();
    await press("open-notifications");
    await press("notification-n6");
    await flush();
    expect(exists("comments-sheet")).toBe(true);
    expect(ix.getComments).toHaveBeenCalledWith("e1");
  });

  it("pages with a cursor", async () => {
    const cursor = { beforeAt: "2026-11-20T00:00:00Z", beforeId: "n1" };
    nt.getNotifications.mockResolvedValueOnce({ items: [notif("n1")], next: cursor })
      .mockResolvedValueOnce({ items: [notif("n1"), notif("n0")], next: null });
    await render();
    await press("open-notifications");
    await press("notifications-more");
    expect(nt.getNotifications).toHaveBeenLastCalledWith(cursor);
    expect(text().match(/reacted/g)).toHaveLength(2);                 // n1 once, plus n0
    expect(exists("notification-n0")).toBe(true);
  });

  it("empty and error states", async () => {
    await render();
    await press("open-notifications");
    expect(exists("notifications-empty")).toBe(true);
    nt.getNotifications.mockRejectedValue(new Error("x"));
    await press("notifications-close");
    await press("open-notifications");
    expect(exists("notifications-retry")).toBe(true);
  });

  it("preferences save per category; push explains when the device blocks it", async () => {
    await render();
    await press("open-notifications");
    await press("notification-settings");
    expect(exists("notification-settings-sheet")).toBe(true);
    await act(async () => { byId("pref-reactions").props.onValueChange(false); });
    await flush();
    expect(nt.saveNotificationPreferences).toHaveBeenCalledWith({ ...ntApi.DEFAULT_PREFERENCES, reactions: false });
    expect(byId("pref-push").props.value).toBe(false);                   // push is off by default
    pu.enablePush.mockResolvedValueOnce("denied");
    await act(async () => { await byId("pref-push").props.onValueChange(true); });
    await flush();
    expect(text()).toContain("blocked for this app in your device settings");
    expect(exists("open-device-settings")).toBe(true);
  });

  it("a deep link from a push opens the right section", async () => {
    mockParams.section = "challenges";
    await render();
    expect(exists("challenges-scroll")).toBe(true);
  });
});

describe("friends list privacy", () => {
  it("shows friends alphabetically with no calories, and a shared or private streak", async () => {
    await render();
    await press("section-friends");
    const t = text();
    // My own total is shown on my card only ("0 / 2000 kcal today"); nothing about friends.
    expect(t.match(/kcal/g)).toHaveLength(1);
    expect(t).toContain("🔥 3-day streak");
    expect(t).toContain("Streak not shared");
    expect(t).toContain("Friends never see your calories, meals or weight");
    expect(t).toContain("🔒 Calories: only you");
    expect(t).toContain("🔒 Activity: private");
    expect(t.indexOf("@meera")).toBeLessThan(t.indexOf("@priya"));
  });

  it("each friend has an accessible options button (not just long-press)", async () => {
    await render();
    await press("section-friends");
    await press("friend-options-f2");
    expect(exists("friend-action-block")).toBe(true);
  });
});

it("a friend's profile can be reported from the long-press menu", async () => {
  await render();
  await press("section-friends");
  await press("friend-options-f1");
  await press("friend-action-report");
  await press("report-spam");
  await press("report-submit");
  expect(ix.reportContent).toHaveBeenCalledWith("profile", "f1", "spam");
});
