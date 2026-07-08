// Round results — tally ballots, rank with the tie-break, and settle a round.
// Extracted from voting.ts so both the voting handlers and the timed
// auto-advance (progression.ts) can share `finalizeReveal` without an import
// cycle. Pure over the Repository port.

import type { Ballot, Round, Track } from "../domain/types.ts";
import { rankSubmissions, tallyBallots } from "../domain/rules.ts";
import type { Deps } from "./leagues.ts";

interface UserView { id: string; displayName: string }
interface VoterComment { voter: UserView; text: string }
export interface RoundResult {
  rank: number;
  track: Track;
  submitter: UserView;
  /** Net total: pointsFor − pointsAgainst. May be negative with anti-votes. */
  points: number;
  /** Sum of positive votes. */
  pointsFor: number;
  /** Sum of anti-votes (positive number; 0 when none / league has them off). */
  pointsAgainst: number;
  /** The submitter's own note about their pick, written at submit time. */
  submitterComment?: string;
  comments: VoterComment[];
}

/** Tally ballots, rank with the tie-break, attach submitter names and voter
 *  comments. Used by reveal and GET results. */
export async function computeResults(deps: Deps, roundId: string): Promise<RoundResult[]> {
  const subs = await deps.repo.getSubmissionsForRound(roundId);
  const ballots = await deps.repo.getBallotsForRound(roundId);
  const tally = tallyBallots(ballots.map((b) => ({ allocations: b.allocations, downvotes: b.downvotes })));

  const ranked = rankSubmissions(
    subs.map((s) => ({
      submissionId: s.id,
      title: s.track.title,
      points: tally.get(s.id)?.points ?? 0,
      distinctVoters: tally.get(s.id)?.distinctVoters ?? 0,
      pointsFor: tally.get(s.id)?.pointsFor ?? 0,
      pointsAgainst: tally.get(s.id)?.pointsAgainst ?? 0,
      userId: s.userId,
      track: s.track,
    })),
  );

  const noteBySubmission = new Map(subs.map((s) => [s.id, s.comment]));
  return Promise.all(
    ranked.map(async (r) => ({
      rank: r.rank,
      track: r.track,
      submitter: { id: r.userId, displayName: await deps.users.getDisplayName(r.userId) },
      points: r.points,
      pointsFor: r.pointsFor,
      pointsAgainst: r.pointsAgainst,
      submitterComment: noteBySubmission.get(r.submissionId) || undefined,
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

/** Tally + rank a voting round, bank each submitter's points, mark it revealed,
 *  and persist. Shared by the owner reveal endpoint and timed auto-advance, so
 *  both settle a round identically. Mutates `round.status`. */
export async function finalizeReveal(deps: Deps, round: Round): Promise<RoundResult[]> {
  const results = await computeResults(deps, round.id);
  for (const r of results) {
    // Negative totals (anti-votes) bank too — the leaderboard can go below 0.
    if (r.points !== 0) await deps.repo.addStandingPoints(round.leagueId, r.submitter.id, r.points);
  }
  round.status = "revealed";
  await deps.repo.updateRound(round);
  return results;
}
