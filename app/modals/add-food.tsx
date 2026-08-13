import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { addFoodLog, getRecentFoodLogs } from "@/lib/api";
import { deriveFoodSuggestions, type LoggedFoodSuggestion } from "@/lib/foodSuggestions";
import { FoodSearchTab } from "@/components/FoodSearchTab";
import { QuickAddTab } from "@/components/QuickAddTab";
import { MEAL_SLOTS, colors, radius, spacing, typography, type MealType } from "@/constants/theme";

type Tab = "search" | "quickAdd";

export default function AddFoodModal() {
  const { userId } = useAuth();
  const params = useLocalSearchParams<{ meal?: string; date?: string }>();
  const meal = (params.meal as MealType) ?? "breakfast";
  const mealLabel = MEAL_SLOTS.find((s) => s.key === meal)?.label ?? "Meal";
  const now = new Date();
  const loggedDate =
    params.date ??
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate()
    ).padStart(2, "0")}`;

  const [tab, setTab] = useState<Tab>("search");
  const [saving, setSaving] = useState(false);
  const [recent, setRecent] = useState<LoggedFoodSuggestion[]>([]);
  const [frequent, setFrequent] = useState<LoggedFoodSuggestion[]>([]);

  useEffect(() => {
    if (!userId) return;
    getRecentFoodLogs(userId)
      .then((logs) => {
        const { recent: r, frequent: f } = deriveFoodSuggestions(logs);
        setRecent(r);
        setFrequent(f);
      })
      .catch(() => {
        // Quick picks are a convenience — a failure here shouldn't block search.
      });
  }, [userId]);

  // Re-logs a past entry verbatim, skipping the portion step.
  async function handleSuggestionConfirm(suggestion: LoggedFoodSuggestion) {
    if (!userId) return;
    setSaving(true);
    try {
      await addFoodLog(userId, {
        logged_date: loggedDate,
        meal_type: meal,
        food_name: suggestion.foodName,
        calories: suggestion.calories,
        carbs_g: suggestion.carbsG,
        fat_g: suggestion.fatG,
        protein_g: suggestion.proteinG,
        serving_g: suggestion.servingG,
        is_quick_add: suggestion.isQuickAdd,
      });
      router.back();
    } finally {
      setSaving(false);
    }
  }

  async function handleSearchConfirm(
    food: { name: string },
    result: { servingGrams: number; calories: number; carbsG: number; fatG: number; proteinG: number }
  ) {
    if (!userId) return;
    setSaving(true);
    try {
      await addFoodLog(userId, {
        logged_date: loggedDate,
        meal_type: meal,
        food_name: food.name,
        calories: result.calories,
        carbs_g: result.carbsG,
        fat_g: result.fatG,
        protein_g: result.proteinG,
        serving_g: result.servingGrams,
        is_quick_add: false,
      });
      router.back();
    } finally {
      setSaving(false);
    }
  }

  async function handleQuickAddConfirm(result: { title: string; calories: number }) {
    if (!userId) return;
    setSaving(true);
    try {
      await addFoodLog(userId, {
        logged_date: loggedDate,
        meal_type: meal,
        food_name: result.title,
        calories: result.calories,
        carbs_g: 0,
        fat_g: 0,
        protein_g: 0,
        serving_g: null,
        is_quick_add: true,
      });
      router.back();
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.closeButton}>✕</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Add to {mealLabel}</Text>
        <View style={{ width: 24 }} />
      </View>

      <View style={styles.tabRow}>
        <Pressable
          style={[styles.tabButton, tab === "search" && styles.tabButtonActive]}
          onPress={() => setTab("search")}
        >
          <Text style={[styles.tabText, tab === "search" && styles.tabTextActive]}>Search</Text>
        </Pressable>
        <Pressable
          style={[styles.tabButton, tab === "quickAdd" && styles.tabButtonActive]}
          onPress={() => setTab("quickAdd")}
        >
          <Text style={[styles.tabText, tab === "quickAdd" && styles.tabTextActive]}>Quick Add</Text>
        </Pressable>
      </View>

      <View style={styles.body}>
        {tab === "search" ? (
          <FoodSearchTab
            onFoodConfirmed={handleSearchConfirm}
            onSuggestionConfirmed={handleSuggestionConfirm}
            recent={recent}
            frequent={frequent}
          />
        ) : (
          <QuickAddTab onConfirm={handleQuickAddConfirm} />
        )}
      </View>

      {saving && (
        <View style={styles.savingOverlay}>
          <Text style={styles.savingText}>Saving...</Text>
        </View>
      )}
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
  tabRow: {
    flexDirection: "row",
    backgroundColor: colors.pillBackground,
    borderRadius: radius.pill,
    padding: 4,
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
  },
  tabButton: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    alignItems: "center",
  },
  tabButtonActive: {
    backgroundColor: colors.card,
  },
  tabText: {
    ...typography.label,
    color: colors.textSecondary,
  },
  tabTextActive: {
    color: colors.textPrimary,
  },
  body: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.lg,
  },
  savingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
  },
  savingText: {
    ...typography.title,
    color: colors.textPrimary,
  },
});
