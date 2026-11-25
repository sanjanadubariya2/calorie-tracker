import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
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
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Last 7 days</Text>
          <Text style={styles.subtitle}>Calorie intake · avg. {Math.round(averageKcal).toLocaleString()} kcal</Text>
        </View>
        {onPress && <Feather name="chevron-right" size={20} color={colors.textSecondary} />}
      </View>

      <View style={styles.chartArea}>
        <View
          style={[
            styles.avgLine,
            { bottom: (averageKcal / maxValue) * CHART_HEIGHT },
          ]}
        />

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
    padding: 18,
    marginTop: 14,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  title: {
    ...typography.title,
    fontSize: 17,
    color: colors.textPrimary,
  },
  subtitle: {
    ...typography.caption,
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 2,
  },
  chartArea: {
    marginTop: spacing.xl,
    position: "relative",
  },
  avgLine: {
    position: "absolute",
    left: 0,
    right: 0,
    borderTopWidth: 2,
    borderStyle: "dashed",
    borderColor: colors.chartPast,
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
    width: 26,
    borderRadius: 10,
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
