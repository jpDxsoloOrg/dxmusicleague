// The rules engine — pure functions, no I/O. This is "the server is the
// referee": the same rules the frontend mirrors for UX are enforced here so a
// hand-crafted request can't break the game. See docs/data-model-and-api.md §2.

import type { LeagueSettings } from "./types.ts";
import { badRequest } from "./errors.ts";
import { inMatchup, matchupState, votableMatchups } from "./matchups.ts";
import type { RoundMatchup, RoundMatchupSet } from "./matchups.ts";

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

/**
 * Validate a head-to-head ballot — the winner-pick analog of `validateBallot`.
 * `picks` is the raw map from the request body (matchupId -> the submissionId
 * picked to win it); `matchups` is the round's derived set with songs attached
 * (`deriveRoundMatchups` / handlers `loadRoundMatchups`, HTH-05), departures
 * applied. `asScheduled` is the same round derived as if nobody had departed
 * (`{ departed: [] }`) — only used to recognise picks made before a departure
 * (below); without it every walkover / no-contest pick is dropped. Throws
 * ApiError(400) on the first broken rule; returns the cleaned picks on pass:
 *
 *   - every pick names a matchup of THIS round (unknown / another round's id
 *     → reject; the bye is not a matchup, so nothing can be picked "in" it);
 *   - no pick in the voter's own matchup, ever — the self-vote rule
 *     (`allowSelfVote` doesn't apply: a matchup ballot can't be self-voted);
 *   - in a contest, the pick is the id of one of that matchup's two songs
 *     (not another matchup's, not the bye's exhibition song, not made up, not
 *     a non-string);
 *   - a pick in a walkover or no-contest matchup is never rejected and never
 *     counts: such a matchup takes no votes. A departure mid-voting turns a
 *     contest the voter may already have picked in into a walkover, which
 *     my-ballot pre-fills on a re-cast (possibly naming the departed player's
 *     now-withdrawn song). That pick — one of the pair's two songs as
 *     scheduled — is KEPT, so if the player rejoins (the pair is a contest
 *     again) the ballot still holds it; anything else there is dropped. The
 *     tally (HTH-07) counts only picks in matchups that are contests at the
 *     reveal, so a kept pick on a walkover is inert;
 *   - completeness, the exact-spend analog: a pick in EVERY votable matchup —
 *     `votableMatchups` (domain/matchups.ts), THE votable-set definition the
 *     tally and the who-can-vote checks share: every contest except the
 *     voter's own. So the bye player picks in all of them, a paired player in
 *     all but their own. A voter with nothing votable (e.g. a two-player
 *     league) passes with no picks — their ballot can still carry comments
 *     (HTH-08 must not count such a ballot row as a vote; see
 *     `votableMatchups`).
 */
export function validateH2HBallot(
  picks: unknown,
  matchups: RoundMatchupSet,
  voterId: string,
  asScheduled?: RoundMatchupSet,
): Record<string, string> {
  if (picks !== undefined && picks !== null && (typeof picks !== "object" || Array.isArray(picks))) {
    throw badRequest("Picks must map each matchup to the song you picked to win it.");
  }
  const byId = new Map(matchups.matchups.map((m) => [m.matchupId, m]));
  const scheduledById = new Map((asScheduled?.matchups ?? []).map((m) => [m.matchupId, m]));

  const cleaned: Record<string, string> = {};
  for (const [matchupId, submissionId] of Object.entries((picks ?? {}) as Record<string, unknown>)) {
    const matchup = byId.get(matchupId);
    if (!matchup) throw badRequest(`Unknown matchup in ballot: ${matchupId}`);
    if (inMatchup(matchup, voterId)) throw badRequest("You can't pick a winner in your own matchup.");
    if (matchupState(matchup) !== "contest") {
      // Walkover / no contest: takes no votes. Keep a pick from before a
      // departure (a song of the pair as scheduled), drop anything else.
      const scheduled = scheduledById.get(matchupId);
      if (scheduled && matchupState(scheduled) === "contest" && isSongOf(scheduled, submissionId)) {
        cleaned[matchupId] = submissionId;
      }
      continue;
    }
    if (typeof submissionId !== "string") {
      throw badRequest("Each pick must be the id of one of the matchup's two songs.");
    }
    if (!isSongOf(matchup, submissionId)) {
      throw badRequest(`That song isn't in matchup ${matchupId}: pick one of its two songs.`);
    }
    cleaned[matchupId] = submissionId;
  }

  const votable = votableMatchups(matchups, voterId);
  const picked = votable.filter((m) => Object.hasOwn(cleaned, m.matchupId)).length;
  if (picked !== votable.length) {
    const n = votable.length;
    throw badRequest(
      `Pick a winner in every matchup you can vote in: ${n} ${n === 1 ? "matchup" : "matchups"} (you picked ${picked}).`,
    );
  }
  return cleaned;
}

/** Is `submissionId` the id of one of the matchup's songs (sides with a song)? */
function isSongOf(m: RoundMatchup, submissionId: unknown): submissionId is string {
  return (
    typeof submissionId === "string" && (submissionId === m.a.submission?.id || submissionId === m.b.submission?.id)
  );
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
