import React, { useEffect, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { getProfile, upsertProfile } from "@/lib/api";
import {
  ACTIVITY_LEVELS,
  DEFAULT_ACTIVITY_LEVEL,
  DEFAULT_MACRO_SPLIT,
  MACRO_PRESETS,
  calculateDailyTarget,
  macroSplitOf,
  type ActivityLevel,
  type MacroSplit,
} from "@/lib/calculations";
import { colors, radius, spacing, typography } from "@/constants/theme";
import type { Gender, Goal } from "@/lib/types";

const GENDERS: { value: Gender; label: string }[] = [
  { value: "female", label: "Female" },
  { value: "male", label: "Male" },
];

const GOALS: { value: Goal; label: string; description: string }[] = [
  { value: "lose", label: "Lose weight", description: "500 kcal below maintenance" },
  { value: "maintain", label: "Maintain weight", description: "At maintenance calories" },
  { value: "gain", label: "Gain muscle", description: "300 kcal above maintenance" },
];

export default function ProfileSetupScreen() {
  const { userId } = useAuth();
  const [age, setAge] = useState("");
  const [heightCm, setHeightCm] = useState("");
  const [weightKg, setWeightKg] = useState("");
  const [gender, setGender] = useState<Gender>("female");
  const [goal, setGoal] = useState<Goal>("maintain");
  const [activity, setActivity] = useState<ActivityLevel>(DEFAULT_ACTIVITY_LEVEL);
  const [split, setSplit] = useState<MacroSplit>(DEFAULT_MACRO_SPLIT);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // This screen is also "Edit profile" / "Set target": start from the saved values.
  useEffect(() => {
    if (!userId) return;
    getProfile(userId)
      .then((p) => {
        if (!p) return;
        setAge(String(p.age));
        setHeightCm(String(p.height_cm));
        setWeightKg(String(p.weight_kg));
        setGender(p.gender);
        setGoal(p.goal);
        setActivity(p.activity_level ?? DEFAULT_ACTIVITY_LEVEL);
        setSplit(macroSplitOf(p));
      })
      .catch(() => {
        // A new user has no profile yet; the empty form is correct.
      });
  }, [userId]);

  const presetKey =
    MACRO_PRESETS.find(
      (p) =>
        p.split.carbPct === split.carbPct &&
        p.split.fatPct === split.fatPct &&
        p.split.proteinPct === split.proteinPct
    )?.key ?? null;

  const parsedAge = parseInt(age, 10);
  const parsedHeight = parseFloat(heightCm);
  const parsedWeight = parseFloat(weightKg);
  const valid =
    parsedAge > 0 && parsedAge < 120 && parsedHeight > 0 && parsedHeight < 250 && parsedWeight > 0 && parsedWeight < 400;

  const previewTarget = valid
    ? calculateDailyTarget(parsedWeight, parsedHeight, parsedAge, gender, goal, activity)
    : null;

  async function handleSubmit() {
    if (!userId || !valid) {
      setError("Please fill in age, height, and weight with valid numbers.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      // The database recomputes daily_target_kcal with the same formula; the
      // value sent here only keeps the request shape older servers expect.
      const target = calculateDailyTarget(parsedWeight, parsedHeight, parsedAge, gender, goal, activity);
      await upsertProfile(userId, {
        age: parsedAge,
        height_cm: parsedHeight,
        weight_kg: parsedWeight,
        gender,
        goal,
        activity_level: activity,
        macro_carb_pct: split.carbPct,
        macro_fat_pct: split.fatPct,
        macro_protein_pct: split.proteinPct,
        daily_target_kcal: target,
      });
      router.replace("/(tabs)");
    } catch (e) {
      setError((e as Error).message || "Couldn't save your profile. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ScrollView style={styles.wrap} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Set up your profile</Text>
      <Text style={styles.subtitle}>
        We'll use this to calculate your daily calorie target with the Mifflin-St Jeor formula.
      </Text>

      <Text style={styles.inputLabel}>Age</Text>
      <TextInput
        style={styles.input}
        value={age}
        onChangeText={setAge}
        keyboardType="numeric"
        placeholder="Years"
        placeholderTextColor={colors.textTertiary}
      />

      <Text style={styles.inputLabel}>Height (cm)</Text>
      <TextInput
        style={styles.input}
        value={heightCm}
        onChangeText={setHeightCm}
        keyboardType="numeric"
        placeholder="e.g. 165"
        placeholderTextColor={colors.textTertiary}
      />

      <Text style={styles.inputLabel}>Weight (kg)</Text>
      <TextInput
        style={styles.input}
        value={weightKg}
        onChangeText={setWeightKg}
        keyboardType="numeric"
        placeholder="e.g. 58"
        placeholderTextColor={colors.textTertiary}
      />

      <Text style={styles.inputLabel}>Gender</Text>
      <View style={styles.chipRow}>
        {GENDERS.map((g) => (
          <Pressable
            key={g.value}
            style={[styles.chip, gender === g.value && styles.chipActive]}
            onPress={() => setGender(g.value)}
          >
            <Text style={[styles.chipText, gender === g.value && styles.chipTextActive]}>
              {g.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.inputLabel}>Goal</Text>
      <View style={styles.goalList}>
        {GOALS.map((g) => (
          <Pressable
            key={g.value}
            style={[styles.goalCard, goal === g.value && styles.goalCardActive]}
            onPress={() => setGoal(g.value)}
          >
            <Text style={styles.goalLabel}>{g.label}</Text>
            <Text style={styles.goalDescription}>{g.description}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.inputLabel}>Activity level</Text>
      <View style={styles.goalList}>
        {ACTIVITY_LEVELS.map((a) => (
          <Pressable
            key={a.value}
            style={[styles.goalCard, activity === a.value && styles.goalCardActive]}
            onPress={() => setActivity(a.value)}
          >
            <Text style={styles.goalLabel}>{a.label}</Text>
            <Text style={styles.goalDescription}>{a.description}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.inputLabel}>Macro balance (carbs / fat / protein)</Text>
      <View style={styles.chipRow}>
        {MACRO_PRESETS.map((p) => (
          <Pressable
            key={p.key}
            style={[styles.chip, presetKey === p.key && styles.chipActive]}
            onPress={() => setSplit(p.split)}
          >
            <Text style={[styles.chipText, presetKey === p.key && styles.chipTextActive]}>{p.label}</Text>
          </Pressable>
        ))}
      </View>
      {presetKey === null && (
        <Text style={styles.goalDescription}>
          Current: {split.carbPct}/{split.fatPct}/{split.proteinPct}
        </Text>
      )}

      {previewTarget && (
        <View style={styles.previewCard}>
          <Text style={styles.previewLabel}>Your estimated daily target</Text>
          <Text style={styles.previewValue}>{previewTarget.toLocaleString()} kcal</Text>
        </View>
      )}

      {error && <Text style={styles.errorText}>{error}</Text>}

      <Pressable
        style={[styles.button, (!valid || submitting) && styles.buttonDisabled]}
        onPress={handleSubmit}
        disabled={!valid || submitting}
      >
        <Text style={styles.buttonText}>{submitting ? "Saving..." : "Save and continue"}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: spacing.lg,
    paddingBottom: spacing.xl * 2,
  },
  title: {
    ...typography.hero,
    fontSize: 28,
    color: colors.textPrimary,
  },
  subtitle: {
    ...typography.body,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    marginBottom: spacing.lg,
  },
  inputLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
    marginTop: spacing.md,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.md,
    padding: spacing.md,
    color: colors.textPrimary,
    ...typography.body,
  },
  chipRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  chip: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.pill,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xs,
    alignItems: "center",
    justifyContent: "center",
  },
  chipActive: {
    backgroundColor: colors.progressFill,
    borderColor: colors.progressFill,
  },
  chipText: {
    ...typography.label,
    color: colors.textSecondary,
    textAlign: "center",
  },
  chipTextActive: {
    color: "#0A0A0A",
  },
  goalList: {
    gap: spacing.sm,
  },
  goalCard: {
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  goalCardActive: {
    borderColor: colors.progressFill,
    backgroundColor: colors.pillBackground,
  },
  goalLabel: {
    ...typography.body,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  goalDescription: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
  previewCard: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.lg,
    alignItems: "center",
    marginTop: spacing.lg,
  },
  previewLabel: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  previewValue: {
    ...typography.title,
    color: colors.progressFill,
    marginTop: spacing.xs,
  },
  errorText: {
    ...typography.caption,
    color: colors.danger,
    marginTop: spacing.md,
  },
  button: {
    backgroundColor: colors.progressFill,
    borderRadius: radius.pill,
    paddingVertical: spacing.md,
    alignItems: "center",
    marginTop: spacing.xl,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonText: {
    ...typography.label,
    color: "#0A0A0A",
  },
});
