import React, { useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { MEAL_SLOTS, colors, radius, spacing, typography } from "@/constants/theme";
import type { FoodLogProposal, ItemEdit, ProposedFood } from "@/lib/assistant";
import { groundItems } from "@/lib/recognition";
import { sourceLabel, warningText } from "@/lib/recognitionReview";

interface Props {
  proposal: FoodLogProposal;
  onConfirm: (edits: { meal_type?: string; items?: ItemEdit[] }) => Promise<unknown>;
  onCancel: () => Promise<unknown>;
}

interface Draft {
  quantity: string;
  unit: string;
  removed: boolean;
  preview: ProposedFood["nutrition"] | null;   // re-priced by the backend after an edit
  previewing: boolean;
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const STATUS_TEXT: Record<string, string> = {
  confirmed: "✓ Logged",
  rejected: "Cancelled",
  expired: "Expired. Ask again to log it.",
  confirming: "Saving…",
};

function isExpired(p: FoodLogProposal): boolean {
  return p.status === "pending" && new Date(p.expires_at).getTime() <= Date.now();
}

export function ProposalCard({ proposal, onConfirm, onCancel }: Props) {
  const [meal, setMeal] = useState<string>(proposal.meal_type);
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    proposal.items.map((i) => ({ quantity: i.quantity !== null ? String(i.quantity) : String(i.grams ?? 1), unit: i.unit ?? "g",
                                 removed: false, preview: null, previewing: false })));
  const [busy, setBusy] = useState<"confirm" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const status = isExpired(proposal) ? "expired" : proposal.status;
  const actionable = status === "pending";

  const edits = useMemo<ItemEdit[]>(() => drafts.flatMap((d, index): ItemEdit[] => {
    const item = proposal.items[index];
    if (d.removed) return [{ index, remove: true }];
    const q = Number(d.quantity.replace(",", "."));
    const original = item.quantity ?? item.grams ?? 1;
    const unitOriginal = item.unit ?? "g";
    return Number.isFinite(q) && q > 0 && (q !== original || d.unit !== unitOriginal) ? [{ index, quantity: q, unit: d.unit }] : [];
  }), [drafts, proposal.items]);

  const nutritionOf = (i: number) => drafts[i].preview ?? proposal.items[i].nutrition;
  const totals = drafts.reduce(
    (acc, d, i) => (d.removed ? acc : {
      calories: acc.calories + nutritionOf(i).calories, protein_g: acc.protein_g + nutritionOf(i).protein_g,
      carbs_g: acc.carbs_g + nutritionOf(i).carbs_g, fat_g: acc.fat_g + nutritionOf(i).fat_g,
    }),
    { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }
  );
  const remaining = drafts.filter((d) => !d.removed).length;

  function update(i: number, patch: Partial<Draft>) {
    setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  }

  async function reprice(i: number, quantity: string, unit: string) {
    const q = Number(quantity.replace(",", "."));
    if (!Number.isFinite(q) || q <= 0) return;
    const item = proposal.items[i];
    if (!item.food_id) return;                      // a recipe: re-priced by servings when confirmed
    update(i, { previewing: true });
    try {
      const result = await groundItems([{ food_name: item.food_name, quantity: q, unit: unit as never,
                                          quantity_source: "manual", selected_food_id: item.food_id }]);
      const n = result.items[0]?.nutrition;
      update(i, { previewing: false, preview: n ? { calories: n.calories, protein_g: n.protein_g, carbs_g: n.carbs_g, fat_g: n.fat_g } : null });
    } catch {
      update(i, { previewing: false });            // the server re-prices on confirm anyway
    }
  }

  async function run(kind: "confirm" | "cancel") {
    if (busyRef.current || !actionable) return;     // no double submission
    busyRef.current = true;
    setBusy(kind);
    setError(null);
    try {
      if (kind === "confirm") {
        await onConfirm({ meal_type: meal !== proposal.meal_type ? meal : undefined, items: edits.length ? edits : undefined });
      } else {
        await onCancel();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  return (
    <View style={[styles.card, !actionable && styles.cardDone]} testID={`proposal-${proposal.id}`}>
      <View style={styles.header}>
        <Text style={styles.title}>Log food?</Text>
        {!actionable && <Text style={[styles.status, status === "confirmed" && { color: colors.success }]} testID="proposal-status">
          {STATUS_TEXT[status] ?? status}</Text>}
      </View>

      {proposal.items.map((item, i) => {
        const d = drafts[i];
        const n = nutritionOf(i);
        return (
          <View key={`${item.food_id ?? item.recipe_id}-${i}`} style={[styles.item, d.removed && styles.removed]} testID={`proposal-item-${i}`}>
            <View style={styles.itemHeader}>
              <Text style={styles.foodName}>{item.food_name}</Text>
              {actionable && remaining > (d.removed ? 0 : 1) && (
                <Pressable onPress={() => update(i, { removed: !d.removed })} hitSlop={10} testID={`proposal-remove-${i}`}>
                  <Text style={styles.link}>{d.removed ? "Undo" : "Remove"}</Text>
                </Pressable>
              )}
            </View>
            {actionable && !d.removed ? (
              <View style={styles.portionRow}>
                <TextInput
                  style={styles.input}
                  value={d.quantity}
                  onChangeText={(t) => update(i, { quantity: t, preview: null })}
                  onEndEditing={() => reprice(i, d.quantity, d.unit)}
                  keyboardType="decimal-pad"
                  testID={`proposal-quantity-${i}`}
                />
                {item.recipe_id ? <Text style={styles.unitText}>servings</Text> : [...new Set([item.unit ?? "g", "g"])].map((u) => (
                  <Pressable key={u} style={[styles.unit, d.unit === u && styles.unitActive]}
                    onPress={() => { update(i, { unit: u, preview: null }); void reprice(i, d.quantity, u); }} testID={`proposal-unit-${i}-${u}`}>
                    <Text style={[styles.unitText, d.unit === u && styles.unitTextActive]}>{u}</Text>
                  </Pressable>
                ))}
                {d.previewing && <ActivityIndicator size="small" color={colors.textSecondary} />}
              </View>
            ) : (
              <Text style={styles.detail}>
                {item.quantity !== null ? `${fmt(item.quantity)} ${item.unit ?? ""}` : ""}
                {item.grams !== null ? `${item.quantity !== null ? " · " : ""}${fmt(item.grams)} g` : ""}
              </Text>
            )}
            {!d.removed && (
              <Text style={styles.detail}>
                {fmt(n.calories)} kcal · P {fmt(n.protein_g)} g · C {fmt(n.carbs_g)} g · F {fmt(n.fat_g)} g
              </Text>
            )}
            <Text style={styles.source}>
              {item.portion_is_estimate ? "Estimated portion · " : ""}Source: {sourceLabel(item.nutrition_source, item.source_ref)}
            </Text>
            {item.warnings.map((w) => <Text key={w} style={styles.warning}>⚠ {warningText(w)}</Text>)}
          </View>
        );
      })}

      {actionable && (
        <View style={styles.meals}>
          {MEAL_SLOTS.map((s) => (
            <Pressable key={s.key} style={[styles.unit, meal === s.key && styles.unitActive]} onPress={() => setMeal(s.key)}
              testID={`proposal-meal-${s.key}`}>
              <Text style={[styles.unitText, meal === s.key && styles.unitTextActive]}>{s.label}</Text>
            </Pressable>
          ))}
        </View>
      )}

      <Text style={styles.totals} testID="proposal-totals">
        {fmt(Math.round(totals.calories))} kcal · P {fmt(Math.round(totals.protein_g * 10) / 10)} g · C{" "}
        {fmt(Math.round(totals.carbs_g * 10) / 10)} g · F {fmt(Math.round(totals.fat_g * 10) / 10)} g
      </Text>
      {error && <Text style={styles.error} testID="proposal-error">{error}</Text>}

      {actionable && (
        <View style={styles.buttons}>
          <Pressable style={styles.secondary} onPress={() => run("cancel")} disabled={busy !== null} testID="proposal-cancel">
            <Text style={styles.secondaryText}>{busy === "cancel" ? "Cancelling…" : "Cancel"}</Text>
          </Pressable>
          <Pressable style={[styles.primary, busy !== null && styles.disabled]} onPress={() => run("confirm")}
            disabled={busy !== null} testID="proposal-confirm">
            <Text style={styles.primaryText}>{busy === "confirm" ? "Logging…" : "Confirm"}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.background, borderRadius: radius.md, borderWidth: 1, borderColor: colors.progressFill,
    padding: spacing.md, marginTop: spacing.sm,
  },
  cardDone: { borderColor: colors.cardBorder },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { ...typography.label, color: colors.textPrimary },
  status: { ...typography.caption, color: colors.textSecondary },
  item: { paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.divider },
  removed: { opacity: 0.4 },
  itemHeader: { flexDirection: "row", justifyContent: "space-between" },
  foodName: { ...typography.label, color: colors.textPrimary, flex: 1 },
  link: { ...typography.caption, color: colors.link },
  portionRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.xs },
  input: {
    borderWidth: 1, borderColor: colors.cardBorder, borderRadius: radius.sm, paddingVertical: 4, paddingHorizontal: spacing.sm,
    color: colors.textPrimary, width: 72, ...typography.body,
  },
  unit: { backgroundColor: colors.pillBackground, borderRadius: radius.pill, paddingVertical: 6, paddingHorizontal: 12 },
  unitActive: { backgroundColor: colors.progressFill },
  unitText: { ...typography.caption, color: colors.textSecondary },
  unitTextActive: { color: colors.onAccent },
  detail: { ...typography.caption, color: colors.textSecondary, marginTop: 4 },
  source: { ...typography.caption, color: colors.textTertiary, marginTop: 2 },
  warning: { ...typography.caption, color: colors.warning, marginTop: 2 },
  meals: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: spacing.md },
  totals: { ...typography.label, color: colors.textPrimary, marginTop: spacing.md },
  error: { ...typography.caption, color: colors.danger, marginTop: spacing.sm },
  buttons: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  primary: { flex: 1, backgroundColor: colors.progressFill, borderRadius: radius.pill, paddingVertical: spacing.sm, alignItems: "center" },
  primaryText: { ...typography.label, color: colors.onAccent },
  secondary: { flex: 1, borderWidth: 1, borderColor: colors.cardBorder, borderRadius: radius.pill, paddingVertical: spacing.sm, alignItems: "center" },
  secondaryText: { ...typography.label, color: colors.textPrimary },
  disabled: { opacity: 0.5 },
});
