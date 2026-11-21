import { MOCK_MODE, supabase } from "./supabase";
import * as mock from "./mockSocial";

export interface PublicProfile {
  user_id: string;
  username: string | null;
  avatar_url: string | null;
}

/**
 * What a friend can see about another friend (migration 025): who they are,
 * and their streak only if they chose to share it (otherwise null). Never
 * calories, nutrition, targets or weight.
 */
export interface FriendSummary extends PublicProfile {
  current_streak: number | null;
}

/** A pending request, from either side. `user_id` is always the *other* person. */
export interface PendingRequest extends PublicProfile {
  friendship_id: string;
}

/** Requests the current user has sent and that are still awaiting a reply. */
export type OutgoingRequest = PendingRequest;

/**
 * SQLSTATE codes raised by the friendship functions in
 * supabase/migrations/003_social_security.sql, plus the unique-violation
 * code for a duplicate request.
 */
export const SOCIAL_ERROR = {
  notAuthenticated: "28000",
  invalidArgument: "22023",
  requestNotFound: "P0002",
  requestNotPending: "55000",
  duplicateRequest: "23505",
} as const;

function errorCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e
    ? String((e as { code: unknown }).code)
    : undefined;
}

/** Turns a social RPC/table error into a sentence fit for the UI. */
export function describeSocialError(e: unknown): string {
  switch (errorCode(e)) {
    case SOCIAL_ERROR.requestNotFound:
      return "That request no longer exists. It may have been cancelled.";
    case SOCIAL_ERROR.requestNotPending:
      return "That request has already been answered.";
    case SOCIAL_ERROR.duplicateRequest:
      return "There's already a request between you two.";
    case SOCIAL_ERROR.notAuthenticated:
      return "You've been signed out. Sign in again and retry.";
    default:
      return "Something went wrong. Check your connection and try again.";
  }
}

/** Usernames are the public handle, so keep them predictable and URL-safe. */
export const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@/, "");
}

export function validateUsername(raw: string): string | null {
  const name = normalizeUsername(raw);
  if (name.length < 3) return "Username must be at least 3 characters.";
  if (name.length > 20) return "Username must be 20 characters or fewer.";
  if (!USERNAME_PATTERN.test(name)) return "Use only letters, numbers, and underscores.";
  return null;
}

export async function isUsernameAvailable(username: string, userId: string): Promise<boolean> {
  if (MOCK_MODE) return mock.mockIsUsernameAvailable(normalizeUsername(username));

  const { data, error } = await supabase
    .from("profiles")
    .select("user_id")
    .ilike("username", normalizeUsername(username))
    .maybeSingle();

  if (error) throw error;
  // Their own current username doesn't count as taken.
  return !data || data.user_id === userId;
}

export async function setUsername(userId: string, username: string): Promise<void> {
  if (MOCK_MODE) return mock.mockSetUsername(normalizeUsername(username));

  const { error } = await supabase
    .from("profiles")
    .update({ username: normalizeUsername(username) })
    .eq("user_id", userId);

  if (error) throw error;
}

export async function setAvatarUrl(userId: string, avatarUrl: string | null): Promise<void> {
  if (MOCK_MODE) return mock.mockSetAvatarUrl(avatarUrl);

  const { error } = await supabase
    .from("profiles")
    .update({ avatar_url: avatarUrl })
    .eq("user_id", userId);

  if (error) throw error;
}

export async function findByUsername(username: string): Promise<PublicProfile | null> {
  if (MOCK_MODE) return mock.mockFindByUsername(normalizeUsername(username));

  const { data, error } = await supabase.rpc("find_profile_by_username", {
    p_username: normalizeUsername(username),
  });

  if (error) throw error;
  return (data as PublicProfile[])?.[0] ?? null;
}

export async function sendFriendRequest(userId: string, addresseeId: string): Promise<void> {
  if (MOCK_MODE) return mock.mockSendFriendRequest(addresseeId);

  // Only the two ids are sent. The database grants INSERT on just these
  // columns, so status always takes its 'pending' default.
  const { error } = await supabase
    .from("friendships")
    .insert({ requester_id: userId, addressee_id: addresseeId });

  if (error) throw error;
}

async function respondToFriendRequest(friendshipId: string, accept: boolean): Promise<void> {
  const { error } = await supabase.rpc("respond_to_friend_request", {
    p_request_id: friendshipId,
    p_accept: accept,
  });
  if (error) throw error;
}

/** Addressee only. Raises P0002 for anyone else, 55000 if already answered. */
export async function acceptFriendRequest(friendshipId: string): Promise<void> {
  if (MOCK_MODE) return mock.mockAcceptFriendRequest(friendshipId);
  return respondToFriendRequest(friendshipId, true);
}

/** Addressee only. Deletes the request, so the pair can connect again later. */
export async function declineFriendRequest(friendshipId: string): Promise<void> {
  if (MOCK_MODE) return mock.mockDeclineFriendRequest(friendshipId);
  return respondToFriendRequest(friendshipId, false);
}

/** Requester only, and only while the request is still pending. */
export async function cancelFriendRequest(friendshipId: string): Promise<void> {
  if (MOCK_MODE) return mock.mockCancelFriendRequest(friendshipId);

  const { error } = await supabase.rpc("cancel_friend_request", { p_request_id: friendshipId });
  if (error) throw error;
}

export async function removeFriendship(friendUserId: string, userId: string): Promise<void> {
  if (MOCK_MODE) return mock.mockRemoveFriend(friendUserId);

  const { error } = await supabase
    .from("friendships")
    .delete()
    .or(
      `and(requester_id.eq.${userId},addressee_id.eq.${friendUserId}),` +
        `and(requester_id.eq.${friendUserId},addressee_id.eq.${userId})`
    );

  if (error) throw error;
}

/** `_todayISO` is unused since migration 027 (kept so callers don't change). */
export async function getFriendSummaries(_todayISO?: string): Promise<FriendSummary[]> {
  if (MOCK_MODE) return mock.mockGetFriendSummaries();

  // get_friend_list (027). The old get_friend_summaries refuses (P0426) so
  // pre-Phase-4 builds can't render a friend's calories as zeros.
  const { data, error } = await supabase.rpc("get_friend_list");
  if (error) throw error;

  // Only these fields are kept, even if an older server sends more.
  return ((data as FriendSummary[]) ?? []).map((f) => ({
    user_id: f.user_id,
    username: f.username,
    avatar_url: f.avatar_url,
    current_streak: f.current_streak === null || f.current_streak === undefined ? null : Number(f.current_streak) || 0,
  }));
}

export async function getPendingRequests(): Promise<PendingRequest[]> {
  if (MOCK_MODE) return mock.mockGetPendingRequests();

  const { data, error } = await supabase.rpc("get_pending_requests");
  if (error) throw error;
  return (data as PendingRequest[]) ?? [];
}

export async function getOutgoingRequests(): Promise<OutgoingRequest[]> {
  if (MOCK_MODE) return mock.mockGetOutgoingRequests();

  const { data, error } = await supabase.rpc("get_outgoing_requests");
  if (error) throw error;
  return (data as OutgoingRequest[]) ?? [];
}
