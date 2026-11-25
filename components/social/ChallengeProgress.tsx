import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";
import { progressFraction } from "@/lib/challenges";

interface Props {
  progress: number;
  target: number;
  completed?: boolean;
  compact?: boolean;
}

/** One dot per target day plus a bar: easy to read at a glance, and never a ranking. */
export function ChallengeProgress({ progress, target, completed, compact }: Props) {
  const done = Math.min(progress, target);
  const pct = progressFraction(progress, target);
  const fill = completed ? colors.badgeActive : colors.progressFill;
  return (
    <View accessible accessibilityLabel={`${done} of ${target} days`} testID="challenge-progress">
      {target <= 14 ? (
        <View style={styles.dots}>
          {Array.from({ length: target }, (_, i) => (
            <View
              key={i}
              style={[styles.dot, compact && styles.dotSmall, i < done ? { backgroundColor: fill, borderColor: fill } : null]}
            >
              {!compact && i < done ? <Text style={styles.tick}>✓</Text> : null}
            </View>
          ))}
          <Text style={styles.count}>{done}/{target}</Text>
        </View>
      ) : (
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${pct * 100}%`, backgroundColor: fill }]} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  dots: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  dot: {
    width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: colors.cardBorder,
    backgroundColor: colors.progressTrack, alignItems: "center", justifyContent: "center",
  },
  dotSmall: { width: 12, height: 12, borderRadius: 6 },
  tick: { fontSize: 12, fontWeight: "700", color: colors.onAccent },
  count: { ...typography.caption, color: colors.textSecondary, marginLeft: spacing.xs },
  track: { height: 8, borderRadius: radius.pill, backgroundColor: colors.progressTrack, overflow: "hidden" },
  fill: { height: "100%", borderRadius: radius.pill },
});
