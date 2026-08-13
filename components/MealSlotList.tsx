import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { MEAL_SLOTS, colors, radius, spacing, typography, type MealType } from "@/constants/theme";
import type { FoodLog } from "@/lib/types";

interface Props {
  logsByMeal: Record<MealType, FoodLog[]>;
  onAddPress: (meal: MealType) => void;
  onSlotPress?: (meal: MealType) => void;
  visibleMeals?: MealType[];
}

export function MealSlotList({ logsByMeal, onAddPress, onSlotPress, visibleMeals }: Props) {
  const slots = visibleMeals
    ? MEAL_SLOTS.filter((s) => visibleMeals.includes(s.key))
    : MEAL_SLOTS;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Log meal</Text>

      {slots.map((slot, index) => {
        const logs = logsByMeal[slot.key] ?? [];
        const totalKcal = logs.reduce((sum, l) => sum + l.calories, 0);
        const itemNames = logs.map((l) => l.food_name).join(", ");

        return (
          <View key={slot.key}>
            <Pressable
              style={styles.row}
              onPress={() => onSlotPress?.(slot.key)}
              accessibilityRole="button"
            >
              <View style={styles.kcalPill}>
                <Text style={styles.kcalValue}>{totalKcal}</Text>
                <Text style={styles.kcalUnit}>kcal</Text>
              </View>

              <View style={styles.textCol}>
                <Text style={styles.mealName}>{slot.label}</Text>
                {itemNames.length > 0 && (
                  <Text style={styles.itemNames} numberOfLines={2}>
                    {itemNames}
                  </Text>
                )}
              </View>

              <Pressable
                style={styles.addButton}
                onPress={(e) => {
                  // Without this the tap also reaches the row Pressable on web,
                  // opening the meal detail screen behind the add-food modal.
                  e.stopPropagation();
                  onAddPress(slot.key);
                }}
                hitSlop={12}
                accessibilityLabel={`Add food to ${slot.label}`}
              >
                <Text style={styles.addButtonText}>+</Text>
              </Pressable>
            </Pressable>
            {index < slots.length - 1 && <View style={styles.divider} />}
          </View>
        );
      })}
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
  title: {
    ...typography.title,
    color: colors.textPrimary,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  kcalPill: {
    width: 64,
    height: 64,
    borderRadius: radius.pill,
    backgroundColor: colors.pillBackground,
    alignItems: "center",
    justifyContent: "center",
  },
  kcalValue: {
    ...typography.label,
    color: colors.textPrimary,
  },
  kcalUnit: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  textCol: {
    flex: 1,
  },
  mealName: {
    ...typography.body,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  itemNames: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
  addButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  addButtonText: {
    fontSize: 24,
    color: colors.textPrimary,
    fontWeight: "300",
  },
  divider: {
    height: 1,
    backgroundColor: colors.divider,
  },
});
