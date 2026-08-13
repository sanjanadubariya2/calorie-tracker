import React, { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { useAuth } from "@/lib/auth-context";
import { deleteFoodLog, getFoodLogsForDate } from "@/lib/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EditLogEntry } from "@/components/EditLogEntry";
import { MEAL_SLOTS, colors, radius, spacing, typography, type MealType } from "@/constants/theme";
import type { FoodLog } from "@/lib/types";

export default function MealDetailModal() {
  const { userId } = useAuth();
  const params = useLocalSearchParams<{ meal?: string; date?: string }>();
  const meal = (params.meal as MealType) ?? "breakfast";
  const mealLabel = MEAL_SLOTS.find((s) => s.key === meal)?.label ?? "Meal";

  const now = new Date();
  const date =
    params.date ??
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate()
    ).padStart(2, "0")}`;

  const [logs, setLogs] = useState<FoodLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<FoodLog | null>(null);
  const [pendingDelete, setPendingDelete] = useState<FoodLog | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!userId) return;
    const all = await getFoodLogsForDate(userId, date);
    setLogs(all.filter((l) => l.meal_type === meal));
  }, [userId, date, meal]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load().finally(() => setLoading(false));
    }, [load])
  );

  async function handleDelete() {
    if (!userId || !pendingDelete) return;
    setBusy(true);
    try {
      await deleteFoodLog(userId, pendingDelete.id);
      setPendingDelete(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  const totalKcal = Math.round(logs.reduce((sum, l) => sum + l.calories, 0));

  if (editing) {
    return (
      <EditLogEntry
        log={editing}
        onCancel={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await load();
        }}
      />
    );
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.closeButton}>✕</Text>
        </Pressable>
        <Text style={styles.headerTitle}>{mealLabel}</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.totalCard}>
          <Text style={styles.totalValue}>{totalKcal.toLocaleString()}</Text>
          <Text style={styles.totalUnit}>kcal logged</Text>
        </View>

        {loading ? (
          <View style={styles.centerBlock}>
            <ActivityIndicator color={colors.progressFill} size="large" />
          </View>
        ) : logs.length === 0 ? (
          <View style={styles.centerBlock}>
            <Text style={styles.emptyTitle}>Nothing logged for {mealLabel.toLowerCase()}</Text>
            <Text style={styles.emptyBody}>Add a food to get started.</Text>
          </View>
        ) : (
          logs.map((log) => (
            <View key={log.id} style={styles.itemCard}>
              <View style={styles.itemHeader}>
                <Text style={styles.itemName}>{log.food_name}</Text>
                <Text style={styles.itemKcal}>{Math.round(log.calories)} kcal</Text>
              </View>

              <Text style={styles.itemMeta}>
                {log.serving_g ? `${log.serving_g} g` : "Quick add"}
                {log.is_quick_add ? "" : ` · C ${log.carbs_g}g · F ${log.fat_g}g · P ${log.protein_g}g`}
              </Text>

              <View style={styles.itemActions}>
                <Pressable style={styles.actionButton} onPress={() => setEditing(log)}>
                  <Text style={styles.actionText}>Edit</Text>
                </Pressable>
                <Pressable
                  style={[styles.actionButton, styles.deleteButton]}
                  onPress={() => setPendingDelete(log)}
                >
                  <Text style={styles.deleteText}>Remove</Text>
                </Pressable>
              </View>
            </View>
          ))
        )}

        <Pressable
          style={styles.addButton}
          onPress={() =>
            router.replace({ pathname: "/modals/add-food", params: { meal, date } })
          }
        >
          <Text style={styles.addButtonText}>+ Add another food</Text>
        </Pressable>

        <View style={{ height: spacing.xl }} />
      </ScrollView>

      <ConfirmDialog
        visible={pendingDelete !== null}
        title="Remove this food?"
        message={
          pendingDelete
            ? `“${pendingDelete.food_name}” (${Math.round(
                pendingDelete.calories
              )} kcal) will be removed from ${mealLabel.toLowerCase()}.`
            : undefined
        }
        confirmLabel={busy ? "Removing…" : "Remove"}
        onConfirm={handleDelete}
        onCancel={() => setPendingDelete(null)}
      />
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
  content: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  totalCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    alignItems: "center",
  },
  totalValue: {
    fontSize: 40,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  totalUnit: {
    ...typography.body,
    color: colors.textSecondary,
  },
  centerBlock: {
    paddingVertical: 48,
    alignItems: "center",
  },
  emptyTitle: {
    ...typography.label,
    color: colors.textSecondary,
  },
  emptyBody: {
    ...typography.caption,
    color: colors.textTertiary,
    marginTop: spacing.xs,
  },
  itemCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  itemHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: spacing.md,
  },
  itemName: {
    ...typography.body,
    fontWeight: "700",
    color: colors.textPrimary,
    flex: 1,
  },
  itemKcal: {
    ...typography.body,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  itemMeta: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  itemActions: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  actionButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.pill,
    paddingVertical: spacing.sm,
    alignItems: "center",
  },
  actionText: {
    ...typography.label,
    color: colors.textPrimary,
  },
  deleteButton: {
    borderColor: colors.danger,
  },
  deleteText: {
    ...typography.label,
    color: colors.danger,
  },
  addButton: {
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.pill,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  addButtonText: {
    ...typography.label,
    color: colors.textPrimary,
  },
});
