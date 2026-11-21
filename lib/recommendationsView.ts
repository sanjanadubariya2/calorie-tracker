// Pure presentation helpers for recommendation cards (no I/O, no nutrition maths).

import type { RecMealType, RecStatus, Recommendation, RecommendationList, RecPortion } from "./recommendations";

export const REC_MEALS: { key: RecMealType; label: string }[] = [
  { key: "breakfast", label: "Breakfast" },
  { key: "lunch", label: "Lunch" },
  { key: "dinner", label: "Dinner" },
  { key: "snack", label: "Snack" },
];

export const CALORIE_LIMITS: { label: string; value: number | undefined }[] = [
  { label: "Fits what's left", value: undefined },
  { label: "≤ 300 kcal", value: 300 },
  { label: "≤ 500 kcal", value: 500 },
  { label: "≤ 700 kcal", value: 700 },
];

/** The meal for the time of day (local clock). */
export function defaultMealType(now: Date = new Date()): RecMealType {
  const h = now.getHours();
  if (h < 11) return "breakfast";
  if (h < 16) return "lunch";
  if (h < 18) return "snack";
  return "dinner";
}

const trim = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));

/** "2 × 1 phulka" / "1.5 × 1 katori"; grams for foods when known. */
export function portionText(p: RecPortion): string {
  const label = p.serving_label.replace(/^1\s+/, "");
  const base = p.servings === 1 ? p.serving_label : `${trim(p.servings)} × ${label}`;
  return p.grams ? `${base} (${trim(p.grams)} g)` : base;
}

export function servingsText(item: Recommendation): string {
  return item.portions.map(portionText).join(" + ");
}

export const FIT_LABEL: Record<Recommendation["score"]["fit"], string> = {
  strong: "Strong fit",
  good: "Good fit",
  fair: "Fair fit",
};

export const KIND_LABEL: Record<Recommendation["kind"], string> = {
  recipe: "Recipe",
  combo: "Meal pairing",
  meal: "Meal",
  food: "Dish",
};

export interface QualityBadge {
  key: string;
  label: string;
  tone: "ok" | "caution";
}

/** Short data-quality indicators; the full warning text is in item.warnings. */
export function qualityBadges(item: Recommendation): QualityBadge[] {
  const out: QualityBadge[] = [];
  const d = item.data;
  if (d.verification === "expert_reviewed") out.push({ key: "verified", label: "Expert reviewed", tone: "ok" });
  else if (d.verification === "unverified") out.push({ key: "unverified", label: "Unverified values", tone: "caution" });
  else out.push({ key: "curated", label: "Curated data", tone: "ok" });
  if (item.kind === "meal" && d.approval_level !== "verified") {
    out.push({ key: "provisional", label: "Provisional meal", tone: "caution" });
  }
  if (d.approximate) out.push({ key: "approx", label: "Approximate", tone: "caution" });
  if (d.quality_flags.includes("cooking_oil_uncertain")) out.push({ key: "oil", label: "Oil uncertain", tone: "caution" });
  if (d.diet_status !== "reviewed") out.push({ key: "diet", label: "Diet not reviewed", tone: "caution" });
  if (d.allergens_detected.length && d.allergen_status !== "reviewed") {
    out.push({ key: "allergens", label: "May contain allergens", tone: "caution" });
  } else if (!d.allergens_detected.length && d.allergen_status !== "reviewed") {
    // "None detected" is not "allergen-free".
    out.push({ key: "allergens-unreviewed", label: "Allergens not reviewed", tone: "caution" });
  }
  return out;
}

export function minutesText(minutes: number | null): string | null {
  if (minutes === null) return null;
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function budgetText(list: RecommendationList): string {
  const b = list.budget;
  const meal = REC_MEALS.find((m) => m.key === b.meal_type)?.label.toLowerCase() ?? b.meal_type;
  const base = `About ${b.kcal.toLocaleString()} kcal for ${meal}`;
  return b.mode === "light" ? `${base} (light options)` : base;
}

const EMPTY_TITLE: Record<Exclude<RecStatus, "ok" | "partial">, string> = {
  empty_catalogue: "No meals to suggest yet",
  insufficient_data: "Not enough checked information",
  excluded_by_constraints: "Nothing matches your preferences",
  no_fit: "Nothing fits right now",
};

/** Title for an empty list; the backend's notes give the specific reason. */
export function emptyTitle(status: RecStatus): string {
  return status === "ok" || status === "partial" ? "No suggestions" : EMPTY_TITLE[status];
}

/** Servings stepper: steps of 1 for whole pieces, 0.5 otherwise; within what the API accepts. */
export function stepServings(p: RecPortion, current: number, direction: 1 | -1): number {
  const whole = Number.isInteger(p.min_servings) && Number.isInteger(p.max_servings) && p.min_servings >= 1;
  const step = whole ? 1 : 0.5;
  const lo = whole ? 1 : Math.max(0.5, p.min_servings / 2);
  const hi = p.max_servings * 2;
  const next = Math.round((current + direction * step) * 100) / 100;
  return Math.min(hi, Math.max(lo, next));
}

/** "Optional: Hot tea +34 kcal, Coconut chutney +67 kcal". */
export function optionalText(item: Recommendation): string | null {
  if (!item.optional_components.length) return null;
  return "Optional: " + item.optional_components.map((o) => `${o.name} +${o.nutrition.kcal} kcal`).join(", ");
}

/** Text the assistant receives when a recommendation is sent to it. */
export function assistantPrompt(item: Recommendation, mealLabel: string): string {
  const n = item.nutrition;
  return `Tell me about this ${mealLabel} recommendation: ${item.name} (${servingsText(item)}, ${n.kcal} kcal, ` +
    `P ${n.protein_g} g, C ${n.carbs_g} g, F ${n.fat_g} g). Why does it fit my day, and what are good alternatives?`;
}
