import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";
import {
  daysLeft,
  kindLabel,
  metricLabel,
  progressMessage,
  stateLabel,
  type CatalogEntry,
  type MyChallenge,
} from "@/lib/challenges";
import { ChallengeProgress } from "./ChallengeProgress";

const STATE_COLOR: Record<string, string> = {
  completed: colors.badgeActive,
  active: colors.progressFill,
  upcoming: colors.chartPast,
  invited: colors.carb,
};

export function StateChip({ state }: { state: MyChallenge["state"] }) {
  const color = STATE_COLOR[state] ?? colors.textTertiary;
  return (
    <View style={[styles.chip, { borderColor: color }]}>
      <Text style={[styles.chipText, { color }]}>{stateLabel(state)}</Text>
    </View>
  );
}

interface CardProps {
  challenge: MyChallenge;
  today: string;
  busy?: boolean;
  onOpen: () => void;
  onCheckIn?: () => void;
  onAccept?: () => void;
  onDecline?: () => void;
}

/** A joined challenge with its progress; check-in or invitation buttons when they apply. */
export function ChallengeProgressCard({ challenge: c, today, busy, onOpen, onCheckIn, onAccept, onDecline }: CardProps) {
  const left = daysLeft(c.ends_on, today);
  const canCheckIn = c.state === "active" && c.metric === "checkin_days";
  return (
    <Pressable testID={`challenge-${c.challenge_id}`} style={styles.card} onPress={onOpen}
               accessibilityRole="button" accessibilityLabel={`${c.title}, ${stateLabel(c.state)}`}>
      <View style={styles.topRow}>
        <Text style={styles.title} numberOfLines={2}>{c.title}</Text>
        <StateChip state={c.state} />
      </View>
      <Text style={styles.meta}>
        {kindLabel(c.kind)} · {metricLabel(c.metric)}
        {c.invited_by_username && c.state === "invited" ? ` · from @${c.invited_by_username}` : ""}
      </Text>

      {c.state === "invited" ? (
        <View style={styles.actions}>
          <Pressable testID={`decline-${c.challenge_id}`} style={styles.secondary} onPress={onDecline} disabled={busy}>
            <Text style={styles.secondaryText}>Decline</Text>
          </Pressable>
          <Pressable testID={`accept-${c.challenge_id}`} style={styles.primary} onPress={onAccept} disabled={busy}>
            <Text style={styles.primaryText}>{busy ? "…" : "Join"}</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <View style={{ marginTop: spacing.md }}>
            <ChallengeProgress progress={c.progress_days} target={c.target_days} completed={c.state === "completed"} />
          </View>
          <Text style={styles.message}>{progressMessage(c, left)}</Text>
          {canCheckIn ? (
            c.checked_in_today ? (
              <View testID={`checked-in-${c.challenge_id}`} style={styles.checkedIn}>
                <Text style={styles.checkedInText}>✓ Checked in today</Text>
              </View>
            ) : (
              <Pressable testID={`checkin-${c.challenge_id}`} style={[styles.primary, styles.wide]} onPress={onCheckIn}
                         disabled={busy}>
                {busy ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.primaryText}>{c.checkin_label ?? "Check in"}</Text>}
              </Pressable>
            )
          ) : null}
        </>
      )}
    </Pressable>
  );
}

interface CatalogProps {
  entry: CatalogEntry;
  busy?: boolean;
  onJoin?: () => void;
  onStart: () => void;
}

/** Discovery card: join this week's app challenge, or start your own. */
export function CatalogCard({ entry: e, busy, onJoin, onStart }: CatalogProps) {
  const joined = e.my_state === "active" || e.my_state === "completed" || e.my_state === "upcoming";
  return (
    <View testID={`catalog-${e.template_code}`} style={styles.card}>
      <View style={styles.topRow}>
        <Text style={styles.title} numberOfLines={2}>{e.title}</Text>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{e.cadence === "daily" ? "Today" : `${e.target_days} of ${e.duration_days} days`}</Text>
        </View>
      </View>
      <Text style={styles.body}>{e.description}</Text>
      <Text style={styles.meta}>
        {metricLabel(e.metric)}
        {e.app_challenge_id && e.participant_count > 0 ? ` · ${e.participant_count} taking part` : ""}
      </Text>
      {e.safety_note ? <Text style={styles.safety}>{e.safety_note}</Text> : null}
      <View style={styles.actions}>
        <Pressable testID={`start-${e.template_code}`} style={styles.secondary} onPress={onStart}>
          <Text style={styles.secondaryText}>{e.app_challenge_id ? "Start with friends" : "Start"}</Text>
        </Pressable>
        {e.app_challenge_id ? (
          joined ? (
            <View testID={`joined-${e.template_code}`} style={[styles.primary, styles.joined]}>
              <Text style={styles.joinedText}>✓ Joined</Text>
            </View>
          ) : (
            <Pressable testID={`join-${e.template_code}`} style={styles.primary} onPress={onJoin} disabled={busy}>
              <Text style={styles.primaryText}>{busy ? "…" : "Join this week"}</Text>
            </Pressable>
          )
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md },
  topRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: spacing.sm },
  title: { ...typography.label, fontSize: 16, color: colors.textPrimary, flex: 1 },
  meta: { ...typography.caption, color: colors.textTertiary, marginTop: spacing.xs },
  body: { ...typography.caption, fontSize: 13, color: colors.textSecondary, marginTop: spacing.xs, lineHeight: 18 },
  safety: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.sm, fontStyle: "italic" },
  message: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.sm },
  chip: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  chipText: { ...typography.caption, fontSize: 11 },
  badge: { backgroundColor: colors.pillBackground, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 3 },
  badgeText: { ...typography.caption, fontSize: 11, color: colors.textSecondary },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm, marginTop: spacing.md },
  primary: {
    backgroundColor: colors.progressFill, borderRadius: radius.pill, paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm, alignItems: "center", justifyContent: "center",
  },
  primaryText: { ...typography.label, color: colors.onAccent },
  wide: { marginTop: spacing.md },
  secondary: { borderWidth: 1, borderColor: colors.cardBorder, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  secondaryText: { ...typography.label, color: colors.textPrimary },
  joined: { backgroundColor: colors.pillBackground },
  joinedText: { ...typography.label, color: colors.link },
  checkedIn: { marginTop: spacing.md, alignItems: "center", paddingVertical: spacing.sm, borderRadius: radius.pill, backgroundColor: colors.pillBackground },
  checkedInText: { ...typography.label, color: colors.link },
});
