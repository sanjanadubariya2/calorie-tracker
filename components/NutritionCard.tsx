import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";
import { MacroBar } from "./MacroBar";
import { DEFAULT_MACRO_SPLIT, calculateActualMacroPercents, type MacroSplit } from "@/lib/calculations";

interface Props {
  carbsG: number;
  fatG: number;
  proteinG: number;
  /** The user's own split from their profile (get_daily_status). */
  split?: MacroSplit | null;
}

export function NutritionCard({ carbsG, fatG, proteinG, split }: Props) {
  const actual = calculateActualMacroPercents(carbsG, fatG, proteinG);
  const recommended = split ?? DEFAULT_MACRO_SPLIT;

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Nutrition info</Text>
      </View>

      <View style={styles.macroCardsRow}>
        <MacroStat label="Protein" value={proteinG} color={colors.protein} />
        <MacroStat label="Carb" value={carbsG} color={colors.carb} />
        <MacroStat label="Fat" value={fatG} color={colors.fat} />
      </View>

      <MacroBar
        label="Actual"
        carbPct={actual.carbPct}
        fatPct={actual.fatPct}
        proteinPct={actual.proteinPct}
        emphasized
      />
      <MacroBar
        label="Recommended"
        carbPct={recommended.carbPct}
        fatPct={recommended.fatPct}
        proteinPct={recommended.proteinPct}
        emphasized={false}
      />
    </View>
  );
}

function MacroStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={styles.macroStat}>
      <View style={styles.macroLabelRow}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <Text style={styles.macroLabel}>{label}</Text>
      </View>
      <Text style={styles.macroValue}>
        {Math.round(value * 10) / 10}
        <Text style={styles.macroUnit}> g</Text>
      </Text>
    </View>
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
    alignItems: "center",
  },
  title: {
    ...typography.title,
    color: colors.textPrimary,
  },
  macroCardsRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  macroStat: {
    flex: 1,
    backgroundColor: colors.background,
    borderRadius: radius.md,
    padding: 14,
  },
  macroLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: spacing.xs,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: radius.pill,
  },
  macroLabel: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  macroValue: {
    ...typography.title,
    color: colors.textPrimary,
  },
  macroUnit: {
    ...typography.caption,
    color: colors.textSecondary,
  },
});
