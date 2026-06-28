// The rules engine — pure functions, no I/O. This is "the server is the
// referee": the same rules the frontend mirrors for UX are enforced here so a
// hand-crafted request can't break the game. See docs/data-model-and-api.md §2.

import type { LeagueSettings } from "./types.ts";
import { badRequest } from "./errors.ts";

export interface BallotInput {
  allocations: Record<string, number>;
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
 * broken rule; returns the cleaned allocations (only positive entries) on pass.
 * Mirrors the 6 ballot rules in the design doc.
 */
export function validateBallot(input: BallotInput, ctx: BallotContext): Record<string, number> {
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

  // Keep only the songs that actually received points.
  const cleaned: Record<string, number> = {};
  for (const [submissionId, points] of entries) {
    if (points > 0) cleaned[submissionId] = points;
  }
  return cleaned;
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
 * `ballots` is a list of allocation maps (submissionId -> points).
 */
export function tallyBallots(
  ballots: Array<Record<string, number>>,
): Map<string, { points: number; distinctVoters: number }> {
  const tally = new Map<string, { points: number; distinctVoters: number }>();
  for (const allocations of ballots) {
    for (const [submissionId, points] of Object.entries(allocations)) {
      if (points <= 0) continue;
      const cur = tally.get(submissionId) ?? { points: 0, distinctVoters: 0 };
      cur.points += points;
      cur.distinctVoters += 1;
      tally.set(submissionId, cur);
    }
  }
  return tally;
}
