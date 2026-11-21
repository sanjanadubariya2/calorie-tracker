import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";
import {
  SocialFeatureUnavailable,
  getActivityFeed,
  getSocialSettings,
  mergeFeed,
  type ActivityEvent,
  type FeedCursor,
} from "@/lib/socialActivity";
import {
  EMPTY_INTERACTIONS,
  applyReaction,
  describeInteractionError,
  getInteractions,
  removeReaction,
  setReaction,
  type EventInteractions,
  type ReactionType,
} from "@/lib/interactions";
import { ActivityCard, ActivityCardSkeleton } from "./ActivityCard";
import { CommentsSheet } from "./CommentsSheet";
import { ReactionBar } from "./ReactionBar";
import { SharingSettingsModal } from "./SharingSettingsModal";
import type { SocialFocus } from "@/app/(tabs)/friends";

interface Props {
  onFindFriends: () => void;
  /** A deep link: the event a notification was about (and whether to open its comments). */
  focus?: SocialFocus | null;
}

type Status = "loading" | "ready" | "error" | "unavailable";

/** Friends' milestones and your own, newest first, with paging and pull-to-refresh. */
export function ActivityFeed({ onFindFriends, focus }: Props) {
  const [items, setItems] = useState<ActivityEvent[]>([]);
  const [next, setNext] = useState<FeedCursor | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [sharing, setSharing] = useState<boolean | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [interactions, setInteractions] = useState<Record<string, EventInteractions>>({});
  const [commentsFor, setCommentsFor] = useState<ActivityEvent | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Ignores a slow response that a newer refresh has superseded.
  const generation = useRef(0);
  // Events with a reaction request in flight: a second tap waits for the first.
  const reacting = useRef(new Set<string>());

  // Counts load after the page, so the feed shows even if they fail.
  const loadInteractions = useCallback(async (events: ActivityEvent[], replace: boolean) => {
    if (!events.length) { if (replace) setInteractions({}); return; }
    try {
      const got = await getInteractions(events.map((e) => e.id));
      setInteractions((cur) => (replace ? got : { ...cur, ...got }));
    } catch {
      // keep what is shown
    }
  }, []);

  const loadFirst = useCallback(async () => {
    const gen = ++generation.current;
    try {
      const [page, settings] = await Promise.all([getActivityFeed(null), getSocialSettings().catch(() => null)]);
      if (gen !== generation.current) return;
      setItems(page.items);
      setNext(page.next);
      setSharing(settings ? settings.share_activity : null);
      setMoreError(false);
      setStatus("ready");
      loadInteractions(page.items, true);
    } catch (e) {
      if (gen !== generation.current) return;
      setStatus(e instanceof SocialFeatureUnavailable ? "unavailable" : "error");
    }
  }, [loadInteractions]);

  useEffect(() => {
    loadFirst();
  }, [loadFirst]);

  const focusEvent = focus?.event;
  const focusComments = focus?.comments;
  const focusKey = focus?.key;
  useEffect(() => {
    if (!focusEvent || !focusComments || status !== "ready") return;
    const ev = items.find((e) => e.id === focusEvent);
    // Older than the loaded pages: comments still open; the title is generic.
    setCommentsFor(ev ?? { id: focusEvent, actor_id: "", actor_username: null, actor_avatar_url: null, is_me: true,
                           kind: "achievement", payload: { title: "your activity" }, created_at: new Date().toISOString() });
  }, [focusEvent, focusComments, focusKey, status, items]);

  async function refresh() {
    setRefreshing(true);
    await loadFirst();
    setRefreshing(false);
  }

  async function loadMore() {
    if (!next || loadingMore || status !== "ready") return;
    const gen = generation.current;
    setLoadingMore(true);
    setMoreError(false);
    try {
      const page = await getActivityFeed(next);
      if (gen !== generation.current) return;
      setItems((cur) => mergeFeed(cur, page.items));
      setNext(page.next);
      loadInteractions(page.items, false);
    } catch {
      if (gen === generation.current) setMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  // Optimistic: the chip changes at once and reverts if the server says no.
  async function react(event: ActivityEvent, next: ReactionType | null) {
    if (reacting.current.has(event.id)) return;
    reacting.current.add(event.id);
    const before = interactions[event.id] ?? EMPTY_INTERACTIONS;
    setInteractions((cur) => ({ ...cur, [event.id]: applyReaction(before, next) }));
    setActionError(null);
    try {
      if (next) await setReaction(event.id, next);
      else await removeReaction(event.id);
    } catch (e) {
      setInteractions((cur) => ({ ...cur, [event.id]: before }));
      setActionError(describeInteractionError(e));
    } finally {
      reacting.current.delete(event.id);
    }
  }

  const header = (
    <View style={styles.headerRow}>
      <Text style={styles.headerText}>
        {sharing === false ? "Your activity is private" : sharing ? "Sharing milestones with friends" : "Activity"}
      </Text>
      <Pressable testID="feed-visibility" style={styles.pill} onPress={() => setSettingsOpen(true)}
                 accessibilityLabel="Activity visibility settings">
        <Text style={styles.pillText}>Visibility</Text>
      </Pressable>
    </View>
  );

  let body: React.ReactNode = null;
  if (status === "loading") {
    body = (
      <View testID="feed-loading" style={styles.pad}>
        {header}
        {[0, 1, 2, 3].map((i) => <ActivityCardSkeleton key={i} />)}
      </View>
    );
  } else if (status === "unavailable" || status === "error") {
    body = (
      <View testID={`feed-${status}`} style={[styles.pad, styles.center]}>
        <Text style={styles.emptyTitle}>
          {status === "unavailable" ? "Activity isn't switched on yet" : "Couldn't load activity"}
        </Text>
        <Text style={styles.emptyBody}>
          {status === "unavailable"
            ? "This server hasn't been updated for the activity feed."
            : "Check your connection and try again."}
        </Text>
        {status === "error" ? (
          <Pressable testID="feed-retry" style={styles.primary} onPress={() => { setStatus("loading"); loadFirst(); }}>
            <Text style={styles.primaryText}>Try again</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <>
      {body ?? (
        <FlatList
          testID="feed-list"
          data={items}
          keyExtractor={(e) => e.id}
          renderItem={({ item }) => (
            <ActivityCard
              event={item}
              footer={
                <ReactionBar
                  eventId={item.id}
                  value={interactions[item.id] ?? EMPTY_INTERACTIONS}
                  readOnly={item.is_me}
                  onReact={(r) => react(item, r)}
                  onOpenComments={() => setCommentsFor(item)}
                />
              }
            />
          )}
          extraData={interactions}
          contentContainerStyle={styles.pad}
          ListHeaderComponent={
            <>
              {header}
              {actionError ? <Text testID="feed-action-error" style={styles.actionError}>{actionError}</Text> : null}
            </>
          }
          ListEmptyComponent={
            <View testID="feed-empty" style={styles.center}>
              <Text style={styles.emptyIcon}>🌱</Text>
              <Text style={styles.emptyTitle}>Nothing here yet</Text>
              <Text style={styles.emptyBody}>
                Streaks, achievements and challenges from you and friends who share them will show up here.
                Meals, calories and weight are never shared.
              </Text>
              <Pressable testID="feed-find-friends" style={styles.primary} onPress={onFindFriends}>
                <Text style={styles.primaryText}>Find friends</Text>
              </Pressable>
            </View>
          }
          ListFooterComponent={
            loadingMore ? (
              <ActivityIndicator testID="feed-loading-more" color={colors.progressFill} style={{ margin: spacing.md }} />
            ) : moreError ? (
              <Pressable testID="feed-more-retry" onPress={loadMore} style={styles.footer}>
                <Text style={styles.link}>Couldn't load more. Tap to retry.</Text>
              </Pressable>
            ) : next ? (
              <Pressable testID="feed-load-more" onPress={loadMore} style={styles.footer}>
                <Text style={styles.link}>Load older activity</Text>
              </Pressable>
            ) : items.length > 0 ? (
              <Text style={styles.end}>You're all caught up</Text>
            ) : null
          }
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          refreshControl={<RefreshControl tintColor={colors.textPrimary} refreshing={refreshing} onRefresh={refresh} />}
        />
      )}
      <CommentsSheet
        event={commentsFor}
        onClose={(changed) => {
          const ev = commentsFor;
          setCommentsFor(null);
          if (changed && ev) loadInteractions([ev], false);
        }}
      />
      <SharingSettingsModal
        visible={settingsOpen}
        onClose={(changed) => {
          setSettingsOpen(false);
          if (changed) loadFirst();
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  pad: { padding: spacing.lg, paddingTop: spacing.sm, flexGrow: 1 },
  center: { alignItems: "center", paddingVertical: spacing.xl },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.md },
  headerText: { ...typography.caption, color: colors.textSecondary, flex: 1 },
  pill: { borderWidth: 1, borderColor: colors.cardBorder, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 6 },
  pillText: { ...typography.caption, color: colors.textPrimary },
  emptyIcon: { fontSize: 40, marginBottom: spacing.sm },
  emptyTitle: { ...typography.label, fontSize: 16, color: colors.textPrimary, textAlign: "center" },
  emptyBody: { ...typography.caption, color: colors.textSecondary, textAlign: "center", marginTop: spacing.sm, lineHeight: 18, maxWidth: 320 },
  primary: { backgroundColor: colors.progressFill, borderRadius: radius.pill, paddingVertical: spacing.sm, paddingHorizontal: spacing.lg, marginTop: spacing.lg },
  primaryText: { ...typography.label, color: "#0A0A0A" },
  footer: { alignItems: "center", padding: spacing.md },
  link: { ...typography.label, color: colors.progressFill },
  actionError: { ...typography.caption, color: colors.danger, marginBottom: spacing.sm },
  end: { ...typography.caption, color: colors.textTertiary, textAlign: "center", padding: spacing.md },
});
