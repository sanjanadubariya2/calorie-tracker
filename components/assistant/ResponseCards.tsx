import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";
import type {
  AssistantResponse,
  DailyStatusCard,
  FoodResult,
  HistoryCard,
  RecommendationsCard,
} from "@/lib/assistant";

const fmt = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined ? "–" : digits ? v.toFixed(digits).replace(/\.0$/, "") : String(Math.round(v));

const SOURCE_TEXT: Record<string, string> = {
  food_log: "your food log",
  catalogue: "the food database",
  general_knowledge: "general nutrition information",
};

export function SourcesLine({ sources }: { sources: string[] }) {
  if (!sources.length) return null;
  return (
    <Text style={styles.sources} testID="response-sources">
      Based on {sources.map((s) => SOURCE_TEXT[s] ?? s).join(" and ")}
    </Text>
  );
}

function Progress({ label, consumed, target, color, unit }: {
  label: string; consumed: number; target: number | null; color: string; unit: string;
}) {
  const pct = target ? Math.min(100, Math.max(0, (consumed / target) * 100)) : 0;
  const over = target !== null && consumed > target;
  return (
    <View style={styles.progressRow}>
      <View style={styles.progressHeader}>
        <Text style={styles.progressLabel}>{label}</Text>
        <Text style={[styles.progressValue, over && { color: colors.danger }]}>
          {fmt(consumed)}{target !== null ? ` / ${fmt(target)}` : ""} {unit}
        </Text>
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${pct}%`, backgroundColor: over ? colors.danger : color }]} />
      </View>
    </View>
  );
}

export function DailyStatusView({ status }: { status: DailyStatusCard }) {
  const k = status.calories_kcal;
  return (
    <View testID="card-daily-status">
      <View style={styles.kcalRow}>
        <Text style={styles.kcalBig}>{fmt(k.remaining ?? k.consumed)}</Text>
        <Text style={styles.kcalLabel}>{k.remaining !== null ? "kcal left today" : "kcal eaten"}</Text>
      </View>
      <Progress label="Calories" consumed={k.consumed} target={k.target} color={colors.progressFill} unit="kcal" />
      <Progress label="Protein" consumed={status.protein_g.consumed} target={status.protein_g.target} color={colors.protein} unit="g" />
      <Progress label="Carbs" consumed={status.carbs_g.consumed} target={status.carbs_g.target} color={colors.carb} unit="g" />
      <Progress label="Fat" consumed={status.fat_g.consumed} target={status.fat_g.target} color={colors.fat} unit="g" />
      {!status.has_targets && <Text style={styles.note}>Set your targets in Profile to see what's left.</Text>}
    </View>
  );
}

export function HistoryView({ history }: { history: HistoryCard }) {
  const max = Math.max(1, ...history.periods.map((p) => p.avg_kcal_per_logged_day ?? 0));
  const target = history.overall.current_target_kcal;
  return (
    <View testID="card-history">
      <Text style={styles.cardTitle}>
        {history.group_by === "week" ? "Weekly" : "Daily"} average · {history.overall.days_logged}/{history.overall.days_in_range} days logged
      </Text>
      {history.periods.slice(-8).map((p) => (
        <View key={p.start} style={styles.barRow}>
          <Text style={styles.barLabel}>{p.start.slice(5)}</Text>
          <View style={styles.barTrack}>
            <View style={[styles.barFill, { width: `${((p.avg_kcal_per_logged_day ?? 0) / max) * 100}%` }]} />
          </View>
          <Text style={styles.barValue}>{p.days_logged ? fmt(p.avg_kcal_per_logged_day) : "–"}</Text>
        </View>
      ))}
      <Text style={styles.note}>
        Average {fmt(history.overall.avg_kcal_per_logged_day)} kcal · P {fmt(history.overall.avg_protein_g)} g · C{" "}
        {fmt(history.overall.avg_carbs_g)} g · F {fmt(history.overall.avg_fat_g)} g
        {target ? ` · near target on ${history.overall.logged_days_within_10pct_of_target ?? 0} days` : ""}
      </Text>
    </View>
  );
}

function FoodRow({ name, detail, kcal, protein, sub }: { name: string; detail: string; kcal: string; protein: string; sub?: string }) {
  return (
    <View style={styles.foodRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.foodName}>{name}</Text>
        <Text style={styles.foodDetail}>{detail}</Text>
        {sub ? <Text style={styles.foodSub}>{sub}</Text> : null}
      </View>
      <View style={styles.foodNumbers}>
        <Text style={styles.foodKcal}>{kcal}</Text>
        <Text style={[styles.foodDetail, { color: colors.protein }]}>{protein}</Text>
      </View>
    </View>
  );
}

export function FoodSearchView({ results }: { results: FoodResult[] }) {
  if (!results.length) return <Text style={styles.note}>No matching foods in the database.</Text>;
  return (
    <View testID="card-food-search">
      {results.slice(0, 5).map((f) => (
        <FoodRow
          key={f.food_id}
          name={f.name + (f.brand ? ` (${f.brand})` : "")}
          detail={`per 100 ${f.per_100.basis} · C ${fmt(f.per_100.carbs_g, 1)} g · F ${fmt(f.per_100.fat_g, 1)} g`}
          sub={f.default_serving ? `Serving: ${f.default_serving.label} (${fmt(f.default_serving.grams)} g)` : undefined}
          kcal={`${fmt(f.per_100.kcal)} kcal`}
          protein={`P ${fmt(f.per_100.protein_g, 1)} g`}
        />
      ))}
    </View>
  );
}

export function RecommendationsView({ card, onAsk }: { card: RecommendationsCard; onAsk?: (text: string) => void }) {
  return (
    <View testID="card-recommendations">
      <Text style={styles.cardTitle}>
        For {card.meal_type.replace("_", " ")} · about {fmt(card.meal_target.calories_kcal)} kcal
        {card.meal_target.protein_g ? `, ${fmt(card.meal_target.protein_g)} g protein` : ""}
      </Text>
      {card.recommendations.map((r) => (
        <Pressable key={r.food_id} onPress={onAsk ? () => onAsk(`Log ${r.serving_label} of ${r.name}`) : undefined}
          disabled={!onAsk} testID={`recommendation-${r.food_id}`}>
          <FoodRow
            name={r.name}
            detail={`${r.serving_label} (${fmt(r.serving_g)} g) · C ${fmt(r.nutrition.carbs_g, 1)} g · F ${fmt(r.nutrition.fat_g, 1)} g`}
            sub={r.reasons.find((x) => x.includes("logged")) ? "You've had this before" : undefined}
            kcal={`${fmt(r.nutrition.calories_kcal)} kcal`}
            protein={`P ${fmt(r.nutrition.protein_g, 1)} g`}
          />
        </Pressable>
      ))}
      {[...card.notes, ...card.cautions].map((n) => <Text key={n} style={styles.note}>{n}</Text>)}
      {onAsk && card.recommendations.length > 0 && <Text style={styles.hint}>Tap a food to log it.</Text>}
    </View>
  );
}

export function OptionChips({ options, onPick, disabled }: { options: string[]; onPick: (o: string) => void; disabled?: boolean }) {
  return (
    <View style={styles.chips}>
      {options.map((o) => (
        <Pressable key={o} style={styles.chip} onPress={() => onPick(o)} disabled={disabled} testID={`option-${o}`}>
          <Text style={styles.chipText}>{o}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** Everything except proposals (ProposalCard) and plain text. */
export function ResponseCard({ response, onAsk, disabled }: {
  response: AssistantResponse; onAsk: (text: string) => void; disabled?: boolean;
}) {
  switch (response.type) {
    case "nutrition_summary":
      return (
        <View style={styles.card}>
          {response.daily_status && <DailyStatusView status={response.daily_status} />}
          {response.history && <HistoryView history={response.history} />}
          {!response.daily_status && !response.history && response.targets?.daily_targets && (
            <Text style={styles.cardTitle} testID="card-targets">
              Daily targets: {response.targets.daily_targets.calories_kcal} kcal · P {response.targets.daily_targets.protein_g} g ·
              C {response.targets.daily_targets.carbs_g} g · F {response.targets.daily_targets.fat_g} g
            </Text>
          )}
        </View>
      );
    case "food_search_results":
      return <View style={styles.card}><FoodSearchView results={response.search.results} /></View>;
    case "meal_recommendation":
      return <View style={styles.card}><RecommendationsView card={response.recommendations} onAsk={disabled ? undefined : onAsk} /></View>;
    case "clarification": {
      const fromIssues = response.food_issues.flatMap((i) => i.options.map((o) => o.name));
      const options = response.options.length ? response.options : fromIssues;
      return options.length ? <OptionChips options={options} onPick={onAsk} disabled={disabled} /> : null;
    }
    default:
      return null;
  }
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.background,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: spacing.md,
    marginTop: spacing.sm,
  },
  cardTitle: { ...typography.label, color: colors.textPrimary, marginBottom: spacing.sm },
  sources: { ...typography.caption, color: colors.textTertiary, marginTop: spacing.sm },
  note: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.sm },
  hint: { ...typography.caption, color: colors.textTertiary, marginTop: spacing.sm },
  kcalRow: { flexDirection: "row", alignItems: "baseline", marginBottom: spacing.sm },
  kcalBig: { ...typography.title, fontSize: 28, color: colors.textPrimary, marginRight: spacing.sm },
  kcalLabel: { ...typography.caption, color: colors.textSecondary },
  progressRow: { marginTop: spacing.sm },
  progressHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  progressLabel: { ...typography.caption, color: colors.textSecondary },
  progressValue: { ...typography.caption, color: colors.textPrimary },
  track: { height: 6, backgroundColor: colors.progressTrack, borderRadius: radius.pill, overflow: "hidden" },
  fill: { height: 6, borderRadius: radius.pill },
  barRow: { flexDirection: "row", alignItems: "center", marginTop: 6 },
  barLabel: { ...typography.caption, color: colors.textSecondary, width: 44 },
  barTrack: { flex: 1, height: 8, backgroundColor: colors.progressTrack, borderRadius: radius.pill, overflow: "hidden" },
  barFill: { height: 8, backgroundColor: colors.chartPast, borderRadius: radius.pill },
  barValue: { ...typography.caption, color: colors.textPrimary, width: 48, textAlign: "right" },
  foodRow: { flexDirection: "row", paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.divider },
  foodName: { ...typography.label, color: colors.textPrimary },
  foodDetail: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  foodSub: { ...typography.caption, color: colors.textTertiary, marginTop: 2 },
  foodNumbers: { alignItems: "flex-end", marginLeft: spacing.sm },
  foodKcal: { ...typography.label, color: colors.textPrimary },
  chips: { flexDirection: "row", flexWrap: "wrap", marginTop: spacing.sm, gap: spacing.sm },
  chip: { backgroundColor: colors.pillBackground, borderRadius: radius.pill, paddingVertical: 8, paddingHorizontal: 14 },
  chipText: { ...typography.caption, color: colors.textPrimary },
});
