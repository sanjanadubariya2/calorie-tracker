// Achievements and streak summary (migration 024).
//
// Everything authoritative is computed by the database: unlocks are awarded by
// evaluate_achievements from server records (on-time meal logs, check-ins,
// challenge completions, reactions) and never revoked. This module only reads
// them and marks celebrations as seen.
import { MOCK_MODE, supabase } from "./supabase";
import { SocialFeatureUnavailable, isNotDeployed } from "./socialActivity";
import * as mock from "./mockAchievements";

export type AchievementCategory = "logging" | "consistency" | "habits" | "challenges" | "social";

export interface Achievement {
  code: string;
  title: string;
  description: string;
  category: AchievementCategory;
  icon: string;
  threshold: number;
  window_days: number | null;
  unlocked_at: string | null;
  seen_at: string | null;
  /** Progress towards the threshold (for windows: the current window ending today). */
  progress: number;
  sort: number;
}

export interface StreakSummary {
  current_streak: number;
  longest_streak: number;
  last_logged_date: string | null;
  logged_days: number;
  checkins_this_week: number;
  challenge_week_run: number;
  challenges_completed: number;
}

export const CATEGORY_LABELS: Record<AchievementCategory, string> = {
  logging: "Logging",
  consistency: "Consistency",
  habits: "Habits",
  challenges: "Challenges",
  social: "Encouragement",
};
const CATEGORY_ORDER: AchievementCategory[] = ["logging", "consistency", "habits", "challenges", "social"];

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await (supabase.rpc as unknown as (
    f: string, a?: Record<string, unknown>
  ) => Promise<{ data: unknown; error: unknown }>)(fn, args);
  if (error) throw isNotDeployed(error) ? new SocialFeatureUnavailable() : error;
  return data as T;
}

export async function getMyAchievements(): Promise<Achievement[]> {
  if (MOCK_MODE) return mock.mockAchievements();
  const rows = (await rpc<Achievement[] | null>("get_my_achievements")) ?? [];
  return rows.map((r) => ({
    ...r,
    threshold: Number(r.threshold) || 1,
    progress: Number(r.progress) || 0,
    sort: Number(r.sort) || 0,
  }));
}

export async function getStreakSummary(): Promise<StreakSummary> {
  if (MOCK_MODE) return mock.mockSummary();
  const rows = (await rpc<StreakSummary[] | null>("get_streak_summary")) ?? [];
  const r = rows[0];
  return {
    current_streak: Number(r?.current_streak) || 0,
    longest_streak: Number(r?.longest_streak) || 0,
    last_logged_date: r?.last_logged_date ?? null,
    logged_days: Number(r?.logged_days) || 0,
    checkins_this_week: Number(r?.checkins_this_week) || 0,
    challenge_week_run: Number(r?.challenge_week_run) || 0,
    challenges_completed: Number(r?.challenges_completed) || 0,
  };
}

export async function markAchievementsSeen(codes: string[]): Promise<void> {
  if (!codes.length) return;
  if (MOCK_MODE) return mock.mockMarkSeen(codes);
  await rpc("mark_achievements_seen", { p_codes: codes });
}

// ------------------------------------------------------------------ view helpers

/** Unlocked but not yet celebrated, oldest first. */
export function pendingCelebrations(list: Achievement[]): Achievement[] {
  return list
    .filter((a) => a.unlocked_at && !a.seen_at)
    .sort((a, b) => String(a.unlocked_at).localeCompare(String(b.unlocked_at)));
}

export function groupByCategory(list: Achievement[]): { category: AchievementCategory; label: string; items: Achievement[] }[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    items: list.filter((a) => a.category === category).sort((a, b) => a.sort - b.sort),
  })).filter((g) => g.items.length > 0);
}

/** Unlocked, newest first. */
export function achievementHistory(list: Achievement[]): Achievement[] {
  return list
    .filter((a) => a.unlocked_at)
    .sort((a, b) => String(b.unlocked_at).localeCompare(String(a.unlocked_at)));
}

/** The locked achievement closest to done (by fraction), to show as "next up". */
export function nextMilestone(list: Achievement[]): Achievement | null {
  const locked = list.filter((a) => !a.unlocked_at);
  if (!locked.length) return null;
  return [...locked].sort((a, b) => {
    const fa = a.progress / a.threshold;
    const fb = b.progress / b.threshold;
    return fb - fa || a.threshold - a.progress - (b.threshold - b.progress) || a.sort - b.sort;
  })[0];
}

export function progressLabel(a: Achievement): string {
  if (a.unlocked_at) return "Unlocked";
  if (a.window_days) return `${a.progress} of ${a.threshold} days in the last ${a.window_days}`;
  return `${a.progress} / ${a.threshold}`;
}

/**
 * The line under the streak. Kind in every state: a broken streak is a fresh
 * start, never a loss, and the best run stays on record.
 */
export function streakMessage(s: Pick<StreakSummary, "current_streak" | "longest_streak">): string {
  if (s.current_streak === 0 && s.longest_streak === 0) return "Log a meal today to start your first streak.";
  if (s.current_streak === 0) {
    return `Welcome back! Log a meal today to start a new streak. Your best so far is ${s.longest_streak} day${s.longest_streak === 1 ? "" : "s"}.`;
  }
  if (s.current_streak === 1) return "Day one. A great place to start.";
  if (s.current_streak >= s.longest_streak) return `${s.current_streak} days, your best run yet!`;
  return `${s.current_streak} days and counting. Your best is ${s.longest_streak}.`;
}

export function formatUnlockDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
