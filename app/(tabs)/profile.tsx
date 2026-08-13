import React, { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { useAuth } from "@/lib/auth-context";
import { getProfile, getStreak } from "@/lib/api";
import { calculateMacroTargets } from "@/lib/calculations";
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
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      if (!userId) return;
      setLoading(true);
      Promise.all([getProfile(userId), getStreak(userId)])
        .then(([p, s]) => {
          setProfile(p);
          setStreak(s);
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

  const macros = profile ? calculateMacroTargets(profile.daily_target_kcal) : null;

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
            <StatRow label="Goal" value={GOAL_LABELS[profile.goal] ?? profile.goal} last />
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Daily targets</Text>
            <StatRow label="Calories" value={`${profile.daily_target_kcal.toLocaleString()} kcal`} />
            {macros && (
              <>
                <StatRow label="Carbs" value={`${macros.carbsG} g`} />
                <StatRow label="Fat" value={`${macros.fatG} g`} />
                <StatRow label="Protein" value={`${macros.proteinG} g`} last />
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
