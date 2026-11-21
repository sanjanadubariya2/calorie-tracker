// Mock-mode counterpart to lib/achievements.ts (in memory; resets on reload).
import type { Achievement, StreakSummary } from "./achievements";

const A = (code: string, title: string, description: string, category: Achievement["category"], icon: string,
           threshold: number, progress: number, sort: number, window_days: number | null = null,
           unlocked = false): Achievement => ({
  code, title, description, category, icon, threshold, window_days, sort,
  progress: unlocked ? threshold : progress,
  unlocked_at: unlocked ? new Date(Date.now() - sort * 86_400_000).toISOString() : null,
  seen_at: unlocked ? new Date().toISOString() : null,
});

let list: Achievement[] = [
  A("first_day_logged", "First meal logged", "Log your first meal or snack.", "logging", "🍽️", 1, 1, 10, null, true),
  A("first_week", "First consistent week", "Log meals on 5 days within a 7-day stretch.", "consistency", "🌱", 5, 3, 20, 7),
  A("consistency_7", "7-day consistency", "Log meals 7 days in a row.", "consistency", "🔥", 7, 3, 30, 7),
  A("consistency_30", "30-day consistency", "Log meals on 25 days within a 30-day stretch. Days off are fine.",
    "consistency", "🏆", 25, 6, 40, 30),
  A("logged_50", "50 days logged", "Log meals on 50 different days.", "logging", "📅", 50, 6, 50),
  A("comeback", "Back on track", "Pick logging back up after a few days off.", "consistency", "🌤️", 1, 0, 70),
  A("first_checkin", "First habit check-in", "Check in to a habit challenge.", "habits", "✅", 1, 0, 80),
  A("first_challenge", "First challenge completed", "Complete a challenge.", "challenges", "🎯", 1, 0, 100),
  A("first_encouragement", "First encouragement", "React to a friend's milestone.", "social", "👏", 1, 0, 130),
];

export async function mockAchievements(): Promise<Achievement[]> {
  return list.map((a) => ({ ...a }));
}

export async function mockSummary(): Promise<StreakSummary> {
  return { current_streak: 3, longest_streak: 5, last_logged_date: null, logged_days: 6, checkins_this_week: 0,
           challenge_week_run: 0, challenges_completed: 0 };
}

export async function mockMarkSeen(codes: string[]): Promise<void> {
  list = list.map((a) => (codes.includes(a.code) && !a.seen_at ? { ...a, seen_at: new Date().toISOString() } : a));
}
