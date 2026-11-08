// The frontend data-access port. Pages talk to a `DataClient`, never to the
// mock store or fetch directly — the same seam pattern as the music providers
// and the auth backends. Two implementations (mockClient.ts, apiClient.ts) are
// chosen by env in data/index.ts, so the app runs fully on mock data locally
// and against the deployed API on AWS.
//
// Round/submission/vote operations are round-centric (they take a roundId — the
// league's current round, resolved from the league detail), matching the REST
// API. Return shapes match the view-model types in src/data/mock.ts.
//
// Head-to-head leagues (HTH-09) add matchups (`getMatchups`), winner-pick
// ballots (`castMatchupBallot`, `MyBallot.picks`) and matchup results: both
// results methods resolve to the `RoundResults` union — `format: "standard"`
// with the ranked list, or `format: "headToHead"` with matchups + bye — so
// pages branch on `results.format` (and on `leagueFormat(league)` elsewhere).

import type { League, LeagueSettings, Round, RoundStatus, Submission } from "../domain/types";
import type { Track } from "../music";
import type {
  BrowseLeagueSummary,
  CreateLeagueInput,
  JoinResult,
  LeagueDetail,
  LeagueSummary,
  MyBallot,
  PublicLeaguePreview,
  PublicLeagueSummary,
  RoundMatchups,
  RoundResults,
  Standing,
  VotableSubmission,
} from "./mock";

export interface CreateRoundInput {
  theme: string;
  description?: string;
}

/** The league settings an owner can edit. Self-voting isn't one: it is never
 *  allowed (BUG-17), so `allowSelfVote` is never sent. */
export type EditableLeagueSettings = Pick<
  LeagueSettings,
  "votePoolSize" | "maxPointsPerSong" | "submissionsPerPlayer" | "downvotePoolSize"
>;

export interface DataClient {
  // ---- Leagues ----
  getMyLeagueSummaries(): Promise<LeagueSummary[]>;
  getLeagueDetail(leagueId: string): Promise<LeagueDetail | undefined>;
  createLeague(input: CreateLeagueInput): Promise<League>;
  joinLeague(code: string): Promise<JoinResult>;
  /** Discover open public leagues to claim a spot in (not-yet-started, has slots). */
  getPublicLeagues(): Promise<PublicLeagueSummary[]>;
  /** Leagues in progress (any visibility) the caller isn't in — spectate-only. */
  getBrowseLeagues(): Promise<BrowseLeagueSummary[]>;
  /** Non-member preview of one public league; undefined if private/missing. */
  getPublicLeaguePreview(leagueId: string): Promise<PublicLeaguePreview | undefined>;
  /** Claim a spot in an open public league (creates the caller's membership). */
  claimSpot(leagueId: string): Promise<JoinResult>;
  /** Leave a league — removes the caller's own membership. */
  leaveLeague(leagueId: string): Promise<void>;
  /** Owner-only: remove another member from the league. */
  kickMember(leagueId: string, userId: string): Promise<void>;
  /** Owner-only: mint a fresh invite code — the old code/link stops working. */
  regenerateInvite(leagueId: string): Promise<League>;
  getStandings(leagueId: string): Promise<Standing[]>;
  /** Owner-only: update the league's voting settings. */
  updateLeagueSettings(leagueId: string, settings: EditableLeagueSettings): Promise<League>;
  /** Owner-only: permanently delete a league and all its data. */
  deleteLeague(leagueId: string): Promise<void>;
  /** Owner-only, once a league has finished: create a fresh league with the
   *  same players + settings (standings reset). Returns the new league. */
  rematchLeague(leagueId: string): Promise<League>;

  // ---- Rounds (league owner) ----
  createRound(leagueId: string, input: CreateRoundInput): Promise<Round>;
  advanceRound(leagueId: string, roundId: string, status: RoundStatus): Promise<Round>;
  /** Owner-only: close voting and reveal — resolves to the round's results
   *  (same union as `getResults`). */
  revealRound(roundId: string): Promise<RoundResults>;

  // ---- Submissions ----
  /** Submit a pick. Allowance 1 → replaces the existing pick; larger → adds
   *  one until the league's submissionsPerPlayer cap is reached. */
  submitSong(roundId: string, track: Track, comment?: string): Promise<Submission>;
  getVotableSubmissions(roundId: string): Promise<VotableSubmission[]>;
  /** The caller's own picks for a round (empty if none) — shown while awaiting others. */
  getMySubmissions(roundId: string): Promise<Submission[]>;
  /** Remove one of the caller's own picks while the round is still submitting. */
  removeSubmission(roundId: string, submissionId: string): Promise<void>;

  // ---- Voting + results ----
  /** Standard (points) ballot. A head-to-head round refuses it. */
  castBallot(
    roundId: string,
    allocations: Record<string, number>,
    comments?: Record<string, string>,
    downvotes?: Record<string, number>,
  ): Promise<void>;
  /** Head-to-head ballot: `picks` maps each matchupId to the submission id
   *  picked to win it — one per votable matchup (both songs present, not the
   *  caller's own). Comments may go on any song of the round. Re-casting
   *  overwrites. The server referees (400 with a readable message); a
   *  standard round refuses it. */
  castMatchupBallot(roundId: string, picks: Record<string, string>, comments?: Record<string, string>): Promise<void>;
  /** The caller's cast ballot for a round (null until they've voted) —
   *  pre-fills the vote page so an edit doesn't silently wipe earlier
   *  points/comments (or, head-to-head, picks). */
  getMyBallot(roundId: string): Promise<MyBallot | null>;
  /** Head-to-head only: the round's matchups, anonymous, with the caller's
   *  own flagged `isMine`, plus the bye's exhibition song. Members from
   *  voting on; anyone once revealed. Rejects for a standard round. */
  getMatchups(roundId: string): Promise<RoundMatchups>;
  /** A revealed round's results, either format. */
  getResults(roundId: string): Promise<RoundResults>;
}
