import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";

interface Props {
  consumed: number;
  target: number;
  /** Low/high "healthy range" band shown next to the target, e.g. target ± 10% */
  rangeLow: number;
  rangeHigh: number;
  /** Right edge of the progress track — deliberately > target, like Samsung Health */
  maxScale: number;
}

export function CalorieSummaryBar({ consumed, target, rangeLow, rangeHigh, maxScale }: Props) {
  const fillPct = Math.min(100, (consumed / maxScale) * 100);
  const targetPct = Math.min(100, (target / maxScale) * 100);

  return (
    <View style={styles.card}>
      <View style={styles.topRow}>
        <View>
          <Text style={styles.bigNumber}>{consumed.toLocaleString()}</Text>
          <Text style={styles.unit}>kcal</Text>
        </View>
        <View style={styles.targetInfo}>
          <View style={styles.targetRow}>
            <View style={styles.targetDot} />
            <Text style={styles.targetText}>{target.toLocaleString()} kcal</Text>
          </View>
          <View style={styles.targetRow}>
            <View style={styles.rangeDot} />
            <Text style={styles.rangeText}>
              {rangeLow.toLocaleString()} - {rangeHigh.toLocaleString()}
            </Text>
          </View>
        </View>
      </View>

      <View style={styles.track}>
        <View style={[styles.fill, { width: `${fillPct}%` }]} />
        <View style={[styles.targetMarker, { left: `${targetPct}%` }]} />
      </View>

      <View style={styles.scaleRow}>
        <Text style={styles.scaleText}>0</Text>
        <Text style={styles.scaleText}>{maxScale.toLocaleString()}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  topRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  bigNumber: {
    ...typography.hero,
    color: colors.textPrimary,
  },
  unit: {
    ...typography.body,
    color: colors.textPrimary,
    marginTop: spacing.xs,
  },
  targetInfo: {
    alignItems: "flex-end",
    gap: spacing.sm,
  },
  targetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  targetDot: {
    width: 20,
    height: 20,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: colors.textSecondary,
  },
  rangeDot: {
    width: 20,
    height: 20,
    borderRadius: radius.pill,
    backgroundColor: colors.textTertiary,
  },
  targetText: {
    ...typography.label,
    color: colors.textSecondary,
  },
  rangeText: {
    ...typography.label,
    color: colors.textSecondary,
  },
  track: {
    height: 14,
    borderRadius: radius.pill,
    backgroundColor: colors.progressTrack,
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
    backgroundColor: colors.progressFill,
  },
  targetMarker: {
    position: "absolute",
    width: 4,
    height: 20,
    top: -3,
    marginLeft: -2,
    borderRadius: 2,
    backgroundColor: colors.textPrimary,
  },
  scaleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: spacing.sm,
  },
  scaleText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
});
