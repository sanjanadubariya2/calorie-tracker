// Mock-mode streak rules. These mirror recalculate_user_streak() and
// effective_current_streak() in supabase/migrations/004_server_streaks.sql,
// which supabase/tests/004_server_streaks.test.sql covers on the database side.
import {
  STREAK_MILESTONES,
  computeStreakRuns,
  effectiveCurrentStreak,
  localISODate,
  milestoneCount,
} from "../streaks";

const T = "2026-11-20";
const current = (dates: string[], today = T) => effectiveCurrentStreak(computeStreakRuns(dates, today), today);

describe("computeStreakRuns / effectiveCurrentStreak", () => {
  it("first log -> 1", () => expect(current([T])).toBe(1));
  it("several logs on one day count once", () => expect(current([T, T, T])).toBe(1));
  it("consecutive days add up", () => expect(current(["2026-11-18", "2026-11-19", T])).toBe(3));
  it("a run ending yesterday is still live", () => expect(current(["2026-11-18", "2026-11-19"])).toBe(2));
  it("a run ending before yesterday has lapsed", () => expect(current(["2026-11-17", "2026-11-18"])).toBe(0));
  it("order of input doesn't matter", () => expect(current([T, "2026-11-18", "2026-11-19"])).toBe(3));

  it("an isolated backdated day does not inflate the current run", () => {
    expect(computeStreakRuns(["2026-11-01", "2026-11-19", T], T)).toEqual({
      lastLoggedDate: T,
      runEndingAtLast: 2,
      longest: 2,
    });
  });

  it("backfilling a gap joins two runs", () => {
    expect(current(["2026-11-16", "2026-11-17", "2026-11-19", T])).toBe(2);
    expect(current(["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", T])).toBe(5);
  });

  it("tracks the longest run separately from the current one", () => {
    const runs = computeStreakRuns(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", T], T);
    expect(runs.longest).toBe(4);
    expect(runs.runEndingAtLast).toBe(1);
  });

  it("ignores dates after today", () => {
    expect(computeStreakRuns([T, "2026-11-21"], T).lastLoggedDate).toBe(T);
  });

  it("counts across month and year boundaries", () => {
    expect(current(["2026-10-30", "2026-10-31", "2026-11-01"], "2026-11-01")).toBe(3);
    expect(current(["2025-12-31", "2026-01-01"], "2026-01-01")).toBe(2);
  });

  it("no logs -> nothing", () => {
    expect(computeStreakRuns([], T)).toEqual({ lastLoggedDate: null, runEndingAtLast: 0, longest: 0 });
    expect(current([])).toBe(0);
  });
});

describe("milestones", () => {
  it("matches the SQL milestone list", () => {
    expect([...STREAK_MILESTONES]).toEqual([3, 7, 14, 30, 60, 100, 180, 365]);
  });

  it("counts milestones reached", () => {
    expect([0, 2, 3, 6, 7, 29, 30, 365, 1000].map(milestoneCount)).toEqual([0, 0, 1, 1, 2, 3, 4, 8, 8]);
  });
});

describe("localISODate", () => {
  it("uses the local calendar date", () => {
    expect(localISODate(new Date(2026, 10, 20, 23, 59))).toBe("2026-11-20");
    expect(localISODate(new Date(2026, 0, 1, 0, 0))).toBe("2026-01-01");
  });
});
