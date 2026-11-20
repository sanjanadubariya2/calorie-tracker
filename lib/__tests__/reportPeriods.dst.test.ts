// Date maths must stay on calendar days across daylight-saving changes, where
// a day is 23 or 25 hours long. jest.global-setup.js pins TZ to
// America/New_York for the whole run; the first test asserts that took effect.

import { buildPeriodRange } from "../reportPeriods";
import { rangeEndingOn } from "../api";

describe("date ranges across DST transitions (America/New_York)", () => {
  it("is running in a DST zone", () => {
    // Offset differs between January and July only where DST applies.
    expect(new Date(2026, 0, 1).getTimezoneOffset()).not.toBe(new Date(2026, 6, 1).getTimezoneOffset());
  });

  it("spring forward (2026-03-08): 7 distinct consecutive days", () => {
    const r = buildPeriodRange("days", "2026-03-10");
    expect(r.bucketStarts).toEqual([
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
    ]);
  });

  it("fall back (2026-11-01): weeks stay Monday-aligned", () => {
    const r = buildPeriodRange("weeks", "2026-11-04");
    expect(r.bucketStarts.slice(-2)).toEqual(["2026-10-26", "2026-11-02"]);
  });

  it("rangeEndingOn (dashboard/friends 7-day window) does not skip or repeat a day", () => {
    expect(rangeEndingOn("2026-03-09").days).toEqual([
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
    ]);
    expect(rangeEndingOn("2026-11-02")).toMatchObject({ start: "2026-10-27", end: "2026-11-02" });
  });
});
