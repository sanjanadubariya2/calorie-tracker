import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { MEAL_SLOTS, colors, fonts, radius, spacing, typography, type MealType } from "@/constants/theme";
import type { FoodLog } from "@/lib/types";

type IconName = React.ComponentProps<typeof Feather>["name"];

/** Icon tile per meal slot: tint background with a darker icon of the same hue. */
const SLOT_STYLE: Record<MealType, { icon: IconName; tint: string; ink: string }> = {
  breakfast: { icon: "sunrise", tint: "#FDEFD3", ink: "#9A6510" },
  lunch: { icon: "sun", tint: "#DDF0E3", ink: "#1C5240" },
  dinner: { icon: "moon", tint: "#E7E2FA", ink: "#4E3BA6" },
  morning_snack: { icon: "coffee", tint: "#FBE3DA", ink: "#A63E1F" },
  afternoon_snack: { icon: "coffee", tint: "#FBE3DA", ink: "#A63E1F" },
  evening_snack: { icon: "coffee", tint: "#FBE3DA", ink: "#A63E1F" },
};

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
              <View style={[styles.iconTile, { backgroundColor: SLOT_STYLE[slot.key].tint }]}>
                <Feather name={SLOT_STYLE[slot.key].icon} size={22} color={SLOT_STYLE[slot.key].ink} />
              </View>

              <View style={styles.textCol}>
                <Text style={styles.mealName}>{slot.label}</Text>
                <Text style={styles.itemNames} numberOfLines={1}>
                  {itemNames.length > 0 ? itemNames : "Nothing logged yet"}
                </Text>
              </View>

              {totalKcal > 0 && (
                <Text style={styles.kcalValue}>
                  {Math.round(totalKcal).toLocaleString()}
                  <Text style={styles.kcalUnit}> kcal</Text>
                </Text>
              )}

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
                <Feather name="plus" size={18} color={colors.primary} />
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
    paddingVertical: 6,
    paddingHorizontal: 14,
    marginTop: 14,
  },
  title: {
    ...typography.title,
    color: colors.textPrimary,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    gap: 12,
  },
  iconTile: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  textCol: {
    flex: 1,
  },
  mealName: {
    ...typography.label,
    fontFamily: fonts.bodyBold,
    fontWeight: "700",
    fontSize: 15,
    color: colors.textPrimary,
  },
  itemNames: {
    ...typography.caption,
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 2,
  },
  kcalValue: {
    fontFamily: fonts.displayBold,
    fontWeight: "700",
    fontSize: 15,
    color: colors.textPrimary,
  },
  kcalUnit: {
    ...typography.caption,
    fontSize: 11,
    color: colors.textSecondary,
  },
  addButton: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: colors.pillBackground,
    alignItems: "center",
    justifyContent: "center",
  },
  divider: {
    height: 1,
    backgroundColor: colors.divider,
  },
});
