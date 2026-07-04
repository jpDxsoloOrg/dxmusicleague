// Lazy round auto-advance for timed leagues. There's no scheduler: whenever the
// league (or its round) is read, we check whether the current phase's deadline
// has passed and advance it — cascading through any phases that all elapsed
// while nobody was looking. Manual leagues are a no-op.
//
// Deadlines are set when a round opens for submissions (see rounds.updateRound):
//   submitting → previewing → voting → revealed
// (See docs/round-automation in memory for the deferred cron alternative.)

import type { League, Round } from "../domain/types.ts";
import { createPlaylistForRound } from "./providers.ts";
import { finalizeReveal } from "./voting.ts";
import type { Deps } from "./leagues.ts";

const past = (iso?: string): boolean => (iso ? Date.now() > new Date(iso).getTime() : false);

/** Advance a timed league's current round through every phase whose deadline has
 *  passed, persisting as it goes. Returns the (possibly mutated) round. No-op for
 *  manual leagues, missing rounds, or when nothing is due. */
export async function autoAdvanceRound(
  deps: Deps,
  league: League,
  round: Round | undefined,
): Promise<Round | undefined> {
  if (!round || league.progression !== "timed") return round;

  let advanced = false;

  // submitting → previewing (build the playlist, best-effort)
  if (round.status === "submitting" && past(round.submissionDeadline)) {
    round.status = "previewing";
    if (!round.playlistUrl) {
      try {
        const subs = await deps.repo.getSubmissionsForRound(round.id);
        const url = await createPlaylistForRound(league, round, subs);
        if (url) round.playlistUrl = url;
      } catch (err) {
        console.error(`Auto-advance playlist creation failed for round ${round.id}:`, err);
      }
    }
    advanced = true;
  }

  // previewing → voting
  if (round.status === "previewing" && past(round.previewDeadline)) {
    round.status = "voting";
    advanced = true;
  }

  // voting → revealed (tally, bank points, persist — its own write)
  if (round.status === "voting" && past(round.voteDeadline)) {
    await finalizeReveal(deps, round);
    return round;
  }

  if (advanced) await deps.repo.updateRound(round);
  return round;
}
