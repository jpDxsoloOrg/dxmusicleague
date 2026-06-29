// Voting handlers — cast a ballot, reveal a round, read results. The actual
// game rules (full-pool ballots, per-song cap, no self-vote, the tie-break) live
// in domain/rules.ts and are reused here; these handlers just supply context and
// do the I/O. Same (deps, caller, ...) shape as the other handlers.

import type { Ballot, Track } from "../domain/types.ts";
import { badRequest, forbidden, notFound } from "../domain/errors.ts";
import { rankSubmissions, tallyBallots, validateBallot } from "../domain/rules.ts";
import type { Deps } from "./leagues.ts";

const deadlinePassed = (iso?: string): boolean => (iso ? Date.now() > new Date(iso).getTime() : false);

interface UserView { id: string; displayName: string }
interface VoterComment { voter: UserView; text: string }
interface RoundResult {
  rank: number;
  track: Track;
  submitter: UserView;
  points: number;
  comments: VoterComment[];
}

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
  // cleaned (positive-only) allocations on success.
  const cleaned = validateBallot(
    { allocations, comments: input?.comments },
    { settings: league.settings, validSubmissionIds, ownSubmissionId },
  );

  const ballot: Ballot = {
    roundId,
    voterId: caller,
    allocations: cleaned,
    comments: cleanComments(input?.comments, validSubmissionIds),
    castAt: new Date().toISOString(),
  };
  await deps.repo.putBallot(ballot); // overwrites any earlier ballot from this voter
  return { ok: true };
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

/** Pure read side: tally ballots, rank with the tie-break, attach submitter
 *  names and voter comments. Used by both reveal and GET results. */
async function computeResults(deps: Deps, roundId: string): Promise<RoundResult[]> {
  const subs = await deps.repo.getSubmissionsForRound(roundId);
  const ballots = await deps.repo.getBallotsForRound(roundId);
  const tally = tallyBallots(ballots.map((b) => b.allocations));

  const ranked = rankSubmissions(
    subs.map((s) => ({
      submissionId: s.id,
      title: s.track.title,
      points: tally.get(s.id)?.points ?? 0,
      distinctVoters: tally.get(s.id)?.distinctVoters ?? 0,
      userId: s.userId,
      track: s.track,
    })),
  );

  return Promise.all(
    ranked.map(async (r) => ({
      rank: r.rank,
      track: r.track,
      submitter: { id: r.userId, displayName: await deps.users.getDisplayName(r.userId) },
      points: r.points,
      comments: await commentsFor(deps, r.submissionId, ballots),
    })),
  );
}

async function commentsFor(deps: Deps, submissionId: string, ballots: Ballot[]): Promise<VoterComment[]> {
  const withComment = ballots.filter((b) => b.comments?.[submissionId]);
  return Promise.all(
    withComment.map(async (b) => ({
      voter: { id: b.voterId, displayName: await deps.users.getDisplayName(b.voterId) },
      text: b.comments![submissionId]!,
    })),
  );
}

export async function revealRound(deps: Deps, caller: string, roundId: string): Promise<RoundResult[]> {
  const round = await deps.repo.getRound(roundId);
  if (!round) throw notFound("That round doesn't exist.");
  const league = await deps.repo.getLeague(round.leagueId);
  if (!league) throw notFound("That league doesn't exist.");
  if (league.ownerId !== caller) throw forbidden("Only the league owner can reveal a round.");
  if (round.status !== "voting") throw badRequest("Only a round that's in voting can be revealed.");

  const results = await computeResults(deps, roundId);

  // Add each submission's points to its submitter's running season total.
  for (const r of results) {
    if (r.points > 0) await deps.repo.addStandingPoints(round.leagueId, r.submitter.id, r.points);
  }

  round.status = "revealed";
  await deps.repo.updateRound(round);
  return results;
}

export async function getResults(deps: Deps, caller: string, roundId: string): Promise<RoundResult[]> {
  const { round } = await roundForMember(deps, caller, roundId);
  if (round.status !== "revealed" && round.status !== "complete") {
    throw badRequest("Results aren't available until the round is revealed.");
  }
  return computeResults(deps, roundId);
}
