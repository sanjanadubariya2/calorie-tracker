import React, { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { useAuth } from "@/lib/auth-context";
import { getDailyStatus, getProfile, getStreak } from "@/lib/api";
import { ACTIVITY_LEVELS, DEFAULT_ACTIVITY_LEVEL } from "@/lib/calculations";
import { todayISO } from "@/lib/dates";
import type { DailyStatus } from "@/lib/nutrition";
import { colors, radius, spacing, typography } from "@/constants/theme";
import type { Profile, UserStreak } from "@/lib/types";

const GOAL_LABELS: Record<string, string> = {
  lose: "Lose weight",
  maintain: "Maintain weight",
  gain: "Gain muscle",
};

export default function ProfileScreen() {
  const { userId, signOut } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [streak, setStreak] = useState<UserStreak | null>(null);
  const [status, setStatus] = useState<DailyStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      if (!userId) return;
      setLoading(true);
      // Targets come from get_daily_status, the same source as the dashboard.
      Promise.all([getProfile(userId), getStreak(userId), getDailyStatus(todayISO())])
        .then(([p, s, st]) => {
          setProfile(p);
          setStreak(s);
          setStatus(st);
        })
        .catch(() => {
          // Keep whatever loaded; the screen renders without the missing parts.
        })
        .finally(() => setLoading(false));
    }, [userId])
  );

  async function handleSignOut() {
    await signOut();
    router.replace("/");
  }

  if (loading) {
    return (
      <View style={styles.centerScreen}>
        <ActivityIndicator color={colors.progressFill} size="large" />
      </View>
    );
  }

  const activityLabel =
    ACTIVITY_LEVELS.find((a) => a.value === (profile?.activity_level ?? DEFAULT_ACTIVITY_LEVEL))?.label ?? "";
  const targetKcal = status?.targetKcal ?? profile?.daily_target_kcal ?? null;

  return (
    <ScrollView style={styles.wrap} contentContainerStyle={styles.content}>
      <Text style={styles.header}>Profile</Text>

      {profile && (
        <>
          <View style={styles.card}>
            <StatRow label="Age" value={`${profile.age} yrs`} />
            <StatRow label="Height" value={`${profile.height_cm} cm`} />
            <StatRow label="Weight" value={`${profile.weight_kg} kg`} />
            <StatRow label="Gender" value={profile.gender === "male" ? "Male" : "Female"} />
            <StatRow label="Goal" value={GOAL_LABELS[profile.goal] ?? profile.goal} />
            <StatRow label="Activity" value={activityLabel} last />
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Daily targets</Text>
            {targetKcal != null && (
              <StatRow label="Calories" value={`${targetKcal.toLocaleString()} kcal`} />
            )}
            {status?.targetCarbsG != null && status.split && (
              <>
                <StatRow label={`Carbs (${status.split.carbPct}%)`} value={`${status.targetCarbsG} g`} />
                <StatRow label={`Fat (${status.split.fatPct}%)`} value={`${status.targetFatG} g`} />
                <StatRow
                  label={`Protein (${status.split.proteinPct}%)`}
                  value={`${status.targetProteinG} g`}
                  last
                />
              </>
            )}
          </View>

          {streak && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Streak</Text>
              <StatRow label="Current streak" value={`${streak.current_streak} days`} />
              <StatRow label="Badges earned" value={`${streak.badges_earned}`} last />
            </View>
          )}

          <Pressable
            style={styles.editButton}
            onPress={() => router.push("/onboarding/profile-setup")}
          >
            <Text style={styles.editButtonText}>Edit profile & recalculate target</Text>
          </Pressable>
        </>
      )}

      <Pressable style={styles.signOutButton} onPress={handleSignOut}>
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

function StatRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View style={[styles.statRow, !last && styles.statRowBorder]}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: colors.background,
  },
  centerScreen: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    padding: spacing.lg,
    paddingBottom: spacing.xl,
  },
  header: {
    ...typography.hero,
    fontSize: 24,
    color: colors.textPrimary,
    marginBottom: spacing.md,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  cardTitle: {
    ...typography.title,
    color: colors.textPrimary,
    marginBottom: spacing.sm,
  },
  statRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: spacing.sm,
  },
  statRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  statLabel: {
    ...typography.body,
    color: colors.textSecondary,
  },
  statValue: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: "700",
  },
  editButton: {
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.pill,
    paddingVertical: spacing.md,
    alignItems: "center",
    marginTop: spacing.sm,
  },
  editButtonText: {
    ...typography.label,
    color: colors.textPrimary,
  },
  signOutButton: {
    marginTop: spacing.xl,
    alignItems: "center",
    paddingVertical: spacing.md,
  },
  signOutText: {
    ...typography.label,
    color: colors.danger,
  },
});
