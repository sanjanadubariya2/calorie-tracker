import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Avatar } from "@/components/Avatar";
import { colors, radius, spacing, typography } from "@/constants/theme";
import { relativeTime } from "@/lib/relativeTime";
import {
  describeNotification,
  getNotifications,
  markNotificationsRead,
  notificationIcon,
  notificationTarget,
  type AppNotification,
  type NotificationCursor,
  type NotificationTarget,
} from "@/lib/notifications";
import { NotificationSettingsSheet } from "./NotificationSettingsSheet";

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Called with the screen a tapped notification leads to. */
  onNavigate: (target: NotificationTarget) => void;
}

/** The notification center: newest first, paged, read/unread, tap to open, settings. */
export function NotificationsSheet({ visible, onClose, onNavigate }: Props) {
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [next, setNext] = useState<NotificationCursor | null>(null);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    try {
      const page = await getNotifications(null);
      if (gen !== generation.current) return;
      setItems(page.items);
      setNext(page.next);
      setError(false);
    } catch {
      if (gen === generation.current) setError(true);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    setItems(null);
    load();
  }, [visible, load]);

  async function loadMore() {
    if (!next || loadingMore) return;
    const gen = generation.current;
    setLoadingMore(true);
    try {
      const page = await getNotifications(next);
      if (gen !== generation.current) return;
      setItems((cur) => {
        const seen = new Set((cur ?? []).map((n) => n.id));
        return [...(cur ?? []), ...page.items.filter((n) => !seen.has(n.id))];
      });
      setNext(page.next);
    } catch {
      // keep what's shown; the button stays for another try
    } finally {
      setLoadingMore(false);
    }
  }

  function open(n: AppNotification) {
    if (!n.is_read) {
      setItems((cur) => cur?.map((x) => (x.id === n.id ? { ...x, is_read: true } : x)) ?? cur);
      markNotificationsRead([n.id]).catch(() => undefined);
    }
    onNavigate(notificationTarget(n));
  }

  async function markAll() {
    setItems((cur) => cur?.map((x) => ({ ...x, is_read: true })) ?? cur);
    await markNotificationsRead().catch(() => load());
  }

  const unread = items?.some((n) => !n.is_read) ?? false;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="notifications">
          <View style={styles.titleRow}>
            <Text style={styles.title}>Notifications</Text>
            <View style={styles.headerActions}>
              <Pressable testID="notification-settings" onPress={() => setSettingsOpen(true)} style={styles.iconButton}
                         accessibilityLabel="Notification settings">
                <Text style={styles.icon}>⚙️</Text>
              </Pressable>
              <Pressable testID="notifications-close" onPress={onClose} style={styles.iconButton}>
                <Text style={styles.done}>Done</Text>
              </Pressable>
            </View>
          </View>
          {unread ? (
            <Pressable testID="mark-all-read" onPress={markAll} style={styles.markAll}>
              <Text style={styles.link}>Mark all as read</Text>
            </Pressable>
          ) : null}

          {error && items === null ? (
            <View style={styles.center}>
              <Text style={styles.empty}>Couldn't load notifications.</Text>
              <Pressable testID="notifications-retry" onPress={load} style={styles.retry}><Text style={styles.link}>Try again</Text></Pressable>
            </View>
          ) : items === null ? (
            <View testID="notifications-loading">
              {[0, 1, 2].map((i) => <View key={i} style={styles.skeleton} />)}
            </View>
          ) : (
            <FlatList
              data={items}
              keyExtractor={(n) => n.id}
              style={{ flexGrow: 0 }}
              refreshControl={<RefreshControl tintColor={colors.textPrimary} refreshing={refreshing}
                                              onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
              ListEmptyComponent={
                <Text style={styles.empty} testID="notifications-empty">
                  Friend requests, challenge invitations, achievements and friends' reactions will show up here.
                </Text>
              }
              renderItem={({ item: n }) => (
                <Pressable testID={`notification-${n.id}`} style={[styles.row, !n.is_read && styles.rowUnread]} onPress={() => open(n)}
                           accessibilityRole="button" accessibilityLabel={`${n.is_read ? "" : "Unread. "}${describeNotification(n)}`}>
                  {n.actor_id ? (
                    <Avatar seed={n.actor_id} photoUrl={n.actor_avatar_url} label={n.actor_username ?? undefined} size={40} />
                  ) : (
                    <View style={styles.systemIcon}><Text style={styles.icon}>{notificationIcon(n.kind)}</Text></View>
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.text, !n.is_read && styles.textUnread]}>{describeNotification(n)}</Text>
                    <Text style={styles.time}>{relativeTime(n.created_at)}</Text>
                  </View>
                  {!n.is_read ? <View style={styles.dot} testID={`unread-${n.id}`} /> : null}
                </Pressable>
              )}
              ListFooterComponent={
                loadingMore ? <ActivityIndicator color={colors.progressFill} style={{ margin: spacing.md }} />
                : next ? (
                  <Pressable testID="notifications-more" onPress={loadMore} style={styles.retry}>
                    <Text style={styles.link}>Load older</Text>
                  </Pressable>
                ) : null
              }
            />
          )}
          <Text style={styles.footnote}>Notifications never include what you eat, calories or weight.</Text>
        </View>
      </View>
      <NotificationSettingsSheet visible={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.card, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: spacing.lg,
    maxHeight: "85%", borderWidth: 1, borderColor: colors.cardBorder,
  },
  titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  headerActions: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  iconButton: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  title: { ...typography.title, color: colors.textPrimary },
  done: { ...typography.label, color: colors.progressFill },
  icon: { fontSize: 20 },
  markAll: { alignSelf: "flex-start", paddingVertical: spacing.sm, minHeight: 44, justifyContent: "center" },
  link: { ...typography.label, color: colors.progressFill },
  center: { alignItems: "center", padding: spacing.lg },
  empty: { ...typography.caption, color: colors.textSecondary, textAlign: "center", padding: spacing.lg, lineHeight: 18 },
  retry: { alignItems: "center", padding: spacing.md, minHeight: 44 },
  skeleton: { height: 56, borderRadius: radius.md, backgroundColor: colors.pillBackground, marginBottom: spacing.sm },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.sm, borderRadius: radius.md, minHeight: 56 },
  rowUnread: { backgroundColor: "rgba(126,211,33,0.06)" },
  systemIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.pillBackground, alignItems: "center", justifyContent: "center" },
  text: { ...typography.body, fontSize: 14, color: colors.textSecondary, lineHeight: 19 },
  textUnread: { color: colors.textPrimary },
  time: { ...typography.caption, color: colors.textTertiary, marginTop: 2 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.progressFill },
  footnote: { ...typography.caption, fontSize: 11, color: colors.textTertiary, textAlign: "center", marginTop: spacing.md },
});
