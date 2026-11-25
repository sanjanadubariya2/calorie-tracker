import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";

interface Props {
  label: "Actual" | "Recommended";
  carbPct: number;
  fatPct: number;
  proteinPct: number;
  /** Actual bar is tall/solid, Recommended is a thin reference strip */
  emphasized: boolean;
}

export function MacroBar({ label, carbPct, fatPct, proteinPct, emphasized }: Props) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      {emphasized && (
        <View style={styles.percentRow}>
          <Text style={[styles.percentText, { color: colors.carbText }]}>{carbPct}%</Text>
          <Text style={[styles.percentText, { color: colors.fatText }]}>{fatPct}%</Text>
          <Text style={[styles.percentText, { color: colors.proteinText }]}>{proteinPct}%</Text>
        </View>
      )}
      <View style={[styles.bar, emphasized ? styles.barTall : styles.barThin]}>
        <View style={[styles.segment, { width: `${carbPct}%`, backgroundColor: colors.carb }]} />
        <View style={[styles.segment, { width: `${fatPct}%`, backgroundColor: colors.fat }]} />
        <View style={[styles.segment, { width: `${proteinPct}%`, backgroundColor: colors.protein }]} />
      </View>
      {!emphasized && (
        <View style={styles.percentRow}>
          <Text style={[styles.percentText, { color: colors.carbText }]}>{carbPct}%</Text>
          <Text style={[styles.percentText, { color: colors.fatText }]}>{fatPct}%</Text>
          <Text style={[styles.percentText, { color: colors.proteinText }]}>{proteinPct}%</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: spacing.md,
  },
  label: {
    ...typography.caption,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  percentRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: spacing.xs,
  },
  percentText: {
    ...typography.label,
  },
  bar: {
    flexDirection: "row",
    borderRadius: radius.pill,
    overflow: "hidden",
    gap: 2,
    width: "100%",
  },
  barTall: {
    height: 14,
  },
  barThin: {
    height: 6,
    opacity: 0.6,
  },
  segment: {
    height: "100%",
  },
});
