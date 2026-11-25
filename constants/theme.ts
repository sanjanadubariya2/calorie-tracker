// "Evergreen" design tokens: a calm sage ground with white cards, one deep
// evergreen surface for the headline number, lime for progress, and a fixed
// colour per macro. Fills and text use separate tokens so text stays readable
// (lime and the macro fills are too light to be text on white).

export const colors = {
  background: "#F2F4EE",
  card: "#FFFFFF",
  cardBorder: "#DCE3D6",
  pillBackground: "#E8EDE3",
  textPrimary: "#13201A",
  textSecondary: "#56665C",
  textTertiary: "#7C8A81",

  // Evergreen hero surface and primary actions
  primary: "#123D2C",
  onPrimary: "#FFFFFF",
  heroMuted: "#A8C7B6",
  heroTrack: "#1F5640",

  // Lime: progress fills and highlight buttons (dark text on top)
  accent: "#C6F36B",
  onAccent: "#123D2C",
  accentTint: "rgba(18, 61, 44, 0.08)",
  link: "#1C6B4A",

  progressTrack: "#E8EDE3",
  progressFill: "#C6F36B",

  // Macro fills, plus darker shades for when a macro colour is text
  carb: "#F2B33D",
  fat: "#7B61D9",
  protein: "#E8603C",
  carbText: "#8A5A00",
  fatText: "#5B43B8",
  proteinText: "#B5401C",

  chartPast: "#CFDBCF",
  chartToday: "#123D2C",

  badgeActive: "#F2B33D",
  badgeInactive: "#E8EDE3",

  warning: "#8A4B0B",
  warningTint: "#FDEFD3",
  danger: "#B5401C",
  success: "#1C7A52",

  divider: "#E8EDE3",
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
};

export const radius = {
  sm: 14,
  md: 22,
  lg: 28,
  xl: 32,
  pill: 999,
};

// Loaded in app/_layout.tsx. Custom fonts pick weight by family, not fontWeight.
export const fonts = {
  display: "BricolageGrotesque_800ExtraBold",
  displayBold: "BricolageGrotesque_700Bold",
  body: "PlusJakartaSans_400Regular",
  bodyMedium: "PlusJakartaSans_500Medium",
  bodySemiBold: "PlusJakartaSans_600SemiBold",
  bodyBold: "PlusJakartaSans_700Bold",
};

export const typography = {
  hero: { fontSize: 52, fontWeight: "800" as const, fontFamily: fonts.display, letterSpacing: -1 },
  title: { fontSize: 20, fontWeight: "700" as const, fontFamily: fonts.displayBold },
  body: { fontSize: 16, fontWeight: "400" as const, fontFamily: fonts.body },
  label: { fontSize: 14, fontWeight: "600" as const, fontFamily: fonts.bodySemiBold },
  caption: { fontSize: 12, fontWeight: "500" as const, fontFamily: fonts.bodyMedium },
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
