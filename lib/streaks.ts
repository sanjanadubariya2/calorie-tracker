// Streak rules shared by mock mode. Production computes the same thing in
// Postgres (supabase/migrations/004_server_streaks.sql); keep the two in step.

import { toISODate } from "./dates";

/** Consecutive-day milestones that each award one badge. Mirrors streak_milestone_count(). */
export const STREAK_MILESTONES = [3, 7, 14, 30, 60, 100, 180, 365] as const;

export function milestoneCount(days: number): number {
  return STREAK_MILESTONES.filter((m) => m <= days).length;
}

/** YYYY-MM-DD in the device's local calendar (alias of dates.toISODate). */
export const localISODate = toISODate;

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  // UTC arithmetic on a calendar date: no DST or zone effects.
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

export interface StreakRuns {
  /** Most recent active date not after `today`, or null. */
  lastLoggedDate: string | null;
  /** Length of the run ending on lastLoggedDate. */
  runEndingAtLast: number;
  longest: number;
}

/**
 * Gaps-and-islands over distinct dates, the same algorithm as
 * recalculate_user_streak(). Dates after `today` are ignored.
 */
export function computeStreakRuns(loggedDates: Iterable<string>, today: string): StreakRuns {
  const days = [...new Set(loggedDates)]
    .filter((d) => d <= today)
    .map(dayNumber)
    .sort((a, b) => a - b);

  let longest = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && days[i] === days[i - 1] + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }

  const lastLoggedDate = [...new Set(loggedDates)].filter((d) => d <= today).sort().pop() ?? null;
  return { lastLoggedDate, runEndingAtLast: days.length ? run : 0, longest };
}

/** The streak as of `today`: the run if it ended today or yesterday, else 0. */
export function effectiveCurrentStreak(runs: StreakRuns, today: string): number {
  if (!runs.lastLoggedDate) return 0;
  return dayNumber(today) - dayNumber(runs.lastLoggedDate) <= 1 ? runs.runEndingAtLast : 0;
}
