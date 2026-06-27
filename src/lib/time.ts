/** Format the time remaining until an ISO deadline as a compact countdown. */
export function formatCountdown(deadlineIso?: string, now: Date = new Date()): string {
  if (!deadlineIso) return "";
  const diffMs = new Date(deadlineIso).getTime() - now.getTime();
  if (diffMs <= 0) return "Closed";

  const totalMin = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
