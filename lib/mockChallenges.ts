// Mock-mode counterpart to lib/challenges.ts (in memory; resets on reload).
// Mirrors the curated templates of migration 022. Log-based progress cannot be
// simulated here, so mock log challenges simply start at zero.
import type { CatalogEntry, ChallengeParticipant, MyChallenge } from "./challenges";

type Template = Omit<CatalogEntry, "app_challenge_id" | "starts_on" | "ends_on" | "participant_count" | "my_state"> & {
  featured: boolean;
};

const T = (code: string, title: string, description: string, metric: Template["metric"], days: number, target: number,
           checkin: string | null, safety: string | null, featured = false): Template => ({
  template_code: code, title, description, metric, cadence: days === 1 ? "daily" : "weekly", duration_days: days,
  target_days: target, checkin_label: checkin, safety_note: safety, featured,
});

const TEMPLATES: Template[] = [
  T("log-today", "Log a meal today", "Log at least one meal or snack today.", "logged_days", 1, 1, null, null),
  T("walk-today", "Take a walk today", "A comfortable walk of about 20 minutes, at your own pace.", "checkin_days", 1, 1,
    "I took a walk today", "Go at a comfortable pace. Skip it if you are unwell."),
  T("log-5-days", "Log meals on 5 days", "Log at least one meal on 5 of the next 7 days.", "logged_days", 7, 5, null,
    "Two days off are built in.", true),
  T("breakfast-5-days", "Log breakfast on 5 days", "Log a breakfast on 5 of the next 7 days.", "breakfast_days", 7, 5,
    null, "Two days off are built in.", true),
  T("water-5-days", "Drink water regularly", "Sip water through the day on 5 of the next 7 days.", "checkin_days", 7, 5,
    "I drank water regularly today", "Drink to thirst; there is no need to force large amounts.", true),
  T("walk-5-days", "Walk on 5 days", "A comfortable walk of about 20 minutes on 5 of the next 7 days.", "checkin_days", 7,
    5, "I took a walk today", "Go at a comfortable pace. Rest days are part of the plan."),
];

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return iso(d);
}
function monday(): string {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return iso(d);
}

let mine: MyChallenge[] = [];
let checkins = new Map<string, Set<string>>();
let seq = 0;

function fromTemplate(t: Template, id: string, kind: MyChallenge["kind"], starts: string): MyChallenge {
  return {
    challenge_id: id, template_code: t.template_code, title: t.title, description: t.description, metric: t.metric,
    cadence: t.cadence, kind, starts_on: starts, ends_on: addDays(starts, t.duration_days - 1), target_days: t.target_days,
    progress_days: 0, state: "active", checkin_label: t.checkin_label, safety_note: t.safety_note, checked_in_today: false,
    participant_count: 1, invited_by_username: null, completed_at: null,
  };
}

export async function mockCatalog(): Promise<CatalogEntry[]> {
  const start = monday();
  return TEMPLATES.map(({ featured, ...t }) => {
    const id = featured ? `mock-app-${t.template_code}` : null;
    const me = id ? mine.find((c) => c.challenge_id === id) : undefined;
    return {
      ...t, app_challenge_id: id, starts_on: id ? start : null, ends_on: id ? addDays(start, 6) : null,
      participant_count: id ? 12 + t.target_days + (me ? 1 : 0) : 0, my_state: me?.state ?? null,
    };
  });
}

export async function mockMine(): Promise<MyChallenge[]> {
  return mine.map((c) => ({ ...c }));
}

export async function mockParticipants(id: string): Promise<ChallengeParticipant[]> {
  const c = mine.find((x) => x.challenge_id === id);
  if (!c || c.kind === "app") return [];
  return [{ user_id: "mock-me", username: null, avatar_url: null, is_me: true, state: c.state,
            progress_days: c.progress_days, target_days: c.target_days }];
}

export async function mockStart(code: string, invite: string[]): Promise<string> {
  const t = TEMPLATES.find((x) => x.template_code === code);
  if (!t) throw Object.assign(new Error("Unknown challenge"), { code: "P0002" });
  const id = `mock-ch-${++seq}`;
  mine = [{ ...fromTemplate(t, id, invite.length ? "group" : "individual", iso(new Date())),
            participant_count: 1 }, ...mine];
  return id;
}

export async function mockJoin(id: string): Promise<void> {
  if (mine.some((c) => c.challenge_id === id && (c.state === "active" || c.state === "completed"))) return;
  const t = TEMPLATES.find((x) => `mock-app-${x.template_code}` === id);
  if (!t) throw Object.assign(new Error("Challenge not found"), { code: "P0002" });
  mine = [fromTemplate(t, id, "app", monday()), ...mine.filter((c) => c.challenge_id !== id)];
}

export async function mockDecline(id: string): Promise<void> {
  mine = mine.filter((c) => c.challenge_id !== id);
}

export async function mockLeave(id: string): Promise<void> {
  const c = mine.find((x) => x.challenge_id === id);
  if (c?.state === "completed") throw Object.assign(new Error("Completed"), { code: "55000" });
  mine = mine.map((x) => (x.challenge_id === id && x.state === "active" ? { ...x, state: "left" } : x));
}

export async function mockCheckIn(id: string): Promise<number> {
  const c = mine.find((x) => x.challenge_id === id && x.state === "active");
  if (!c) throw Object.assign(new Error("Not an active participant"), { code: "P0002" });
  if (c.metric !== "checkin_days") {
    throw Object.assign(new Error("This challenge is tracked from your food logs"), { code: "22023" });
  }
  const days = checkins.get(id) ?? new Set<string>();
  days.add(iso(new Date()));
  checkins.set(id, days);
  const progress = days.size;
  mine = mine.map((x) => x.challenge_id !== id ? x : {
    ...x, progress_days: progress, checked_in_today: true,
    ...(progress >= x.target_days ? { state: "completed" as const, completed_at: new Date().toISOString() } : {}),
  });
  return progress;
}

/** Test hook. */
export function resetMockChallenges(): void {
  mine = [];
  checkins = new Map();
  seq = 0;
}
