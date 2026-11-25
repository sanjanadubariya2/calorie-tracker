import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useAuth } from "@/lib/auth-context";
import { updateFoodLog } from "@/lib/api";
import { MEAL_SLOTS, colors, radius, spacing, typography, type MealType } from "@/constants/theme";
import type { FoodLog } from "@/lib/types";
import { roundHalfAwayFromZero } from "@/lib/calculations";
import { MAX_SERVING_G, scaleNutrients } from "@/lib/nutrition";

interface Props {
  log: FoodLog;
  onCancel: () => void;
  onSaved: () => void;
}

const round1 = (n: number) => roundHalfAwayFromZero(n, 1);

export function EditLogEntry({ log, onCancel, onSaved }: Props) {
  const { userId } = useAuth();

  // A log stores absolute nutrition for its portion, so re-scaling works off
  // the original serving. Quick adds have no serving, and their calories are
  // edited directly instead.
  const canRescale = log.serving_g != null && log.serving_g > 0;

  const [name, setName] = useState(log.food_name);
  const [mealType, setMealType] = useState<MealType>(log.meal_type);
  const [gramsText, setGramsText] = useState(canRescale ? String(log.serving_g) : "");
  const [caloriesText, setCaloriesText] = useState(String(Math.round(log.calories)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const grams = parseFloat(gramsText);
  const caloriesInput = parseFloat(caloriesText);

  const scaled = useMemo(() => {
    if (!canRescale) {
      return {
        calories: Number.isNaN(caloriesInput) ? 0 : caloriesInput,
        carbsG: log.carbs_g,
        fatG: log.fat_g,
        proteinG: log.protein_g,
        servingG: null as number | null,
      };
    }

    const originalGrams = log.serving_g as number;
    const nextGrams = Number.isNaN(grams) ? 0 : grams;

    // With a stored per-100 g snapshot, compute from it exactly as the
    // database does: no drift across repeated edits.
    if (log.nutrients_per_100g) {
      const t = scaleNutrients(log.nutrients_per_100g, nextGrams);
      return { calories: t.calories, carbsG: t.carbsG, fatG: t.fatG, proteinG: t.proteinG, servingG: nextGrams };
    }

    // Older logs have no snapshot: rescale the stored totals.
    const factor = nextGrams / originalGrams;

    return {
      calories: roundHalfAwayFromZero(log.calories * factor),
      carbsG: round1(log.carbs_g * factor),
      fatG: round1(log.fat_g * factor),
      proteinG: round1(log.protein_g * factor),
      servingG: nextGrams,
    };
  }, [canRescale, grams, caloriesInput, log]);

  const valid = canRescale ? grams > 0 && grams <= MAX_SERVING_G : caloriesInput > 0;

  async function handleSave() {
    if (!userId || !valid) return;
    setSaving(true);
    setError(null);
    try {
      await updateFoodLog(userId, log.id, {
        food_name: name.trim() || log.food_name,
        meal_type: mealType,
        calories: scaled.calories,
        carbs_g: scaled.carbsG,
        fat_g: scaled.fatG,
        protein_g: scaled.proteinG,
        serving_g: scaled.servingG,
      });
      onSaved();
    } catch {
      setError("Couldn't save the change. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Pressable onPress={onCancel} hitSlop={12}>
          <Text style={styles.closeButton}>‹</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Edit entry</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Text style={styles.label}>Name</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholderTextColor={colors.textTertiary}
          />
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>{canRescale ? "Portion" : "Calories"}</Text>
          <View style={styles.inputRow}>
            <TextInput
              style={[styles.input, styles.inputFlex]}
              keyboardType="numeric"
              value={canRescale ? gramsText : caloriesText}
              onChangeText={canRescale ? setGramsText : setCaloriesText}
              placeholderTextColor={colors.textTertiary}
            />
            <Text style={styles.unit}>{canRescale ? "g" : "kcal"}</Text>
          </View>
          {canRescale && (
            <Text style={styles.hint}>
              Macros rescale with the portion, from the original {log.serving_g} g entry.
            </Text>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Meal</Text>
          <View style={styles.mealGrid}>
            {MEAL_SLOTS.map((slot) => {
              const active = slot.key === mealType;
              return (
                <Pressable
                  key={slot.key}
                  style={[styles.mealChip, active && styles.mealChipActive]}
                  onPress={() => setMealType(slot.key)}
                >
                  <Text style={[styles.mealChipText, active && styles.mealChipTextActive]}>
                    {slot.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Updated totals</Text>
          <Text style={styles.previewKcal}>{scaled.calories.toLocaleString()} kcal</Text>
          {canRescale && (
            <View style={styles.macroRow}>
              <Text style={[styles.macro, { color: colors.carbText }]}>C {scaled.carbsG} g</Text>
              <Text style={[styles.macro, { color: colors.fatText }]}>F {scaled.fatG} g</Text>
              <Text style={[styles.macro, { color: colors.proteinText }]}>P {scaled.proteinG} g</Text>
            </View>
          )}
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <View style={styles.actionRow}>
          <Pressable style={[styles.actionButton, styles.cancelButton]} onPress={onCancel}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[styles.actionButton, styles.saveButton, (!valid || saving) && styles.disabled]}
            onPress={handleSave}
            disabled={!valid || saving}
          >
            <Text style={styles.saveText}>{saving ? "Saving…" : "Save"}</Text>
          </Pressable>
        </View>

        <View style={{ height: spacing.xl }} />
      </ScrollView>
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
    fontSize: 26,
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
  },
  label: {
    ...typography.caption,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.md,
    padding: spacing.md,
    color: colors.textPrimary,
    ...typography.body,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  inputFlex: {
    flex: 1,
  },
  unit: {
    ...typography.body,
    color: colors.textSecondary,
  },
  hint: {
    ...typography.caption,
    color: colors.textTertiary,
    marginTop: spacing.sm,
  },
  mealGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  mealChip: {
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  mealChipActive: {
    backgroundColor: colors.progressFill,
    borderColor: colors.progressFill,
  },
  mealChipText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  mealChipTextActive: {
    color: colors.onAccent,
    fontWeight: "700",
  },
  previewKcal: {
    fontSize: 32,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  macroRow: {
    flexDirection: "row",
    gap: spacing.lg,
    marginTop: spacing.sm,
  },
  macro: {
    ...typography.label,
  },
  errorText: {
    ...typography.caption,
    color: colors.danger,
  },
  actionRow: {
    flexDirection: "row",
    gap: spacing.md,
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
  saveText: {
    ...typography.label,
    color: colors.onAccent,
  },
  disabled: {
    opacity: 0.4,
  },
});
