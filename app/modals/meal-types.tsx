import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { router } from "expo-router";
import { MEAL_SLOTS, colors, radius, spacing, typography, type MealType } from "@/constants/theme";
import { getVisibleMealTypes, setVisibleMealTypes } from "@/lib/mealPrefs";

export default function MealTypesModal() {
  const [visible, setVisible] = useState<MealType[]>(MEAL_SLOTS.map((s) => s.key));
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getVisibleMealTypes().then((v) => {
      setVisible(v);
      setLoaded(true);
    });
  }, []);

  async function toggle(key: MealType) {
    const isOn = visible.includes(key);
    if (isOn && visible.length === 1) return; // keep at least one meal slot visible
    const next = isOn ? visible.filter((k) => k !== key) : [...visible, key];
    setVisible(next);
    await setVisibleMealTypes(next);
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.closeButton}>✕</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Meal types to show</Text>
        <View style={{ width: 24 }} />
      </View>

      <Text style={styles.hint}>
        Choose which meal slots appear on your Today screen and Log meal card.
      </Text>

      <ScrollView contentContainerStyle={styles.list}>
        {loaded &&
          MEAL_SLOTS.map((slot) => {
            const isOn = visible.includes(slot.key);
            return (
              <View key={slot.key} style={styles.row}>
                <Text style={styles.rowLabel}>{slot.label}</Text>
                <Switch
                  value={isOn}
                  onValueChange={() => toggle(slot.key)}
                  trackColor={{ false: colors.pillBackground, true: colors.progressFill }}
                  thumbColor={colors.textPrimary}
                />
              </View>
            );
          })}
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
    fontSize: 20,
    color: colors.textPrimary,
    width: 24,
  },
  headerTitle: {
    ...typography.title,
    color: colors.textPrimary,
  },
  hint: {
    ...typography.body,
    color: colors.textSecondary,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.md,
  },
  list: {
    padding: spacing.lg,
    gap: spacing.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.card,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  rowLabel: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: "700",
  },
});
