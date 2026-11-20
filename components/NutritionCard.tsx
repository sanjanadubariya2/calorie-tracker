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
        <MacroStat label="Carb" value={carbsG} color={colors.carb} />
        <MacroStat label="Fat" value={fatG} color={colors.fat} />
        <MacroStat label="Protein" value={proteinG} color={colors.protein} />
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
      <Text style={[styles.macroLabel, { color }]}>{label}</Text>
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
    padding: spacing.lg,
    marginTop: spacing.md,
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
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  macroLabel: {
    ...typography.label,
    marginBottom: spacing.xs,
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
