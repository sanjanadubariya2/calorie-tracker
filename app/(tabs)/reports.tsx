import React, { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { useAuth } from "@/lib/auth-context";
import { getDailyStatus, getDailyTotals } from "@/lib/api";
import { DEFAULT_TARGET_KCAL } from "@/lib/calculations";
import type { NutritionRow } from "@/lib/nutrition";
import {
  bucketLogs,
  buildPeriodRange,
  formatRangeLabel,
  summarizePeriod,
  toISODate,
  type PeriodMode,
} from "@/lib/reportPeriods";
import { CalorieReportChart, MacroReportChart } from "@/components/ReportChart";
import { colors, radius, spacing, typography } from "@/constants/theme";

type Metric = "calories" | "macros";

const MODES: { key: PeriodMode; label: string }[] = [
  { key: "days", label: "Days" },
  { key: "weeks", label: "Weeks" },
  { key: "months", label: "Months" },
];

export default function ReportsScreen() {
  const { userId } = useAuth();
  const today = toISODate(new Date());

  const [mode, setMode] = useState<PeriodMode>("days");
  const [metric, setMetric] = useState<Metric>("calories");
  const [offset, setOffset] = useState(0);
  const [logs, setLogs] = useState<NutritionRow[]>([]);
  const [targetKcal, setTargetKcal] = useState(DEFAULT_TARGET_KCAL);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const range = useMemo(() => buildPeriodRange(mode, today, offset), [mode, today, offset]);

  const loadData = useCallback(async () => {
    if (!userId) return;
    // Per-day, per-meal sums from the database instead of every raw log in the
    // window (up to six months). The target line is the target in force at the
    // end of the period, from the user's target history.
    const lastDay = range.end < today ? range.end : today;
    const [rows, status] = await Promise.all([
      getDailyTotals(range.start, range.end),
      getDailyStatus(lastDay),
    ]);
    setLogs(rows);
    setTargetKcal(status.targetKcal ?? DEFAULT_TARGET_KCAL);
  }, [userId, range.start, range.end, today]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      setLoadError(null);
      loadData()
        .catch(() => setLoadError("Couldn't load this period. Try again."))
        .finally(() => setLoading(false));
    }, [loadData])
  );

  const buckets = useMemo(() => bucketLogs(mode, range, logs, today), [mode, range, logs, today]);
  const summary = useMemo(() => summarizePeriod(logs), [logs]);

  const isCurrentPeriod = offset === 0;

  return (
    <ScrollView style={styles.wrap} contentContainerStyle={styles.content}>
      <Text style={styles.screenTitle}>Food</Text>

      <View style={styles.modeRow}>
        {MODES.map((m) => {
          const active = m.key === mode;
          return (
            <Pressable
              key={m.key}
              style={[styles.modeChip, active && styles.modeChipActive]}
              onPress={() => {
                setMode(m.key);
                setOffset(0);
              }}
            >
              <Text style={[styles.modeText, active && styles.modeTextActive]}>{m.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.card}>
        <View style={styles.rangeRow}>
          <Pressable onPress={() => setOffset((o) => o - 1)} hitSlop={12} accessibilityLabel="Previous period">
            <Text style={styles.rangeChevron}>‹</Text>
          </Pressable>
          <Text style={styles.rangeLabel}>{formatRangeLabel(mode, range)}</Text>
          <Pressable
            onPress={() => setOffset((o) => Math.min(0, o + 1))}
            disabled={isCurrentPeriod}
            hitSlop={12}
            accessibilityLabel="Next period"
          >
            <Text style={[styles.rangeChevron, isCurrentPeriod && styles.rangeChevronDisabled]}>›</Text>
          </Pressable>
        </View>

        <View style={styles.metricRow}>
          <Pressable
            style={[styles.metricChip, metric === "calories" && styles.metricChipActive]}
            onPress={() => setMetric("calories")}
          >
            <Text style={[styles.metricText, metric === "calories" && styles.metricTextActive]}>
              Calories
            </Text>
          </Pressable>
          <Pressable
            style={[styles.metricChip, metric === "macros" && styles.metricChipActive]}
            onPress={() => setMetric("macros")}
          >
            <Text style={[styles.metricText, metric === "macros" && styles.metricTextActive]}>
              Macronutrients
            </Text>
          </Pressable>
        </View>

        {loading ? (
          <View style={styles.spinnerWrap}>
            <ActivityIndicator color={colors.link} size="large" />
          </View>
        ) : loadError ? (
          <View style={styles.spinnerWrap}>
            <Text style={styles.emptyTitle}>{loadError}</Text>
          </View>
        ) : summary.loggedDayCount === 0 ? (
          <View style={styles.spinnerWrap}>
            <Text style={styles.emptyTitle}>Nothing logged in this period</Text>
            <Text style={styles.emptyBody}>Log a meal to see your trends here.</Text>
          </View>
        ) : metric === "calories" ? (
          <>
            <View style={styles.averageBadge}>
              <Text style={styles.averageBadgeText}>Average</Text>
            </View>
            <Text style={styles.bigNumber}>
              {summary.averageKcal.toLocaleString()}
              <Text style={styles.bigNumberUnit}> kcal</Text>
            </Text>

            <View style={styles.mealGrid}>
              {summary.perMealAverage.map((m) => (
                <View key={m.meal} style={styles.mealCell}>
                  <Text style={styles.mealLabel}>{m.label}</Text>
                  <Text style={styles.mealValue}>{m.kcal.toLocaleString()}</Text>
                </View>
              ))}
            </View>

            <CalorieReportChart
              buckets={buckets}
              averageKcal={summary.averageKcal}
              targetKcal={targetKcal}
            />
          </>
        ) : (
          <>
            <View style={styles.macroStatRow}>
              <MacroStat
                label="Carb"
                color={colors.carb}
                percent={summary.carbPct}
                grams={`${summary.totalCarbsG} g`}
              />
              <MacroStat
                label="Fat"
                color={colors.fat}
                percent={summary.fatPct}
                grams={`${summary.totalFatG} g`}
              />
              <MacroStat
                label="Protein"
                color={colors.protein}
                percent={summary.proteinPct}
                grams={`${summary.totalProteinG} g`}
              />
            </View>
            <Text style={styles.macroCaption}>Daily average across days you logged.</Text>

            <MacroReportChart buckets={buckets} />
          </>
        )}
      </View>

      <View style={{ height: spacing.xl }} />
    </ScrollView>
  );
}

function MacroStat({
  label,
  color,
  percent,
  grams,
}: {
  label: string;
  color: string;
  percent: number;
  grams: string;
}) {
  return (
    <View style={styles.macroStat}>
      <View style={styles.macroStatHeader}>
        <View style={[styles.macroDot, { backgroundColor: color }]} />
        <Text style={styles.macroStatLabel}>{label}</Text>
      </View>
      <Text style={styles.macroStatPercent}>
        {percent}
        <Text style={styles.macroStatPercentUnit}> %</Text>
      </Text>
      <Text style={styles.macroStatGrams}>{grams}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: spacing.lg,
  },
  screenTitle: {
    ...typography.title,
    color: colors.textPrimary,
    marginBottom: spacing.md,
  },
  modeRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  modeChip: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  modeChipActive: {
    backgroundColor: colors.primary,
  },
  modeText: {
    ...typography.label,
    color: colors.textSecondary,
  },
  modeTextActive: {
    color: colors.onPrimary,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  rangeRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rangeChevron: {
    fontSize: 22,
    color: colors.textPrimary,
    fontWeight: "600",
    paddingHorizontal: spacing.sm,
  },
  rangeChevronDisabled: {
    color: colors.textTertiary,
  },
  rangeLabel: {
    ...typography.label,
    color: colors.textPrimary,
  },
  metricRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  metricChip: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.pillBackground,
  },
  metricChipActive: {
    backgroundColor: colors.primary,
  },
  metricText: {
    ...typography.label,
    color: colors.textSecondary,
  },
  metricTextActive: {
    color: colors.onPrimary,
  },
  spinnerWrap: {
    paddingVertical: 64,
    alignItems: "center",
  },
  emptyTitle: {
    ...typography.label,
    color: colors.textSecondary,
  },
  emptyBody: {
    ...typography.caption,
    color: colors.textTertiary,
    marginTop: spacing.xs,
  },
  averageBadge: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 2,
    marginTop: spacing.lg,
  },
  averageBadgeText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  bigNumber: {
    fontSize: 44,
    fontWeight: "700",
    color: colors.textPrimary,
    marginTop: spacing.sm,
  },
  bigNumberUnit: {
    ...typography.body,
    color: colors.textSecondary,
  },
  mealGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: spacing.lg,
    rowGap: spacing.sm,
  },
  mealCell: {
    width: "50%",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingRight: spacing.lg,
  },
  mealLabel: {
    ...typography.body,
    color: colors.textSecondary,
  },
  mealValue: {
    ...typography.body,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  macroStatRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  macroStat: {
    flex: 1,
  },
  macroStatHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    alignSelf: "flex-start",
  },
  macroDot: {
    width: 6,
    height: 6,
    borderRadius: radius.pill,
  },
  macroStatLabel: {
    ...typography.caption,
    color: colors.textPrimary,
  },
  macroStatPercent: {
    fontSize: 28,
    fontWeight: "700",
    color: colors.textPrimary,
    marginTop: spacing.sm,
  },
  macroStatPercentUnit: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  macroStatGrams: {
    ...typography.label,
    color: colors.textPrimary,
  },
  macroCaption: {
    ...typography.caption,
    color: colors.textTertiary,
    marginTop: spacing.sm,
  },
});
