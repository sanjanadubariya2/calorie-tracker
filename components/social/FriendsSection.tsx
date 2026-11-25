import React, { useCallback, useState } from "react";
import {
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
import { blockUser, getSocialSettings } from "@/lib/socialActivity";
import { buildReportText, shareReport } from "@/lib/shareReport";
import { Avatar } from "@/components/Avatar";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { FriendActionsSheet } from "./FriendActionsSheet";
import { ReportSheet } from "./ReportSheet";
import { SharingSettingsModal } from "./SharingSettingsModal";
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

/** My social profile, friend discovery, requests and the friends list. No friend calorie data. */
export function FriendsSection() {
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
  const [pendingBlock, setPendingBlock] = useState<FriendSummary | null>(null);
  const [actionsFor, setActionsFor] = useState<FriendSummary | null>(null);
  const [reporting, setReporting] = useState<FriendSummary | null>(null);
  const [sharing, setSharing] = useState(false);
  const [sharingOpen, setSharingOpen] = useState(false);
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

    getSocialSettings().then((st) => setSharing(st.share_activity)).catch(() => undefined);

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

  async function handleBlock() {
    if (!pendingBlock) return;
    setRemoveError(null);
    try {
      await blockUser(pendingBlock.user_id);
    } catch (e) {
      setRemoveError(describeSocialError(e));
    } finally {
      setPendingBlock(null);
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

  // Alphabetical from the server: friends are never ranked.

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
      {loadError ? <Text style={styles.errorText}>{loadError}</Text> : null}

      {loading ? (
        <View testID="friends-loading">
          {[0, 1, 2].map((i) => <View key={i} style={styles.skeleton} />)}
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
                <View style={styles.chips}>
                  <View style={styles.chip} testID="private-chip"><Text style={styles.chipText}>🔒 Calories: only you</Text></View>
                  <Pressable testID="sharing-chip" style={styles.chip} onPress={() => setSharingOpen(true)}
                             accessibilityRole="button" accessibilityLabel="Activity sharing settings">
                    <Text style={styles.chipText}>{sharing ? "👥 Activity: friends" : "🔒 Activity: private"}</Text>
                  </Pressable>
                </View>
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
            <Text style={styles.cardTitle}>Friends{friends.length ? ` (${friends.length})` : ""}</Text>
            {removeError ? <Text style={styles.searchMessage}>{removeError}</Text> : null}

            {friends.length === 0 ? (
              <View style={styles.emptyBlock} testID="friends-empty">
                <Text style={styles.emptyTitle}>No friends yet</Text>
                <Text style={styles.emptyBody}>
                  Add someone by username to cheer each other on and take on challenges together.
                </Text>
              </View>
            ) : (
              <>
                {friends.map((f) => (
                  <FriendRow key={f.user_id} friend={f} onOptions={() => setActionsFor(f)} />
                ))}
                <Text style={styles.privacyNote}>
                  Friends never see your calories, meals or weight. They see your streak and milestones only if you
                  share them.
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
            ? `@${pendingRemove.username} will no longer see your shared activity, and you won't see theirs.`
            : undefined
        }
        confirmLabel="Remove"
        onConfirm={handleRemove}
        onCancel={() => setPendingRemove(null)}
      />

      <FriendActionsSheet
        friend={actionsFor}
        onRemove={() => { setPendingRemove(actionsFor); setActionsFor(null); }}
        onBlock={() => { setPendingBlock(actionsFor); setActionsFor(null); }}
        onReport={() => { setReporting(actionsFor); setActionsFor(null); }}
        onClose={() => setActionsFor(null)}
      />

      <SharingSettingsModal
        visible={sharingOpen}
        onClose={(changed) => {
          setSharingOpen(false);
          if (changed) getSocialSettings().then((st) => setSharing(st.share_activity)).catch(() => undefined);
        }}
      />

      <ReportSheet
        target={reporting ? { kind: "profile", id: reporting.user_id, label: `@${reporting.username}` } : null}
        onClose={() => setReporting(null)}
      />

      <ConfirmDialog
        visible={pendingBlock !== null}
        title="Block this person?"
        message={
          pendingBlock
            ? `You and @${pendingBlock.username} will stop being friends, won't see each other's activity or ` +
              "challenges, and can't send each other requests. You can unblock them in Sharing settings."
            : undefined
        }
        confirmLabel="Block"
        onConfirm={handleBlock}
        onCancel={() => setPendingBlock(null)}
      />
    </ScrollView>
  );
}

function displayName(username: string | null): string {
  return username ? `@${username}` : "Unknown user";
}

function streakText(streak: number | null): string {
  if (streak === null) return "Streak not shared";
  if (streak === 0) return "No streak right now";
  return `🔥 ${streak}-day streak`;
}

function FriendRow({ friend, onOptions }: { friend: FriendSummary; onOptions: () => void }) {
  return (
    <Pressable style={styles.friendRow} onLongPress={onOptions} testID={`friend-${friend.user_id}`}>
      <Avatar seed={friend.user_id} photoUrl={friend.avatar_url} label={friend.username ?? undefined} />
      <View style={styles.friendBody}>
        <Text style={styles.friendName} numberOfLines={1}>{displayName(friend.username)}</Text>
        <Text style={styles.friendMeta}>{streakText(friend.current_streak)}</Text>
      </View>
      <Pressable testID={`friend-options-${friend.user_id}`} onPress={onOptions} style={styles.optionsButton}
                 accessibilityRole="button" accessibilityLabel={`Options for ${displayName(friend.username)}`}>
        <Text style={styles.optionsText}>•••</Text>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingTop: spacing.sm },
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
  shareButtonText: { ...typography.label, color: colors.onAccent },
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
  primaryButtonText: { ...typography.label, color: colors.onAccent },
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
  inviteText: { ...typography.label, color: colors.link },
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
  acceptButtonText: { ...typography.label, color: colors.onAccent },
  emptyBlock: { alignItems: "center", paddingVertical: spacing.xl },
  emptyTitle: { ...typography.label, color: colors.textSecondary },
  emptyBody: {
    ...typography.caption,
    color: colors.textTertiary,
    textAlign: "center",
    marginTop: spacing.xs,
  },
  friendRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, marginTop: spacing.md, minHeight: 48 },
  friendBody: { flex: 1 },
  friendName: { ...typography.body, color: colors.textPrimary },
  friendMeta: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  optionsButton: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  optionsText: { ...typography.label, color: colors.textSecondary, letterSpacing: 1 },
  skeleton: { height: 88, borderRadius: radius.lg, backgroundColor: colors.card, marginBottom: spacing.md },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: spacing.xs },
  chip: { borderRadius: radius.pill, borderWidth: 1, borderColor: colors.cardBorder, paddingHorizontal: spacing.sm,
          paddingVertical: 4, minHeight: 28, justifyContent: "center" },
  chipText: { ...typography.caption, fontSize: 11, color: colors.textSecondary },
  privacyNote: {
    ...typography.caption,
    color: colors.textTertiary,
    marginTop: spacing.lg,
    lineHeight: 16,
  },
});
