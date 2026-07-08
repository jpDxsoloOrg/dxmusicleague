// Voting handlers — cast a ballot, reveal a round, read results. The actual
// game rules (full-pool ballots, per-song cap, no self-vote, the tie-break) live
// in domain/rules.ts and are reused here; these handlers just supply context and
// do the I/O. Same (deps, caller, ...) shape as the other handlers.

import type { Ballot } from "../domain/types.ts";
import { badRequest, forbidden, notFound } from "../domain/errors.ts";
import { validateBallot } from "../domain/rules.ts";
import { computeResults, finalizeReveal, type RoundResult } from "./results.ts";
import { autoAdvanceRound } from "./progression.ts";
import type { Deps } from "./leagues.ts";

const deadlinePassed = (iso?: string): boolean => (iso ? Date.now() > new Date(iso).getTime() : false);

/** Load a round + league, asserting league membership. */
async function roundForMember(deps: Deps, caller: string, roundId: string) {
  const round = await deps.repo.getRound(roundId);
  if (!round) throw notFound("That round doesn't exist.");
  const league = await deps.repo.getLeague(round.leagueId);
  if (!league || !league.memberIds.includes(caller)) {
    throw forbidden("You're not a member of this league.");
  }
  return { round, league };
}

export interface CastBallotInput {
  allocations: Record<string, number>;
  downvotes?: Record<string, number>;
  comments?: Record<string, string>;
}

export async function castBallot(
  deps: Deps,
  caller: string,
  roundId: string,
  input: CastBallotInput,
): Promise<{ ok: true }> {
  const { round, league } = await roundForMember(deps, caller, roundId);
  if (round.status !== "voting") throw badRequest("This round isn't open for voting.");
  if (deadlinePassed(round.voteDeadline)) throw badRequest("The voting deadline has passed.");

  const subs = await deps.repo.getSubmissionsForRound(roundId);
  const validSubmissionIds = new Set(subs.map((s) => s.id));
  const ownSubmissionId = subs.find((s) => s.userId === caller)?.id;

  const allocations = input?.allocations && typeof input.allocations === "object" ? input.allocations : {};

  // The rules engine throws ApiError(400) on any broken rule; returns the
  // cleaned (positive-only) allocations and downvotes on success.
  const cleaned = validateBallot(
    { allocations, downvotes: input?.downvotes, comments: input?.comments },
    { settings: league.settings, validSubmissionIds, ownSubmissionId },
  );

  const ballot: Ballot = {
    roundId,
    voterId: caller,
    allocations: cleaned.allocations,
    downvotes: cleaned.downvotes,
    comments: cleanComments(input?.comments, validSubmissionIds),
    castAt: new Date().toISOString(),
  };
  await deps.repo.putBallot(ballot); // overwrites any earlier ballot from this voter
  // Timed leagues: if this was the last outstanding vote, reveal the round now
  // rather than waiting for the deadline.
  await autoAdvanceRound(deps, league, round);
  return { ok: true };
}

/** The caller's own cast ballot for a round (or null before they vote), so the
 *  vote page can pre-fill points + comments instead of starting blank — a blind
 *  re-cast used to silently wipe the earlier ballot's comments. */
export async function getMyBallot(
  deps: Deps,
  caller: string,
  roundId: string,
): Promise<{
  allocations: Record<string, number>;
  downvotes: Record<string, number>;
  comments: Record<string, string>;
} | null> {
  await roundForMember(deps, caller, roundId);
  const ballot = await deps.repo.getBallot(roundId, caller);
  return ballot
    ? { allocations: ballot.allocations, downvotes: ballot.downvotes ?? {}, comments: ballot.comments ?? {} }
    : null;
}

/** Keep only comments on real submissions, trimmed and non-empty. */
function cleanComments(raw: unknown, validIds: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const [id, text] of Object.entries(raw as Record<string, unknown>)) {
      if (validIds.has(id) && typeof text === "string" && text.trim()) out[id] = text.trim();
    }
  }
  return out;
}

export async function revealRound(deps: Deps, caller: string, roundId: string): Promise<RoundResult[]> {
  const round = await deps.repo.getRound(roundId);
  if (!round) throw notFound("That round doesn't exist.");
  const league = await deps.repo.getLeague(round.leagueId);
  if (!league) throw notFound("That league doesn't exist.");
  if (league.ownerId !== caller) throw forbidden("Only the league owner can reveal a round.");
  if (round.status !== "voting") throw badRequest("Only a round that's in voting can be revealed.");

  return finalizeReveal(deps, round);
}

export async function getResults(deps: Deps, caller: string, roundId: string): Promise<RoundResult[]> {
  const { round } = await roundForMember(deps, caller, roundId);
  if (round.status !== "revealed" && round.status !== "complete") {
    throw badRequest("Results aren't available until the round is revealed.");
  }
  return computeResults(deps, roundId);
}
