import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";
import { RECOGNITION_UNITS, type RecognitionUnit } from "@/lib/recognition";
import {
  MATCH_LABEL,
  isReady,
  levelLabel,
  sourceLabel,
  warningText,
  type ReviewItem,
} from "@/lib/recognitionReview";

interface Props {
  item: ReviewItem;
  disabled: boolean;
  onRename: (name: string) => void;
  onSelectFood: (foodId: string) => void;
  onSetPortion: (quantity: number, unit: RecognitionUnit) => void;
  onRemove: () => void;
  onRetry: () => void;
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

export function RecognitionItemCard({ item, disabled, onRename, onSelectFood, onSetPortion, onRemove, onRetry }: Props) {
  const g = item.grounded;
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(item.input.food_name);
  const [quantity, setQuantity] = useState(item.input.quantity ? String(item.input.quantity) : "");
  const unit: RecognitionUnit = item.input.unit ?? "g";

  useEffect(() => setName(item.input.food_name), [item.input.food_name]);
  useEffect(() => setQuantity(item.input.quantity ? String(item.input.quantity) : ""), [item.input.quantity]);

  const saved = item.savedLogId !== null;
  const locked = disabled || saved;
  const selectedId = g?.match.selected?.food_id ?? null;
  const showOptions = item.options.length > 0 && (g?.match.decision !== "confident" || item.options.length > 1);

  function commitQuantity(nextUnit: RecognitionUnit = unit) {
    let q = Number(quantity.replace(",", "."));
    if (!quantity.trim() || !Number.isFinite(q) || q <= 0) {
      // Picking a unit with no amount means one of it (e.g. "1 bowl").
      if (nextUnit === unit) return;
      q = 1;
    }
    if (q === item.input.quantity && nextUnit === item.input.unit) return;
    onSetPortion(q, nextUnit);
  }

  function commitName() {
    setEditingName(false);
    const trimmed = name.trim();
    if (trimmed && trimmed !== item.input.food_name) onRename(trimmed);
    else setName(item.input.food_name);
  }

  return (
    <View style={[styles.card, !isReady(item) && !item.pending && !saved && styles.cardAttention]} testID={`review-item-${item.key}`}>
      <View style={styles.headerRow}>
        {editingName ? (
          <TextInput
            style={[styles.input, styles.nameInput]}
            value={name}
            onChangeText={setName}
            onSubmitEditing={commitName}
            onBlur={commitName}
            autoFocus
            maxLength={120}
            testID="item-name-input"
          />
        ) : (
          <Pressable style={styles.nameWrap} disabled={locked} onPress={() => setEditingName(true)} testID="item-name">
            <Text style={styles.name}>{item.input.food_name}</Text>
            {!locked && <Text style={styles.editHint}>Edit name</Text>}
          </Pressable>
        )}
        {saved ? (
          <Text style={styles.savedTag}>Saved</Text>
        ) : (
          <Pressable onPress={onRemove} disabled={disabled} hitSlop={12} testID="item-remove" accessibilityLabel="Remove item">
            <Text style={styles.remove}>✕</Text>
          </Pressable>
        )}
      </View>

      {item.candidate ? (
        <Text style={styles.caption}>
          {item.candidate.original_description && item.candidate.original_description !== item.input.food_name
            ? `From: “${item.candidate.original_description}”`
            : item.origin === "ai" ? "Recognised by AI" : ""}
        </Text>
      ) : (
        <Text style={styles.caption}>Added by you</Text>
      )}
      {item.candidate?.notes.map((note) => (
        <Text key={note} style={styles.note}>{note}</Text>
      ))}

      {/* Match */}
      <Text style={styles.sectionLabel}>Food</Text>
      {g?.match.selected ? (
        <Text style={styles.value} testID="item-match">
          {g.match.selected.name}
          {g.match.selected.brand ? ` (${g.match.selected.brand})` : ""}
        </Text>
      ) : (
        <Text style={[styles.value, styles.muted]}>{g ? "Not chosen yet" : "Matching…"}</Text>
      )}
      {showOptions && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
          {item.options.map((o) => (
            <Pressable
              key={o.food_id}
              style={[styles.chip, o.food_id === selectedId && styles.chipActive]}
              disabled={locked || o.food_id === selectedId}
              onPress={() => onSelectFood(o.food_id)}
              testID={`option-${o.food_id}`}
            >
              <Text style={[styles.chipText, o.food_id === selectedId && styles.chipTextActive]}>
                {o.name} · {Math.round(o.per_100.kcal)} kcal/100{o.per_100.basis}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {/* Portion */}
      <Text style={styles.sectionLabel}>Portion</Text>
      <View style={styles.portionRow}>
        <TextInput
          style={[styles.input, styles.quantityInput]}
          value={quantity}
          onChangeText={setQuantity}
          onEndEditing={() => commitQuantity()}
          onSubmitEditing={() => commitQuantity()}
          keyboardType="decimal-pad"
          editable={!locked}
          placeholder="Amount"
          placeholderTextColor={colors.textTertiary}
          testID="item-quantity"
        />
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {RECOGNITION_UNITS.map((u) => (
            <Pressable
              key={u}
              style={[styles.chip, u === unit && styles.chipActive]}
              disabled={locked}
              onPress={() => commitQuantity(u)}
              testID={`unit-${u}`}
            >
              <Text style={[styles.chipText, u === unit && styles.chipTextActive]}>{u}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
      {g && (
        <Text style={styles.caption} testID="item-portion">
          {g.portion.grams !== null
            ? `${g.portion.is_estimate ? "≈ " : ""}${fmt(g.portion.grams)} g${g.portion.is_estimate ? " (estimate)" : ""} · ${g.portion.explanation}`
            : g.portion.explanation}
        </Text>
      )}

      {/* Nutrition */}
      {g?.nutrition ? (
        <View style={styles.nutritionRow} testID="item-nutrition">
          <Text style={styles.kcal}>{fmt(g.nutrition.calories)} kcal</Text>
          <Text style={[styles.macro, { color: colors.proteinText }]}>P {fmt(g.nutrition.protein_g)} g</Text>
          <Text style={[styles.macro, { color: colors.carbText }]}>C {fmt(g.nutrition.carbs_g)} g</Text>
          <Text style={[styles.macro, { color: colors.fatText }]}>F {fmt(g.nutrition.fat_g)} g</Text>
        </View>
      ) : null}
      {g?.nutrition && <Text style={styles.caption}>Source: {sourceLabel(g.nutrition.source, g.nutrition.source_ref)}</Text>}

      {/* Confidence: three separate signals, never combined */}
      {g && (
        <Text style={styles.caption} testID="item-confidence">
          {g.confidence.recognition_level ? `Recognition: ${levelLabel(g.confidence.recognition_level)} · ` : ""}
          Match: {MATCH_LABEL[g.confidence.match_level]}
          {g.confidence.portion_level ? ` · Portion: ${levelLabel(g.confidence.portion_level)}` : ""}
        </Text>
      )}

      {g?.warnings.map((w) => (
        <Text key={w} style={styles.warning}>⚠ {warningText(w)}</Text>
      ))}

      {item.pending && (
        <View style={styles.pendingRow}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
          <Text style={styles.caption}>Updating…</Text>
        </View>
      )}
      {item.error && (
        <View style={styles.pendingRow}>
          <Text style={styles.error}>{item.error}</Text>
          <Pressable onPress={onRetry} disabled={disabled} testID="item-retry">
            <Text style={styles.link}>Retry</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  cardAttention: { borderColor: colors.fat },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  nameWrap: { flex: 1 },
  name: { ...typography.label, color: colors.textPrimary, fontSize: 16 },
  editHint: { ...typography.caption, color: colors.textTertiary },
  nameInput: { flex: 1, marginRight: spacing.sm },
  remove: { fontSize: 18, color: colors.textSecondary, paddingLeft: spacing.sm },
  savedTag: { ...typography.caption, color: colors.success },
  caption: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.xs },
  note: { ...typography.caption, color: colors.textTertiary, marginTop: 2 },
  sectionLabel: { ...typography.caption, color: colors.textTertiary, marginTop: spacing.md, textTransform: "uppercase" },
  value: { ...typography.body, color: colors.textPrimary, marginTop: 2 },
  muted: { color: colors.textSecondary },
  chipRow: { marginTop: spacing.sm },
  chip: {
    backgroundColor: colors.pillBackground,
    borderRadius: radius.pill,
    paddingVertical: 6,
    paddingHorizontal: 12,
    marginRight: spacing.sm,
  },
  chipActive: { backgroundColor: colors.progressFill },
  chipText: { ...typography.caption, color: colors.textSecondary },
  chipTextActive: { color: colors.onPrimary },
  portionRow: { flexDirection: "row", alignItems: "center", marginTop: spacing.xs },
  input: {
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.sm,
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    color: colors.textPrimary,
    ...typography.body,
  },
  quantityInput: { width: 80, marginRight: spacing.sm },
  nutritionRow: { flexDirection: "row", alignItems: "baseline", marginTop: spacing.md, flexWrap: "wrap" },
  kcal: { ...typography.title, color: colors.textPrimary, marginRight: spacing.md },
  macro: { ...typography.label, marginRight: spacing.md },
  warning: { ...typography.caption, color: colors.warning, marginTop: spacing.xs },
  pendingRow: { flexDirection: "row", alignItems: "center", marginTop: spacing.sm, gap: spacing.sm },
  error: { ...typography.caption, color: colors.danger, flex: 1 },
  link: { ...typography.label, color: colors.link },
});
