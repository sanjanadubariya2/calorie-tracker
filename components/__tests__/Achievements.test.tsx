// Achievements screen and celebration: streak card with kind recovery copy,
// next milestone, locked previews with progress, history, celebrate-once.
import React from "react";
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import * as api from "@/lib/achievements";
import { AchievementsView } from "@/components/achievements/AchievementsView";
import { AchievementCelebration } from "@/components/achievements/AchievementCelebration";

jest.mock("@react-navigation/native", () => {
  const React = jest.requireActual("react");
  return { useFocusEffect: (cb: () => void) => React.useEffect(cb, [cb]) };
});
jest.mock("@/lib/achievements", () => ({
  ...jest.requireActual("@/lib/achievements"),
  getMyAchievements: jest.fn(),
  getStreakSummary: jest.fn(),
  markAchievementsSeen: jest.fn(),
}));

jest.setTimeout(20_000);
const m = api as jest.Mocked<typeof api>;
const { SocialFeatureUnavailable } = jest.requireActual("@/lib/socialActivity");

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

const ach = (code: string, over: Partial<api.Achievement> = {}): api.Achievement => ({
  code, title: code, description: `${code} description`, category: "logging", icon: "⭐", threshold: 5, window_days: null,
  unlocked_at: null, seen_at: null, progress: 0, sort: 10, ...over,
});
const summary: api.StreakSummary = { current_streak: 0, longest_streak: 12, last_logged_date: "2026-11-10", logged_days: 40,
                                     checkins_this_week: 2, challenge_week_run: 1, challenges_completed: 3 };

beforeEach(() => {
  jest.clearAllMocks();
  m.getMyAchievements.mockResolvedValue([
    ach("first_day_logged", { title: "First meal logged", icon: "🍽️", unlocked_at: "2026-11-01T09:00:00Z", seen_at: "2026-11-01T09:00:00Z", progress: 1, threshold: 1 }),
    ach("first_week", { title: "First consistent week", category: "consistency", window_days: 7, progress: 4 }),
    ach("encourager_25", { title: "Encourager", category: "social", threshold: 25, progress: 3 }),
  ]);
  m.getStreakSummary.mockResolvedValue(summary);
  m.markAchievementsSeen.mockResolvedValue();
});

async function render(el: React.ReactElement) {
  await act(async () => { r = TestRenderer.create(el); });
  await flush();
}

it("shows the streak with a welcoming message after a break, never a loss", async () => {
  await render(<AchievementsView />);
  expect(text()).toContain("day streak");
  expect(byId("streak-message").props.children).toBe(
    "Welcome back! Log a meal today to start a new streak. Your best so far is 12 days.");
  expect(text()).toContain("12 days");
  expect(text()).not.toMatch(/lost|broken|failed/i);
});

it("previews locked badges with progress and highlights the next milestone", async () => {
  await render(<AchievementsView />);
  expect(text()).toContain("Badges 1/3");
  expect(text()).toContain("4 of 5 days in the last 7");
  expect(text()).toContain("3 / 25");
  expect(exists("next-milestone")).toBe(true);
  expect(text()).toContain("Next up");
  expect(text().indexOf("First consistent week")).toBeLessThan(text().indexOf("Badges"));
  expect(text()).toContain("🔒");
});

it("history lists unlocks newest first, with an empty state", async () => {
  await render(<AchievementsView />);
  await press("achievements-tab-history");
  expect(exists("history-first_day_logged")).toBe(true);
  expect(exists("history-first_week")).toBe(false);
  m.getMyAchievements.mockResolvedValue([ach("x")]);
  await render(<AchievementsView />);
  await press("achievements-tab-history");
  expect(exists("history-empty")).toBe(true);
});

it("error with retry, and a friendly state when the server lacks the feature", async () => {
  m.getMyAchievements.mockRejectedValueOnce(new Error("net"));
  await render(<AchievementsView />);
  expect(exists("achievements-error")).toBe(true);
  await press("achievements-retry");
  expect(exists("achievements")).toBe(true);
  m.getMyAchievements.mockRejectedValue(new SocialFeatureUnavailable());
  await render(<AchievementsView />);
  expect(exists("achievements-unavailable")).toBe(true);
});

it("celebrates new unlocks one at a time, then marks them seen once", async () => {
  m.getMyAchievements.mockResolvedValue([
    ach("a1", { title: "First week", unlocked_at: "2026-11-21T09:00:00Z" }),
    ach("a2", { title: "Seven days", unlocked_at: "2026-11-21T10:00:00Z" }),
    ach("old", { unlocked_at: "2026-11-01T00:00:00Z", seen_at: "2026-11-01T00:00:00Z" }),
  ]);
  await render(<AchievementCelebration />);
  expect(exists("celebration")).toBe(true);
  expect(text()).toContain("Achievement unlocked");
  expect(text()).toContain("First week");
  expect(text()).toContain("1 of 2");
  await press("celebration-next");
  expect(text()).toContain("Seven days");
  expect(m.markAchievementsSeen).not.toHaveBeenCalled();
  await press("celebration-next");
  expect(m.markAchievementsSeen).toHaveBeenCalledWith(["a1", "a2"]);
  expect(exists("celebration")).toBe(false);
});

it("shows nothing when there is nothing new, or when loading fails", async () => {
  await render(<AchievementCelebration />);
  expect(exists("celebration")).toBe(false);
  m.getMyAchievements.mockRejectedValue(new Error("x"));
  await render(<AchievementCelebration />);
  expect(exists("celebration")).toBe(false);
});
