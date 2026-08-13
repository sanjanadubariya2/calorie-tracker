import React, { useCallback, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { useAuth } from "@/lib/auth-context";
import { getFoodLogsForDate, getFoodLogsInRange, getProfile, getStreak, rangeEndingOn } from "@/lib/api";
import { getVisibleMealTypes } from "@/lib/mealPrefs";
import { DashboardHeader } from "@/components/DashboardHeader";
import { CalorieSummaryBar } from "@/components/CalorieSummaryBar";
import { NutritionCard } from "@/components/NutritionCard";
import { MealSlotList } from "@/components/MealSlotList";
import { WeeklyChart, type DayTotal } from "@/components/WeeklyChart";
import { BadgeRow } from "@/components/BadgeRow";
import { colors, spacing, MEAL_SLOTS, type MealType } from "@/constants/theme";
import type { FoodLog, Profile } from "@/lib/types";

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function shiftDate(iso: string, deltaDays: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + deltaDays);
  return toISODate(date);
}

function formatDateLabel(iso: string, todayISO: string): string {
  if (iso === todayISO) return "Today";
  if (iso === shiftDate(todayISO, -1)) return "Yesterday";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function groupByMeal(logs: FoodLog[]): Record<MealType, FoodLog[]> {
  const grouped = Object.fromEntries(MEAL_SLOTS.map((s) => [s.key, [] as FoodLog[]])) as Record<
    MealType,
    FoodLog[]
  >;
  for (const log of logs) {
    grouped[log.meal_type]?.push(log);
  }
  return grouped;
}

export default function DashboardScreen() {
  const { userId } = useAuth();
  const todayISO = toISODate(new Date());

  const [selectedDate, setSelectedDate] = useState(todayISO);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [dayLogs, setDayLogs] = useState<FoodLog[]>([]);
  const [weekDays, setWeekDays] = useState<DayTotal[]>([]);
  const [weekAverage, setWeekAverage] = useState(0);
  const [streak, setStreak] = useState(0);
  const [visibleMeals, setVisibleMeals] = useState<MealType[]>(MEAL_SLOTS.map((s) => s.key));
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(async () => {
    if (!userId) return;
    const { start, end, days } = rangeEndingOn(selectedDate);

    const [profileData, dayData, rangeData, streakData, mealPrefs] = await Promise.all([
      getProfile(userId),
      getFoodLogsForDate(userId, selectedDate),
      getFoodLogsInRange(userId, start, end),
      getStreak(userId),
      getVisibleMealTypes(),
    ]);

    setProfile(profileData);
    setDayLogs(dayData);
    setVisibleMeals(mealPrefs);

    const totalsByDate = new Map<string, number>();
    for (const log of rangeData) {
      totalsByDate.set(log.logged_date, (totalsByDate.get(log.logged_date) ?? 0) + log.calories);
    }
    const dayTotals: DayTotal[] = days.map((date) => ({
      date,
      dayLabel: String(Number(date.slice(8, 10))),
      totalKcal: Math.round(totalsByDate.get(date) ?? 0),
      isToday: date === selectedDate,
    }));
    setWeekDays(dayTotals);

    const nonZeroDays = dayTotals.filter((d) => d.totalKcal > 0);
    const avg =
      nonZeroDays.length > 0
        ? nonZeroDays.reduce((sum, d) => sum + d.totalKcal, 0) / nonZeroDays.length
        : 0;
    setWeekAverage(avg);

    setStreak(streakData?.current_streak ?? 0);
  }, [userId, selectedDate]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      loadData().finally(() => setLoading(false));
    }, [loadData])
  );

  async function handleRefresh() {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }

  const isToday = selectedDate === todayISO;
  const target = profile?.daily_target_kcal ?? 2000;
  const consumed = Math.round(dayLogs.reduce((sum, l) => sum + l.calories, 0));
  const carbsG = Math.round(dayLogs.reduce((sum, l) => sum + l.carbs_g, 0));
  const fatG = Math.round(dayLogs.reduce((sum, l) => sum + l.fat_g, 0));
  const proteinG = Math.round(dayLogs.reduce((sum, l) => sum + l.protein_g, 0));

  return (
    <ScrollView
      style={styles.wrap}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl tintColor={colors.textPrimary} refreshing={refreshing} onRefresh={handleRefresh} />}
    >
      <DashboardHeader
        dateLabel={formatDateLabel(selectedDate, todayISO)}
        isToday={isToday}
        onPrevDay={() => setSelectedDate((d) => shiftDate(d, -1))}
        onNextDay={() => setSelectedDate((d) => shiftDate(d, 1))}
        onJumpToToday={() => setSelectedDate(todayISO)}
        menuItems={[
          { label: "Set target", onPress: () => router.push("/onboarding/profile-setup") },
          { label: "Meal types to show", onPress: () => router.push("/modals/meal-types") },
          { label: "About nutrition and diet", onPress: () => router.push("/modals/about-nutrition") },
        ]}
      />

      {loading ? (
        <View style={styles.contentSpinner}>
          <ActivityIndicator color={colors.progressFill} size="large" />
        </View>
      ) : (
        <>
          <CalorieSummaryBar
            consumed={consumed}
            target={target}
            rangeLow={Math.round(target * 0.9)}
            rangeHigh={Math.round(target * 1.1)}
            maxScale={Math.round(target * 1.3)}
          />

          <NutritionCard carbsG={carbsG} fatG={fatG} proteinG={proteinG} />

          <MealSlotList
            logsByMeal={groupByMeal(dayLogs)}
            visibleMeals={visibleMeals}
            onAddPress={(meal) =>
              router.push({ pathname: "/modals/add-food", params: { meal, date: selectedDate } })
            }
            onSlotPress={(meal) =>
              router.push({ pathname: "/modals/meal-detail", params: { meal, date: selectedDate } })
            }
          />

          <WeeklyChart
            days={weekDays}
            averageKcal={weekAverage}
            onPress={() => router.push("/reports")}
          />

          <BadgeRow currentStreak={streak} />
        </>
      )}

      <View style={{ height: spacing.xl }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: colors.background,
  },
  contentSpinner: {
    paddingVertical: 96,
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    padding: spacing.lg,
    paddingBottom: spacing.xl,
  },
});
