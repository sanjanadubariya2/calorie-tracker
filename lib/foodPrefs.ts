import AsyncStorage from "@react-native-async-storage/async-storage";
import type { FoodSearchResult } from "./types";

// Recent search terms and starred foods. Both are device-local: they're
// convenience state rather than user data worth syncing, so they stay out of
// Supabase and work identically in mock mode.

const RECENT_SEARCHES_KEY = "calorie-tracker-recent-searches-v1";
const FAVOURITES_KEY = "calorie-tracker-favourite-foods-v1";

const MAX_RECENT_SEARCHES = 10;
const MAX_FAVOURITES = 50;

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/* ---------------------------------- recent searches --------------------------------- */

export async function getRecentSearches(): Promise<string[]> {
  return readJson<string[]>(RECENT_SEARCHES_KEY, []);
}

export async function addRecentSearch(term: string): Promise<string[]> {
  const trimmed = term.trim();
  if (trimmed.length < 2) return getRecentSearches();

  const existing = await getRecentSearches();
  // Case-insensitive de-dupe, most recent first.
  const deduped = existing.filter((t) => t.toLowerCase() !== trimmed.toLowerCase());
  const next = [trimmed, ...deduped].slice(0, MAX_RECENT_SEARCHES);
  await AsyncStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
  return next;
}

export async function removeRecentSearch(term: string): Promise<string[]> {
  const existing = await getRecentSearches();
  const next = existing.filter((t) => t !== term);
  await AsyncStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
  return next;
}

export async function clearRecentSearches(): Promise<void> {
  await AsyncStorage.removeItem(RECENT_SEARCHES_KEY);
}

/* ------------------------------------ favourites ------------------------------------ */

export async function getFavourites(): Promise<FoodSearchResult[]> {
  return readJson<FoodSearchResult[]>(FAVOURITES_KEY, []);
}

export async function isFavourite(id: string): Promise<boolean> {
  const favourites = await getFavourites();
  return favourites.some((f) => f.id === id);
}

/** Adds or removes the food, returning whether it is a favourite afterwards. */
export async function toggleFavourite(food: FoodSearchResult): Promise<boolean> {
  const favourites = await getFavourites();
  const without = favourites.filter((f) => f.id !== food.id);
  const wasFavourite = without.length !== favourites.length;

  const next = wasFavourite ? without : [food, ...without].slice(0, MAX_FAVOURITES);
  await AsyncStorage.setItem(FAVOURITES_KEY, JSON.stringify(next));
  return !wasFavourite;
}

export async function removeFavourite(id: string): Promise<FoodSearchResult[]> {
  const favourites = await getFavourites();
  const next = favourites.filter((f) => f.id !== id);
  await AsyncStorage.setItem(FAVOURITES_KEY, JSON.stringify(next));
  return next;
}
