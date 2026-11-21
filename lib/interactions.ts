// Reactions, comments and reports (migration 023). Notifications: lib/notifications.ts.
//
// The actor is always auth.uid() on the server: no function here takes a user
// id for "who is acting". The database checks that the caller can see the
// event, blocks either way, rate limits and content rules; the checks here
// only give faster feedback.
import { MOCK_MODE, supabase } from "./supabase";
import { SocialFeatureUnavailable, isNotDeployed } from "./socialActivity";
import * as mock from "./mockInteractions";

export type ReactionType = "like" | "celebrate" | "support" | "fire";

export const REACTIONS: { type: ReactionType; emoji: string; label: string }[] = [
  { type: "like", emoji: "👍", label: "Like" },
  { type: "celebrate", emoji: "🎉", label: "Celebrate" },
  { type: "support", emoji: "💪", label: "Support" },
  { type: "fire", emoji: "🔥", label: "Fire" },
];

export interface EventInteractions {
  counts: Record<ReactionType, number>;
  mine: ReactionType | null;
  comments: number;
}

export interface ActivityComment {
  id: string;
  author_id: string;
  author_username: string | null;
  author_avatar_url: string | null;
  is_mine: boolean;
  can_delete: boolean;
  body: string;
  created_at: string;
}

export type ReportReason = "spam" | "harassment" | "inappropriate" | "other";
export const REPORT_REASONS: { reason: ReportReason; label: string }[] = [
  { reason: "spam", label: "Spam" },
  { reason: "harassment", label: "Harassment or bullying" },
  { reason: "inappropriate", label: "Inappropriate" },
  { reason: "other", label: "Something else" },
];

export const COMMENT_MAX = 280;
export const EMPTY_INTERACTIONS: EventInteractions = {
  counts: { like: 0, celebrate: 0, support: 0, fire: 0 }, mine: null, comments: 0,
};

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await (supabase.rpc as unknown as (
    f: string, a?: Record<string, unknown>
  ) => Promise<{ data: unknown; error: unknown }>)(fn, args);
  if (error) throw isNotDeployed(error) ? new SocialFeatureUnavailable() : error;
  return data as T;
}

/** Mirrors comment_body_ok in 023. Returns the cleaned text, or an error message. */
export function validateComment(raw: string): { ok: true; body: string } | { ok: false; error: string } {
  const body = raw.replace(/\r\n?/g, "\n").trim();
  if (!body) return { ok: false, error: "Write something first." };
  if ([...body].length > COMMENT_MAX) return { ok: false, error: `Keep it under ${COMMENT_MAX} characters.` };
  if (/[\u0001-\u0009\u000b-\u001f\u007f]/.test(body)) return { ok: false, error: "Use plain text only." };
  if (body.split("\n").length > 4) return { ok: false, error: "Use at most 4 lines." };
  return { ok: true, body };
}

export function describeInteractionError(e: unknown): string {
  if (e instanceof SocialFeatureUnavailable) return e.message;
  const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
  const msg = typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : "";
  switch (code) {
    case "P0429": return "You're going a bit fast. Try again in a minute.";
    case "P0002": return "This isn't available any more.";
    case "28000": return "You've been signed out. Sign in again and retry.";
    case "22023": return msg && msg.length < 120 ? `${msg}.` : "That isn't allowed.";
    default: return "Something went wrong. Check your connection and try again.";
  }
}

export async function getInteractions(eventIds: string[]): Promise<Record<string, EventInteractions>> {
  const out: Record<string, EventInteractions> = {};
  if (!eventIds.length) return out;
  const rows = MOCK_MODE
    ? await mock.mockInteractions(eventIds)
    : (await rpc<Record<string, unknown>[] | null>("get_activity_interactions", { p_events: eventIds.slice(0, 50) })) ?? [];
  for (const r of rows) {
    out[String(r.event_id)] = {
      counts: {
        like: Number(r.like_count) || 0,
        celebrate: Number(r.celebrate_count) || 0,
        support: Number(r.support_count) || 0,
        fire: Number(r.fire_count) || 0,
      },
      mine: (REACTIONS.some((x) => x.type === r.my_reaction) ? r.my_reaction : null) as ReactionType | null,
      comments: Number(r.comment_count) || 0,
    };
  }
  return out;
}

/** The new state after choosing `next` (or removing it with null): for optimistic updates. */
export function applyReaction(state: EventInteractions, next: ReactionType | null): EventInteractions {
  const counts = { ...state.counts };
  if (state.mine) counts[state.mine] = Math.max(0, counts[state.mine] - 1);
  if (next) counts[next] += 1;
  return { ...state, counts, mine: next };
}

export async function setReaction(eventId: string, reaction: ReactionType): Promise<void> {
  if (MOCK_MODE) return mock.mockSetReaction(eventId, reaction);
  await rpc("set_reaction", { p_event: eventId, p_reaction: reaction });
}

export async function removeReaction(eventId: string): Promise<void> {
  if (MOCK_MODE) return mock.mockRemoveReaction(eventId);
  await rpc("remove_reaction", { p_event: eventId });
}

export async function getComments(eventId: string): Promise<ActivityComment[]> {
  if (MOCK_MODE) return mock.mockComments(eventId);
  return (await rpc<ActivityComment[] | null>("get_comments", { p_event: eventId })) ?? [];
}

export async function addComment(eventId: string, body: string): Promise<string> {
  const v = validateComment(body);
  if (!v.ok) throw Object.assign(new Error(v.error), { code: "22023", message: v.error.replace(/\.$/, "") });
  if (MOCK_MODE) return mock.mockAddComment(eventId, v.body);
  return rpc<string>("add_comment", { p_event: eventId, p_body: v.body });
}

export async function deleteComment(commentId: string): Promise<void> {
  if (MOCK_MODE) return mock.mockDeleteComment(commentId);
  await rpc("delete_comment", { p_comment: commentId });
}

export async function reportContent(kind: "comment" | "profile", targetId: string, reason: ReportReason): Promise<void> {
  if (MOCK_MODE) return;
  await rpc("report_content", { p_kind: kind, p_target: targetId, p_reason: reason, p_note: null });
}
