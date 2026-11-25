import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { colors, fonts, radius, spacing, typography } from "@/constants/theme";

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
      <View style={styles.header}>
        <View style={styles.flameTile}>
          <Feather name="zap" size={24} color={colors.accent} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>
            {currentStreak > 0 ? `${currentStreak}-day streak` : "Badge progress"}
          </Text>
          <Text style={styles.subtitle}>{message}</Text>
        </View>
      </View>

      <View style={styles.row}>
        <View style={styles.slotsRow}>
          {slots.map((day) => {
            const filled = day <= currentStreak;
            return (
              <View key={day} style={[styles.slot, filled && styles.slotFilled]}>
                {filled ? (
                  <Feather name="check" size={16} color={colors.accent} />
                ) : (
                  <Text style={styles.slotNumber}>{day}</Text>
                )}
              </View>
            );
          })}
        </View>
        <View style={styles.trophyWrap}>
          <Feather name="award" size={30} color={colors.primary} />
          <Text style={styles.trophyCount}>{goalDays}</Text>
        </View>
      </View>
      {onPress ? <Text style={styles.link}>See all achievements ›</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  link: { ...typography.label, color: colors.onAccent, marginTop: spacing.md },
  card: {
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    padding: 18,
    marginTop: 14,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  flameTile: {
    width: 52,
    height: 52,
    borderRadius: 18,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    ...typography.title,
    fontFamily: fonts.display,
    fontSize: 18,
    color: colors.onAccent,
  },
  subtitle: {
    ...typography.caption,
    fontSize: 13,
    color: colors.onAccent,
    marginTop: 2,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.md,
  },
  slotsRow: {
    flexDirection: "row",
    gap: 6,
  },
  slot: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    backgroundColor: "rgba(18, 61, 44, 0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  slotFilled: {
    backgroundColor: colors.primary,
  },
  slotNumber: {
    ...typography.caption,
    color: colors.onAccent,
  },
  trophyWrap: {
    alignItems: "center",
  },
  trophyCount: {
    ...typography.caption,
    color: colors.onAccent,
    marginTop: 2,
  },
});
