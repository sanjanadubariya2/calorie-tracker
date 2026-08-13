import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";
import type { ReportBucket } from "@/lib/reportPeriods";

const CHART_HEIGHT = 180;

interface CalorieProps {
  buckets: ReportBucket[];
  averageKcal: number;
  targetKcal: number;
}

/** Calories view: one bar per bucket, with the target band and average line. */
export function CalorieReportChart({ buckets, averageKcal, targetKcal }: CalorieProps) {
  const peak = Math.max(targetKcal * 1.5, averageKcal, ...buckets.map((b) => b.totalKcal), 1);
  const toY = (value: number) => (value / peak) * CHART_HEIGHT;

  const bandLow = targetKcal * 0.9;
  const bandHeight = Math.max(2, toY(targetKcal * 1.1) - toY(bandLow));

  return (
    <View style={styles.chartArea}>
      <Text style={[styles.gridLabel, { bottom: CHART_HEIGHT - 6 }]}>{Math.round(peak).toLocaleString()}</Text>

      {/* Target band — the "healthy range" stripe from the reference. */}
      <View style={[styles.targetBand, { bottom: toY(bandLow), height: bandHeight }]} />
      <Text style={[styles.gridLabel, { bottom: toY(targetKcal) - 6 }]}>
        {Math.round(targetKcal).toLocaleString()}
      </Text>

      {averageKcal > 0 && (
        <>
          <View style={[styles.avgLine, { bottom: toY(averageKcal) }]} />
          <View style={[styles.avgPill, { bottom: toY(averageKcal) - 10 }]}>
            <Text style={styles.avgPillText}>Avg.</Text>
          </View>
        </>
      )}

      <View style={styles.barsRow}>
        {buckets.map((bucket) => {
          const height = bucket.totalKcal > 0 ? Math.max(6, toY(bucket.totalKcal)) : 0;
          return (
            <View key={bucket.key} style={styles.barCol}>
              <View style={styles.barTrack}>
                <View
                  style={[
                    styles.bar,
                    {
                      height,
                      backgroundColor: bucket.isCurrent ? colors.chartToday : colors.chartPast,
                    },
                  ]}
                />
              </View>
              <Text style={[styles.axisLabel, bucket.isCurrent && styles.axisLabelCurrent]}>
                {bucket.label}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

interface MacroProps {
  buckets: ReportBucket[];
}

/** Macronutrients view: each bar is a 100%-stacked carb/fat/protein column. */
export function MacroReportChart({ buckets }: MacroProps) {
  return (
    <View style={styles.chartArea}>
      {[100, 70, 40].map((line) => (
        <React.Fragment key={line}>
          <View style={[styles.gridLine, { bottom: (line / 100) * CHART_HEIGHT }]} />
          <Text style={[styles.gridLabel, { bottom: (line / 100) * CHART_HEIGHT - 6 }]}>{line}</Text>
        </React.Fragment>
      ))}

      <View style={styles.barsRow}>
        {buckets.map((bucket) => {
          const carbKcal = bucket.carbsG * 4;
          const fatKcal = bucket.fatG * 9;
          const proteinKcal = bucket.proteinG * 4;
          const total = carbKcal + fatKcal + proteinKcal;

          return (
            <View key={bucket.key} style={styles.barCol}>
              <View style={styles.barTrack}>
                {total > 0 ? (
                  <View style={[styles.stackedBar, { height: CHART_HEIGHT }]}>
                    <View style={{ flex: carbKcal, backgroundColor: colors.carb }} />
                    <View style={{ flex: fatKcal, backgroundColor: colors.fat }} />
                    <View style={{ flex: proteinKcal, backgroundColor: colors.protein }} />
                  </View>
                ) : null}
              </View>
              <Text style={[styles.axisLabel, bucket.isCurrent && styles.axisLabelCurrent]}>
                {bucket.label}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  chartArea: {
    marginTop: spacing.xl,
    position: "relative",
    paddingRight: 44,
  },
  barsRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    height: CHART_HEIGHT,
  },
  barCol: {
    alignItems: "center",
    flex: 1,
  },
  barTrack: {
    height: CHART_HEIGHT,
    justifyContent: "flex-end",
  },
  bar: {
    width: 12,
    borderRadius: radius.pill,
  },
  stackedBar: {
    width: 12,
    borderRadius: radius.pill,
    overflow: "hidden",
  },
  axisLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.sm,
  },
  axisLabelCurrent: {
    color: colors.textPrimary,
    fontWeight: "700",
  },
  gridLine: {
    position: "absolute",
    left: 0,
    right: 44,
    borderTopWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.divider,
  },
  gridLabel: {
    position: "absolute",
    right: 0,
    ...typography.caption,
    color: colors.textSecondary,
  },
  targetBand: {
    position: "absolute",
    left: 0,
    right: 44,
    backgroundColor: "rgba(126, 211, 33, 0.12)",
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: "rgba(126, 211, 33, 0.35)",
  },
  avgLine: {
    position: "absolute",
    left: 0,
    right: 44,
    borderTopWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.textTertiary,
  },
  avgPill: {
    position: "absolute",
    right: 0,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.card,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
  },
  avgPillText: {
    ...typography.caption,
    color: colors.textPrimary,
  },
});
