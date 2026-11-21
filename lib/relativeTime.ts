// Short relative timestamps for the activity feed ("just now", "5m", "3h",
// "Yesterday", "4d", then a date). Pure, so it is easy to test.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  // Clock skew between device and server: a few seconds "in the future" is still now.
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const days = Math.round((startOfLocalDay(now) - startOfLocalDay(then)) / 86_400_000);
  if (days === 0) return `${Math.floor(minutes / 60)}h ago`;
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  const label = `${then.getDate()} ${MONTHS[then.getMonth()]}`;
  return then.getFullYear() === now.getFullYear() ? label : `${label} ${then.getFullYear()}`;
}
