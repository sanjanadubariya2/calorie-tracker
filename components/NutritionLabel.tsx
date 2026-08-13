import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";

export interface LabelNutrients {
  calories: number;
  fatG: number;
  saturatedFatG?: number;
  carbsG: number;
  fiberG?: number;
  sugarsG?: number;
  proteinG: number;
  sodiumMg?: number;
  saltG?: number;
}

interface Props {
  servingLabel: string;
  nutrients: LabelNutrients;
}

// FDA-style reference values, used only for the % daily value column.
const DAILY_VALUES = {
  fatG: 78,
  saturatedFatG: 20,
  carbsG: 275,
  fiberG: 28,
  proteinG: 50,
  sodiumMg: 2300,
};

function percentOf(value: number | undefined, dailyValue: number): string {
  if (value == null) return "";
  return `${Math.round((value / dailyValue) * 100)} %`;
}

export function NutritionLabel({ servingLabel, nutrients }: Props) {
  const n = nutrients;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Serving size</Text>
      <Text style={styles.serving}>{servingLabel}</Text>

      <View style={styles.thickRule} />
      <Text style={styles.amountPerServing}>Amount per serving</Text>

      <View style={styles.caloriesRow}>
        <Text style={styles.caloriesLabel}>Calories</Text>
        <Text style={styles.caloriesValue}>{Math.round(n.calories)}</Text>
      </View>

      <View style={styles.mediumRule} />
      <Text style={styles.dailyValueHeader}>% Daily Values*</Text>

      <Row label="Total fat" value={`${n.fatG} g`} percent={percentOf(n.fatG, DAILY_VALUES.fatG)} />
      {n.saturatedFatG != null && (
        <Row
          indented
          label="Saturated fat"
          value={`${n.saturatedFatG} g`}
          percent={percentOf(n.saturatedFatG, DAILY_VALUES.saturatedFatG)}
        />
      )}
      {n.sodiumMg != null && (
        <Row
          label="Sodium"
          value={`${Math.round(n.sodiumMg)} mg`}
          percent={percentOf(n.sodiumMg, DAILY_VALUES.sodiumMg)}
        />
      )}
      <Row
        label="Total carbohydrate"
        value={`${n.carbsG} g`}
        percent={percentOf(n.carbsG, DAILY_VALUES.carbsG)}
      />
      {n.fiberG != null && (
        <Row
          indented
          label="Dietary fibre"
          value={`${n.fiberG} g`}
          percent={percentOf(n.fiberG, DAILY_VALUES.fiberG)}
        />
      )}
      {n.sugarsG != null && <Row indented label="Total sugars" value={`${n.sugarsG} g`} />}
      <Row label="Protein" value={`${n.proteinG} g`} percent={percentOf(n.proteinG, DAILY_VALUES.proteinG)} />
      {n.saltG != null && <Row label="Salt" value={`${n.saltG} g`} last />}

      <Text style={styles.footnote}>
        * Percent Daily Values are based on a 2,000 kcal diet. Your daily values may be higher or
        lower depending on your calorie needs.
      </Text>
      <Text style={styles.source}>Nutrition data from Open Food Facts</Text>
    </View>
  );
}

function Row({
  label,
  value,
  percent,
  indented,
  last,
}: {
  label: string;
  value: string;
  percent?: string;
  indented?: boolean;
  last?: boolean;
}) {
  return (
    <View style={[styles.row, !last && styles.rowBorder]}>
      <Text style={[styles.rowLabel, indented && styles.rowLabelIndented]}>{label}</Text>
      <View style={styles.rowRight}>
        <Text style={styles.rowValue}>{value}</Text>
        {percent ? <Text style={styles.rowPercent}>{percent}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.lg,
  },
  title: {
    ...typography.label,
    color: colors.textPrimary,
    textAlign: "center",
  },
  serving: {
    ...typography.body,
    fontWeight: "700",
    color: colors.textPrimary,
    textAlign: "center",
    marginTop: 2,
  },
  thickRule: {
    height: 4,
    backgroundColor: colors.textPrimary,
    marginTop: spacing.sm,
  },
  amountPerServing: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  caloriesRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  caloriesLabel: {
    fontSize: 24,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  caloriesValue: {
    fontSize: 24,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  mediumRule: {
    height: 2,
    backgroundColor: colors.textPrimary,
    marginTop: spacing.xs,
  },
  dailyValueHeader: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: "700",
    textAlign: "right",
    marginTop: spacing.xs,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.sm,
  },
  rowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  rowLabel: {
    ...typography.body,
    color: colors.textPrimary,
    flex: 1,
  },
  rowLabelIndented: {
    paddingLeft: spacing.md,
    color: colors.textSecondary,
  },
  rowRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  rowValue: {
    ...typography.body,
    color: colors.textPrimary,
  },
  rowPercent: {
    ...typography.body,
    color: colors.textSecondary,
    minWidth: 44,
    textAlign: "right",
  },
  footnote: {
    ...typography.caption,
    color: colors.textTertiary,
    marginTop: spacing.md,
    lineHeight: 16,
  },
  source: {
    ...typography.caption,
    color: colors.textTertiary,
    marginTop: spacing.xs,
    fontStyle: "italic",
  },
});
