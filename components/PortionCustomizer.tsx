import React, { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";
import { scaleNutrient, calculateActualMacroPercents } from "@/lib/calculations";
import { isFavourite, toggleFavourite } from "@/lib/foodPrefs";
import { PortionSlider } from "./PortionSlider";
import { NutritionLabel } from "./NutritionLabel";
import type { FoodSearchResult } from "@/lib/types";

interface Props {
  food: FoodSearchResult;
  onConfirm: (result: {
    servingGrams: number;
    calories: number;
    carbsG: number;
    fatG: number;
    proteinG: number;
  }) => void;
  onCancel?: () => void;
}

// Open Food Facts reports per 100 g, so a "serving" is a base weight the
// slider multiplies. 100 g keeps the maths transparent.
const BASE_SERVING_G = 100;

const round1 = (n: number) => Math.round(n * 10) / 10;
const scaleOptional = (per100g: number | undefined, grams: number) =>
  per100g == null ? undefined : round1(scaleNutrient(per100g, grams));

export function PortionCustomizer({ food, onConfirm, onCancel }: Props) {
  const [multiplier, setMultiplier] = useState(1);
  const [gramsText, setGramsText] = useState(String(BASE_SERVING_G));
  const [favourite, setFavourite] = useState(false);

  useEffect(() => {
    isFavourite(food.id).then(setFavourite);
  }, [food.id]);

  // The slider and the gram field are two views of the same number. Moving the
  // slider rewrites the field; typing in the field is the source of truth until
  // the slider moves again.
  function handleSliderChange(next: number) {
    setMultiplier(next);
    setGramsText(String(Math.round(next * BASE_SERVING_G)));
  }

  function handleGramsChange(text: string) {
    setGramsText(text);
    const grams = parseFloat(text);
    if (!Number.isNaN(grams) && grams > 0) setMultiplier(grams / BASE_SERVING_G);
  }

  const servingGrams = useMemo(() => {
    const grams = parseFloat(gramsText);
    return Number.isNaN(grams) || grams < 0 ? 0 : grams;
  }, [gramsText]);

  const computed = useMemo(
    () => ({
      calories: Math.round(scaleNutrient(food.caloriesPer100g, servingGrams)),
      carbsG: round1(scaleNutrient(food.carbsPer100g, servingGrams)),
      fatG: round1(scaleNutrient(food.fatPer100g, servingGrams)),
      proteinG: round1(scaleNutrient(food.proteinPer100g, servingGrams)),
    }),
    [food, servingGrams]
  );

  const macroSplit = calculateActualMacroPercents(computed.carbsG, computed.fatG, computed.proteinG);

  async function handleToggleFavourite() {
    setFavourite(await toggleFavourite(food));
  }

  return (
    <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      <Text style={styles.sheetTitle}>Set portion size</Text>

      <View style={styles.card}>
        <View style={styles.headerRow}>
          <View style={styles.headerText}>
            <Text style={styles.foodName}>{food.name}</Text>
            <Text style={styles.foodKcal}>{computed.calories} kcal</Text>
            {food.brand ? <Text style={styles.brand}>{food.brand}</Text> : null}
          </View>
          <Pressable
            onPress={handleToggleFavourite}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={favourite ? "Remove from favourites" : "Add to favourites"}
          >
            <Text style={[styles.star, favourite && styles.starActive]}>{favourite ? "★" : "☆"}</Text>
          </Pressable>
        </View>

        <PortionSlider value={multiplier} onChange={handleSliderChange} />

        <View style={styles.gramsRow}>
          <TextInput
            style={styles.gramsInput}
            keyboardType="numeric"
            value={gramsText}
            onChangeText={handleGramsChange}
            placeholder="100"
            placeholderTextColor={colors.textTertiary}
          />
          <Text style={styles.gramsUnit}>grams</Text>
        </View>
        <Text style={styles.hint}>Drag the slider or type an exact weight.</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Macronutrients</Text>
        <View style={styles.legendRow}>
          <Legend color={colors.carb} label="Carb" />
          <Legend color={colors.fat} label="Fat" />
          <Legend color={colors.protein} label="Protein" />
        </View>

        <View style={styles.macroBar}>
          <View style={[styles.macroSegment, { flex: macroSplit.carbPct, backgroundColor: colors.carb }]} />
          <View style={[styles.macroSegment, { flex: macroSplit.fatPct, backgroundColor: colors.fat }]} />
          <View
            style={[styles.macroSegment, { flex: macroSplit.proteinPct, backgroundColor: colors.protein }]}
          />
        </View>

        <View style={styles.macroValuesRow}>
          <Text style={[styles.macroValue, { color: colors.carb }]}>{computed.carbsG} g</Text>
          <Text style={[styles.macroValue, { color: colors.fat }]}>{computed.fatG} g</Text>
          <Text style={[styles.macroValue, { color: colors.protein }]}>{computed.proteinG} g</Text>
        </View>
      </View>

      <NutritionLabel
        servingLabel={`${servingGrams || 0} g`}
        nutrients={{
          calories: computed.calories,
          fatG: computed.fatG,
          saturatedFatG: scaleOptional(food.saturatedFatPer100g, servingGrams),
          carbsG: computed.carbsG,
          fiberG: scaleOptional(food.fiberPer100g, servingGrams),
          sugarsG: scaleOptional(food.sugarsPer100g, servingGrams),
          proteinG: computed.proteinG,
          // Open Food Facts reports sodium in grams per 100 g.
          sodiumMg: food.sodiumPer100g == null
            ? undefined
            : Math.round(scaleNutrient(food.sodiumPer100g, servingGrams) * 1000),
          saltG: scaleOptional(food.saltPer100g, servingGrams),
        }}
      />

      <View style={styles.actionRow}>
        {onCancel && (
          <Pressable style={[styles.actionButton, styles.cancelButton]} onPress={onCancel}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        )}
        <Pressable
          style={[styles.actionButton, styles.saveButton, servingGrams <= 0 && styles.saveButtonDisabled]}
          onPress={() => onConfirm({ servingGrams, ...computed })}
          disabled={servingGrams <= 0}
        >
          <Text style={styles.saveText}>Save</Text>
        </Pressable>
      </View>

      <View style={{ height: spacing.xl }} />
    </ScrollView>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  sheetTitle: {
    ...typography.title,
    color: colors.textPrimary,
    marginBottom: spacing.md,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: spacing.md,
  },
  headerText: {
    flex: 1,
  },
  foodName: {
    ...typography.body,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  foodKcal: {
    ...typography.body,
    color: colors.textSecondary,
    marginTop: 2,
  },
  brand: {
    ...typography.caption,
    color: colors.textTertiary,
    marginTop: 2,
  },
  star: {
    fontSize: 26,
    color: colors.textSecondary,
  },
  starActive: {
    color: colors.badgeActive,
  },
  gramsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  gramsInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.md,
    padding: spacing.md,
    color: colors.textPrimary,
    ...typography.body,
  },
  gramsUnit: {
    ...typography.body,
    color: colors.textSecondary,
  },
  hint: {
    ...typography.caption,
    color: colors.textTertiary,
    marginTop: spacing.sm,
    textAlign: "center",
  },
  cardTitle: {
    ...typography.title,
    color: colors.textPrimary,
  },
  legendRow: {
    flexDirection: "row",
    gap: spacing.lg,
    marginTop: spacing.md,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: radius.pill,
  },
  legendLabel: {
    ...typography.label,
    color: colors.textPrimary,
  },
  macroBar: {
    flexDirection: "row",
    height: 14,
    borderRadius: radius.pill,
    overflow: "hidden",
    marginTop: spacing.md,
    backgroundColor: colors.progressTrack,
  },
  macroSegment: {
    height: "100%",
  },
  macroValuesRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: spacing.sm,
  },
  macroValue: {
    ...typography.label,
  },
  actionRow: {
    flexDirection: "row",
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  actionButton: {
    flex: 1,
    borderRadius: radius.pill,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  cancelButton: {
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  cancelText: {
    ...typography.label,
    color: colors.textPrimary,
  },
  saveButton: {
    backgroundColor: colors.progressFill,
  },
  saveButtonDisabled: {
    opacity: 0.4,
  },
  saveText: {
    ...typography.label,
    color: "#0A0A0A",
  },
});
