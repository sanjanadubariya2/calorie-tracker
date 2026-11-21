// Mock-mode counterpart to lib/interactions.ts (in memory; resets on reload).
import type { ActivityComment, ReactionType } from "./interactions";
import type { AppNotification, NotificationPreferences } from "./notifications";

const reactions = new Map<string, ReactionType>();          // my reaction per event
const comments = new Map<string, ActivityComment[]>();
let seq = 0;
let read = false;
let prefs: NotificationPreferences = {
  friend_requests: true, challenges: true, achievements: true, reactions: true, comments: true,
  friend_milestones: true, push_enabled: false,
};

export async function mockInteractions(ids: string[]): Promise<Record<string, unknown>[]> {
  return ids.map((id, i) => {
    const mine = reactions.get(id) ?? null;
    const base = { like: i % 3, celebrate: (i + 1) % 2, support: 0, fire: i % 2 };
    if (mine) base[mine] += 1;
    return { event_id: id, like_count: base.like, celebrate_count: base.celebrate, support_count: base.support,
             fire_count: base.fire, my_reaction: mine, comment_count: comments.get(id)?.length ?? 0 };
  });
}

export async function mockSetReaction(id: string, r: ReactionType): Promise<void> {
  reactions.set(id, r);
}

export async function mockRemoveReaction(id: string): Promise<void> {
  reactions.delete(id);
}

export async function mockComments(id: string): Promise<ActivityComment[]> {
  return [...(comments.get(id) ?? [])];
}

export async function mockAddComment(id: string, body: string): Promise<string> {
  const c: ActivityComment = { id: `mock-c-${++seq}`, author_id: "mock-me", author_username: null, author_avatar_url: null,
                               is_mine: true, can_delete: true, body, created_at: new Date().toISOString() };
  comments.set(id, [...(comments.get(id) ?? []), c]);
  return c.id;
}

export async function mockDeleteComment(commentId: string): Promise<void> {
  for (const [k, v] of comments) comments.set(k, v.filter((c) => c.id !== commentId));
}

export async function mockNotifications(): Promise<AppNotification[]> {
  return [{
    id: "mock-n-1", kind: "reaction", actor_id: "mock-friend-1", actor_username: "meera_runs", actor_avatar_url: null,
    reaction: "celebrate", event_id: "mock-ev-3", event_kind: "achievement", event_payload: { title: "First meal logged" },
    challenge_id: null, friendship_id: null, payload: {},
    comment_preview: null, created_at: new Date(Date.now() - 3_600_000).toISOString(), is_read: read,
  }, {
    id: "mock-n-2", kind: "friend_request", actor_id: "mock-friend-4", actor_username: "dev_eats", actor_avatar_url: null,
    reaction: null, event_id: null, event_kind: null, event_payload: null, challenge_id: null, friendship_id: "mock-req-1",
    payload: {}, comment_preview: null, created_at: new Date(Date.now() - 7_200_000).toISOString(), is_read: read,
  }];
}

export async function mockMarkRead(): Promise<void> {
  read = true;
}

export async function mockGetPrefs(): Promise<NotificationPreferences> {
  return { ...prefs };
}

export async function mockSavePrefs(next: NotificationPreferences): Promise<void> {
  prefs = { ...next };
}
