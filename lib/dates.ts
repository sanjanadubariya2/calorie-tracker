// Local calendar dates, the app's one date convention.
//
// food_logs.logged_date and every date the app sends to the database are
// YYYY-MM-DD in the *device's* local calendar. Never derive them with
// toISOString(), which converts to UTC and shifts the day for anyone not on UTC.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** YYYY-MM-DD for a Date in local time. */
export function toISODate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

/** Today's local date. */
export function todayISO(): string {
  return toISODate(new Date());
}

/** Local midnight of a YYYY-MM-DD date. */
export function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** True for a real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
export function isISODate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/** Adds whole calendar days. DST-safe: works on calendar fields, not milliseconds. */
export function shiftDate(iso: string, deltaDays: number): string {
  const date = parseISODate(iso);
  date.setDate(date.getDate() + deltaDays);
  return toISODate(date);
}

/** The `length`-day window ending on (and including) `endDate`. */
export function rangeEndingOn(
  endDate: string,
  length = 7
): { start: string; end: string; days: string[] } {
  const days: string[] = [];
  for (let i = length - 1; i >= 0; i--) days.push(shiftDate(endDate, -i));
  return { start: days[0], end: days[days.length - 1], days };
}
