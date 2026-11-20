import {
  bucketLogs,
  buildPeriodRange,
  formatRangeLabel,
  summarizePeriod,
  toISODate,
} from "../reportPeriods";
import type { FoodLog } from "../types";

let seq = 0;
function log(date: string, overrides: Partial<FoodLog> = {}): FoodLog {
  seq += 1;
  return {
    id: `log-${seq}`,
    user_id: "u1",
    logged_date: date,
    meal_type: "lunch",
    food_name: "Food",
    calories: 100,
    carbs_g: 10,
    fat_g: 5,
    protein_g: 5,
    serving_g: 100,
    is_quick_add: false,
    ...overrides,
  };
}

// 2026-11-20 is a Friday.
const ANCHOR = "2026-11-20";

describe("toISODate", () => {
  it("formats in local time with zero padding", () => {
    expect(toISODate(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(toISODate(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31");
  });
});

describe("buildPeriodRange", () => {
  it("days: the 7 days ending on the anchor", () => {
    const r = buildPeriodRange("days", ANCHOR);
    expect(r.start).toBe("2026-11-14");
    expect(r.end).toBe("2026-11-20");
    expect(r.bucketStarts).toHaveLength(7);
    expect(r.bucketStarts[6]).toBe(ANCHOR);
  });

  it("days: offset -1 is the previous 7 days, with no gap or overlap", () => {
    const r = buildPeriodRange("days", ANCHOR, -1);
    expect(r.start).toBe("2026-11-07");
    expect(r.end).toBe("2026-11-13");
  });

  it("weeks: 8 Monday-based weeks ending with the anchor's week", () => {
    const r = buildPeriodRange("weeks", ANCHOR);
    expect(r.bucketStarts).toHaveLength(8);
    expect(r.bucketStarts[7]).toBe("2026-11-16"); // Monday of the anchor's week
    expect(r.start).toBe("2026-09-28");
    expect(r.end).toBe("2026-11-22"); // Sunday
  });

  it("months: 6 calendar months ending with the anchor's month", () => {
    const r = buildPeriodRange("months", ANCHOR);
    expect(r.bucketStarts).toEqual([
      "2026-06-01",
      "2026-07-01",
      "2026-08-01",
      "2026-09-01",
      "2026-10-01",
      "2026-11-01",
    ]);
    expect(r.start).toBe("2026-06-01");
    expect(r.end).toBe("2026-11-30");
  });

  it("months: paging back crosses the year boundary", () => {
    const r = buildPeriodRange("months", ANCHOR, -1);
    expect(r.start).toBe("2025-12-01");
    expect(r.end).toBe("2026-05-31");
  });

  it("months: ends on the last day of February in a leap year", () => {
    const r = buildPeriodRange("months", "2028-02-10");
    expect(r.end).toBe("2028-02-29");
  });
});

describe("bucketLogs", () => {
  it("sums per day and counts distinct logged days", () => {
    const range = buildPeriodRange("days", ANCHOR);
    const buckets = bucketLogs(
      "days",
      range,
      [log("2026-11-20"), log("2026-11-20", { calories: 250.4 }), log("2026-11-18")],
      ANCHOR
    );
    const today = buckets.find((b) => b.key === "2026-11-20")!;
    expect(today.totalKcal).toBe(350);
    expect(today.loggedDays).toBe(1);
    expect(today.isCurrent).toBe(true);
    expect(today.label).toBe("20");
    expect(buckets.find((b) => b.key === "2026-11-19")!.totalKcal).toBe(0);
  });

  it("drops logs outside the range", () => {
    const range = buildPeriodRange("days", ANCHOR);
    const buckets = bucketLogs("days", range, [log("2026-10-01", { calories: 9999 })], ANCHOR);
    expect(buckets.reduce((s, b) => s + b.totalKcal, 0)).toBe(0);
  });

  it("weeks: groups Monday-Sunday and counts logged days inside the week", () => {
    const range = buildPeriodRange("weeks", ANCHOR);
    const buckets = bucketLogs(
      "weeks",
      range,
      [log("2026-11-16"), log("2026-11-22"), log("2026-11-15")],
      ANCHOR
    );
    const thisWeek = buckets.find((b) => b.key === "2026-11-16")!;
    expect(thisWeek.totalKcal).toBe(200);
    expect(thisWeek.loggedDays).toBe(2);
    expect(buckets.find((b) => b.key === "2026-11-09")!.totalKcal).toBe(100); // Sunday 15th
  });

  it("months: labels with month initials", () => {
    const range = buildPeriodRange("months", ANCHOR);
    expect(bucketLogs("months", range, [], ANCHOR).map((b) => b.label)).toEqual([
      "J", "J", "A", "S", "O", "N",
    ]);
  });
});

describe("summarizePeriod", () => {
  it("averages per logged day, not per calendar day", () => {
    const s = summarizePeriod([
      log("2026-11-18", { calories: 1500 }),
      log("2026-11-20", { calories: 2000, meal_type: "dinner" }),
      log("2026-11-20", { calories: 500, meal_type: "breakfast" }),
    ]);
    expect(s.loggedDayCount).toBe(2);
    expect(s.averageKcal).toBe(2000); // 4000 / 2 days
  });

  it("reports per-meal averages only for meals that were eaten", () => {
    const s = summarizePeriod([
      log("2026-11-18", { calories: 300, meal_type: "breakfast" }),
      log("2026-11-19", { calories: 500, meal_type: "breakfast" }),
    ]);
    expect(s.perMealAverage).toEqual([{ meal: "breakfast", label: "Breakfast", kcal: 400 }]);
  });

  it("returns zeros, not NaN, for an empty period", () => {
    const s = summarizePeriod([]);
    expect(s).toMatchObject({
      averageKcal: 0,
      loggedDayCount: 0,
      carbPct: 0,
      fatPct: 0,
      proteinPct: 0,
      perMealAverage: [],
    });
  });

  it("computes the calorie-weighted macro split", () => {
    const s = summarizePeriod([log("2026-11-20", { carbs_g: 50, fat_g: 10, protein_g: 25 })]);
    expect([s.carbPct, s.fatPct, s.proteinPct]).toEqual([51, 23, 26]);
  });
});

describe("formatRangeLabel", () => {
  it("formats a same-month range compactly", () => {
    expect(formatRangeLabel("days", buildPeriodRange("days", ANCHOR))).toBe("14–20 Nov");
  });

  it("names both months when the range spans two", () => {
    expect(formatRangeLabel("weeks", buildPeriodRange("weeks", ANCHOR))).toBe("28 Sep – 22 Nov");
  });

  it("formats month ranges with the year", () => {
    expect(formatRangeLabel("months", buildPeriodRange("months", ANCHOR))).toBe("Jun – Nov 2026");
  });
});
