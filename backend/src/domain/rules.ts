// The rules engine — pure functions, no I/O. This is "the server is the
// referee": the same rules the frontend mirrors for UX are enforced here so a
// hand-crafted request can't break the game. See docs/data-model-and-api.md §2.

import type { LeagueSettings } from "./types.ts";
import { badRequest } from "./errors.ts";

export interface BallotInput {
  allocations: Record<string, number>;
  /** submissionId -> anti-votes; each subtracts a point at tally. */
  downvotes?: Record<string, number>;
  comments?: Record<string, string>;
}

export interface BallotContext {
  settings: LeagueSettings;
  /** Submission ids that exist in this round. */
  validSubmissionIds: Set<string>;
  /** The caller's own submission id in this round, if any. */
  ownSubmissionId?: string;
}

/**
 * Validate a ballot as a complete unit. Throws ApiError(400) on the first
 * broken rule; returns the cleaned allocations and downvotes (positive entries
 * only) on pass. Mirrors the ballot rules in the design doc. The vote pool
 * must be spent exactly; anti-votes are optional (0 up to downvotePoolSize).
 */
export function validateBallot(
  input: BallotInput,
  ctx: BallotContext,
): { allocations: Record<string, number>; downvotes: Record<string, number> } {
  const { settings, validSubmissionIds, ownSubmissionId } = ctx;
  const entries = Object.entries(input.allocations);

  let total = 0;
  for (const [submissionId, points] of entries) {
    if (!validSubmissionIds.has(submissionId)) {
      throw badRequest(`Unknown submission in ballot: ${submissionId}`);
    }
    if (!Number.isInteger(points) || points < 0) {
      throw badRequest("Each allocation must be a whole number of points, 0 or more.");
    }
    if (points > settings.maxPointsPerSong) {
      throw badRequest(`No song may get more than ${settings.maxPointsPerSong} points.`);
    }
    if (!settings.allowSelfVote && submissionId === ownSubmissionId && points > 0) {
      throw badRequest("You can't vote for your own submission.");
    }
    total += points;
  }

  if (total !== settings.votePoolSize) {
    throw badRequest(`You must spend exactly ${settings.votePoolSize} points (you spent ${total}).`);
  }

  const downvotePool = settings.downvotePoolSize ?? 0;
  const downEntries = Object.entries(input.downvotes ?? {});
  let downTotal = 0;
  for (const [submissionId, antiVotes] of downEntries) {
    if (!validSubmissionIds.has(submissionId)) {
      throw badRequest(`Unknown submission in ballot: ${submissionId}`);
    }
    if (!Number.isInteger(antiVotes) || antiVotes < 0) {
      throw badRequest("Each anti-vote must be a whole number, 0 or more.");
    }
    if (!settings.allowSelfVote && submissionId === ownSubmissionId && antiVotes > 0) {
      throw badRequest("You can't anti-vote your own submission.");
    }
    downTotal += antiVotes;
  }
  if (downTotal > downvotePool) {
    throw badRequest(
      downvotePool === 0
        ? "This league doesn't use anti-votes."
        : `You have at most ${downvotePool} anti-votes to spend (you spent ${downTotal}).`,
    );
  }

  // Keep only the songs that actually received points / anti-votes.
  const cleaned: Record<string, number> = {};
  for (const [submissionId, points] of entries) {
    if (points > 0) cleaned[submissionId] = points;
  }
  const cleanedDown: Record<string, number> = {};
  for (const [submissionId, antiVotes] of downEntries) {
    if (antiVotes > 0) cleanedDown[submissionId] = antiVotes;
  }
  return { allocations: cleaned, downvotes: cleanedDown };
}

export interface Tallyable {
  submissionId: string;
  title: string;
  points: number;
  /** Count of distinct voters who placed > 0 points on this submission. */
  distinctVoters: number;
}

/**
 * Rank submissions with the fixed tie-break:
 *   points desc → distinct-voter count desc → title A→Z.
 * Returns the same items, sorted, each tagged with its 1-based rank.
 */
export function rankSubmissions<T extends Tallyable>(items: T[]): Array<T & { rank: number }> {
  return [...items]
    .sort(
      (a, b) =>
        b.points - a.points ||
        b.distinctVoters - a.distinctVoters ||
        a.title.localeCompare(b.title),
    )
    .map((item, i) => ({ ...item, rank: i + 1 }));
}

/**
 * Tally raw ballots into per-submission point totals + distinct-voter counts.
 * Anti-votes subtract from the total (which may go negative); only positive
 * votes count toward the distinct-voter tie-break.
 */
export interface TallyEntry {
  /** Net total: pointsFor − pointsAgainst. May be negative. */
  points: number;
  distinctVoters: number;
  /** Sum of positive votes. */
  pointsFor: number;
  /** Sum of anti-votes (as a positive number). */
  pointsAgainst: number;
}

export function tallyBallots(
  ballots: Array<{ allocations: Record<string, number>; downvotes?: Record<string, number> }>,
): Map<string, TallyEntry> {
  const tally = new Map<string, TallyEntry>();
  const entry = (submissionId: string): TallyEntry => {
    const cur = tally.get(submissionId) ?? { points: 0, distinctVoters: 0, pointsFor: 0, pointsAgainst: 0 };
    tally.set(submissionId, cur);
    return cur;
  };
  for (const ballot of ballots) {
    for (const [submissionId, points] of Object.entries(ballot.allocations)) {
      if (points <= 0) continue;
      const cur = entry(submissionId);
      cur.points += points;
      cur.pointsFor += points;
      cur.distinctVoters += 1;
    }
    for (const [submissionId, antiVotes] of Object.entries(ballot.downvotes ?? {})) {
      if (antiVotes <= 0) continue;
      const cur = entry(submissionId);
      cur.points -= antiVotes;
      cur.pointsAgainst += antiVotes;
    }
  }
  return tally;
}
