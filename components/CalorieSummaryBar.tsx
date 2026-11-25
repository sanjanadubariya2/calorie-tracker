import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, fonts, radius, spacing, typography } from "@/constants/theme";

interface Props {
  consumed: number;
  target: number;
  /** Low/high "healthy range" band shown next to the target, e.g. target ± 10% */
  rangeLow: number;
  rangeHigh: number;
  /** Right edge of the progress track — deliberately > target, like Samsung Health */
  maxScale: number;
}

/** Evergreen hero card: the day's headline number, what's left, and the track against the target. */
export function CalorieSummaryBar({ consumed, target, rangeLow, rangeHigh, maxScale }: Props) {
  const fillPct = Math.min(100, (consumed / maxScale) * 100);
  const targetPct = Math.min(100, (target / maxScale) * 100);
  const remaining = target - consumed;
  const over = remaining < 0;

  return (
    <View style={styles.card}>
      <View style={styles.topRow}>
        <View style={styles.numbers}>
          <Text style={styles.kicker}>Calories eaten</Text>
          <Text style={styles.bigNumber}>{consumed.toLocaleString()}</Text>
          <Text style={styles.kicker}>of {target.toLocaleString()} kcal target</Text>
        </View>
        <View style={styles.leftBadge} accessible accessibilityLabel={
          over ? `${Math.abs(remaining)} kilocalories over target` : `${remaining} kilocalories left`}>
          <Text style={styles.leftValue}>{Math.abs(remaining).toLocaleString()}</Text>
          <Text style={styles.leftUnit}>{over ? "kcal over" : "kcal left"}</Text>
        </View>
      </View>

      <View style={styles.track}>
        <View style={[styles.fill, { width: `${fillPct}%` }]} />
        <View style={[styles.targetMarker, { left: `${targetPct}%` }]} />
      </View>

      <View style={styles.scaleRow}>
        <Text style={styles.scaleText}>0</Text>
        <Text style={styles.scaleText}>
          Healthy range {rangeLow.toLocaleString()} – {rangeHigh.toLocaleString()}
        </Text>
        <Text style={styles.scaleText}>{maxScale.toLocaleString()}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.primary,
    borderRadius: radius.xl,
    padding: 22,
  },
  topRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.md,
  },
  numbers: {
    flex: 1,
  },
  kicker: {
    ...typography.label,
    fontFamily: fonts.bodyMedium,
    fontWeight: "500",
    fontSize: 13,
    color: colors.heroMuted,
  },
  bigNumber: {
    ...typography.hero,
    color: colors.onPrimary,
    marginVertical: spacing.xs,
  },
  leftBadge: {
    width: 116,
    height: 116,
    borderRadius: radius.pill,
    borderWidth: 12,
    borderColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  leftValue: {
    fontFamily: fonts.display,
    fontWeight: "800",
    fontSize: 24,
    color: colors.accent,
  },
  leftUnit: {
    ...typography.caption,
    color: colors.heroMuted,
  },
  track: {
    height: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.heroTrack,
    marginTop: spacing.lg,
    overflow: "visible",
    justifyContent: "center",
  },
  fill: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  targetMarker: {
    position: "absolute",
    width: 4,
    height: 18,
    top: -4,
    marginLeft: -2,
    borderRadius: 2,
    backgroundColor: colors.onPrimary,
  },
  scaleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: spacing.sm,
  },
  scaleText: {
    ...typography.caption,
    color: colors.heroMuted,
  },
});
