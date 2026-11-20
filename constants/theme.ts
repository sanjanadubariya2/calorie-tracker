// Design tokens pulled directly from the reference screenshots:
// near-black cards on pure black background, green progress fill,
// purple/coral/yellow macro accents.

export const colors = {
  background: "#000000",
  card: "#141414",
  cardBorder: "#2A2A2A",
  pillBackground: "#1F1F1F",
  textPrimary: "#FFFFFF",
  textSecondary: "#9B9B9B",
  textTertiary: "#6E6E6E",

  progressTrack: "#2A2A2A",
  progressFill: "#7ED321",

  carb: "#B48CF2",
  fat: "#F28C6A",
  protein: "#F4D35E",

  chartPast: "#4FA8F0",
  chartToday: "#7ED321",

  badgeActive: "#F2C744",
  badgeInactive: "#2A2A2A",

  danger: "#F26666",
  success: "#7ED321",

  divider: "#232323",
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
};

export const radius = {
  sm: 8,
  md: 16,
  lg: 24,
  pill: 999,
};

export const typography = {
  hero: { fontSize: 52, fontWeight: "700" as const },
  title: { fontSize: 20, fontWeight: "700" as const },
  body: { fontSize: 16, fontWeight: "400" as const },
  label: { fontSize: 14, fontWeight: "600" as const },
  caption: { fontSize: 12, fontWeight: "500" as const },
};

export const MEAL_SLOTS = [
  { key: "breakfast", label: "Breakfast" },
  { key: "lunch", label: "Lunch" },
  { key: "dinner", label: "Dinner" },
  { key: "morning_snack", label: "Morning snack" },
  { key: "afternoon_snack", label: "Afternoon snack" },
  { key: "evening_snack", label: "Evening snack" },
] as const;

export type MealType = (typeof MEAL_SLOTS)[number]["key"];

export function isMealType(value: unknown): value is MealType {
  return MEAL_SLOTS.some((s) => s.key === value);
}
