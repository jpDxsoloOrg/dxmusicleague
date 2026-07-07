// Lazy round auto-advance for timed leagues. There's no scheduler: whenever the
// league or its round is read (and right after a submission/ballot), we check
// whether the current phase should end and advance it — cascading through any
// phases that all elapsed while nobody was looking. Manual leagues are a no-op.
//
// A phase ends when EITHER its deadline passes OR everyone has finished it
// (all members submitted / all members voted). Advancing re-bases the next
// phase's deadline to `phaseDays` from now, so finishing early shortens the
// round instead of leaving dead time.
//
// The owner can still advance manually in timed mode (rounds.updateRound /
// revealRound) — this just automates it. See memory: round-automation.

import type { League, Round } from "../domain/types.ts";
import { createPlaylistForRound } from "./providers.ts";
import { finalizeReveal } from "./results.ts";
import { phaseDeadline } from "./timing.ts";
import type { Deps } from "./leagues.ts";

const past = (iso?: string): boolean => (iso ? Date.now() > new Date(iso).getTime() : false);

/** Advance a timed league's current round through every phase that's ready
 *  (deadline passed OR everyone finished), persisting as it goes. Returns the
 *  (possibly mutated) round. No-op for manual leagues or when nothing is due. */
export async function autoAdvanceRound(
  deps: Deps,
  league: League,
  round: Round | undefined,
): Promise<Round | undefined> {
  if (!round || league.progression !== "timed" || !league.phaseDays) return round;
  const phaseDays = league.phaseDays;
  const memberCount = league.memberIds.length;
  let advanced = false;

  // submitting → previewing: deadline passed OR every member has used every
  // submission slot (submissionsPerPlayer picks each).
  if (round.status === "submitting") {
    const subs = await deps.repo.getSubmissionsForRound(round.id);
    const allowance = league.settings.submissionsPerPlayer || 1;
    const everyoneSubmitted = memberCount > 0 && subs.length >= memberCount * allowance;
    const deadlineHit = past(round.submissionDeadline);
    if (deadlineHit || everyoneSubmitted) {
      round.status = "previewing";
      // Everyone finished before the deadline → pull the rest of the schedule
      // forward. Deadline-triggered → keep the schedule so a long-dormant round
      // can cascade through every elapsed phase on a single read.
      if (!deadlineHit) {
        round.previewDeadline = phaseDeadline(phaseDays);
        round.voteDeadline = phaseDeadline(2 * phaseDays);
      }
      if (!round.playlistUrl) {
        try {
          const url = await createPlaylistForRound(league, round, subs);
          if (url) round.playlistUrl = url;
        } catch (err) {
          console.error(`Auto-advance playlist creation failed for round ${round.id}:`, err);
        }
      }
      advanced = true;
    }
  }

  // previewing → voting: only the deadline (listening has no "finished" signal).
  if (round.status === "previewing" && past(round.previewDeadline)) {
    round.status = "voting";
    advanced = true;
  }

  // voting → revealed: deadline passed OR every member voted (with songs to rank).
  if (round.status === "voting") {
    const [subs, ballots] = await Promise.all([
      deps.repo.getSubmissionsForRound(round.id),
      deps.repo.getBallotsForRound(round.id),
    ]);
    const everyoneVoted = memberCount > 0 && ballots.length >= memberCount && subs.length > 0;
    if (past(round.voteDeadline) || everyoneVoted) {
      await finalizeReveal(deps, round); // tallies, banks points, persists
      return round;
    }
  }

  if (advanced) await deps.repo.updateRound(round);
  return round;
}
