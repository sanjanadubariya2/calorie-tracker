import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";

interface Props {
  currentStreak: number;
  /** Weekly badge track, 7 slots, matching the reference screenshot */
  goalDays?: number;
  /** Opens the achievements screen. */
  onPress?: () => void;
}

export function BadgeRow({ currentStreak, goalDays = 7, onPress }: Props) {
  const slots = Array.from({ length: goalDays }, (_, i) => i + 1);
  const message =
    currentStreak === 0
      ? "Log a meal today to start a streak. Every day is a fresh start."
      : currentStreak === 1
      ? "Great start!"
      : "Another day down!";

  return (
    <Pressable style={styles.card} onPress={onPress} disabled={!onPress} testID="badge-row"
               accessibilityRole={onPress ? "button" : undefined} accessibilityHint="Opens your achievements">
      <Text style={styles.title}>Badge progress</Text>
      <Text style={styles.subtitle}>{message}</Text>

      <View style={styles.row}>
        <View style={styles.slotsRow}>
          {slots.map((day) => {
            const filled = day <= currentStreak;
            return (
              <View key={day} style={[styles.slot, filled && styles.slotFilled]}>
                {filled ? (
                  <Text style={styles.checkmark}>✓</Text>
                ) : (
                  <Text style={styles.slotNumber}>{day}</Text>
                )}
              </View>
            );
          })}
        </View>
        <View style={styles.trophyWrap}>
          <Text style={styles.trophyEmoji}>🏆</Text>
          <Text style={styles.trophyCount}>{goalDays}</Text>
        </View>
      </View>
      {onPress ? <Text style={styles.link}>See all achievements ›</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  link: { ...typography.caption, color: colors.progressFill, marginTop: spacing.md },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginTop: spacing.md,
  },
  title: {
    ...typography.title,
    color: colors.textPrimary,
  },
  subtitle: {
    ...typography.body,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.lg,
  },
  slotsRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  slot: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    backgroundColor: colors.badgeInactive,
    alignItems: "center",
    justifyContent: "center",
  },
  slotFilled: {
    backgroundColor: colors.badgeActive,
  },
  checkmark: {
    color: "#1A1A1A",
    fontWeight: "700",
  },
  slotNumber: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  trophyWrap: {
    alignItems: "center",
  },
  trophyEmoji: {
    fontSize: 40,
  },
  trophyCount: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: -6,
  },
});
