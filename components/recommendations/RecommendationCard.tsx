import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";
import type { Recommendation } from "@/lib/recommendations";
import { FIT_LABEL, KIND_LABEL, minutesText, optionalText, qualityBadges, servingsText } from "@/lib/recommendationsView";

interface Props {
  item: Recommendation;
  saved: boolean;
  busy: boolean;
  onOpen: () => void;
  onSave: () => void;
  onNotInterested: () => void;
  onAsk?: () => void;
}

/** No image: there are no verified meal photos, and none are invented. */
export function RecommendationCard({ item, saved, busy, onOpen, onSave, onNotInterested, onAsk }: Props) {
  const n = item.nutrition;
  const minutes = minutesText(item.total_minutes);
  const tid = item.key;
  return (
    <View style={styles.card} testID={`rec-card-${tid}`}>
      <Pressable onPress={onOpen} accessibilityRole="button"
        accessibilityLabel={`${item.name}, ${n.kcal} kilocalories. Open details`} testID={`rec-open-${tid}`}>
        <View style={styles.header}>
          <Text style={styles.kind}>{KIND_LABEL[item.kind]}{minutes ? ` · ${minutes}` : ""}</Text>
          <Text style={[styles.fit, item.score.fit === "strong" && styles.fitStrong]}>{FIT_LABEL[item.score.fit]}</Text>
        </View>
        <Text style={styles.name}>{item.name}{item.variant ? ` (${item.variant})` : ""}</Text>
        <Text style={styles.serving} testID={`rec-serving-${tid}`}>{servingsText(item)}</Text>
        <View style={styles.macros} accessible accessibilityLabel={
          `${n.kcal} kilocalories, protein ${n.protein_g} grams, carbohydrate ${n.carbs_g} grams, fat ${n.fat_g} grams`}>
          <Text style={styles.kcal} testID={`rec-kcal-${tid}`}>{n.kcal} kcal</Text>
          <Text style={[styles.macro, { color: colors.proteinText }]}>P {n.protein_g} g</Text>
          <Text style={[styles.macro, { color: colors.carbText }]}>C {n.carbs_g} g</Text>
          <Text style={[styles.macro, { color: colors.fatText }]}>F {n.fat_g} g</Text>
          {item.optional_components.length > 0 && <Text style={styles.macro}>base meal</Text>}
        </View>
        {optionalText(item) && <Text style={styles.reason} testID={`rec-optional-${tid}`}>{optionalText(item)}</Text>}
        {item.reasons.slice(0, 2).map((r) => <Text key={r} style={styles.reason}>• {r}</Text>)}
        <View style={styles.badges}>
          {qualityBadges(item).map((b) => (
            <Text key={b.key} style={[styles.badge, b.tone === "caution" && styles.badgeCaution]}
              testID={`rec-badge-${tid}-${b.key}`}>{b.label}</Text>
          ))}
        </View>
      </Pressable>
      <View style={styles.actions}>
        <Pressable onPress={onSave} disabled={busy} accessibilityRole="button"
          accessibilityLabel={saved ? "Remove from saved" : "Save"} testID={`rec-save-${tid}`} hitSlop={8}>
          <Text style={styles.action}>{saved ? "★ Saved" : "☆ Save"}</Text>
        </Pressable>
        <Pressable onPress={onNotInterested} disabled={busy} accessibilityRole="button"
          accessibilityLabel="Not interested" testID={`rec-hide-${tid}`} hitSlop={8}>
          <Text style={styles.action}>Not interested</Text>
        </Pressable>
        {onAsk && (
          <Pressable onPress={onAsk} accessibilityRole="button" accessibilityLabel="Ask the assistant about this"
            testID={`rec-ask-${tid}`} hitSlop={8}>
            <Text style={styles.action}>Ask assistant</Text>
          </Pressable>
        )}
        <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel="Details and log"
          testID={`rec-details-${tid}`} hitSlop={8}>
          <Text style={[styles.action, styles.primary]}>Details</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function RecommendationSkeleton({ index }: { index: number }) {
  return (
    <View style={styles.card} testID={`rec-skeleton-${index}`} accessibilityLabel="Loading recommendations">
      <View style={[styles.bone, { width: "30%" }]} />
      <View style={[styles.bone, styles.boneTitle, { width: "70%" }]} />
      <View style={[styles.bone, { width: "45%" }]} />
      <View style={[styles.bone, { width: "85%" }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.cardBorder,
    padding: spacing.md, marginBottom: spacing.md,
  },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  kind: { ...typography.caption, color: colors.textSecondary },
  fit: { ...typography.caption, color: colors.textSecondary },
  fitStrong: { color: colors.success },
  name: { ...typography.title, color: colors.textPrimary, marginTop: spacing.xs },
  serving: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  macros: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: spacing.md, marginTop: spacing.sm },
  kcal: { ...typography.label, color: colors.textPrimary },
  macro: { ...typography.caption },
  reason: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.xs },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: spacing.sm },
  badge: {
    ...typography.caption, color: colors.textSecondary, backgroundColor: colors.pillBackground,
    borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 2, overflow: "hidden",
  },
  badgeCaution: { color: colors.proteinText },
  actions: {
    flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: spacing.md, marginTop: spacing.md,
    borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: spacing.sm,
  },
  action: { ...typography.caption, color: colors.textSecondary, paddingVertical: spacing.xs },
  primary: { color: colors.textPrimary },
  bone: { height: 12, borderRadius: radius.sm, backgroundColor: colors.pillBackground, marginTop: spacing.sm },
  boneTitle: { height: 20 },
});
