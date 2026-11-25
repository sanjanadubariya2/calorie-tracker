import React, { useCallback, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { useAuth } from "@/lib/auth-context";
import { getDailyStatus, getDailyTotals, getFoodLogsForDate, getStreak } from "@/lib/api";
import { rangeEndingOn, shiftDate, toISODate } from "@/lib/dates";
import { averageOverLoggedDays, targetBand, totalsByDate, type DailyStatus } from "@/lib/nutrition";
import { DEFAULT_TARGET_KCAL } from "@/lib/calculations";
import { getVisibleMealTypes } from "@/lib/mealPrefs";
import { DashboardHeader } from "@/components/DashboardHeader";
import { CalorieSummaryBar } from "@/components/CalorieSummaryBar";
import { NutritionCard } from "@/components/NutritionCard";
import { MealSlotList } from "@/components/MealSlotList";
import { WeeklyChart, type DayTotal } from "@/components/WeeklyChart";
import { BadgeRow } from "@/components/BadgeRow";
import { AchievementCelebration } from "@/components/achievements/AchievementCelebration";
import { colors, spacing, typography, MEAL_SLOTS, type MealType } from "@/constants/theme";
import type { FoodLog } from "@/lib/types";

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
  const [status, setStatus] = useState<DailyStatus | null>(null);
  const [dayLogs, setDayLogs] = useState<FoodLog[]>([]);
  const [weekDays, setWeekDays] = useState<DayTotal[]>([]);
  const [weekAverage, setWeekAverage] = useState(0);
  const [streak, setStreak] = useState(0);
  const [visibleMeals, setVisibleMeals] = useState<MealType[]>(MEAL_SLOTS.map((s) => s.key));
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!userId) return;
    const { start, end, days } = rangeEndingOn(selectedDate);

    // Daily numbers come from the database (get_daily_status / get_daily_totals);
    // the day's logs are still fetched for the meal list.
    const [statusData, dayData, weekRows, streakData, mealPrefs] = await Promise.all([
      getDailyStatus(selectedDate),
      getFoodLogsForDate(userId, selectedDate),
      getDailyTotals(start, end),
      getStreak(userId),
      getVisibleMealTypes(),
    ]);

    setStatus(statusData);
    setDayLogs(dayData);
    setVisibleMeals(mealPrefs);

    const byDate = totalsByDate(weekRows);
    const dayTotals: DayTotal[] = days.map((date) => ({
      date,
      dayLabel: String(Number(date.slice(8, 10))),
      totalKcal: Math.round(byDate.get(date)?.calories ?? 0),
      isToday: date === selectedDate,
    }));
    setWeekDays(dayTotals);
    setWeekAverage(averageOverLoggedDays(weekRows));

    setStreak(streakData?.current_streak ?? 0);
  }, [userId, selectedDate]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      setLoadError(null);
      loadData()
        .catch(() => setLoadError("Couldn't load your day. Pull down to retry."))
        .finally(() => setLoading(false));
    }, [loadData])
  );

  async function handleRefresh() {
    setRefreshing(true);
    setLoadError(null);
    await loadData().catch(() => setLoadError("Couldn't load your day. Pull down to retry."));
    setRefreshing(false);
  }

  const isToday = selectedDate === todayISO;
  const target = status?.targetKcal ?? DEFAULT_TARGET_KCAL;
  const band = targetBand(target);
  const consumed = Math.round(status?.consumed.calories ?? 0);
  const carbsG = Math.round(status?.consumed.carbsG ?? 0);
  const fatG = Math.round(status?.consumed.fatG ?? 0);
  const proteinG = Math.round(status?.consumed.proteinG ?? 0);

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
        onProfilePress={() => router.push("/profile")}
        menuItems={[
          { label: "Set target", onPress: () => router.push("/onboarding/profile-setup") },
          { label: "Meal types to show", onPress: () => router.push("/modals/meal-types") },
          { label: "About nutrition and diet", onPress: () => router.push("/modals/about-nutrition") },
        ]}
      />

      {loadError ? <Text style={styles.errorText}>{loadError}</Text> : null}

      {loading ? (
        <View style={styles.contentSpinner}>
          <ActivityIndicator color={colors.link} size="large" />
        </View>
      ) : (
        <>
          <CalorieSummaryBar
            consumed={consumed}
            target={target}
            rangeLow={band.low}
            rangeHigh={band.high}
            maxScale={Math.round(target * 1.3)}
          />

          <NutritionCard carbsG={carbsG} fatG={fatG} proteinG={proteinG} split={status?.split} />

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

          <BadgeRow currentStreak={streak} onPress={() => router.push("/modals/achievements")} />
        </>
      )}

      <View style={{ height: spacing.xl }} />
      <AchievementCelebration />
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
    paddingHorizontal: 20,
    paddingTop: 56,
    paddingBottom: spacing.xl,
  },
  errorText: {
    ...typography.caption,
    color: colors.danger,
    marginBottom: spacing.md,
  },
});
