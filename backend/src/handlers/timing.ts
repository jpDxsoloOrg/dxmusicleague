// Shared timing helper for timed leagues. A phase deadline is simply `phaseDays`
// days after the phase begins — computed fresh whenever a phase is entered, so
// advancing a phase early automatically re-bases the next one.

const DAY_MS = 86_400_000;

/** ISO deadline `phaseDays` days after `fromMs` (defaults to now). */
export function phaseDeadline(phaseDays: number, fromMs = Date.now()): string {
  return new Date(fromMs + phaseDays * DAY_MS).toISOString();
}
