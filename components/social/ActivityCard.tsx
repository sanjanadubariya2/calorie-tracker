import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Avatar } from "@/components/Avatar";
import { colors, radius, spacing, typography } from "@/constants/theme";
import { describeActivity, type ActivityEvent } from "@/lib/socialActivity";
import { relativeTime } from "@/lib/relativeTime";

interface Props {
  event: ActivityEvent;
  now?: Date;
  /** Reactions and comments row. */
  footer?: React.ReactNode;
}

/** One feed entry: who, what milestone, when. Only whitelisted, non-health facts. */
export function ActivityCard({ event, now, footer }: Props) {
  const { icon, title } = describeActivity(event);
  const name = event.is_me ? "You" : event.actor_username ? `@${event.actor_username}` : "A friend";
  return (
    <View testID={`activity-${event.id}`} style={styles.outer}>
    <View style={styles.inner} accessible accessibilityLabel={`${name}. ${title}.`}>
      <Avatar seed={event.actor_id} photoUrl={event.actor_avatar_url} label={event.actor_username ?? undefined} size={40} />
      <View style={styles.body}>
        <View style={styles.header}>
          <Text style={[styles.name, event.is_me && styles.me]} numberOfLines={1}>{name}</Text>
          <Text style={styles.time}>{relativeTime(event.created_at, now)}</Text>
        </View>
        <Text style={styles.title}>{title}</Text>
      </View>
      <View style={styles.iconWrap}>
        <Text style={styles.icon}>{icon}</Text>
      </View>
    </View>
    {footer}
    </View>
  );
}

/** Placeholder card shown while the first page loads. */
export function ActivityCardSkeleton() {
  return (
    <View style={styles.card} testID="activity-skeleton">
      <View style={[styles.skeleton, { width: 40, height: 40, borderRadius: 20 }]} />
      <View style={styles.body}>
        <View style={[styles.skeleton, { width: "40%", height: 12 }]} />
        <View style={[styles.skeleton, { width: "80%", height: 12, marginTop: spacing.sm }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: { backgroundColor: colors.card, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  inner: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  body: { flex: 1 },
  header: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: spacing.sm },
  name: { ...typography.label, color: colors.textPrimary, flexShrink: 1 },
  me: { color: colors.progressFill },
  time: { ...typography.caption, color: colors.textTertiary },
  title: { ...typography.body, fontSize: 15, color: colors.textSecondary, marginTop: 2, lineHeight: 20 },
  iconWrap: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: colors.pillBackground,
    alignItems: "center", justifyContent: "center",
  },
  icon: { fontSize: 18 },
  skeleton: { backgroundColor: colors.pillBackground, borderRadius: radius.sm },
});
