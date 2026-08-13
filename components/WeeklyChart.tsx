import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";

export interface DayTotal {
  date: string; // YYYY-MM-DD
  dayLabel: string; // e.g. "12"
  totalKcal: number;
  isToday: boolean;
}

interface Props {
  days: DayTotal[];
  averageKcal: number;
  /** Drills into the full Reports screen, matching the reference's chevron. */
  onPress?: () => void;
}

const CHART_HEIGHT = 140;

export function WeeklyChart({ days, averageKcal, onPress }: Props) {
  const maxValue = Math.max(averageKcal, ...days.map((d) => d.totalKcal), 1);

  return (
    <Pressable style={styles.card} onPress={onPress} disabled={!onPress}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Calorie intake over last 7 days</Text>
        {onPress && <Text style={styles.chevron}>›</Text>}
      </View>

      <View style={styles.chartArea}>
        <View
          style={[
            styles.avgLine,
            { bottom: (averageKcal / maxValue) * CHART_HEIGHT },
          ]}
        />
        <View style={styles.avgLabelWrap}>
          <Text style={styles.avgLabel}>Avg.</Text>
          <Text style={styles.avgValue}>{Math.round(averageKcal).toLocaleString()}</Text>
        </View>

        <View style={styles.barsRow}>
          {days.map((day) => {
            const barHeight = day.totalKcal > 0 ? Math.max(6, (day.totalKcal / maxValue) * CHART_HEIGHT) : 0;
            return (
              <View key={day.date} style={styles.barCol}>
                <View style={styles.barTrack}>
                  <View
                    style={[
                      styles.bar,
                      {
                        height: barHeight,
                        backgroundColor: day.isToday ? colors.chartToday : colors.chartPast,
                      },
                    ]}
                  />
                </View>
                <Text style={[styles.dayLabel, day.isToday && styles.dayLabelToday]}>
                  {day.dayLabel}
                </Text>
              </View>
            );
          })}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginTop: spacing.md,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  title: {
    ...typography.title,
    color: colors.textPrimary,
    flex: 1,
  },
  chevron: {
    fontSize: 22,
    color: colors.textSecondary,
    paddingLeft: spacing.sm,
  },
  chartArea: {
    marginTop: spacing.lg,
    position: "relative",
  },
  avgLine: {
    position: "absolute",
    left: 0,
    right: 0,
    borderTopWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.textTertiary,
  },
  avgLabelWrap: {
    position: "absolute",
    right: 0,
    top: -28,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    alignItems: "center",
  },
  avgLabel: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  avgValue: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: "700",
  },
  barsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
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
    width: 10,
    borderRadius: radius.pill,
  },
  dayLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.sm,
  },
  dayLabelToday: {
    color: colors.textPrimary,
    fontWeight: "700",
  },
});
