import type { FoodLog } from "./types";
import { MEAL_SLOTS, type MealType } from "@/constants/theme";

// Period maths for the Reports screen. Everything is computed in local time —
// toISOString() would roll the date over for anyone east or west of UTC.

export type PeriodMode = "days" | "weeks" | "months";

export interface ReportBucket {
  /** Bucket start date, YYYY-MM-DD. */
  key: string;
  /** Axis label: day-of-month, week start, or month initial. */
  label: string;
  totalKcal: number;
  carbsG: number;
  fatG: number;
  proteinG: number;
  /** Days in this bucket that have at least one log — the averaging divisor. */
  loggedDays: number;
  isCurrent: boolean;
}

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function parseISO(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(iso: string, days: number): string {
  const d = parseISO(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

/** Monday-based week start, matching the reference app's 7-day rows. */
function startOfWeek(iso: string): string {
  const d = parseISO(iso);
  const dayOfWeek = (d.getDay() + 6) % 7; // Mon = 0
  d.setDate(d.getDate() - dayOfWeek);
  return toISODate(d);
}

function startOfMonth(iso: string): string {
  const d = parseISO(iso);
  return toISODate(new Date(d.getFullYear(), d.getMonth(), 1));
}

/** How many buckets each mode shows. */
const BUCKET_COUNT: Record<PeriodMode, number> = { days: 7, weeks: 8, months: 6 };

export interface PeriodRange {
  start: string;
  end: string;
  bucketStarts: string[];
}

/**
 * The window ending on `anchor`: 7 days, 8 weeks, or 6 months back.
 * `offset` pages backwards (-1 = previous window).
 */
export function buildPeriodRange(mode: PeriodMode, anchor: string, offset = 0): PeriodRange {
  const count = BUCKET_COUNT[mode];
  const bucketStarts: string[] = [];

  if (mode === "days") {
    const end = addDays(anchor, offset * count);
    for (let i = count - 1; i >= 0; i--) bucketStarts.push(addDays(end, -i));
  } else if (mode === "weeks") {
    const anchorWeek = startOfWeek(anchor);
    const end = addDays(anchorWeek, offset * count * 7);
    for (let i = count - 1; i >= 0; i--) bucketStarts.push(addDays(end, -i * 7));
  } else {
    const d = parseISO(startOfMonth(anchor));
    d.setMonth(d.getMonth() + offset * count);
    for (let i = count - 1; i >= 0; i--) {
      const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
      bucketStarts.push(toISODate(m));
    }
  }

  const start = bucketStarts[0];
  const lastStart = bucketStarts[bucketStarts.length - 1];
  let end: string;
  if (mode === "days") end = lastStart;
  else if (mode === "weeks") end = addDays(lastStart, 6);
  else {
    const d = parseISO(lastStart);
    end = toISODate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  }

  return { start, end, bucketStarts };
}

function bucketKeyFor(mode: PeriodMode, date: string): string {
  if (mode === "days") return date;
  if (mode === "weeks") return startOfWeek(date);
  return startOfMonth(date);
}

const MONTH_INITIALS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

function labelFor(mode: PeriodMode, bucketStart: string): string {
  const d = parseISO(bucketStart);
  if (mode === "months") return MONTH_INITIALS[d.getMonth()];
  return String(d.getDate());
}

export function bucketLogs(
  mode: PeriodMode,
  range: PeriodRange,
  logs: FoodLog[],
  today: string
): ReportBucket[] {
  const currentBucket = bucketKeyFor(mode, today);

  const buckets = new Map<string, ReportBucket & { dates: Set<string> }>();
  for (const bucketStart of range.bucketStarts) {
    buckets.set(bucketStart, {
      key: bucketStart,
      label: labelFor(mode, bucketStart),
      totalKcal: 0,
      carbsG: 0,
      fatG: 0,
      proteinG: 0,
      loggedDays: 0,
      isCurrent: bucketStart === currentBucket,
      dates: new Set<string>(),
    });
  }

  for (const log of logs) {
    const bucket = buckets.get(bucketKeyFor(mode, log.logged_date));
    if (!bucket) continue;
    bucket.totalKcal += log.calories;
    bucket.carbsG += log.carbs_g;
    bucket.fatG += log.fat_g;
    bucket.proteinG += log.protein_g;
    bucket.dates.add(log.logged_date);
  }

  return range.bucketStarts.map((key) => {
    const b = buckets.get(key)!;
    return {
      key: b.key,
      label: b.label,
      totalKcal: Math.round(b.totalKcal),
      carbsG: Math.round(b.carbsG),
      fatG: Math.round(b.fatG),
      proteinG: Math.round(b.proteinG),
      loggedDays: b.dates.size,
      isCurrent: b.isCurrent,
    };
  });
}

export interface PeriodSummary {
  averageKcal: number;
  perMealAverage: { meal: MealType; label: string; kcal: number }[];
  totalCarbsG: number;
  totalFatG: number;
  totalProteinG: number;
  carbPct: number;
  fatPct: number;
  proteinPct: number;
  loggedDayCount: number;
}

/**
 * Averages are per *logged* day, not per calendar day — a week with two days
 * logged shouldn't read as if the other five were zero-calorie days.
 */
export function summarizePeriod(logs: FoodLog[]): PeriodSummary {
  const loggedDates = new Set(logs.map((l) => l.logged_date));
  const dayCount = Math.max(1, loggedDates.size);

  const totalKcal = logs.reduce((sum, l) => sum + l.calories, 0);
  const totalCarbsG = logs.reduce((sum, l) => sum + l.carbs_g, 0);
  const totalFatG = logs.reduce((sum, l) => sum + l.fat_g, 0);
  const totalProteinG = logs.reduce((sum, l) => sum + l.protein_g, 0);

  const perMealAverage = MEAL_SLOTS.map((slot) => {
    const kcal = logs
      .filter((l) => l.meal_type === slot.key)
      .reduce((sum, l) => sum + l.calories, 0);
    return { meal: slot.key as MealType, label: slot.label, kcal: Math.round(kcal / dayCount) };
  }).filter((m) => m.kcal > 0);

  const carbKcal = totalCarbsG * 4;
  const fatKcal = totalFatG * 9;
  const proteinKcal = totalProteinG * 4;
  const macroKcal = carbKcal + fatKcal + proteinKcal;

  return {
    averageKcal: Math.round(totalKcal / dayCount),
    perMealAverage,
    totalCarbsG: Math.round(totalCarbsG / dayCount),
    totalFatG: Math.round(totalFatG / dayCount),
    totalProteinG: Math.round(totalProteinG / dayCount),
    carbPct: macroKcal > 0 ? Math.round((carbKcal / macroKcal) * 100) : 0,
    fatPct: macroKcal > 0 ? Math.round((fatKcal / macroKcal) * 100) : 0,
    proteinPct: macroKcal > 0 ? Math.round((proteinKcal / macroKcal) * 100) : 0,
    loggedDayCount: loggedDates.size,
  };
}

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Header label, e.g. "7–13 Aug" or "Mar – Aug 2026". */
export function formatRangeLabel(mode: PeriodMode, range: PeriodRange): string {
  const start = parseISO(range.start);
  const end = parseISO(range.end);

  if (mode === "months") {
    return `${MONTH_NAMES[start.getMonth()]} – ${MONTH_NAMES[end.getMonth()]} ${end.getFullYear()}`;
  }

  if (start.getMonth() === end.getMonth()) {
    return `${start.getDate()}–${end.getDate()} ${MONTH_NAMES[end.getMonth()]}`;
  }
  return `${start.getDate()} ${MONTH_NAMES[start.getMonth()]} – ${end.getDate()} ${
    MONTH_NAMES[end.getMonth()]
  }`;
}
