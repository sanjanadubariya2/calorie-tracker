import { Platform, Share } from "react-native";

export interface ReportInput {
  username: string | null;
  dateLabel: string;
  consumedKcal: number;
  targetKcal: number;
  carbsG: number;
  fatG: number;
  proteinG: number;
  streakDays: number;
  weekAverageKcal: number;
}

function bar(fraction: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/**
 * Plain-text report. Deliberately not an image: text pastes into WhatsApp,
 * Instagram captions, Slack, and notes without a share-sheet that can't
 * handle attachments, and it stays readable if a platform strips formatting.
 */
export function buildReportText(r: ReportInput): string {
  const handle = r.username ? `@${r.username}` : "My";
  const pct = r.targetKcal > 0 ? r.consumedKcal / r.targetKcal : 0;
  const remaining = Math.max(0, r.targetKcal - r.consumedKcal);

  const over = r.consumedKcal - r.targetKcal;
  const statusLine =
    remaining > 0
      ? `${remaining.toLocaleString()} kcal left today`
      : over > 0
      ? `${over.toLocaleString()} kcal over target`
      : "Right on target";

  const lines = [
    `${handle} — ${r.dateLabel}`,
    ``,
    `${bar(pct)}  ${Math.round(pct * 100)}%`,
    `${r.consumedKcal.toLocaleString()} / ${r.targetKcal.toLocaleString()} kcal`,
    statusLine,
    ``,
    `Carbs ${r.carbsG} g · Fat ${r.fatG} g · Protein ${r.proteinG} g`,
    `7-day average: ${Math.round(r.weekAverageKcal).toLocaleString()} kcal`,
  ];

  if (r.streakDays > 0) {
    lines.push(`Streak: ${r.streakDays} day${r.streakDays === 1 ? "" : "s"} 🔥`);
  }

  lines.push(``, `Tracked with Calorie Tracker`);
  return lines.join("\n");
}

export interface ShareOutcome {
  shared: boolean;
  /** Set when the platform had no share sheet and the text was copied instead. */
  copiedToClipboard?: boolean;
}

/**
 * Opens the native share sheet, falling back to the Web Share API and then to
 * the clipboard — desktop browsers commonly have neither.
 */
export async function shareReport(text: string): Promise<ShareOutcome> {
  if (Platform.OS !== "web") {
    const result = await Share.share({ message: text });
    return { shared: result.action !== Share.dismissedAction };
  }

  const nav = typeof navigator !== "undefined" ? (navigator as Navigator) : undefined;

  if (nav?.share) {
    try {
      await nav.share({ text });
      return { shared: true };
    } catch {
      // User dismissed, or the browser refused — fall through to clipboard.
    }
  }

  if (nav?.clipboard?.writeText) {
    await nav.clipboard.writeText(text);
    return { shared: true, copiedToClipboard: true };
  }

  return { shared: false };
}
