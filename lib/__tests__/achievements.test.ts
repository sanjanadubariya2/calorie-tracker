// Achievements client: RPC shapes and view helpers. Awarding, duplicates,
// time zones and backdating are enforced by the database
// (supabase/tests/024_achievements.test.sql and tests/concurrency/).
import { supabase } from "../supabase";
import {
  achievementHistory,
  getMyAchievements,
  getStreakSummary,
  groupByCategory,
  markAchievementsSeen,
  nextMilestone,
  pendingCelebrations,
  progressLabel,
  streakMessage,
  type Achievement,
} from "../achievements";

jest.mock("../supabase", () => ({ MOCK_MODE: false, supabase: { rpc: jest.fn() } }));
const rpc = supabase.rpc as unknown as jest.Mock;
beforeEach(() => rpc.mockReset());

const a = (code: string, over: Partial<Achievement> = {}): Achievement => ({
  code, title: code, description: "", category: "logging", icon: "⭐", threshold: 5, window_days: null,
  unlocked_at: null, seen_at: null, progress: 0, sort: 10, ...over,
});

it("reads achievements and coerces numbers; marking seen sends only codes", async () => {
  rpc.mockResolvedValue({ data: [{ ...a("x"), threshold: "7", progress: "3", sort: "20" }], error: null });
  const [x] = await getMyAchievements();
  expect([x.threshold, x.progress, x.sort]).toEqual([7, 3, 20]);
  rpc.mockResolvedValue({ data: null, error: null });
  await markAchievementsSeen(["x", "y"]);
  expect(rpc).toHaveBeenLastCalledWith("mark_achievements_seen", { p_codes: ["x", "y"] });
  rpc.mockClear();
  await markAchievementsSeen([]);
  expect(rpc).not.toHaveBeenCalled();
});

it("returns a zeroed summary when the server has no streak row yet", async () => {
  rpc.mockResolvedValue({ data: [], error: null });
  expect(await getStreakSummary()).toMatchObject({ current_streak: 0, longest_streak: 0, logged_days: 0 });
});

it("pending celebrations: unlocked, unseen, oldest first", () => {
  const list = [
    a("seen", { unlocked_at: "2026-11-01T00:00:00Z", seen_at: "2026-11-01T00:00:00Z" }),
    a("new2", { unlocked_at: "2026-11-21T10:00:00Z" }),
    a("new1", { unlocked_at: "2026-11-21T09:00:00Z" }),
    a("locked"),
  ];
  expect(pendingCelebrations(list).map((x) => x.code)).toEqual(["new1", "new2"]);
  expect(achievementHistory(list).map((x) => x.code)).toEqual(["new2", "new1", "seen"]);
});

it("next milestone is the locked one closest to done", () => {
  const list = [a("far", { progress: 1, threshold: 50 }), a("close", { progress: 4, threshold: 5 }),
                a("done", { unlocked_at: "2026-01-01T00:00:00Z" })];
  expect(nextMilestone(list)?.code).toBe("close");
  expect(nextMilestone([a("done", { unlocked_at: "x" })])).toBeNull();
});

it("groups by category in a fixed order, sorted", () => {
  const g = groupByCategory([a("s", { category: "social" }), a("l2", { sort: 20 }), a("l1", { sort: 5 })]);
  expect(g.map((x) => x.category)).toEqual(["logging", "social"]);
  expect(g[0].items.map((x) => x.code)).toEqual(["l1", "l2"]);
  expect(g[1].label).toBe("Encouragement");
});

it("progress labels", () => {
  expect(progressLabel(a("w", { window_days: 7, progress: 3 }))).toBe("3 of 5 days in the last 7");
  expect(progressLabel(a("t", { progress: 2 }))).toBe("2 / 5");
  expect(progressLabel(a("u", { unlocked_at: "x" }))).toBe("Unlocked");
});

it("streak messages welcome people back and never shame", () => {
  expect(streakMessage({ current_streak: 0, longest_streak: 0 })).toMatch(/start your first streak/);
  expect(streakMessage({ current_streak: 0, longest_streak: 12 })).toBe(
    "Welcome back! Log a meal today to start a new streak. Your best so far is 12 days.");
  expect(streakMessage({ current_streak: 9, longest_streak: 9 })).toMatch(/best run yet/);
  expect(streakMessage({ current_streak: 3, longest_streak: 9 })).toMatch(/and counting/);
  for (const [c, l] of [[0, 0], [0, 5], [1, 5], [3, 9], [9, 9]]) {
    expect(streakMessage({ current_streak: c, longest_streak: l })).not.toMatch(/lost|broke|fail|missed|shame|behind/i);
  }
});
