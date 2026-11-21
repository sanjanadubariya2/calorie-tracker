// Details for one recommendation: re-priced servings, ingredients, instructions,
// and logging through the existing proposal flow (the user must confirm).
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";
import { confirmProposal, rejectProposal, type FoodLogProposal } from "@/lib/assistant";
import { ProposalCard } from "@/components/assistant/ProposalCard";
import {
  getRecommendation,
  prepareLog,
  sendFeedback,
  toRecommendationError,
  type RecommendationDetail as Detail,
} from "@/lib/recommendations";
import { KIND_LABEL, minutesText, portionText, qualityBadges, stepServings } from "@/lib/recommendationsView";

interface Props {
  id: string | null;
  onClose: () => void;
  onSavedChange: (saved: boolean) => void;
  onAsk?: (detail: Detail) => void;
}

export function RecommendationDetailSheet({ id, onClose, onSavedChange, onAsk }: Props) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [servings, setServings] = useState<number[]>([]);
  const [optional, setOptional] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<FoodLogProposal | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [logged, setLogged] = useState(false);
  const request = useRef(0);

  const load = useCallback(async (rid: string, s?: number[], opt?: string[]) => {
    const n = ++request.current;                  // only the latest response is shown
    setLoading(true);
    setError(null);
    try {
      const d = await getRecommendation(rid, s, opt);
      if (n !== request.current) return;
      setDetail(d);
      setServings(d.item.portions.map((p) => p.servings));
      setOptional(d.selected_optional);
    } catch (e) {
      if (n === request.current) setError(toRecommendationError(e).message);
    } finally {
      if (n === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setDetail(null);
    setProposal(null);
    setLogged(false);
    setOptional([]);
    if (id) {
      void load(id);
      void sendFeedback(id, "viewed").catch(() => undefined);    // recorded, never read as liking
    }
  }, [id, load]);

  function step(i: number, direction: 1 | -1) {
    if (!detail || !id) return;
    const next = servings.map((s, j) => (j === i ? stepServings(detail.item.portions[j], s, direction) : s));
    if (next[i] === servings[i]) return;
    setServings(next);
    void load(id, next, optional);                // re-priced by the database
  }

  function toggleOptional(foodId: string) {
    if (!id) return;
    const next = optional.includes(foodId) ? optional.filter((o) => o !== foodId) : [...optional, foodId];
    setOptional(next);
    void load(id, servings, next);                // the backend re-checks and re-prices the total
  }

  async function toggleSave() {
    if (!detail || !id) return;
    const saved = !detail.saved;
    setDetail({ ...detail, saved });
    try {
      await sendFeedback(id, saved ? "saved" : "unsaved");
      onSavedChange(saved);
    } catch (e) {
      setDetail({ ...detail, saved: !saved });
      setError(toRecommendationError(e).message);
    }
  }

  async function log() {
    if (!id || preparing) return;
    setPreparing(true);
    setError(null);
    try {
      setProposal(await prepareLog(id, { servings, optional }));
    } catch (e) {
      setError(toRecommendationError(e).message);
    } finally {
      setPreparing(false);
    }
  }

  const item = detail?.item;
  return (
    <Modal visible={id !== null} animationType="slide" onRequestClose={onClose} transparent={false}>
      <View style={styles.wrap} testID="rec-detail">
        <View style={styles.top}>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" testID="rec-detail-close" hitSlop={10}>
            <Text style={styles.link}>Close</Text>
          </Pressable>
          {detail && (
            <Pressable onPress={toggleSave} accessibilityRole="button" testID="rec-detail-save" hitSlop={10}
              accessibilityLabel={detail.saved ? "Remove from saved" : "Save"}>
              <Text style={styles.link}>{detail.saved ? "★ Saved" : "☆ Save"}</Text>
            </Pressable>
          )}
        </View>
        {!detail && loading && <ActivityIndicator color={colors.textPrimary} style={{ marginTop: spacing.xl }} testID="rec-detail-loading" />}
        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.error} testID="rec-detail-error">{error}</Text>
            {!detail && id && (
              <Pressable onPress={() => load(id)} testID="rec-detail-retry" accessibilityRole="button">
                <Text style={styles.link}>Try again</Text>
              </Pressable>
            )}
          </View>
        )}
        {item && detail && (
          <ScrollView contentContainerStyle={styles.body}>
            <Text style={styles.kind}>{KIND_LABEL[item.kind]}
              {item.total_minutes !== null ? ` · ${minutesText(item.total_minutes)}` : ""}</Text>
            <Text style={styles.title}>{item.name}{item.variant ? ` (${item.variant})` : ""}</Text>
            {item.description && <Text style={styles.muted}>{item.description}</Text>}

            <Text style={styles.section}>Serving size</Text>
            {item.portions.map((p, i) => (
              <View key={`${p.id}-${i}`} style={styles.portion}>
                <Text style={styles.portionName}>{p.name}</Text>
                <View style={styles.stepper}>
                  <Pressable onPress={() => step(i, -1)} style={styles.stepBtn} accessibilityRole="button"
                    accessibilityLabel={`Less ${p.name}`} testID={`rec-less-${i}`}><Text style={styles.stepText}>−</Text></Pressable>
                  <Text style={styles.portionText} testID={`rec-portion-${i}`}>{portionText({ ...p, servings: servings[i] ?? p.servings })}</Text>
                  <Pressable onPress={() => step(i, 1)} style={styles.stepBtn} accessibilityRole="button"
                    accessibilityLabel={`More ${p.name}`} testID={`rec-more-${i}`}><Text style={styles.stepText}>+</Text></Pressable>
                </View>
              </View>
            ))}
            {item.optional_components.length > 0 && (
              <>
                <Text style={styles.section}>Optional add-ons</Text>
                {item.optional_components.map((o) => {
                  const on = optional.includes(o.id);
                  return (
                    <Pressable key={o.id} onPress={() => toggleOptional(o.id)} style={styles.optionRow}
                      accessibilityRole="checkbox" accessibilityState={{ checked: on }}
                      accessibilityLabel={`Add ${o.name}, ${o.nutrition.kcal} kilocalories`} testID={`rec-optional-${o.id}`}>
                      <Text style={styles.checkbox}>{on ? "☑" : "☐"}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.portionText}>{o.name} · {portionText({ ...item.portions[0], ...o, kind: "food", min_servings: o.servings, max_servings: o.servings })}</Text>
                        <Text style={styles.caption}>+{o.nutrition.kcal} kcal · P {o.nutrition.protein_g} g · C {o.nutrition.carbs_g} g · F {o.nutrition.fat_g} g
                          {o.allergens_detected.length ? ` · may contain ${o.allergens_detected.join(", ").replace(/_/g, " ")}` : ""}
                          {o.allergen_status !== "reviewed" ? " · allergens not reviewed" : ""}
                          {o.quality_flags.includes("density_assumed") ? " · volume-based estimate" : ""}</Text>
                      </View>
                    </Pressable>
                  );
                })}
              </>
            )}
            {item.optional_withheld.map((w) => (
              <Text key={w.name} style={styles.caption} testID={`rec-withheld-${w.name}`}>
                Not offered: {w.name} ({w.label.toLowerCase()})
              </Text>
            ))}
            <View style={styles.totals} accessible testID="rec-detail-nutrition">
              <Text style={styles.kcal}>{detail.total_nutrition.kcal} kcal</Text>
              <Text style={[styles.macro, { color: colors.protein }]}>P {detail.total_nutrition.protein_g} g</Text>
              <Text style={[styles.macro, { color: colors.carb }]}>C {detail.total_nutrition.carbs_g} g</Text>
              <Text style={[styles.macro, { color: colors.fat }]}>F {detail.total_nutrition.fat_g} g</Text>
              {loading && <ActivityIndicator size="small" color={colors.textSecondary} />}
            </View>
            <Text style={styles.caption}>
              {optional.length ? `Base meal ${item.nutrition.kcal} kcal + ${optional.length} add-on${optional.length > 1 ? "s" : ""}. ` : ""}
              Priced by the database for these servings.
            </Text>

            <Text style={styles.section}>Why it was suggested</Text>
            {item.reasons.map((r) => <Text key={r} style={styles.muted}>• {r}</Text>)}

            <Text style={styles.section}>Data quality</Text>
            <View style={styles.badges}>
              {qualityBadges(item).map((b) => <Text key={b.key} style={[styles.badge, b.tone === "caution" && styles.caution]}>{b.label}</Text>)}
            </View>
            {item.warnings.map((w) => <Text key={w} style={styles.warning}>⚠ {w}</Text>)}

            {item.ingredients.length > 0 && (
              <>
                <Text style={styles.section}>Ingredients</Text>
                {item.ingredients.map((g, i) => (
                  <Text key={`${g.part}-${i}`} style={styles.muted} testID={`rec-ingredient-${i}`}>
                    • {g.name}{g.quantity !== null ? ` — ${g.quantity} ${g.unit ?? ""}` : ""}
                    {g.grams !== null && g.unit !== "g" ? ` (${g.grams} g)` : ""}{g.optional ? " (optional)" : ""}
                  </Text>
                ))}
              </>
            )}
            {detail.instructions.some((s) => s.length) && (
              <>
                <Text style={styles.section}>How to make it</Text>
                {detail.instructions.map((steps, part) => steps.map((s, i) => (
                  <Text key={`${part}-${i}`} style={styles.muted}>{i + 1}. {s}</Text>
                )))}
              </>
            )}
            {item.equipment && item.equipment.length > 0 && (
              <Text style={styles.caption}>Needs: {item.equipment.join(", ").replace(/_/g, " ")}</Text>
            )}

            {proposal ? (
              <ProposalCard
                proposal={proposal}
                onConfirm={async (edits) => {
                  const r = await confirmProposal(proposal.id, edits);
                  setProposal(r.proposal);
                  setLogged(true);
                }}
                onCancel={async () => setProposal(await rejectProposal(proposal.id))}
              />
            ) : (
              <View style={styles.buttons}>
                {onAsk && (
                  <Pressable style={styles.secondary} onPress={() => onAsk(detail)} accessibilityRole="button" testID="rec-detail-ask">
                    <Text style={styles.secondaryText}>Ask assistant</Text>
                  </Pressable>
                )}
                <Pressable style={[styles.primary, preparing && styles.disabled]} onPress={log} disabled={preparing}
                  accessibilityRole="button" accessibilityLabel="Prepare to log this meal" testID="rec-detail-log">
                  <Text style={styles.primaryText}>{preparing ? "Preparing…" : "Log this meal"}</Text>
                </Pressable>
              </View>
            )}
            {logged && <Text style={styles.success} testID="rec-detail-logged">Logged. It will show on your Today tab.</Text>}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.background, paddingTop: spacing.xl },
  top: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: spacing.md },
  body: { padding: spacing.md, paddingBottom: spacing.xl * 2 },
  kind: { ...typography.caption, color: colors.textSecondary },
  title: { ...typography.title, color: colors.textPrimary, marginTop: spacing.xs },
  section: { ...typography.label, color: colors.textPrimary, marginTop: spacing.lg, marginBottom: spacing.xs },
  muted: { ...typography.body, color: colors.textSecondary, marginTop: 2 },
  caption: { ...typography.caption, color: colors.textTertiary, marginTop: spacing.xs },
  link: { ...typography.label, color: colors.textPrimary },
  portion: { marginTop: spacing.sm },
  portionName: { ...typography.caption, color: colors.textSecondary },
  stepper: { flexDirection: "row", alignItems: "center", gap: spacing.md, marginTop: spacing.xs },
  stepBtn: {
    width: 40, height: 40, borderRadius: radius.pill, backgroundColor: colors.pillBackground,
    alignItems: "center", justifyContent: "center",
  },
  stepText: { ...typography.title, color: colors.textPrimary },
  optionRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm, paddingVertical: spacing.xs },
  checkbox: { ...typography.title, color: colors.textPrimary },
  portionText: { ...typography.body, color: colors.textPrimary, flexShrink: 1 },
  totals: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: spacing.md, marginTop: spacing.md },
  kcal: { ...typography.title, color: colors.textPrimary },
  macro: { ...typography.label },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  badge: {
    ...typography.caption, color: colors.textSecondary, backgroundColor: colors.pillBackground,
    borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 2, overflow: "hidden",
  },
  caution: { color: colors.protein },
  warning: { ...typography.caption, color: colors.protein, marginTop: spacing.xs },
  errorBox: { padding: spacing.md, gap: spacing.sm },
  error: { ...typography.body, color: colors.danger },
  success: { ...typography.label, color: colors.success, marginTop: spacing.md },
  buttons: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm, marginTop: spacing.lg },
  primary: { backgroundColor: colors.textPrimary, borderRadius: radius.pill, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  primaryText: { ...typography.label, color: colors.background },
  secondary: { borderRadius: radius.pill, borderWidth: 1, borderColor: colors.cardBorder, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  secondaryText: { ...typography.label, color: colors.textPrimary },
  disabled: { opacity: 0.5 },
});
