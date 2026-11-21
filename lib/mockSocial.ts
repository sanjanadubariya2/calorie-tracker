import AsyncStorage from "@react-native-async-storage/async-storage";
import type { FriendSummary, PendingRequest, PublicProfile } from "./social";

// Mock-mode counterpart to lib/social.ts, so the social tab is explorable with
// no Supabase project. Seeded with a few characters to compare against.

const STORAGE_KEY = "calorie-tracker-mock-social-v2";   // v2: no friend calorie data

interface MockSocialDB {
  username: string | null;
  avatarUrl: string | null;
  friends: FriendSummary[];
  requests: PendingRequest[];
  /** Requests this user has sent. Optional so mock DBs saved before it existed still load. */
  outgoing?: PendingRequest[];
  directory: PublicProfile[];
}

function seed(): MockSocialDB {
  const friends: FriendSummary[] = [
    {
      user_id: "mock-friend-1",
      username: "meera_runs",
      avatar_url: null,
      current_streak: 6,
    },
    {
      user_id: "mock-friend-2",
      username: "arjun_lifts",
      avatar_url: null,
      current_streak: 3,
    },
    {
      user_id: "mock-friend-3",
      username: "priya",
      avatar_url: null,
      current_streak: null,          // doesn't share her streak
    },
  ];

  return {
    username: null,
    avatarUrl: null,
    friends,
    requests: [
      { friendship_id: "mock-req-1", user_id: "mock-friend-4", username: "dev_eats", avatar_url: null },
    ],
    outgoing: [],
    directory: [
      { user_id: "mock-friend-5", username: "rahul_fit", avatar_url: null },
      { user_id: "mock-friend-6", username: "sneha", avatar_url: null },
    ],
  };
}

let cache: MockSocialDB | null = null;

async function load(): Promise<MockSocialDB> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    cache = raw ? (JSON.parse(raw) as MockSocialDB) : seed();
  } catch {
    cache = seed();
  }
  return cache;
}

async function save(db: MockSocialDB): Promise<void> {
  cache = db;
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(db));
}

export async function mockIsUsernameAvailable(username: string): Promise<boolean> {
  const db = await load();
  const taken = [...db.friends, ...db.directory].some((p) => p.username === username);
  return !taken;
}

export async function mockSetUsername(username: string): Promise<void> {
  const db = await load();
  db.username = username;
  await save(db);
}

export async function mockSetAvatarUrl(avatarUrl: string | null): Promise<void> {
  const db = await load();
  db.avatarUrl = avatarUrl;
  await save(db);
}

export async function mockFindByUsername(username: string): Promise<PublicProfile | null> {
  const db = await load();
  return (
    db.directory.find((p) => p.username === username) ??
    db.friends.find((f) => f.username === username) ??
    null
  );
}

export async function mockSendFriendRequest(addresseeId: string): Promise<void> {
  const db = await load();
  const found = db.directory.find((p) => p.user_id === addresseeId);
  if (!found) return;
  // Matches the real flow: the request waits in "Sent requests" until it's
  // cancelled. Mock mode has no second user, so nobody ever accepts it.
  db.directory = db.directory.filter((p) => p.user_id !== addresseeId);
  db.outgoing = [
    { friendship_id: `mock-out-${Date.now()}`, ...found },
    ...(db.outgoing ?? []),
  ];
  await save(db);
}

export async function mockDeclineFriendRequest(friendshipId: string): Promise<void> {
  const db = await load();
  const req = db.requests.find((r) => r.friendship_id === friendshipId);
  if (!req) return;
  db.requests = db.requests.filter((r) => r.friendship_id !== friendshipId);
  db.directory.push({ user_id: req.user_id, username: req.username, avatar_url: req.avatar_url });
  await save(db);
}

export async function mockCancelFriendRequest(friendshipId: string): Promise<void> {
  const db = await load();
  const req = (db.outgoing ?? []).find((r) => r.friendship_id === friendshipId);
  if (!req) return;
  db.outgoing = (db.outgoing ?? []).filter((r) => r.friendship_id !== friendshipId);
  db.directory.push({ user_id: req.user_id, username: req.username, avatar_url: req.avatar_url });
  await save(db);
}

export async function mockGetOutgoingRequests(): Promise<PendingRequest[]> {
  return (await load()).outgoing ?? [];
}

export async function mockAcceptFriendRequest(friendshipId: string): Promise<void> {
  const db = await load();
  const req = db.requests.find((r) => r.friendship_id === friendshipId);
  if (!req) return;
  db.requests = db.requests.filter((r) => r.friendship_id !== friendshipId);
  db.friends.push({
    user_id: req.user_id,
    username: req.username,
    avatar_url: req.avatar_url,
    current_streak: 2,
  });
  await save(db);
}

export async function mockRemoveFriend(friendUserId: string): Promise<void> {
  const db = await load();
  const removed = db.friends.find((f) => f.user_id === friendUserId);
  db.friends = db.friends.filter((f) => f.user_id !== friendUserId);
  if (removed) {
    db.directory.push({
      user_id: removed.user_id,
      username: removed.username,
      avatar_url: removed.avatar_url,
    });
  }
  await save(db);
}

export async function mockGetFriendSummaries(): Promise<FriendSummary[]> {
  return (await load()).friends;
}

export async function mockGetPendingRequests(): Promise<PendingRequest[]> {
  return (await load()).requests;
}
