// lib/dates.ts — the app's single local-date convention. Jest pins
// TZ=America/New_York (jest.global-setup.js), so "local" is deterministic.
import { isISODate, parseISODate, rangeEndingOn, shiftDate, toISODate, todayISO } from "../dates";

describe("toISODate: local calendar date, never UTC", () => {
  it("23:59 local stays on the same date even though UTC is already tomorrow", () => {
    // 2026-11-20 23:59 in New York is 2026-11-21 04:59 UTC.
    const lateEvening = new Date(2026, 10, 20, 23, 59);
    expect(lateEvening.toISOString().slice(0, 10)).toBe("2026-11-21"); // the old bug
    expect(toISODate(lateEvening)).toBe("2026-11-20");
  });

  it("00:00 local is the new date", () => {
    expect(toISODate(new Date(2026, 10, 21, 0, 0))).toBe("2026-11-21");
  });

  it("todayISO matches toISODate(now)", () => {
    expect(todayISO()).toBe(toISODate(new Date()));
  });
});

describe("parseISODate / shiftDate", () => {
  it("parses to local midnight", () => {
    const d = parseISODate("2026-03-08");
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 2, 8, 0]);
  });

  it("crosses month, year and leap-day boundaries", () => {
    expect(shiftDate("2026-01-31", 1)).toBe("2026-02-01");
    expect(shiftDate("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDate("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("is DST-safe (spring forward 2026-03-08, fall back 2026-11-01)", () => {
    expect(shiftDate("2026-03-07", 1)).toBe("2026-03-08");
    expect(shiftDate("2026-03-08", 1)).toBe("2026-03-09");
    expect(shiftDate("2026-11-01", 1)).toBe("2026-11-02");
    expect(shiftDate("2026-11-02", -1)).toBe("2026-11-01");
  });
});

describe("isISODate (route params are validated before reaching the database)", () => {
  it.each(["2026-11-20", "2028-02-29", "2000-01-01"])("accepts %s", (v) => {
    expect(isISODate(v)).toBe(true);
  });

  it.each([
    "2026-02-30",
    "2027-02-29",
    "2026-13-01",
    "2026-1-5",
    "20261120",
    "2026-11-20T00:00",
    "",
    "tomorrow",
    undefined,
    null,
    20261120,
    ["2026-11-20"],
  ])("rejects %p", (v) => {
    expect(isISODate(v)).toBe(false);
  });
});

describe("rangeEndingOn", () => {
  it("defaults to 7 days including the end date", () => {
    expect(rangeEndingOn("2026-11-20")).toEqual({
      start: "2026-11-14",
      end: "2026-11-20",
      days: ["2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"],
    });
  });

  it("supports other lengths", () => {
    expect(rangeEndingOn("2026-03-01", 3).days).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
  });
});
