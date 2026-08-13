import { Platform } from "react-native";
import type { FoodSearchResult } from "./types";

// Open Food Facts retired the legacy /cgi/search.pl text search on the
// production host — it now answers 503 with an HTML "temporarily
// unavailable" page. Two things replace it, and which one we can use
// depends on the platform:
//
//   search.openfoodfacts.org (Search-a-licious) — current production data,
//     but sends no Access-Control-Allow-Origin, so browsers block it.
//   world.openfoodfacts.net (OFF's public mirror) — still serves the legacy
//     search.pl format AND sends `Access-Control-Allow-Origin: *`, so it is
//     the only option that works on web.
//
// Native has no CORS enforcement, so it prefers production data and falls
// back to the mirror. Web has to start at the mirror.
const SEARCH_URL = "https://search.openfoodfacts.org/search";
const MIRROR_SEARCH_URL = "https://world.openfoodfacts.net/cgi/search.pl";
const LEGACY_SEARCH_URL = "https://world.openfoodfacts.org/cgi/search.pl";

const FIELDS = "code,product_name,brands,image_front_small_url,nutriments";
const PAGE_SIZE = 20;

// Rounds to one decimal place, dropping the value entirely when OFF has no
// entry for it so the nutrition label can hide that row.
function optionalNutrient(value: number | undefined): number | undefined {
  return value == null ? undefined : Math.round(value * 10) / 10;
}

// OFF asks API clients to identify themselves. Browsers forbid setting
// User-Agent and any custom header would force a CORS preflight, so this
// is native-only.
const USER_AGENT = "CalorieTracker/1.0 (Expo app; https://github.com/)";

function requestInit(signal?: AbortSignal): RequestInit {
  return Platform.OS === "web" ? { signal } : { signal, headers: { "User-Agent": USER_AGENT } };
}

interface OFFNutriments {
  "energy-kcal_100g"?: number;
  carbohydrates_100g?: number;
  fat_100g?: number;
  proteins_100g?: number;
  "saturated-fat_100g"?: number;
  sugars_100g?: number;
  fiber_100g?: number;
  sodium_100g?: number;
  salt_100g?: number;
}

// Shared shape across both endpoints. `brands` is a comma-joined string on
// the legacy API but an array on Search-a-licious.
interface OFFProduct {
  code: string;
  product_name?: string;
  brands?: string | string[] | null;
  image_front_small_url?: string | null;
  nutriments?: OFFNutriments;
}

function normalizeBrand(brands: OFFProduct["brands"]): string | undefined {
  if (!brands) return undefined;
  const joined = Array.isArray(brands) ? brands.join(", ") : brands;
  return joined.trim() || undefined;
}

function toSearchResults(products: OFFProduct[]): FoodSearchResult[] {
  return products
    .filter((p) => p.product_name && p.nutriments?.["energy-kcal_100g"] != null)
    .map((p) => ({
      id: p.code,
      name: p.product_name as string,
      brand: normalizeBrand(p.brands),
      caloriesPer100g: p.nutriments?.["energy-kcal_100g"] ?? 0,
      carbsPer100g: p.nutriments?.carbohydrates_100g ?? 0,
      fatPer100g: p.nutriments?.fat_100g ?? 0,
      proteinPer100g: p.nutriments?.proteins_100g ?? 0,
      imageUrl: p.image_front_small_url ?? undefined,
      saturatedFatPer100g: optionalNutrient(p.nutriments?.["saturated-fat_100g"]),
      sugarsPer100g: optionalNutrient(p.nutriments?.sugars_100g),
      fiberPer100g: optionalNutrient(p.nutriments?.fiber_100g),
      sodiumPer100g: optionalNutrient(p.nutriments?.sodium_100g),
      saltPer100g: optionalNutrient(p.nutriments?.salt_100g),
    }));
}

// When OFF is down it serves an HTML error page, sometimes with a 200. Parsing
// that as JSON throws an unhelpful syntax error, so check the type first.
async function readJson(res: Response, source: string): Promise<unknown> {
  if (!res.ok) throw new Error(`${source} returned ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    throw new Error(`${source} returned ${contentType || "an unknown content type"}, not JSON`);
  }
  return res.json();
}

async function searchViaSearchalicious(query: string, signal?: AbortSignal) {
  const url =
    `${SEARCH_URL}?q=${encodeURIComponent(query)}` +
    `&page_size=${PAGE_SIZE}&fields=${FIELDS}`;
  const res = await fetch(url, requestInit(signal));
  const data = (await readJson(res, "Open Food Facts search")) as { hits?: OFFProduct[] };
  return toSearchResults(data.hits ?? []);
}

// Both legacy-format hosts (mirror and production) share this shape.
function searchViaLegacyHost(baseUrl: string, label: string) {
  return async (query: string, signal?: AbortSignal) => {
    const url =
      `${baseUrl}?search_terms=${encodeURIComponent(query)}` +
      `&json=true&page_size=${PAGE_SIZE}&fields=${FIELDS}`;
    const res = await fetch(url, requestInit(signal));
    const data = (await readJson(res, label)) as { products?: OFFProduct[] };
    return toSearchResults(data.products ?? []);
  };
}

const searchViaMirror = searchViaLegacyHost(MIRROR_SEARCH_URL, "Open Food Facts mirror search");
const searchViaLegacy = searchViaLegacyHost(LEGACY_SEARCH_URL, "Open Food Facts legacy search");

// Ordered by what can actually succeed on each platform — see the note at
// the top of this file.
const SEARCH_STRATEGIES =
  Platform.OS === "web"
    ? [searchViaMirror, searchViaLegacy]
    : [searchViaSearchalicious, searchViaMirror, searchViaLegacy];

export async function searchFoods(query: string, signal?: AbortSignal): Promise<FoodSearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  let lastError: unknown;
  for (const strategy of SEARCH_STRATEGIES) {
    try {
      return await strategy(trimmed, signal);
    } catch (err) {
      // A cancelled request is not a failure — don't retry it against the
      // remaining sources.
      if ((err as Error).name === "AbortError") throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Open Food Facts search failed");
}

// Simple debounce helper used by the search tab so we don't hit the API
// on every keystroke.
export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  delayMs: number
): (...args: Args) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}
