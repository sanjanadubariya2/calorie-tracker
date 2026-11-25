import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { addFoodLog, getRecentFoodLogs } from "@/lib/api";
import { deriveFoodSuggestions, type LoggedFoodSuggestion } from "@/lib/foodSuggestions";
import { isISODate, todayISO } from "@/lib/dates";
import { snapshotFromSearchResult } from "@/lib/nutrition";
import type { FoodSearchResult, NewFoodLog } from "@/lib/types";
import { FoodSearchTab } from "@/components/FoodSearchTab";
import { QuickAddTab } from "@/components/QuickAddTab";
import { RecognitionTab } from "@/components/RecognitionTab";
import { MEAL_SLOTS, colors, isMealType, radius, spacing, typography, type MealType } from "@/constants/theme";

type Tab = "search" | "recognize" | "quickAdd";

const TABS: { key: Tab; label: string }[] = [
  { key: "search", label: "Search" },
  { key: "recognize", label: "Photo / Text" },
  { key: "quickAdd", label: "Quick Add" },
];

export default function AddFoodModal() {
  const { userId } = useAuth();
  const params = useLocalSearchParams<{ meal?: string; date?: string }>();
  // Route params are untrusted strings: validate before they reach the database.
  const meal: MealType = isMealType(params.meal) ? params.meal : "breakfast";
  const mealLabel = MEAL_SLOTS.find((s) => s.key === meal)?.label ?? "Meal";
  const loggedDate = isISODate(params.date) ? params.date : todayISO();

  const [tab, setTab] = useState<Tab>("search");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
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

  // Every path saves through here, so failures are always shown.
  async function save(log: NewFoodLog) {
    if (!userId) return;
    setSaving(true);
    setSaveError(null);
    try {
      await addFoodLog(userId, log);
      router.back();
    } catch {
      setSaveError("Couldn't save this food. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  // Re-logs a past entry, carrying its original snapshot so the database
  // recomputes it exactly as before.
  function handleSuggestionConfirm(suggestion: LoggedFoodSuggestion) {
    return save({
      logged_date: loggedDate,
      meal_type: meal,
      food_name: suggestion.foodName,
      calories: suggestion.calories,
      carbs_g: suggestion.carbsG,
      fat_g: suggestion.fatG,
      protein_g: suggestion.proteinG,
      serving_g: suggestion.servingG,
      is_quick_add: suggestion.isQuickAdd,
      source: suggestion.isQuickAdd ? "quick_add" : "relog",
      source_ref: suggestion.sourceRef,
      nutrients_per_100g: suggestion.nutrientsPer100g,
    });
  }

  // Search or favourite: keep the Open Food Facts barcode and the per-100 g
  // values the portion was computed from.
  function handleSearchConfirm(
    food: FoodSearchResult,
    result: { servingGrams: number; calories: number; carbsG: number; fatG: number; proteinG: number }
  ) {
    return save({
      logged_date: loggedDate,
      meal_type: meal,
      food_name: food.name,
      calories: result.calories,
      carbs_g: result.carbsG,
      fat_g: result.fatG,
      protein_g: result.proteinG,
      serving_g: result.servingGrams,
      is_quick_add: false,
      source: "open_food_facts",
      source_ref: food.id || null,
      nutrients_per_100g: snapshotFromSearchResult(food),
    });
  }

  function handleQuickAddConfirm(result: { title: string; calories: number }) {
    return save({
      logged_date: loggedDate,
      meal_type: meal,
      food_name: result.title,
      calories: result.calories,
      carbs_g: 0,
      fat_g: 0,
      protein_g: 0,
      serving_g: null,
      is_quick_add: true,
      source: "quick_add",
    });
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
        {TABS.map((t) => (
          <Pressable
            key={t.key}
            style={[styles.tabButton, tab === t.key && styles.tabButtonActive]}
            onPress={() => setTab(t.key)}
            testID={`tab-${t.key}`}
          >
            <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      {saveError ? <Text style={styles.errorText}>{saveError}</Text> : null}

      <View style={styles.body}>
        {tab === "search" ? (
          <FoodSearchTab
            onFoodConfirmed={handleSearchConfirm}
            onSuggestionConfirmed={handleSuggestionConfirm}
            recent={recent}
            frequent={frequent}
          />
        ) : tab === "recognize" && userId ? (
          // Reviews AI-recognised items and saves each through addFoodLog only
          // after the user confirms (nothing is logged automatically).
          <RecognitionTab
            initialMeal={meal}
            loggedDate={loggedDate}
            addLog={(log) => addFoodLog(userId, log)}
            onDone={() => router.back()}
            onManual={() => setTab("search")}
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
    backgroundColor: colors.primary,
  },
  tabText: {
    ...typography.label,
    color: colors.textSecondary,
  },
  tabTextActive: {
    color: colors.onPrimary,
  },
  body: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.lg,
  },
  savingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(19,32,26,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  savingText: {
    ...typography.title,
    color: colors.textPrimary,
  },
  errorText: {
    ...typography.caption,
    color: colors.danger,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.md,
  },
});
