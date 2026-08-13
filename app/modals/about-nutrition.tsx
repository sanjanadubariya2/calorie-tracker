import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { getProfile } from "@/lib/api";
import { calculateMacroTargets } from "@/lib/calculations";
import { colors, radius, spacing, typography } from "@/constants/theme";

// Acceptable macronutrient distribution ranges from the US National Academies'
// Health and Medicine Division — the same reference the screenshots cite.
const MACRO_RANGES = [
  { label: "carbohydrates", range: "45% – 65%", color: colors.carb },
  { label: "fat", range: "20% – 35%", color: colors.fat },
  { label: "protein", range: "10% – 35%", color: colors.protein },
];

export default function AboutNutritionModal() {
  const { userId } = useAuth();
  const [targetKcal, setTargetKcal] = useState<number | null>(null);

  useEffect(() => {
    if (!userId) return;
    getProfile(userId)
      .then((p) => setTargetKcal(p?.daily_target_kcal ?? null))
      .catch(() => setTargetKcal(null));
  }, [userId]);

  const macros = targetKcal ? calculateMacroTargets(targetKcal) : null;

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.closeButton}>✕</Text>
        </Pressable>
        <Text style={styles.headerTitle}>About nutrition and diet</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Recommended daily calorie intake</Text>
          <Text style={styles.cardBody}>
            {targetKcal
              ? `Your recommended daily calorie intake is ${targetKcal.toLocaleString()} calories. ` +
                "This is based on your gender, age, height, weight, and goal."
              : "Set up your profile to see a personalised daily calorie target."}
          </Text>
          <Text style={styles.cardBody}>
            Keep in mind that this is just a recommendation. Adjust your intake based on your
            personal health needs and activity level. For example, if you're pregnant or
            breastfeeding, you may need more calories every day.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>How the target is calculated</Text>
          <Text style={styles.cardBody}>
            We estimate your Basal Metabolic Rate with the Mifflin-St Jeor equation, scale it by a
            light-activity factor to get your Total Daily Energy Expenditure, then adjust for your
            goal — 500 kcal below for losing weight, 300 kcal above for gaining.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Balancing macronutrients</Text>
          <Text style={styles.cardBody}>
            Macronutrients are carbohydrates, fat, and protein. For healthy adults, the Health and
            Medicine Division of the National Academy of Sciences recommends this balance of your
            calories:
          </Text>

          {MACRO_RANGES.map((m) => (
            <View key={m.label} style={styles.rangeRow}>
              <View style={[styles.rangeDot, { backgroundColor: m.color }]} />
              <Text style={styles.rangeText}>
                <Text style={styles.rangeValue}>{m.range}</Text> from {m.label}
              </Text>
            </View>
          ))}

          <Text style={styles.cardBody}>
            Note that this is the percentage of calories, not the percentage of each food type by
            weight. You get about 4 calories per gram of protein or carbs, and 9 calories per gram
            of fat.
          </Text>
        </View>

        {macros && targetKcal && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Your target in grams</Text>
            <Text style={styles.cardBody}>
              Here's how this app splits your {targetKcal.toLocaleString()} kcal, using a
              55% / 25% / 20% balance:
            </Text>

            <MacroLine
              color={colors.carb}
              label="Carbohydrates"
              grams={macros.carbsG}
              kcal={macros.carbsG * 4}
            />
            <MacroLine color={colors.fat} label="Fat" grams={macros.fatG} kcal={macros.fatG * 9} />
            <MacroLine
              color={colors.protein}
              label="Protein"
              grams={macros.proteinG}
              kcal={macros.proteinG * 4}
            />
          </View>
        )}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Quick add</Text>
          <Text style={styles.cardBody}>
            Quick-added calories log kcal only, without a macro breakdown, so they won't appear in
            your Carb, Fat, and Protein totals.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>A note on accuracy</Text>
          <Text style={styles.cardBody}>
            These are estimates, not medical advice. Food data comes from Open Food Facts, which is
            crowd-sourced and can contain errors. If you have a specific health condition or
            nutrition goal, check with a registered dietitian or doctor.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

function MacroLine({
  color,
  label,
  grams,
  kcal,
}: {
  color: string;
  label: string;
  grams: number;
  kcal: number;
}) {
  return (
    <View style={styles.rangeRow}>
      <View style={[styles.rangeDot, { backgroundColor: color }]} />
      <Text style={styles.rangeText}>
        <Text style={styles.rangeValue}>{grams} g</Text> {label} ({Math.round(kcal).toLocaleString()}{" "}
        kcal)
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: colors.background,
    paddingTop: spacing.xl,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
  },
  closeButton: {
    fontSize: 20,
    color: colors.textPrimary,
    width: 24,
  },
  headerTitle: {
    ...typography.title,
    color: colors.textPrimary,
  },
  content: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  cardTitle: {
    ...typography.title,
    color: colors.textPrimary,
  },
  cardBody: {
    ...typography.body,
    color: colors.textSecondary,
    lineHeight: 22,
  },
  rangeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  rangeDot: {
    width: 8,
    height: 8,
    borderRadius: radius.pill,
  },
  rangeText: {
    ...typography.body,
    color: colors.textSecondary,
    flex: 1,
  },
  rangeValue: {
    color: colors.textPrimary,
    fontWeight: "700",
  },
});
