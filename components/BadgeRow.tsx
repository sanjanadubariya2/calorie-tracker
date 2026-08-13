import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";

interface Props {
  currentStreak: number;
  /** Weekly badge track, 7 slots, matching the reference screenshot */
  goalDays?: number;
}

export function BadgeRow({ currentStreak, goalDays = 7 }: Props) {
  const slots = Array.from({ length: goalDays }, (_, i) => i + 1);
  const message =
    currentStreak === 0
      ? "Log a meal today to start your streak!"
      : currentStreak === 1
      ? "Great start!"
      : "Another day down!";

  return (
    <View style={styles.card}>
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
    </View>
  );
}

const styles = StyleSheet.create({
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
