// Challenges client: RPC shapes, error messages and view helpers. Progress,
// completion, authorization and races are enforced by the database
// (supabase/tests/022_challenges.test.sql and tests/concurrency/).
import { supabase } from "../supabase";
import {
  checkInChallenge,
  daysLeft,
  describeChallengeError,
  getMyChallenges,
  groupChallenges,
  joinChallenge,
  progressFraction,
  progressMessage,
  startChallenge,
  type MyChallenge,
} from "../challenges";
import { SocialFeatureUnavailable } from "../socialActivity";

jest.mock("../supabase", () => ({ MOCK_MODE: false, supabase: { rpc: jest.fn() } }));
const rpc = supabase.rpc as unknown as jest.Mock;

beforeEach(() => rpc.mockReset());

it("sends only template, start date and invitees when starting; never progress or a user id", async () => {
  rpc.mockResolvedValue({ data: "c1", error: null });
  expect(await startChallenge("walk-5-days", ["f1"], "2026-11-22")).toBe("c1");
  expect(rpc).toHaveBeenCalledWith("start_challenge",
    { p_template: "walk-5-days", p_starts_on: "2026-11-22", p_invite: ["f1"] });
  rpc.mockResolvedValue({ data: "c2", error: null });
  await startChallenge("log-today");
  expect(rpc).toHaveBeenLastCalledWith("start_challenge", { p_template: "log-today", p_starts_on: null, p_invite: [] });
});

it("check-in sends the challenge id and the device's date (never progress) and returns the server's count", async () => {
  rpc.mockResolvedValue({ data: 3, error: null });
  expect(await checkInChallenge("c1", "2026-11-21")).toBe(3);
  expect(rpc).toHaveBeenCalledWith("check_in_challenge", { p_challenge: "c1", p_day: "2026-11-21" });
  await checkInChallenge("c1");
  expect(rpc.mock.calls[1][1].p_day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

it("coerces numeric fields from the server", async () => {
  rpc.mockResolvedValue({ data: [{ challenge_id: "c", progress_days: "4", participant_count: "2" }], error: null });
  const [c] = await getMyChallenges();
  expect(c.progress_days).toBe(4);
  expect(c.participant_count).toBe(2);
});

it("maps server errors to messages", async () => {
  expect(describeChallengeError({ code: "P0002" })).toMatch(/isn't available/);
  expect(describeChallengeError({ code: "55000" })).toMatch(/already finished/);
  expect(describeChallengeError({ code: "22023", message: "You can only invite friends" })).toBe("You can only invite friends.");
  expect(describeChallengeError({ code: "22023", message: "x".repeat(300) })).toMatch(/isn't possible/);
  expect(describeChallengeError(new SocialFeatureUnavailable())).toMatch(/aren't available/);
  expect(describeChallengeError(new Error("boom"))).toMatch(/Something went wrong/);
  rpc.mockResolvedValue({ data: null, error: { code: "42883" } });
  await expect(joinChallenge("c")).rejects.toBeInstanceOf(SocialFeatureUnavailable);
});

it("progress and days-left helpers", () => {
  expect(progressFraction(3, 5)).toBeCloseTo(0.6);
  expect(progressFraction(9, 5)).toBe(1);
  expect(progressFraction(1, 0)).toBe(0);
  expect(daysLeft("2026-11-27", "2026-11-21")).toBe(7);
  expect(daysLeft("2026-11-21", "2026-11-21")).toBe(1);
  expect(daysLeft("2026-11-20", "2026-11-21")).toBe(0);
});

it("progress messages are encouraging and never pressuring", () => {
  const c = (state: MyChallenge["state"], p: number, t = 5) => ({ state, progress_days: p, target_days: t });
  expect(progressMessage(c("active", 3), 4)).toBe("2 more days to go · 4 days left");
  expect(progressMessage(c("active", 1), 2)).toMatch(/at your own pace/);
  expect(progressMessage(c("completed", 5), 0)).toMatch(/Completed/);
  expect(progressMessage(c("expired", 3), 0)).toMatch(/Every day counts/);
  for (const s of ["active", "expired", "completed", "upcoming", "left"] as const) {
    expect(progressMessage(c(s, 1), 1)).not.toMatch(/fail|lost|behind|kcal|weight/i);
  }
});

it("groups challenges for the Joined and Completed views", () => {
  const mk = (id: string, state: MyChallenge["state"]) => ({ challenge_id: id, state }) as MyChallenge;
  const g = groupChallenges([mk("a", "invited"), mk("b", "active"), mk("c", "upcoming"), mk("d", "completed"),
                             mk("e", "expired"), mk("f", "left")]);
  expect(g.invited.map((x) => x.challenge_id)).toEqual(["a"]);
  expect(g.current.map((x) => x.challenge_id)).toEqual(["b", "c"]);
  expect(g.completed.map((x) => x.challenge_id)).toEqual(["d"]);
  expect(g.past.map((x) => x.challenge_id)).toEqual(["e", "f"]);
});
