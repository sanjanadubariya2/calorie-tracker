// Mock-mode counterpart to lib/socialActivity.ts (in memory; resets on reload).
import type { BlockedUser, FeedCursor, SocialSettings } from "./socialActivity";

type Row = Record<string, unknown>;

const HOUR = 3_600_000;

function seedFeed(): Row[] {
  const now = Date.now();
  const ev = (i: number, actor: string, username: string, kind: string, payload: object, hoursAgo: number): Row => ({
    id: `mock-ev-${i}`, actor_id: actor, actor_username: username, actor_avatar_url: null,
    is_me: actor === "mock-me", kind, payload, created_at: new Date(now - hoursAgo * HOUR).toISOString(),
  });
  return [
    ev(1, "mock-friend-1", "meera_runs", "streak_milestone", { days: 7 }, 0.2),
    ev(2, "mock-friend-3", "priya", "challenge_completed", { title: "Walk on 5 days", target_days: 5 }, 3),
    ev(3, "mock-me", "you", "achievement", { code: "first_day_logged", title: "Logged a first day" }, 20),
    ev(4, "mock-friend-2", "arjun_lifts", "challenge_joined", { title: "Log breakfast on 5 days", target_days: 5 }, 30),
    ev(5, "mock-friend-3", "priya", "habit_milestone", { days: 30 }, 50),
    ev(6, "mock-friend-1", "meera_runs", "achievement", { code: "first_challenge", title: "Completed a first challenge" }, 120),
    ev(7, "mock-friend-3", "priya", "streak_milestone", { days: 14 }, 200),
  ];
}

let feed: Row[] | null = null;
let settings: SocialSettings = {
  share_activity: false, share_streaks: true, share_habits: true, share_achievements: true, share_challenges: true,
};
let blocked: BlockedUser[] = [];

export async function mockGetFeed(cursor: FeedCursor | null, limit: number): Promise<Row[]> {
  feed ??= seedFeed();
  const hidden = new Set(blocked.map((b) => b.user_id));
  const sorted = [...feed]
    .filter((r) => !hidden.has(String(r.actor_id)))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)));
  const start = cursor
    ? sorted.findIndex((r) => String(r.created_at) < cursor.beforeAt
        || (r.created_at === cursor.beforeAt && String(r.id) < cursor.beforeId))
    : 0;
  return start < 0 ? [] : sorted.slice(start, start + limit);
}

export async function mockGetSettings(): Promise<SocialSettings> {
  return { ...settings };
}

export async function mockSaveSettings(next: SocialSettings): Promise<void> {
  settings = { ...next };
}

export async function mockBlock(userId: string): Promise<void> {
  if (!blocked.some((b) => b.user_id === userId)) blocked = [...blocked, { user_id: userId, username: null, avatar_url: null }];
}

export async function mockUnblock(userId: string): Promise<void> {
  blocked = blocked.filter((b) => b.user_id !== userId);
}

export async function mockGetBlocked(): Promise<BlockedUser[]> {
  return [...blocked];
}
