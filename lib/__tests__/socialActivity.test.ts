// Feed client: request shapes, paging, the event whitelist, settings writes.
// Visibility itself is enforced by the database (supabase/tests/021_social_activity.test.sql).
import { supabase } from "../supabase";
import {
  DEFAULT_SETTINGS,
  SocialFeatureUnavailable,
  blockUser,
  describeActivity,
  getActivityFeed,
  getSocialSettings,
  mergeFeed,
  saveSocialSettings,
  type ActivityEvent,
} from "../socialActivity";

jest.mock("../supabase", () => ({ MOCK_MODE: false, supabase: { rpc: jest.fn(), from: jest.fn() } }));
const rpc = supabase.rpc as unknown as jest.Mock;
const from = supabase.from as unknown as jest.Mock;

const row = (i: number, kind = "streak_milestone", payload: object = { days: 7 }) => ({
  id: `e${i}`, actor_id: "u1", actor_username: "meera", actor_avatar_url: null, is_me: false, kind, payload,
  created_at: new Date(Date.UTC(2026, 10, 21, 12, 0, 0) - i * 60_000).toISOString(),
});

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
});

describe("getActivityFeed", () => {
  it("asks for the first page with no cursor and never sends a user id", async () => {
    rpc.mockResolvedValue({ data: [row(1)], error: null });
    const page = await getActivityFeed();
    expect(rpc).toHaveBeenCalledWith("get_activity_feed", { p_before_at: undefined, p_before_id: undefined, p_limit: 20 });
    expect(JSON.stringify(rpc.mock.calls[0])).not.toMatch(/user/);
    expect(page.items).toHaveLength(1);
    expect(page.next).toBeNull();                        // fewer than a page: nothing older
  });

  it("returns a keyset cursor from the last row of a full page", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => row(i));
    rpc.mockResolvedValue({ data: rows, error: null });
    const page = await getActivityFeed(null, 3);
    expect(page.next).toEqual({ beforeAt: rows[2].created_at, beforeId: "e2" });
    rpc.mockResolvedValue({ data: [], error: null });
    await getActivityFeed(page.next, 3);
    expect(rpc).toHaveBeenLastCalledWith("get_activity_feed", { p_before_at: rows[2].created_at, p_before_id: "e2", p_limit: 3 });
  });

  it("drops unknown kinds and any payload field outside the whitelist", async () => {
    rpc.mockResolvedValue({
      data: [row(1, "weight_update", { kg: 70 }), row(2, "achievement", { code: "x", title: "T", kcal: 1800 })],
      error: null,
    });
    const { items } = await getActivityFeed();
    expect(items.map((e) => e.id)).toEqual(["e2"]);
    expect(JSON.stringify(items[0].payload)).not.toMatch(/kcal|1800/);
  });

  it("keeps paging even when a whole page was unknown kinds", async () => {
    rpc.mockResolvedValue({ data: [row(1, "future_kind", {}), row(2, "future_kind", {})], error: null });
    const page = await getActivityFeed(null, 2);
    expect(page.items).toEqual([]);
    expect(page.next).not.toBeNull();
  });

  it("maps a missing function (migration not applied) to SocialFeatureUnavailable", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "not found" } });
    await expect(getActivityFeed()).rejects.toBeInstanceOf(SocialFeatureUnavailable);
    rpc.mockResolvedValue({ data: null, error: { code: "28000", message: "Not authenticated" } });
    await expect(getActivityFeed()).rejects.toMatchObject({ code: "28000" });
  });
});

it("mergeFeed appends without duplicates", () => {
  const a = { id: "1" } as ActivityEvent;
  const b = { id: "2" } as ActivityEvent;
  expect(mergeFeed([a, b], [b, { id: "3" } as ActivityEvent]).map((e) => e.id)).toEqual(["1", "2", "3"]);
});

describe("describeActivity", () => {
  const ev = (kind: ActivityEvent["kind"], payload: ActivityEvent["payload"]) =>
    ({ ...row(1), kind, payload }) as unknown as ActivityEvent;
  it.each([
    [ev("streak_milestone", { days: 7 }), "Reached a 7-day logging streak"],
    [ev("habit_milestone", { days: 30 }), "Has logged meals on 30 days"],
    [ev("achievement", { title: "Completed a first challenge" }), "Earned “Completed a first challenge”"],
    [ev("challenge_joined", { title: "Walk on 5 days" }), "Joined the challenge “Walk on 5 days”"],
    [ev("challenge_completed", {}), "Completed the challenge “a challenge”"],
  ])("%#", (e, title) => {
    expect(describeActivity(e).title).toBe(title);
  });
  it("never mentions food, calories or weight", () => {
    for (const k of ["streak_milestone", "habit_milestone", "achievement", "challenge_joined", "challenge_completed"] as const) {
      expect(describeActivity(ev(k, { days: 3, title: "X" })).title).not.toMatch(/kcal|calorie|weight|kg/i);
    }
  });
});

describe("settings", () => {
  it("defaults to private when no row exists", async () => {
    const maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
    from.mockReturnValue({ select: () => ({ maybeSingle }) });
    expect(await getSocialSettings()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.share_activity).toBe(false);
  });

  it("upserts only the share columns (user_id comes from auth.uid())", async () => {
    const upsert = jest.fn().mockResolvedValue({ error: null });
    from.mockReturnValue({ upsert });
    await saveSocialSettings({ ...DEFAULT_SETTINGS, share_activity: true });
    expect(from).toHaveBeenCalledWith("social_settings");
    const [values, options] = upsert.mock.calls[0];
    expect(Object.keys(values).sort()).toEqual(
      ["share_achievements", "share_activity", "share_challenges", "share_habits", "share_streaks"]);
    expect(options).toEqual({ onConflict: "user_id" });
  });
});

it("blocks through the RPC", async () => {
  rpc.mockResolvedValue({ data: null, error: null });
  await blockUser("u9");
  expect(rpc).toHaveBeenCalledWith("block_user", { p_user_id: "u9" });
});
