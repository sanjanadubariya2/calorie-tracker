// Notification center, preferences and deep links (migrations 023 and 026).
//
// Notifications are created only by the database (friend requests, challenge
// invitations and reminders, completions, achievements, friends' reactions,
// comments and shared milestones), never for food logs. Reads re-check
// blocks and visibility on the server. This module only reads, marks read,
// and saves the caller's own preferences.
import { MOCK_MODE, supabase } from "./supabase";
import { SocialFeatureUnavailable, isNotDeployed, type ActivityEvent } from "./socialActivity";
import { REACTIONS, type ReactionType } from "./interactions";
import * as mock from "./mockInteractions";

export type NotificationKind =
  | "reaction" | "comment" | "friend_request" | "friend_accepted" | "challenge_invite" | "challenge_starting"
  | "challenge_completed" | "achievement_unlocked" | "friend_milestone";

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  actor_id: string | null;
  actor_username: string | null;
  actor_avatar_url: string | null;
  reaction: ReactionType | null;
  event_id: string | null;
  event_kind: ActivityEvent["kind"] | null;
  event_payload: ActivityEvent["payload"] | null;
  challenge_id: string | null;
  friendship_id: string | null;
  payload: { title?: string; days?: number; code?: string; starts_on?: string };
  comment_preview: string | null;
  created_at: string;
  is_read: boolean;
}

export interface NotificationCursor {
  beforeAt: string;
  beforeId: string;
}

export interface NotificationPage {
  items: AppNotification[];
  next: NotificationCursor | null;
}

export interface NotificationPreferences {
  friend_requests: boolean;
  challenges: boolean;
  achievements: boolean;
  reactions: boolean;
  comments: boolean;
  friend_milestones: boolean;
  push_enabled: boolean;
}

export const DEFAULT_PREFERENCES: NotificationPreferences = {
  friend_requests: true, challenges: true, achievements: true, reactions: true, comments: true,
  friend_milestones: true, push_enabled: false,
};

export const PREFERENCE_ROWS: { key: Exclude<keyof NotificationPreferences, "push_enabled">; label: string; hint: string }[] = [
  { key: "friend_requests", label: "Friend requests", hint: "New requests and accepted ones" },
  { key: "challenges", label: "Challenges", hint: "Invitations, start reminders, completions" },
  { key: "achievements", label: "Achievements", hint: "When you unlock one" },
  { key: "reactions", label: "Reactions", hint: "Friends reacting to your milestones" },
  { key: "comments", label: "Comments", hint: "Friends commenting on your milestones" },
  { key: "friend_milestones", label: "Friends' milestones", hint: "Streaks of 7+ days that friends share" },
];

export const PAGE_SIZE = 20;
const KINDS: readonly NotificationKind[] = ["reaction", "comment", "friend_request", "friend_accepted", "challenge_invite",
  "challenge_starting", "challenge_completed", "achievement_unlocked", "friend_milestone"];

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await (supabase.rpc as unknown as (
    f: string, a?: Record<string, unknown>
  ) => Promise<{ data: unknown; error: unknown }>)(fn, args);
  if (error) throw isNotDeployed(error) ? new SocialFeatureUnavailable() : error;
  return data as T;
}

export async function getNotifications(cursor: NotificationCursor | null = null, limit = PAGE_SIZE): Promise<NotificationPage> {
  const rows = MOCK_MODE
    ? await mock.mockNotifications()
    : (await rpc<AppNotification[] | null>("get_notifications", {
        p_before_at: cursor?.beforeAt ?? null, p_before_id: cursor?.beforeId ?? null, p_limit: limit,
      })) ?? [];
  const items = rows.filter((n) => KINDS.includes(n.kind)).map((n) => ({ ...n, payload: n.payload ?? {} }));
  const last = rows[rows.length - 1];
  return { items, next: rows.length >= limit && last ? { beforeAt: last.created_at, beforeId: last.id } : null };
}

export async function getUnreadCount(): Promise<number> {
  if (MOCK_MODE) return (await mock.mockNotifications()).filter((n) => !n.is_read).length;
  return Number(await rpc<number>("get_unread_notification_count")) || 0;
}

/** Marks the given notifications read, or all of them when `ids` is omitted. */
export async function markNotificationsRead(ids?: string[]): Promise<void> {
  if (ids && ids.length === 0) return;
  if (MOCK_MODE) return mock.mockMarkRead();
  await rpc("mark_notifications_read", { p_ids: ids ?? null });
}

export async function getNotificationPreferences(): Promise<NotificationPreferences> {
  if (MOCK_MODE) return mock.mockGetPrefs();
  const { data, error } = await supabase.from("notification_preferences")
    .select("friend_requests, challenges, achievements, reactions, comments, friend_milestones, push_enabled")
    .maybeSingle();
  if (error) throw isNotDeployed(error) ? new SocialFeatureUnavailable() : error;
  return data ? { ...DEFAULT_PREFERENCES, ...data } : { ...DEFAULT_PREFERENCES };
}

/** Saves the caller's preferences. user_id defaults to auth.uid() on the server. */
export async function saveNotificationPreferences(p: NotificationPreferences): Promise<void> {
  if (MOCK_MODE) return mock.mockSavePrefs(p);
  const { error } = await supabase.from("notification_preferences").upsert({
    friend_requests: p.friend_requests, challenges: p.challenges, achievements: p.achievements, reactions: p.reactions,
    comments: p.comments, friend_milestones: p.friend_milestones, push_enabled: p.push_enabled,
  }, { onConflict: "user_id" });
  if (error) throw isNotDeployed(error) ? new SocialFeatureUnavailable() : error;
}

// ------------------------------------------------------------------ text and links

function who(n: AppNotification): string {
  return n.actor_username ? `@${n.actor_username}` : "A friend";
}

function startsLabel(startsOn: string | undefined, today: string): string {
  if (!startsOn) return "soon";
  return startsOn <= today ? "today" : "tomorrow";
}

export function describeNotification(n: AppNotification, today: string = localToday()): string {
  const title = n.payload?.title ?? n.event_payload?.title;
  switch (n.kind) {
    case "reaction": {
      const r = REACTIONS.find((x) => x.type === n.reaction);
      return `${who(n)} reacted ${r ? `${r.emoji} ` : ""}to ${activityLabel(n)}`;
    }
    case "comment":
      return `${who(n)} commented on ${activityLabel(n)}${n.comment_preview ? `: ${n.comment_preview}` : ""}`;
    case "friend_request": return `${who(n)} sent you a friend request`;
    case "friend_accepted": return `${who(n)} accepted your friend request`;
    case "challenge_invite": return `${who(n)} invited you to “${title ?? "a challenge"}”`;
    case "challenge_starting": return `“${title ?? "Your challenge"}” starts ${startsLabel(n.payload?.starts_on, today)}`;
    case "challenge_completed": return `You completed “${title ?? "a challenge"}”. Nice consistency!`;
    case "achievement_unlocked": return `Achievement unlocked: ${title ?? "a new badge"}`;
    case "friend_milestone": return `${who(n)} reached a ${n.payload?.days ?? n.event_payload?.days ?? ""}-day logging streak`;
  }
}

function activityLabel(n: AppNotification): string {
  if (n.event_payload?.title) return `“${n.event_payload.title}”`;
  if (n.event_kind === "streak_milestone" && n.event_payload?.days) return `your ${n.event_payload.days}-day streak`;
  if (n.event_kind === "habit_milestone") return "your logging milestone";
  return "your activity";
}

export function notificationIcon(kind: NotificationKind): string {
  switch (kind) {
    case "reaction": return "👏";
    case "comment": return "💬";
    case "friend_request": return "👋";
    case "friend_accepted": return "🤝";
    case "challenge_invite": return "🎯";
    case "challenge_starting": return "⏰";
    case "challenge_completed": return "🎉";
    case "achievement_unlocked": return "🏅";
    case "friend_milestone": return "🔥";
  }
}

export type NotificationTarget =
  | { pathname: "/(tabs)/friends"; params: { section: "friends" | "challenges" | "feed"; challenge?: string; event?: string; comments?: string } }
  | { pathname: "/modals/achievements"; params?: undefined };

/** Where tapping a notification (in the app or on the lock screen) leads. */
export function notificationTarget(n: Pick<AppNotification, "kind" | "challenge_id" | "event_id">): NotificationTarget {
  switch (n.kind) {
    case "friend_request":
    case "friend_accepted":
      return { pathname: "/(tabs)/friends", params: { section: "friends" } };
    case "challenge_invite":
    case "challenge_starting":
    case "challenge_completed":
      return { pathname: "/(tabs)/friends", params: { section: "challenges", ...(n.challenge_id ? { challenge: n.challenge_id } : {}) } };
    case "achievement_unlocked":
      return { pathname: "/modals/achievements" };
    default:
      return { pathname: "/(tabs)/friends", params: {
        section: "feed", ...(n.event_id ? { event: n.event_id } : {}), ...(n.kind === "comment" ? { comments: "1" } : {}) } };
  }
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
