import React, { useCallback, useEffect, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { colors, radius, spacing, typography } from "@/constants/theme";
import { ActivityFeed } from "@/components/social/ActivityFeed";
import { ChallengesSection } from "@/components/social/ChallengesSection";
import { FriendsSection } from "@/components/social/FriendsSection";
import { NotificationsSheet } from "@/components/social/NotificationsSheet";
import { getUnreadCount, type NotificationTarget } from "@/lib/notifications";

type Section = "feed" | "challenges" | "friends";

/** What a deep link (notification tap) asked to show. `key` makes repeated links re-trigger. */
export interface SocialFocus {
  challenge?: string;
  event?: string;
  comments?: boolean;
  key: number;
}

const SECTIONS: { key: Section; label: string }[] = [
  { key: "feed", label: "Activity" },
  { key: "challenges", label: "Challenges" },
  { key: "friends", label: "Friends" },
];

/** The Friends tab: activity feed, wellness challenges, and the friends list. */
export default function FriendsScreen() {
  const params = useLocalSearchParams<{ section?: string; challenge?: string; event?: string; comments?: string }>();
  const [section, setSection] = useState<Section>("feed");
  const [focus, setFocus] = useState<SocialFocus | null>(null);
  const [unread, setUnread] = useState(0);
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  const refreshUnread = useCallback(() => {
    getUnreadCount().then(setUnread).catch(() => setUnread(0));
  }, []);
  useFocusEffect(refreshUnread);

  const apply = useCallback((p: { section?: string; challenge?: string; event?: string; comments?: string }) => {
    if (p.section === "feed" || p.section === "challenges" || p.section === "friends") setSection(p.section);
    if (p.challenge || p.event) {
      setFocus({ challenge: p.challenge, event: p.event, comments: p.comments === "1", key: Date.now() });
    }
  }, []);

  // Links from pushes and other screens arrive as route params.
  useEffect(() => {
    apply({ section: params.section, challenge: params.challenge, event: params.event, comments: params.comments });
  }, [apply, params.section, params.challenge, params.event, params.comments]);

  function navigate(target: NotificationTarget) {
    setNotificationsOpen(false);
    refreshUnread();
    if (target.pathname === "/(tabs)/friends") apply(target.params);
    else router.push(target.pathname);
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>Friends</Text>
          <Pressable testID="open-notifications" onPress={() => setNotificationsOpen(true)} hitSlop={10}
                     accessibilityLabel={unread ? `Notifications, ${unread} unread` : "Notifications"}>
            <Feather name="bell" size={20} color={colors.textPrimary} />
            {unread > 0 ? (
              <View style={styles.badge} testID="unread-badge">
                <Text style={styles.badgeText}>{unread > 99 ? "99+" : unread}</Text>
              </View>
            ) : null}
          </Pressable>
        </View>
        <View style={styles.segment} accessibilityRole="tablist">
          {SECTIONS.map((s) => (
            <Pressable
              key={s.key}
              testID={`section-${s.key}`}
              style={[styles.item, section === s.key && styles.itemActive]}
              onPress={() => setSection(s.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: section === s.key }}
            >
              <Text style={[styles.itemText, section === s.key && styles.itemTextActive]}>{s.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <View style={styles.body}>
        {section === "feed" ? (
          <ActivityFeed onFindFriends={() => setSection("friends")} focus={focus} />
        ) : section === "challenges" ? (
          <ChallengesSection focus={focus} />
        ) : (
          <FriendsSection />
        )}
      </View>
      <NotificationsSheet
        visible={notificationsOpen}
        onClose={() => { setNotificationsOpen(false); refreshUnread(); }}
        onNavigate={navigate}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.background },
  header: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.md },
  title: { ...typography.title, color: colors.textPrimary },
  badge: {
    position: "absolute", top: -4, right: -8, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4,
    backgroundColor: colors.danger, alignItems: "center", justifyContent: "center",
  },
  badgeText: { fontSize: 10, fontWeight: "700", color: "#FFFFFF" },
  segment: { flexDirection: "row", backgroundColor: colors.pillBackground, borderRadius: radius.pill, padding: 3, marginBottom: spacing.sm },
  item: { flex: 1, alignItems: "center", paddingVertical: spacing.sm, borderRadius: radius.pill },
  itemActive: { backgroundColor: colors.primary },
  itemText: { ...typography.label, color: colors.textSecondary },
  itemTextActive: { color: colors.onPrimary },
  body: { flex: 1 },
});
