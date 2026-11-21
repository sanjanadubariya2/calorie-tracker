// Wellness challenges (migration 022).
//
// Progress is never sent by the client: the database counts days from food
// logs, or from once-a-day self-reported check-ins, and decides completion.
// Templates are curated consistency habits with rest days built in; nothing
// here is about calories, weight or amounts, and participants are listed
// alphabetically, never ranked.
import { MOCK_MODE, supabase } from "./supabase";
import { SocialFeatureUnavailable, isNotDeployed } from "./socialActivity";
import * as mock from "./mockChallenges";

export type ChallengeMetric = "logged_days" | "breakfast_days" | "main_meals_days" | "checkin_days";
export type ChallengeState = "invited" | "upcoming" | "active" | "completed" | "expired" | "left" | "declined";

export interface CatalogEntry {
  template_code: string;
  title: string;
  description: string;
  metric: ChallengeMetric;
  cadence: "daily" | "weekly";
  duration_days: number;
  target_days: number;
  checkin_label: string | null;
  safety_note: string | null;
  /** This week's open app challenge for the template, if it has one. */
  app_challenge_id: string | null;
  starts_on: string | null;
  ends_on: string | null;
  participant_count: number;
  my_state: ChallengeState | null;
}

export interface MyChallenge {
  challenge_id: string;
  template_code: string;
  title: string;
  description: string;
  metric: ChallengeMetric;
  cadence: "daily" | "weekly";
  kind: "individual" | "group" | "app";
  starts_on: string;
  ends_on: string;
  target_days: number;
  progress_days: number;
  state: ChallengeState;
  checkin_label: string | null;
  safety_note: string | null;
  checked_in_today: boolean;
  participant_count: number;
  invited_by_username: string | null;
  completed_at: string | null;
}

export interface ChallengeParticipant {
  user_id: string;
  username: string | null;
  avatar_url: string | null;
  is_me: boolean;
  state: ChallengeState;
  progress_days: number;
  target_days: number;
}

export const CHALLENGE_ERROR = {
  notAuthenticated: "28000",
  invalid: "22023",
  notFound: "P0002",
  ended: "55000",
} as const;

function code(e: unknown): string {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
}

/** A sentence for the UI. 22023 messages are written for people in migration 022. */
export function describeChallengeError(e: unknown): string {
  if (e instanceof SocialFeatureUnavailable) return e.message;
  switch (code(e)) {
    case CHALLENGE_ERROR.notFound:
      return "This challenge isn't available any more.";
    case CHALLENGE_ERROR.ended:
      return "This challenge has already finished.";
    case CHALLENGE_ERROR.notAuthenticated:
      return "You've been signed out. Sign in again and retry.";
    case CHALLENGE_ERROR.invalid: {
      const msg = (e as { message?: unknown }).message;
      return typeof msg === "string" && msg.length > 0 && msg.length < 120 ? `${msg}.` : "That isn't possible for this challenge.";
    }
    default:
      return "Something went wrong. Check your connection and try again.";
  }
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  // The generated types know these functions; a loose call keeps this helper small.
  const { data, error } = await (supabase.rpc as unknown as (
    f: string, a?: Record<string, unknown>
  ) => Promise<{ data: unknown; error: unknown }>)(fn, args);
  if (error) throw isNotDeployed(error) ? new SocialFeatureUnavailable() : error;
  return data as T;
}

export async function getChallengeCatalog(): Promise<CatalogEntry[]> {
  if (MOCK_MODE) return mock.mockCatalog();
  const rows = await rpc<CatalogEntry[] | null>("get_challenge_catalog");
  return (rows ?? []).map((r) => ({ ...r, participant_count: Number(r.participant_count) || 0 }));
}

export async function getMyChallenges(): Promise<MyChallenge[]> {
  if (MOCK_MODE) return mock.mockMine();
  const rows = await rpc<MyChallenge[] | null>("get_my_challenges");
  return (rows ?? []).map((r) => ({
    ...r,
    progress_days: Number(r.progress_days) || 0,
    participant_count: Number(r.participant_count) || 0,
  }));
}

export async function getChallengeParticipants(challengeId: string): Promise<ChallengeParticipant[]> {
  if (MOCK_MODE) return mock.mockParticipants(challengeId);
  return (await rpc<ChallengeParticipant[] | null>("get_challenge_participants", { p_challenge: challengeId })) ?? [];
}

/** Starts a challenge from a template (today, or within the next week), optionally with friends. */
export async function startChallenge(templateCode: string, inviteUserIds: string[] = [], startsOn?: string): Promise<string> {
  if (MOCK_MODE) return mock.mockStart(templateCode, inviteUserIds);
  return rpc<string>("start_challenge", {
    p_template: templateCode,
    p_starts_on: startsOn ?? null,
    p_invite: inviteUserIds,
  });
}

/** Joins an open app challenge or accepts an invitation. Safe to repeat. */
export async function joinChallenge(challengeId: string): Promise<void> {
  if (MOCK_MODE) return mock.mockJoin(challengeId);
  await rpc("join_challenge", { p_challenge: challengeId });
}

export async function declineChallenge(challengeId: string): Promise<void> {
  if (MOCK_MODE) return mock.mockDecline(challengeId);
  await rpc("decline_challenge", { p_challenge: challengeId });
}

export async function leaveChallenge(challengeId: string): Promise<void> {
  if (MOCK_MODE) return mock.mockLeave(challengeId);
  await rpc("leave_challenge", { p_challenge: challengeId });
}

/**
 * Self-reported check-in for today (the device's local date; the server
 * accepts only today or yesterday in some time zone, inside the challenge).
 * Repeating it the same day changes nothing. Returns progress.
 */
export async function checkInChallenge(challengeId: string, day: string = localToday()): Promise<number> {
  if (MOCK_MODE) return mock.mockCheckIn(challengeId);
  return Number(await rpc<number>("check_in_challenge", { p_challenge: challengeId, p_day: day })) || 0;
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ view helpers

export function progressFraction(progress: number, target: number): number {
  if (!(target > 0)) return 0;
  return Math.max(0, Math.min(1, progress / target));
}

/** Whole days from `today` to `endsOn` inclusive (0 once it has ended). Dates are YYYY-MM-DD. */
export function daysLeft(endsOn: string, today: string): number {
  const diff = Math.round((Date.parse(`${endsOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  return Number.isFinite(diff) ? Math.max(0, diff + 1) : 0;
}

export function metricLabel(metric: ChallengeMetric): string {
  return metric === "checkin_days" ? "Self-reported check-in" : "Tracked from your meal logs";
}

export function stateLabel(state: ChallengeState): string {
  switch (state) {
    case "invited": return "Invitation";
    case "upcoming": return "Starts soon";
    case "active": return "In progress";
    case "completed": return "Completed";
    case "expired": return "Ended";
    case "left": return "Left";
    case "declined": return "Declined";
  }
}

export function kindLabel(kind: MyChallenge["kind"]): string {
  return kind === "app" ? "App challenge" : kind === "group" ? "With friends" : "Personal";
}

export interface GroupedChallenges {
  invited: MyChallenge[];
  current: MyChallenge[];
  completed: MyChallenge[];
  past: MyChallenge[];
}

export function groupChallenges(list: MyChallenge[]): GroupedChallenges {
  return {
    invited: list.filter((c) => c.state === "invited"),
    current: list.filter((c) => c.state === "active" || c.state === "upcoming"),
    completed: list.filter((c) => c.state === "completed"),
    past: list.filter((c) => c.state === "expired" || c.state === "left"),
  };
}

/** A friendly line under the progress bar. Never pressures: misses are fine. */
export function progressMessage(c: Pick<MyChallenge, "state" | "progress_days" | "target_days">, left: number): string {
  if (c.state === "completed") return "Completed. Nice consistency!";
  if (c.state === "upcoming") return "Starts soon.";
  if (c.state === "expired") return `Finished with ${c.progress_days} of ${c.target_days} days. Every day counts.`;
  if (c.state === "left") return "You left this challenge.";
  const need = Math.max(0, c.target_days - c.progress_days);
  if (need === 0) return "Target reached!";
  if (left < need) return `${c.progress_days} of ${c.target_days} days so far. Keep going at your own pace.`;
  return `${need} more day${need === 1 ? "" : "s"} to go · ${left} day${left === 1 ? "" : "s"} left`;
}
