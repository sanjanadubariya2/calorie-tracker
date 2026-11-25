import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";
import type { LoggedFoodSuggestion } from "@/lib/foodSuggestions";
import type { FoodSearchResult } from "@/lib/types";

export type QuickPickTab = "recent" | "frequent" | "favourites";

const TABS: { key: QuickPickTab; label: string }[] = [
  { key: "recent", label: "Recently added" },
  { key: "frequent", label: "Frequently added" },
  { key: "favourites", label: "Favourites" },
];

interface Props {
  activeTab: QuickPickTab;
  onTabChange: (tab: QuickPickTab) => void;

  recent: LoggedFoodSuggestion[];
  frequent: LoggedFoodSuggestion[];
  favourites: FoodSearchResult[];

  recentSearches: string[];
  onSearchTermPress: (term: string) => void;
  onRemoveSearchTerm: (term: string) => void;
  onClearSearches: () => void;

  /** Re-logs a previously logged food as-is, no portion step. */
  onSuggestionPress: (suggestion: LoggedFoodSuggestion) => void;
  /** Opens a starred food in the portion sheet, since portion may differ. */
  onFavouritePress: (food: FoodSearchResult) => void;
  onRemoveFavourite: (id: string) => void;
}

export function QuickPickPanel({
  activeTab,
  onTabChange,
  recent,
  frequent,
  favourites,
  recentSearches,
  onSearchTermPress,
  onRemoveSearchTerm,
  onClearSearches,
  onSuggestionPress,
  onFavouritePress,
  onRemoveFavourite,
}: Props) {
  const suggestions = activeTab === "recent" ? recent : frequent;

  return (
    <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      {recentSearches.length > 0 && (
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>Recent searches</Text>
            <Pressable onPress={onClearSearches} hitSlop={8}>
              <Text style={styles.clearAll}>Clear all</Text>
            </Pressable>
          </View>

          <View style={styles.chipWrap}>
            {recentSearches.map((term) => (
              <View key={term} style={styles.chip}>
                <Pressable onPress={() => onSearchTermPress(term)} hitSlop={6}>
                  <Text style={styles.chipText}>{term}</Text>
                </Pressable>
                <Pressable
                  onPress={() => onRemoveSearchTerm(term)}
                  hitSlop={10}
                  accessibilityLabel={`Remove ${term} from recent searches`}
                >
                  <Text style={styles.chipRemove}>✕</Text>
                </Pressable>
              </View>
            ))}
          </View>
        </View>
      )}

      <View style={styles.tabRow}>
        {TABS.map((tab) => {
          const active = tab.key === activeTab;
          return (
            <Pressable
              key={tab.key}
              style={[styles.tabChip, active && styles.tabChipActive]}
              onPress={() => onTabChange(tab.key)}
            >
              <Text style={[styles.tabText, active && styles.tabTextActive]}>{tab.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {activeTab === "favourites" ? (
        favourites.length === 0 ? (
          <EmptyState
            title="No favourite foods"
            body="Tap the ☆ on any food while setting its portion to keep it here."
          />
        ) : (
          favourites.map((food) => (
            <View key={food.id} style={styles.row}>
              <Pressable style={styles.rowMain} onPress={() => onFavouritePress(food)}>
                <Text style={styles.rowName} numberOfLines={2}>
                  {food.name}
                </Text>
                <Text style={styles.rowMeta}>
                  {Math.round(food.caloriesPer100g)} kcal / 100 g
                  {food.brand ? ` · ${food.brand}` : ""}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => onRemoveFavourite(food.id)}
                hitSlop={10}
                accessibilityLabel={`Remove ${food.name} from favourites`}
              >
                <Text style={styles.starFilled}>★</Text>
              </Pressable>
            </View>
          ))
        )
      ) : suggestions.length === 0 ? (
        <EmptyState
          title={activeTab === "recent" ? "Nothing logged yet" : "No repeat foods yet"}
          body={
            activeTab === "recent"
              ? "Foods you log will show up here for one-tap re-logging."
              : "Once you log the same food more than once, it'll appear here."
          }
        />
      ) : (
        suggestions.map((s) => (
          <Pressable key={s.key} style={styles.row} onPress={() => onSuggestionPress(s)}>
            <View style={styles.rowMain}>
              <Text style={styles.rowName} numberOfLines={2}>
                {s.foodName}
              </Text>
              <Text style={styles.rowMeta}>
                {Math.round(s.calories)} kcal
                {s.servingG ? ` · ${s.servingG} g` : ""}
                {s.timesLogged > 1 ? ` · logged ${s.timesLogged}×` : ""}
              </Text>
            </View>
            <Text style={styles.addGlyph}>+</Text>
          </Pressable>
        ))
      )}

      <View style={{ height: spacing.xl }} />
    </ScrollView>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.emptyWrap}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cardTitle: {
    ...typography.label,
    color: colors.textSecondary,
  },
  clearAll: {
    ...typography.label,
    color: colors.link,
  },
  chipWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.pillBackground,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  chipText: {
    ...typography.label,
    color: colors.textPrimary,
  },
  chipRemove: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  tabRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  tabChip: {
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  tabChipActive: {
    backgroundColor: colors.pillBackground,
    borderColor: colors.textSecondary,
  },
  tabText: {
    ...typography.label,
    color: colors.textSecondary,
  },
  tabTextActive: {
    color: colors.textPrimary,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  rowMain: {
    flex: 1,
  },
  rowName: {
    ...typography.body,
    color: colors.textPrimary,
  },
  rowMeta: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
  addGlyph: {
    fontSize: 24,
    color: colors.textPrimary,
    fontWeight: "300",
  },
  starFilled: {
    fontSize: 22,
    color: colors.warning,
  },
  emptyWrap: {
    alignItems: "center",
    paddingVertical: spacing.xl,
  },
  emptyTitle: {
    ...typography.title,
    color: colors.textSecondary,
  },
  emptyBody: {
    ...typography.caption,
    color: colors.textTertiary,
    textAlign: "center",
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
});
