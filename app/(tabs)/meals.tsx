// Personalized meal recommendations (Phase 3). Ranking and nutrition come from
// the backend's deterministic engine; this screen only presents them.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { colors, radius, spacing, typography } from "@/constants/theme";
import { useAssistant } from "@/lib/assistant-context";
import {
  listRecommendations,
  recommendationsAvailable,
  sendFeedback,
  toRecommendationError,
  type RecMealType,
  type Recommendation,
  type RecommendationList,
} from "@/lib/recommendations";
import {
  CALORIE_LIMITS,
  REC_MEALS,
  assistantPrompt,
  budgetText,
  defaultMealType,
  emptyTitle,
} from "@/lib/recommendationsView";
import { RecommendationCard, RecommendationSkeleton } from "@/components/recommendations/RecommendationCard";
import { RecommendationDetailSheet } from "@/components/recommendations/RecommendationDetail";

const COUNT = 5;

export default function MealsScreen() {
  const assistant = useAssistant();
  const [meal, setMeal] = useState<RecMealType>(() => defaultMealType());
  const [highProtein, setHighProtein] = useState(false);
  const [maxKcal, setMaxKcal] = useState<number | undefined>(undefined);
  const [data, setData] = useState<RecommendationList | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(async (opts: { exclude?: string[]; refresh?: boolean } = {}) => {
    const n = ++request.current;                   // a newer request wins
    if (opts.refresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const list = await listRecommendations({
        meal_type: meal, count: COUNT, protein: highProtein ? "high" : "normal", max_kcal: maxKcal,
        exclude: opts.exclude,
      });
      if (n !== request.current) return;
      setData(list);
    } catch (e) {
      if (n !== request.current) return;
      const err = toRecommendationError(e);
      setError({ message: err.message, retryable: err.retryable });
    } finally {
      if (n === request.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [meal, highProtein, maxKcal]);

  useEffect(() => {
    if (recommendationsAvailable()) void load();
  }, [load]);

  if (!recommendationsAvailable()) {
    return (
      <View style={[styles.wrap, styles.center]} testID="meals-unavailable">
        <Text style={styles.heading}>Meals</Text>
        <Text style={styles.muted}>Meal recommendations aren't available in this version of the app.</Text>
      </View>
    );
  }

  const mealLabel = REC_MEALS.find((m) => m.key === meal)?.label.toLowerCase() ?? meal;

  async function act(item: Recommendation, run: () => Promise<void>) {
    if (!item.id || busy.has(item.key)) return;
    setBusy((b) => new Set(b).add(item.key));
    try {
      await run();
    } catch (e) {
      setNotice(toRecommendationError(e).message);
    } finally {
      setBusy((b) => { const next = new Set(b); next.delete(item.key); return next; });
    }
  }

  const toggleSave = (item: Recommendation) => act(item, async () => {
    const isSaved = saved.has(item.key);
    await sendFeedback(item.id as string, isSaved ? "unsaved" : "saved");
    setSaved((s) => { const next = new Set(s); if (isSaved) next.delete(item.key); else next.add(item.key); return next; });
    setNotice(isSaved ? "Removed from saved." : "Saved.");
  });

  const notInterested = (item: Recommendation) => act(item, async () => {
    await sendFeedback(item.id as string, "not_interested");
    setData((d) => (d ? { ...d, items: d.items.filter((i) => i.key !== item.key) } : d));
    setNotice(`You'll see ${item.name} less often.`);
  });

  function ask(text: string) {
    assistant.compose(text);
    router.push("/(tabs)/assistant");
  }

  const items = data?.items ?? [];
  return (
    <View style={styles.wrap}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl tintColor={colors.textPrimary} refreshing={refreshing}
          onRefresh={() => load({ refresh: true })} />}
        testID="meals-scroll"
      >
        <Text style={styles.heading}>Meals</Text>
        <View style={styles.tabs} accessibilityRole="tablist">
          {REC_MEALS.map((m) => (
            <Pressable key={m.key} onPress={() => setMeal(m.key)} style={[styles.tab, meal === m.key && styles.tabActive]}
              accessibilityRole="tab" accessibilityState={{ selected: meal === m.key }} testID={`meals-tab-${m.key}`}>
              <Text style={[styles.tabText, meal === m.key && styles.tabTextActive]}>{m.label}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.filters}>
          <Pressable onPress={() => setHighProtein((v) => !v)} style={[styles.chip, highProtein && styles.chipActive]}
            accessibilityRole="switch" accessibilityState={{ checked: highProtein }} testID="meals-high-protein">
            <Text style={[styles.chipText, highProtein && styles.chipTextActive]}>High protein</Text>
          </Pressable>
          {CALORIE_LIMITS.map((c) => (
            <Pressable key={c.label} onPress={() => setMaxKcal(c.value)}
              style={[styles.chip, maxKcal === c.value && styles.chipActive]}
              accessibilityRole="radio" accessibilityState={{ selected: maxKcal === c.value }}
              testID={`meals-limit-${c.value ?? "left"}`}>
              <Text style={[styles.chipText, maxKcal === c.value && styles.chipTextActive]}>{c.label}</Text>
            </Pressable>
          ))}
        </View>

        {data && !loading && <Text style={styles.budget} testID="meals-budget">{budgetText(data)}</Text>}
        {notice && (
          <Pressable onPress={() => setNotice(null)} testID="meals-notice" accessibilityRole="button">
            <Text style={styles.notice}>{notice}</Text>
          </Pressable>
        )}

        {loading && [0, 1, 2].map((i) => <RecommendationSkeleton key={i} index={i} />)}

        {!loading && error && (
          <View style={styles.state} testID="meals-error">
            <Text style={styles.stateTitle}>Couldn't load suggestions</Text>
            <Text style={styles.muted}>{error.message}</Text>
            <Pressable style={styles.button} onPress={() => load()} accessibilityRole="button" testID="meals-retry">
              <Text style={styles.buttonText}>Try again</Text>
            </Pressable>
          </View>
        )}

        {!loading && !error && data && items.length === 0 && (
          <View style={styles.state} testID="meals-empty">
            <Text style={styles.stateTitle}>{emptyTitle(data.status)}</Text>
            {data.notes.map((n) => <Text key={n} style={styles.muted}>{n}</Text>)}
            <Pressable style={styles.button} onPress={() => load()} accessibilityRole="button" testID="meals-empty-refresh">
              <Text style={styles.buttonText}>Refresh</Text>
            </Pressable>
          </View>
        )}

        {!loading && !error && items.map((item) => (
          <RecommendationCard
            key={item.key}
            item={item}
            saved={saved.has(item.key)}
            busy={busy.has(item.key) || !item.id}
            onOpen={() => item.id && setOpenId(item.id)}
            onSave={() => toggleSave(item)}
            onNotInterested={() => notInterested(item)}
            onAsk={assistant.available ? () => ask(assistantPrompt(item, mealLabel)) : undefined}
          />
        ))}

        {!loading && !error && items.length > 0 && (
          <>
            {data?.notes.map((n) => <Text key={n} style={styles.note}>{n}</Text>)}
            <View style={styles.footer}>
              <Pressable style={styles.secondary} onPress={() => load({ exclude: items.map((i) => i.key) })}
                accessibilityRole="button" testID="meals-alternatives">
                <Text style={styles.secondaryText}>Show other options</Text>
              </Pressable>
              <Pressable style={styles.secondary} onPress={() => load()} accessibilityRole="button" testID="meals-refresh">
                <Text style={styles.secondaryText}>Refresh</Text>
              </Pressable>
            </View>
          </>
        )}
      </ScrollView>

      <RecommendationDetailSheet
        id={openId}
        onClose={() => setOpenId(null)}
        onSavedChange={(isSaved) => {
          const key = items.find((i) => i.id === openId)?.key;
          if (key) setSaved((s) => { const next = new Set(s); if (isSaved) next.add(key); else next.delete(key); return next; });
        }}
        onAsk={assistant.available ? (d) => { setOpenId(null); ask(assistantPrompt(d.item, mealLabel)); } : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.background },
  center: { alignItems: "center", justifyContent: "center", padding: spacing.lg },
  content: { padding: spacing.md, paddingTop: spacing.xl, paddingBottom: spacing.xl * 2, maxWidth: 720, width: "100%", alignSelf: "center" },
  heading: { ...typography.title, color: colors.textPrimary, marginBottom: spacing.md },
  tabs: { flexDirection: "row", backgroundColor: colors.pillBackground, borderRadius: radius.pill, padding: 4 },
  tab: { flex: 1, paddingVertical: spacing.sm, borderRadius: radius.pill, alignItems: "center" },
  tabActive: { backgroundColor: colors.textPrimary },
  tabText: { ...typography.label, color: colors.textSecondary },
  tabTextActive: { color: colors.background },
  filters: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.md },
  chip: { borderRadius: radius.pill, borderWidth: 1, borderColor: colors.cardBorder, paddingHorizontal: spacing.md, paddingVertical: 6 },
  chipActive: { backgroundColor: colors.textPrimary, borderColor: colors.textPrimary },
  chipText: { ...typography.caption, color: colors.textSecondary },
  chipTextActive: { color: colors.background },
  budget: { ...typography.label, color: colors.textSecondary, marginVertical: spacing.md },
  notice: { ...typography.caption, color: colors.textPrimary, backgroundColor: colors.card, borderRadius: radius.sm,
    padding: spacing.sm, marginBottom: spacing.md, overflow: "hidden" },
  muted: { ...typography.body, color: colors.textSecondary, textAlign: "center", marginTop: spacing.xs },
  note: { ...typography.caption, color: colors.textTertiary, marginBottom: spacing.xs },
  state: { alignItems: "center", padding: spacing.lg, gap: spacing.sm },
  stateTitle: { ...typography.label, color: colors.textPrimary },
  button: { marginTop: spacing.sm, backgroundColor: colors.textPrimary, borderRadius: radius.pill, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  buttonText: { ...typography.label, color: colors.background },
  footer: { flexDirection: "row", justifyContent: "center", gap: spacing.sm, marginTop: spacing.sm },
  secondary: { borderRadius: radius.pill, borderWidth: 1, borderColor: colors.cardBorder, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  secondaryText: { ...typography.label, color: colors.textPrimary },
});
