import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { useAuth } from "@/lib/auth-context";
import { getFoodLogsForDate, getFoodLogsInRange, getProfile, getStreak, rangeEndingOn } from "@/lib/api";
import {
  acceptFriendRequest,
  findByUsername,
  getFriendSummaries,
  getPendingRequests,
  removeFriendship,
  sendFriendRequest,
  type FriendSummary,
  type PendingRequest,
} from "@/lib/social";
import { buildReportText, shareReport } from "@/lib/shareReport";
import { Avatar } from "@/components/Avatar";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { colors, radius, spacing, typography } from "@/constants/theme";
import type { Profile } from "@/lib/types";

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

interface MyStats {
  consumed: number;
  target: number;
  carbsG: number;
  fatG: number;
  proteinG: number;
  streak: number;
  weekAvg: number;
}

export default function FriendsScreen() {
  const { userId } = useAuth();
  const today = toISODate(new Date());

  const [profile, setProfile] = useState<Profile | null>(null);
  const [mine, setMine] = useState<MyStats | null>(null);
  const [friends, setFriends] = useState<FriendSummary[]>([]);
  const [requests, setRequests] = useState<PendingRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchMessage, setSearchMessage] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<FriendSummary | null>(null);
  const [shareNote, setShareNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    const { start, end } = rangeEndingOn(today);

    const [profileData, todayLogs, weekLogs, streakData, friendList, requestList] = await Promise.all([
      getProfile(userId),
      getFoodLogsForDate(userId, today),
      getFoodLogsInRange(userId, start, end),
      getStreak(userId),
      getFriendSummaries(today).catch(() => [] as FriendSummary[]),
      getPendingRequests().catch(() => [] as PendingRequest[]),
    ]);

    setProfile(profileData);

    const totalsByDate = new Map<string, number>();
    for (const log of weekLogs) {
      totalsByDate.set(log.logged_date, (totalsByDate.get(log.logged_date) ?? 0) + log.calories);
    }
    const dayTotals = [...totalsByDate.values()].filter((v) => v > 0);

    setMine({
      consumed: Math.round(todayLogs.reduce((s, l) => s + l.calories, 0)),
      target: profileData?.daily_target_kcal ?? 2000,
      carbsG: Math.round(todayLogs.reduce((s, l) => s + l.carbs_g, 0)),
      fatG: Math.round(todayLogs.reduce((s, l) => s + l.fat_g, 0)),
      proteinG: Math.round(todayLogs.reduce((s, l) => s + l.protein_g, 0)),
      streak: streakData?.current_streak ?? 0,
      weekAvg: dayTotals.length ? dayTotals.reduce((a, b) => a + b, 0) / dayTotals.length : 0,
    });

    setFriends(friendList);
    setRequests(requestList);
  }, [userId, today]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load().finally(() => setLoading(false));
    }, [load])
  );

  async function handleSearch() {
    if (!userId || search.trim().length < 3) return;
    setSearching(true);
    setSearchMessage(null);
    try {
      const found = await findByUsername(search);
      if (!found) {
        setSearchMessage(`No user called @${search.trim().toLowerCase()}.`);
        return;
      }
      if (friends.some((f) => f.user_id === found.user_id)) {
        setSearchMessage(`You're already connected with @${found.username}.`);
        return;
      }
      await sendFriendRequest(userId, found.user_id);
      setSearchMessage(`Request sent to @${found.username}.`);
      setSearch("");
      await load();
    } catch (e) {
      const message = (e as Error).message ?? "";
      setSearchMessage(
        message.includes("duplicate") || message.includes("unique")
          ? "You've already sent this person a request."
          : "Couldn't send that request. Try again."
      );
    } finally {
      setSearching(false);
    }
  }

  async function handleShare() {
    if (!mine) return;
    const text = buildReportText({
      username: profile?.username ?? null,
      dateLabel: "Today",
      consumedKcal: mine.consumed,
      targetKcal: mine.target,
      carbsG: mine.carbsG,
      fatG: mine.fatG,
      proteinG: mine.proteinG,
      streakDays: mine.streak,
      weekAverageKcal: mine.weekAvg,
    });

    const outcome = await shareReport(text);
    setShareNote(
      outcome.copiedToClipboard
        ? "Report copied to your clipboard."
        : outcome.shared
        ? null
        : "Sharing isn't available on this device."
    );
  }

  async function handleRemove() {
    if (!userId || !pendingRemove) return;
    await removeFriendship(pendingRemove.user_id, userId);
    setPendingRemove(null);
    await load();
  }

  const needsUsername = !profile?.username;

  // Me plus friends, ranked by how close each is to their own target — a fair
  // comparison when everyone's target is different.
  const leaderboard = [...friends]
    .map((f) => ({
      ...f,
      progress: f.daily_target_kcal > 0 ? f.today_kcal / f.daily_target_kcal : 0,
    }))
    .sort((a, b) => b.current_streak - a.current_streak);

  return (
    <ScrollView
      style={styles.wrap}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          tintColor={colors.textPrimary}
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
    >
      <Text style={styles.screenTitle}>Friends</Text>

      {loading ? (
        <View style={styles.centerBlock}>
          <ActivityIndicator color={colors.progressFill} size="large" />
        </View>
      ) : (
        <>
          <View style={styles.card}>
            <View style={styles.meRow}>
              <Avatar
                seed={userId ?? "me"}
                photoUrl={profile?.avatar_url}
                label={profile?.username ?? undefined}
                size={56}
              />
              <View style={styles.meText}>
                <Text style={styles.meName}>
                  {profile?.username ? `@${profile.username}` : "Set a username"}
                </Text>
                <Text style={styles.meMeta}>
                  {mine
                    ? `${mine.consumed.toLocaleString()} / ${mine.target.toLocaleString()} kcal today`
                    : "—"}
                </Text>
              </View>
              <Pressable
                style={styles.editButton}
                onPress={() => router.push("/modals/edit-social-profile")}
              >
                <Text style={styles.editButtonText}>Edit</Text>
              </Pressable>
            </View>

            <Pressable style={styles.shareButton} onPress={handleShare}>
              <Text style={styles.shareButtonText}>Share my progress report</Text>
            </Pressable>
            {shareNote ? <Text style={styles.shareNote}>{shareNote}</Text> : null}
          </View>

          {needsUsername ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Pick a username first</Text>
              <Text style={styles.cardBody}>
                Friends add you by username, so you need one before you can connect. It's the only
                thing they'll see — your age and weight stay private.
              </Text>
              <Pressable
                style={styles.primaryButton}
                onPress={() => router.push("/modals/edit-social-profile")}
              >
                <Text style={styles.primaryButtonText}>Choose username</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Add a friend</Text>
              <View style={styles.searchRow}>
                <Text style={styles.atSign}>@</Text>
                <TextInput
                  style={styles.searchInput}
                  value={search}
                  onChangeText={(t) => {
                    setSearch(t);
                    setSearchMessage(null);
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="username"
                  placeholderTextColor={colors.textTertiary}
                  onSubmitEditing={handleSearch}
                />
                <Pressable
                  style={[styles.addButton, search.trim().length < 3 && styles.disabled]}
                  onPress={handleSearch}
                  disabled={search.trim().length < 3 || searching}
                >
                  <Text style={styles.addButtonText}>{searching ? "…" : "Add"}</Text>
                </Pressable>
              </View>
              {searchMessage ? <Text style={styles.searchMessage}>{searchMessage}</Text> : null}

              <Pressable
                style={styles.inviteRow}
                onPress={async () => {
                  const outcome = await shareReport(
                    `Add me on Calorie Tracker — my username is @${profile?.username}.`
                  );
                  setShareNote(
                    outcome.copiedToClipboard ? "Invite copied to your clipboard." : null
                  );
                }}
              >
                <Text style={styles.inviteText}>Share my invite link</Text>
              </Pressable>
            </View>
          )}

          {requests.length > 0 && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Requests</Text>
              {requests.map((r) => (
                <View key={r.friendship_id} style={styles.requestRow}>
                  <Avatar seed={r.user_id} photoUrl={r.avatar_url} label={r.username ?? "?"} />
                  <Text style={styles.requestName}>@{r.username}</Text>
                  <Pressable
                    style={styles.acceptButton}
                    onPress={async () => {
                      await acceptFriendRequest(r.friendship_id);
                      await load();
                    }}
                  >
                    <Text style={styles.acceptButtonText}>Accept</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          )}

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Today's progress</Text>

            {leaderboard.length === 0 ? (
              <View style={styles.emptyBlock}>
                <Text style={styles.emptyTitle}>No friends yet</Text>
                <Text style={styles.emptyBody}>
                  Add someone by username to compare streaks and daily totals.
                </Text>
              </View>
            ) : (
              <>
                {mine && (
                  <ProgressRow
                    seed={userId ?? "me"}
                    photoUrl={profile?.avatar_url}
                    name={profile?.username ? `@${profile.username}` : "You"}
                    isMe
                    consumed={mine.consumed}
                    target={mine.target}
                    streak={mine.streak}
                  />
                )}
                {leaderboard.map((f) => (
                  <ProgressRow
                    key={f.user_id}
                    seed={f.user_id}
                    photoUrl={f.avatar_url}
                    name={`@${f.username}`}
                    consumed={f.today_kcal}
                    target={f.daily_target_kcal}
                    streak={f.current_streak}
                    onLongPress={() => setPendingRemove(f)}
                  />
                ))}
                <Text style={styles.privacyNote}>
                  Friends see your daily totals and streak — never what you ate. Long-press a friend
                  to remove them.
                </Text>
              </>
            )}
          </View>
        </>
      )}

      <View style={{ height: spacing.xl }} />

      <ConfirmDialog
        visible={pendingRemove !== null}
        title="Remove friend?"
        message={
          pendingRemove
            ? `@${pendingRemove.username} will no longer see your progress, and you won't see theirs.`
            : undefined
        }
        confirmLabel="Remove"
        onConfirm={handleRemove}
        onCancel={() => setPendingRemove(null)}
      />
    </ScrollView>
  );
}

function ProgressRow({
  seed,
  photoUrl,
  name,
  consumed,
  target,
  streak,
  isMe,
  onLongPress,
}: {
  seed: string;
  photoUrl?: string | null;
  name: string;
  consumed: number;
  target: number;
  streak: number;
  isMe?: boolean;
  onLongPress?: () => void;
}) {
  const pct = target > 0 ? Math.min(1, consumed / target) : 0;
  const over = target > 0 && consumed > target;

  return (
    <Pressable style={styles.progressRow} onLongPress={onLongPress} disabled={!onLongPress}>
      <Avatar seed={seed} photoUrl={photoUrl} label={name.replace("@", "")} />
      <View style={styles.progressBody}>
        <View style={styles.progressHeader}>
          <Text style={[styles.progressName, isMe && styles.progressNameMe]} numberOfLines={1}>
            {name}
            {isMe ? " (you)" : ""}
          </Text>
          <Text style={styles.progressKcal}>
            {Math.round(consumed).toLocaleString()}
            <Text style={styles.progressTarget}> / {target.toLocaleString()}</Text>
          </Text>
        </View>

        <View style={styles.progressTrack}>
          <View
            style={[
              styles.progressFill,
              { width: `${pct * 100}%`, backgroundColor: over ? colors.fat : colors.progressFill },
            ]}
          />
        </View>

        {streak > 0 && <Text style={styles.progressStreak}>🔥 {streak} day streak</Text>}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg },
  screenTitle: { ...typography.title, color: colors.textPrimary, marginBottom: spacing.md },
  centerBlock: { paddingVertical: 96, alignItems: "center" },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  cardTitle: { ...typography.title, fontSize: 18, color: colors.textPrimary },
  cardBody: {
    ...typography.body,
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    lineHeight: 21,
  },
  meRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  meText: { flex: 1 },
  meName: { ...typography.body, fontWeight: "700", color: colors.textPrimary },
  meMeta: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  editButton: {
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  editButtonText: { ...typography.caption, color: colors.textPrimary },
  shareButton: {
    backgroundColor: colors.progressFill,
    borderRadius: radius.pill,
    paddingVertical: spacing.md,
    alignItems: "center",
    marginTop: spacing.lg,
  },
  shareButtonText: { ...typography.label, color: "#0A0A0A" },
  shareNote: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: "center",
    marginTop: spacing.sm,
  },
  primaryButton: {
    backgroundColor: colors.progressFill,
    borderRadius: radius.pill,
    paddingVertical: spacing.md,
    alignItems: "center",
    marginTop: spacing.md,
  },
  primaryButtonText: { ...typography.label, color: "#0A0A0A" },
  searchRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.md },
  atSign: { ...typography.body, color: colors.textSecondary },
  searchInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    ...typography.body,
  },
  addButton: {
    backgroundColor: colors.pillBackground,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  addButtonText: { ...typography.label, color: colors.textPrimary },
  disabled: { opacity: 0.4 },
  searchMessage: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.sm },
  inviteRow: { marginTop: spacing.md, alignItems: "center" },
  inviteText: { ...typography.label, color: colors.progressFill },
  requestRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginTop: spacing.md,
  },
  requestName: { ...typography.body, color: colors.textPrimary, flex: 1 },
  acceptButton: {
    backgroundColor: colors.progressFill,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  acceptButtonText: { ...typography.label, color: "#0A0A0A" },
  emptyBlock: { alignItems: "center", paddingVertical: spacing.xl },
  emptyTitle: { ...typography.label, color: colors.textSecondary },
  emptyBody: {
    ...typography.caption,
    color: colors.textTertiary,
    textAlign: "center",
    marginTop: spacing.xs,
  },
  progressRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  progressBody: { flex: 1 },
  progressHeader: { flexDirection: "row", justifyContent: "space-between", gap: spacing.sm },
  progressName: { ...typography.body, color: colors.textPrimary, flex: 1 },
  progressNameMe: { fontWeight: "700" },
  progressKcal: { ...typography.caption, color: colors.textPrimary },
  progressTarget: { color: colors.textSecondary },
  progressTrack: {
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.progressTrack,
    marginTop: spacing.xs,
    overflow: "hidden",
  },
  progressFill: { height: "100%", borderRadius: radius.pill },
  progressStreak: { ...typography.caption, color: colors.textSecondary, marginTop: 4 },
  privacyNote: {
    ...typography.caption,
    color: colors.textTertiary,
    marginTop: spacing.lg,
    lineHeight: 16,
  },
});
