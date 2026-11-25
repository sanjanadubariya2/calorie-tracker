import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";
import { debounce, searchFoods } from "@/lib/openFoodFacts";
import {
  addRecentSearch,
  clearRecentSearches,
  getFavourites,
  getRecentSearches,
  removeFavourite,
  removeRecentSearch,
} from "@/lib/foodPrefs";
import type { LoggedFoodSuggestion } from "@/lib/foodSuggestions";
import type { FoodSearchResult } from "@/lib/types";
import { PortionCustomizer } from "./PortionCustomizer";
import { QuickPickPanel, type QuickPickTab } from "./QuickPickPanel";

interface Props {
  onFoodConfirmed: (food: FoodSearchResult, result: {
    servingGrams: number;
    calories: number;
    carbsG: number;
    fatG: number;
    proteinG: number;
  }) => void;
  /** Re-logs a previously logged food verbatim. */
  onSuggestionConfirmed: (suggestion: LoggedFoodSuggestion) => void;
  recent: LoggedFoodSuggestion[];
  frequent: LoggedFoodSuggestion[];
}

export function FoodSearchTab({
  onFoodConfirmed,
  onSuggestionConfirmed,
  recent,
  frequent,
}: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FoodSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<FoodSearchResult | null>(null);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [favourites, setFavourites] = useState<FoodSearchResult[]>([]);
  const [quickTab, setQuickTab] = useState<QuickPickTab>("recent");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    getRecentSearches().then(setRecentSearches);
    getFavourites().then(setFavourites);
  }, []);

  const runSearch = useRef(
    debounce(async (text: string) => {
      if (text.trim().length < 2) {
        setResults([]);
        setLoading(false);
        return;
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        setError(null);
        const data = await searchFoods(text, controller.signal);
        setResults(data);
        // Only remember terms that actually found something, so typos don't
        // clutter the chip list.
        if (data.length > 0) setRecentSearches(await addRecentSearch(text));
      } catch (e) {
        const err = e as Error;
        if (err.name !== "AbortError") {
          // Distinguish "you're offline" from "Open Food Facts is down", so a
          // service outage doesn't send people hunting for a network problem.
          const isNetworkFailure = err.name === "TypeError";
          setError(
            isNetworkFailure
              ? "Couldn't reach the food database. Check your connection and try again."
              : "The food database isn't responding right now. Try again shortly, or use Quick Add."
          );
        }
      } finally {
        setLoading(false);
      }
    }, 450)
  ).current;

  const handleChangeText = useCallback(
    (text: string) => {
      setQuery(text);
      setSelected(null);
      setLoading(text.trim().length >= 2);
      runSearch(text);
    },
    [runSearch]
  );

  if (selected) {
    return (
      <View style={styles.wrap}>
        <PortionCustomizer
          food={selected}
          onConfirm={(result) => onFoodConfirmed(selected, result)}
          onCancel={() => setSelected(null)}
        />
      </View>
    );
  }

  const showQuickPicks = query.trim().length < 2 && !loading;

  return (
    <View style={styles.wrap}>
      <TextInput
        style={styles.input}
        value={query}
        onChangeText={handleChangeText}
        placeholder="Search for a food, e.g. banana chips"
        placeholderTextColor={colors.textTertiary}
      />

      {loading && (
        <View style={styles.centerRow}>
          <ActivityIndicator color={colors.link} />
        </View>
      )}

      {error && <Text style={styles.errorText}>{error}</Text>}

      {!loading && !error && query.trim().length >= 2 && results.length === 0 && (
        <Text style={styles.emptyText}>No matches. Try a different search term, or use Quick Add.</Text>
      )}

      {showQuickPicks ? (
        <QuickPickPanel
          activeTab={quickTab}
          onTabChange={setQuickTab}
          recent={recent}
          frequent={frequent}
          favourites={favourites}
          recentSearches={recentSearches}
          onSearchTermPress={handleChangeText}
          onRemoveSearchTerm={async (term) => setRecentSearches(await removeRecentSearch(term))}
          onClearSearches={async () => {
            await clearRecentSearches();
            setRecentSearches([]);
          }}
          onSuggestionPress={onSuggestionConfirmed}
          onFavouritePress={setSelected}
          onRemoveFavourite={async (id) => setFavourites(await removeFavourite(id))}
        />
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <Pressable style={styles.resultRow} onPress={() => setSelected(item)}>
              <View style={styles.resultTextCol}>
                <Text style={styles.resultName} numberOfLines={2}>
                  {item.name}
                </Text>
                {item.brand && (
                  <Text style={styles.resultBrand} numberOfLines={1}>
                    {item.brand}
                  </Text>
                )}
              </View>
              <Text style={styles.resultKcal}>{Math.round(item.caloriesPer100g)} kcal/100g</Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
  },
  backRow: {
    paddingBottom: spacing.md,
  },
  backText: {
    ...typography.label,
    color: colors.textSecondary,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.md,
    padding: spacing.md,
    color: colors.textPrimary,
    ...typography.body,
  },
  centerRow: {
    marginTop: spacing.lg,
    alignItems: "center",
  },
  errorText: {
    ...typography.caption,
    color: colors.danger,
    marginTop: spacing.md,
  },
  emptyText: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.md,
  },
  resultRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    gap: spacing.md,
  },
  resultTextCol: {
    flex: 1,
  },
  resultName: {
    ...typography.body,
    color: colors.textPrimary,
  },
  resultBrand: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
  resultKcal: {
    ...typography.caption,
    color: colors.textSecondary,
  },
});
