import { MOCK_MODE, supabase } from "./supabase";
import * as mock from "./mockSocial";

export interface PublicProfile {
  user_id: string;
  username: string | null;
  avatar_url: string | null;
}

export interface FriendSummary extends PublicProfile {
  today_kcal: number;
  avg7_kcal: number;
  current_streak: number;
  daily_target_kcal: number;
}

export interface PendingRequest extends PublicProfile {
  friendship_id: string;
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

  const { error } = await supabase
    .from("friendships")
    .insert({ requester_id: userId, addressee_id: addresseeId, status: "pending" });

  if (error) throw error;
}

export async function acceptFriendRequest(friendshipId: string): Promise<void> {
  if (MOCK_MODE) return mock.mockAcceptFriendRequest(friendshipId);

  const { error } = await supabase
    .from("friendships")
    .update({ status: "accepted" })
    .eq("id", friendshipId);

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

export async function getFriendSummaries(todayISO: string): Promise<FriendSummary[]> {
  if (MOCK_MODE) return mock.mockGetFriendSummaries();

  const { data, error } = await supabase.rpc("get_friend_summaries", { p_today: todayISO });
  if (error) throw error;

  // Postgres numerics arrive as strings over PostgREST.
  return ((data as FriendSummary[]) ?? []).map((f) => ({
    ...f,
    today_kcal: Number(f.today_kcal) || 0,
    avg7_kcal: Number(f.avg7_kcal) || 0,
  }));
}

export async function getPendingRequests(): Promise<PendingRequest[]> {
  if (MOCK_MODE) return mock.mockGetPendingRequests();

  const { data, error } = await supabase.rpc("get_pending_requests");
  if (error) throw error;
  return (data as PendingRequest[]) ?? [];
}
