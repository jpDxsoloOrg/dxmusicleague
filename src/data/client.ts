// The frontend data-access port. Pages talk to a `DataClient`, never to the
// mock store or fetch directly — the same seam pattern as the music providers
// and the auth backends. Two implementations (mockClient.ts, apiClient.ts) are
// chosen by env in data/index.ts, so the app runs fully on mock data locally
// and against the deployed API on AWS.
//
// Round/submission/vote operations are round-centric (they take a roundId — the
// league's current round, resolved from the league detail), matching the REST
// API. Return shapes match the view-model types in src/data/mock.ts.

import type { League, LeagueSettings, Round, RoundStatus, Submission } from "../domain/types";
import type { Track } from "../music";
import type {
  BrowseLeagueSummary,
  CreateLeagueInput,
  JoinResult,
  LeagueDetail,
  LeagueSummary,
  PublicLeaguePreview,
  PublicLeagueSummary,
  RoundResult,
  Standing,
  VotableSubmission,
} from "./mock";

export interface CreateRoundInput {
  theme: string;
  description?: string;
}

/** The league settings an owner can edit. */
export type EditableLeagueSettings = Pick<
  LeagueSettings,
  "votePoolSize" | "maxPointsPerSong" | "allowSelfVote" | "submissionsPerPlayer" | "downvotePoolSize"
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

  // ---- Rounds (league owner) ----
  createRound(leagueId: string, input: CreateRoundInput): Promise<Round>;
  advanceRound(leagueId: string, roundId: string, status: RoundStatus): Promise<Round>;
  revealRound(roundId: string): Promise<RoundResult[]>;

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
  castBallot(
    roundId: string,
    allocations: Record<string, number>,
    comments?: Record<string, string>,
    downvotes?: Record<string, number>,
  ): Promise<void>;
  /** The caller's cast ballot for a round (null before voting) — pre-fills the
   *  vote page so an edit doesn't silently wipe earlier points/comments. */
  getMyBallot(roundId: string): Promise<{
    allocations: Record<string, number>;
    downvotes: Record<string, number>;
    comments: Record<string, string>;
  } | null>;
  getResults(roundId: string): Promise<RoundResult[]>;
}
