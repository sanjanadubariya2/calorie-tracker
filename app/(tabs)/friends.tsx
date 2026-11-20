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
import { getDailyStatus, getDailyTotals, getProfile, getStreak } from "@/lib/api";
import { rangeEndingOn, toISODate } from "@/lib/dates";
import { averageOverLoggedDays } from "@/lib/nutrition";
import { DEFAULT_TARGET_KCAL } from "@/lib/calculations";
import {
  SOCIAL_ERROR,
  acceptFriendRequest,
  cancelFriendRequest,
  declineFriendRequest,
  describeSocialError,
  findByUsername,
  getFriendSummaries,
  getOutgoingRequests,
  getPendingRequests,
  removeFriendship,
  sendFriendRequest,
  type FriendSummary,
  type OutgoingRequest,
  type PendingRequest,
} from "@/lib/social";
import { buildReportText, shareReport } from "@/lib/shareReport";
import { Avatar } from "@/components/Avatar";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { colors, radius, spacing, typography } from "@/constants/theme";
import type { Profile } from "@/lib/types";

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
  const [outgoing, setOutgoing] = useState<OutgoingRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Friendship id of the request row with an action in flight, so only that
  // row's buttons disable.
  const [requestBusy, setRequestBusy] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchMessage, setSearchMessage] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<FriendSummary | null>(null);
  const [shareNote, setShareNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    const { start, end } = rangeEndingOn(today);

    // Social data loads alongside personal stats but fails independently: a
    // broken friends query shouldn't blank the "me" card, and vice versa.
    const socialPromise = Promise.allSettled([
      getFriendSummaries(today),
      getPendingRequests(),
      getOutgoingRequests(),
    ]);

    // Same daily numbers as the dashboard: get_daily_status / get_daily_totals.
    const [profileData, status, weekRows, streakData] = await Promise.all([
      getProfile(userId),
      getDailyStatus(today),
      getDailyTotals(start, end),
      getStreak(userId),
    ]);

    setProfile(profileData);
    setMine({
      consumed: Math.round(status.consumed.calories),
      target: status.targetKcal ?? DEFAULT_TARGET_KCAL,
      carbsG: Math.round(status.consumed.carbsG),
      fatG: Math.round(status.consumed.fatG),
      proteinG: Math.round(status.consumed.proteinG),
      streak: streakData?.current_streak ?? 0,
      weekAvg: averageOverLoggedDays(weekRows),
    });

    const [friendRes, incomingRes, outgoingRes] = await socialPromise;
    // On failure keep whatever was already on screen rather than flashing to empty.
    if (friendRes.status === "fulfilled") setFriends(friendRes.value);
    if (incomingRes.status === "fulfilled") setRequests(incomingRes.value);
    if (outgoingRes.status === "fulfilled") setOutgoing(outgoingRes.value);

    const socialFailed = [friendRes, incomingRes, outgoingRes].some((r) => r.status === "rejected");
    setLoadError(socialFailed ? "Couldn't load your friends and requests. Pull down to retry." : null);
  }, [userId, today]);

  // load() rejects only when the personal-stats queries fail.
  const safeLoad = useCallback(
    () =>
      load().catch(() => {
        setLoadError("Couldn't load your progress. Pull down to retry.");
      }),
    [load]
  );

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      safeLoad().finally(() => setLoading(false));
    }, [safeLoad])
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
      if (outgoing.some((r) => r.user_id === found.user_id)) {
        setSearchMessage(`You've already sent @${found.username} a request.`);
        return;
      }
      if (requests.some((r) => r.user_id === found.user_id)) {
        setSearchMessage(`@${found.username} has already sent you a request. Accept it below.`);
        return;
      }
      await sendFriendRequest(userId, found.user_id);
      setSearchMessage(`Request sent to @${found.username}.`);
      setSearch("");
      await safeLoad();
    } catch (e) {
      // The pair index rejects a second request in either direction, even one
      // this screen hasn't loaded yet.
      const code = (e as { code?: string }).code;
      setSearchMessage(
        code === SOCIAL_ERROR.duplicateRequest
          ? "There's already a request between you two. Pull down to refresh."
          : describeSocialError(e)
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
    setRemoveError(null);
    try {
      await removeFriendship(pendingRemove.user_id, userId);
    } catch (e) {
      setRemoveError(describeSocialError(e));
    } finally {
      setPendingRemove(null);
    }
    await safeLoad();
  }

  // Accept, decline, and cancel share this wrapper: one row busy at a time,
  // the error shown inline, and a reload either way. After a stale-request
  // error (P0002/55000) the reload drops the row that no longer applies.
  async function runRequestAction(friendshipId: string, action: () => Promise<void>) {
    setRequestBusy(friendshipId);
    setRequestError(null);
    try {
      await action();
    } catch (e) {
      setRequestError(describeSocialError(e));
    } finally {
      await safeLoad();
      setRequestBusy(null);
    }
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
            await safeLoad();
            setRefreshing(false);
          }}
        />
      }
    >
      <Text style={styles.screenTitle}>Friends</Text>
      {loadError ? <Text style={styles.errorText}>{loadError}</Text> : null}

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

          {requestError ? <Text style={styles.errorText}>{requestError}</Text> : null}

          {requests.length > 0 && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Requests</Text>
              {requests.map((r) => {
                const busy = requestBusy === r.friendship_id;
                return (
                  <View key={r.friendship_id} style={styles.requestRow}>
                    <Avatar seed={r.user_id} photoUrl={r.avatar_url} label={r.username ?? "?"} />
                    <Text style={styles.requestName} numberOfLines={1}>
                      {displayName(r.username)}
                    </Text>
                    <Pressable
                      style={[styles.secondaryButton, busy && styles.disabled]}
                      disabled={requestBusy !== null}
                      onPress={() =>
                        runRequestAction(r.friendship_id, () => declineFriendRequest(r.friendship_id))
                      }
                      accessibilityLabel={`Decline request from ${displayName(r.username)}`}
                    >
                      <Text style={styles.secondaryButtonText}>Decline</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.acceptButton, busy && styles.disabled]}
                      disabled={requestBusy !== null}
                      onPress={() =>
                        runRequestAction(r.friendship_id, () => acceptFriendRequest(r.friendship_id))
                      }
                      accessibilityLabel={`Accept request from ${displayName(r.username)}`}
                    >
                      <Text style={styles.acceptButtonText}>{busy ? "…" : "Accept"}</Text>
                    </Pressable>
                  </View>
                );
              })}
            </View>
          )}

          {outgoing.length > 0 && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Sent requests</Text>
              {outgoing.map((r) => {
                const busy = requestBusy === r.friendship_id;
                return (
                  <View key={r.friendship_id} style={styles.requestRow}>
                    <Avatar seed={r.user_id} photoUrl={r.avatar_url} label={r.username ?? "?"} />
                    <View style={styles.requestText}>
                      <Text style={styles.requestName} numberOfLines={1}>
                        {displayName(r.username)}
                      </Text>
                      <Text style={styles.requestMeta}>Waiting for a reply</Text>
                    </View>
                    <Pressable
                      style={[styles.secondaryButton, busy && styles.disabled]}
                      disabled={requestBusy !== null}
                      onPress={() =>
                        runRequestAction(r.friendship_id, () => cancelFriendRequest(r.friendship_id))
                      }
                      accessibilityLabel={`Cancel request to ${displayName(r.username)}`}
                    >
                      <Text style={styles.secondaryButtonText}>{busy ? "…" : "Cancel"}</Text>
                    </Pressable>
                  </View>
                );
              })}
            </View>
          )}

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Today's progress</Text>
            {removeError ? <Text style={styles.searchMessage}>{removeError}</Text> : null}

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

function displayName(username: string | null): string {
  return username ? `@${username}` : "Unknown user";
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
  requestText: { flex: 1 },
  requestMeta: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  secondaryButton: {
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  secondaryButtonText: { ...typography.label, color: colors.textPrimary },
  errorText: { ...typography.caption, color: colors.danger, marginBottom: spacing.md },
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
