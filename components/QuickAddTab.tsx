import React, { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";

interface Props {
  onConfirm: (result: { title: string; calories: number }) => void;
}

export function QuickAddTab({ onConfirm }: Props) {
  const [title, setTitle] = useState("");
  const [calories, setCalories] = useState("");

  const caloriesNum = parseInt(calories, 10) || 0;
  const canSubmit = title.trim().length > 0 && caloriesNum > 0;

  return (
    <View style={styles.wrap}>
      <Text style={styles.hint}>
        Know the calories but not the exact macros? Add it directly — it'll count toward your daily
        total.
      </Text>

      <Text style={styles.inputLabel}>Title</Text>
      <TextInput
        style={styles.input}
        value={title}
        onChangeText={setTitle}
        placeholder="e.g. Restaurant meal"
        placeholderTextColor={colors.textTertiary}
      />

      <Text style={styles.inputLabel}>Calories</Text>
      <TextInput
        style={styles.input}
        value={calories}
        onChangeText={setCalories}
        keyboardType="numeric"
        placeholder="e.g. 350"
        placeholderTextColor={colors.textTertiary}
      />

      <Pressable
        style={[styles.confirmButton, !canSubmit && styles.confirmButtonDisabled]}
        disabled={!canSubmit}
        onPress={() => onConfirm({ title: title.trim(), calories: caloriesNum })}
      >
        <Text style={styles.confirmButtonText}>Add to log</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingTop: spacing.md,
  },
  hint: {
    ...typography.caption,
    color: colors.textSecondary,
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
  confirmButton: {
    backgroundColor: colors.progressFill,
    borderRadius: radius.pill,
    paddingVertical: spacing.md,
    alignItems: "center",
    marginTop: spacing.xl,
  },
  confirmButtonDisabled: {
    opacity: 0.4,
  },
  confirmButtonText: {
    ...typography.label,
    color: colors.onAccent,
  },
});
