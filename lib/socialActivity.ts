// Activity feed, sharing settings and blocking (migration 021).
//
// The database decides what each person may see: get_activity_feed returns
// only the caller's own events plus those of accepted, unblocked friends who
// opted in for that kind of event. Events never carry food, nutrition, weight
// or health data; the payload is limited to a day count, an achievement or a
// challenge title (activity_payload_ok in 021).
import { MOCK_MODE, supabase } from "./supabase";
import * as mock from "./mockSocialActivity";

export type ActivityKind =
  | "streak_milestone"
  | "habit_milestone"
  | "achievement"
  | "challenge_joined"
  | "challenge_completed";

export interface ActivityEvent {
  id: string;
  actor_id: string;
  actor_username: string | null;
  actor_avatar_url: string | null;
  is_me: boolean;
  kind: ActivityKind;
  payload: { days?: number; code?: string; title?: string; challenge_id?: string; target_days?: number };
  created_at: string;
}

export interface FeedCursor {
  beforeAt: string;
  beforeId: string;
}

export interface FeedPage {
  items: ActivityEvent[];
  /** Null when there is nothing older to load. */
  next: FeedCursor | null;
}

export interface SocialSettings {
  share_activity: boolean;
  share_streaks: boolean;
  share_habits: boolean;
  share_achievements: boolean;
  share_challenges: boolean;
}

export interface BlockedUser {
  user_id: string;
  username: string | null;
  avatar_url: string | null;
}

/** Sharing is opt-in: nothing is shown to friends until the master switch is on. */
export const DEFAULT_SETTINGS: SocialSettings = {
  share_activity: false,
  share_streaks: true,
  share_habits: true,
  share_achievements: true,
  share_challenges: true,
};

export const FEED_PAGE_SIZE = 20;
const KINDS: readonly ActivityKind[] = [
  "streak_milestone", "habit_milestone", "achievement", "challenge_joined", "challenge_completed",
];

export class SocialFeatureUnavailable extends Error {
  constructor() {
    super("Activity and challenges aren't available on this server yet.");
  }
}

/** PostgREST/Postgres codes for "this function or table doesn't exist" (migration not applied). */
export function isNotDeployed(e: unknown): boolean {
  const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
  return code === "PGRST202" || code === "PGRST205" || code === "42883" || code === "42P01";
}

function raise(e: unknown): never {
  throw isNotDeployed(e) ? new SocialFeatureUnavailable() : e;
}

function toEvent(row: Record<string, unknown>): ActivityEvent | null {
  if (!KINDS.includes(row.kind as ActivityKind)) return null;     // an older client ignores newer kinds
  const p = (row.payload ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id),
    actor_id: String(row.actor_id),
    actor_username: (row.actor_username as string | null) ?? null,
    actor_avatar_url: (row.actor_avatar_url as string | null) ?? null,
    is_me: Boolean(row.is_me),
    kind: row.kind as ActivityKind,
    payload: {
      days: typeof p.days === "number" ? p.days : undefined,
      code: typeof p.code === "string" ? p.code : undefined,
      title: typeof p.title === "string" ? p.title : undefined,
      challenge_id: typeof p.challenge_id === "string" ? p.challenge_id : undefined,
      target_days: typeof p.target_days === "number" ? p.target_days : undefined,
    },
    created_at: String(row.created_at),
  };
}

export async function getActivityFeed(cursor: FeedCursor | null = null, limit = FEED_PAGE_SIZE): Promise<FeedPage> {
  const rows = MOCK_MODE
    ? await mock.mockGetFeed(cursor, limit)
    : await (async () => {
        const { data, error } = await supabase.rpc("get_activity_feed", {
          p_before_at: cursor?.beforeAt ?? undefined,
          p_before_id: cursor?.beforeId ?? undefined,
          p_limit: limit,
        });
        if (error) raise(error);
        return (data ?? []) as unknown as Record<string, unknown>[];
      })();
  const items = rows.map(toEvent).filter((e): e is ActivityEvent => e !== null);
  const last = rows[rows.length - 1];
  return {
    items,
    // A full page means there may be more; the cursor is the raw last row so
    // skipped unknown kinds don't stall paging.
    next: rows.length >= limit && last ? { beforeAt: String(last.created_at), beforeId: String(last.id) } : null,
  };
}

/** Appends a page, dropping any event already shown (a refresh can overlap). */
export function mergeFeed(current: ActivityEvent[], incoming: ActivityEvent[]): ActivityEvent[] {
  const seen = new Set(current.map((e) => e.id));
  return [...current, ...incoming.filter((e) => !seen.has(e.id))];
}

export interface ActivityText {
  icon: string;
  title: string;
}

/** What a card says. Only uses the whitelisted payload fields. */
export function describeActivity(e: ActivityEvent): ActivityText {
  const days = e.payload.days ?? 0;
  const title = e.payload.title?.trim() || "a challenge";
  switch (e.kind) {
    case "streak_milestone":
      return { icon: "🔥", title: `Reached a ${days}-day logging streak` };
    case "habit_milestone":
      return { icon: "📅", title: `Has logged meals on ${days} days` };
    case "achievement":
      return { icon: "🏅", title: `Earned “${e.payload.title?.trim() || "an achievement"}”` };
    case "challenge_joined":
      return { icon: "🤝", title: `Joined the challenge “${title}”` };
    case "challenge_completed":
      return { icon: "🎉", title: `Completed the challenge “${title}”` };
  }
}

export async function getSocialSettings(): Promise<SocialSettings> {
  if (MOCK_MODE) return mock.mockGetSettings();
  const { data, error } = await supabase
    .from("social_settings")
    .select("share_activity, share_streaks, share_habits, share_achievements, share_challenges")
    .maybeSingle();
  if (error) raise(error);
  return data ? { ...DEFAULT_SETTINGS, ...data } : { ...DEFAULT_SETTINGS };
}

/**
 * Saves the switches. user_id is left out: it defaults to auth.uid(), and the
 * table grants UPDATE on the share columns only.
 */
export async function saveSocialSettings(settings: SocialSettings): Promise<void> {
  if (MOCK_MODE) return mock.mockSaveSettings(settings);
  const { error } = await supabase.from("social_settings").upsert(
    {
      share_activity: settings.share_activity,
      share_streaks: settings.share_streaks,
      share_habits: settings.share_habits,
      share_achievements: settings.share_achievements,
      share_challenges: settings.share_challenges,
    },
    { onConflict: "user_id" }
  );
  if (error) raise(error);
}

/** Blocks someone: removes the friendship both ways and hides each from the other. */
export async function blockUser(userId: string): Promise<void> {
  if (MOCK_MODE) return mock.mockBlock(userId);
  const { error } = await supabase.rpc("block_user", { p_user_id: userId });
  if (error) raise(error);
}

export async function unblockUser(userId: string): Promise<void> {
  if (MOCK_MODE) return mock.mockUnblock(userId);
  const { error } = await supabase.rpc("unblock_user", { p_user_id: userId });
  if (error) raise(error);
}

export async function getBlockedUsers(): Promise<BlockedUser[]> {
  if (MOCK_MODE) return mock.mockGetBlocked();
  const { data, error } = await supabase.rpc("get_blocked_users");
  if (error) raise(error);
  return ((data ?? []) as BlockedUser[]).map((b) => ({ user_id: b.user_id, username: b.username, avatar_url: b.avatar_url }));
}
