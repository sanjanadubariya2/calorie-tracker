import { relativeTime } from "../relativeTime";

const now = new Date(2026, 10, 21, 15, 0, 0); // 21 Nov 2026, 15:00 local
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const MIN = 60_000;

it.each([
  [ago(5_000), "just now"],
  [ago(-10_000), "just now"],          // slight clock skew into the future
  [ago(5 * MIN), "5m ago"],
  [ago(59 * MIN), "59m ago"],
  [ago(3 * 60 * MIN), "3h ago"],
  [new Date(2026, 10, 20, 23, 0).toISOString(), "Yesterday"],
  [new Date(2026, 10, 18, 9, 0).toISOString(), "3d ago"],
  [new Date(2026, 10, 2, 9, 0).toISOString(), "2 Nov"],
  [new Date(2025, 11, 30, 9, 0).toISOString(), "30 Dec 2025"],
])("%s -> %s", (iso, expected) => {
  expect(relativeTime(iso, now)).toBe(expected);
});

it("uses calendar days, so 1am today is hours ago, not yesterday", () => {
  expect(relativeTime(new Date(2026, 10, 21, 1, 0).toISOString(), now)).toBe("14h ago");
});

it("returns an empty string for garbage", () => {
  expect(relativeTime("not a date", now)).toBe("");
});
