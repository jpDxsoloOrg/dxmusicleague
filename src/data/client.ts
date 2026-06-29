// The frontend data-access port. Pages talk to a `DataClient`, never to the
// mock store or fetch directly — the same seam pattern as the music providers
// and the auth backends. Two implementations (mockClient.ts, apiClient.ts) are
// chosen by env in data/index.ts, so the app runs fully on mock data locally
// and against the deployed API on AWS.
//
// Round/submission/vote operations are round-centric (they take a roundId — the
// league's current round, resolved from the league detail), matching the REST
// API. Return shapes match the view-model types in src/data/mock.ts.

import type { League, Round, RoundStatus, Submission } from "../domain/types";
import type { Track } from "../music";
import type {
  CreateLeagueInput,
  JoinResult,
  LeagueDetail,
  LeagueSummary,
  RoundResult,
  Standing,
  VotableSubmission,
} from "./mock";

export interface CreateRoundInput {
  theme: string;
  description?: string;
}

export interface DataClient {
  // ---- Leagues ----
  getMyLeagueSummaries(): Promise<LeagueSummary[]>;
  getLeagueDetail(leagueId: string): Promise<LeagueDetail | undefined>;
  createLeague(input: CreateLeagueInput): Promise<League>;
  joinLeague(code: string): Promise<JoinResult>;
  getStandings(leagueId: string): Promise<Standing[]>;

  // ---- Rounds (league owner) ----
  createRound(leagueId: string, input: CreateRoundInput): Promise<Round>;
  advanceRound(leagueId: string, roundId: string, status: RoundStatus): Promise<Round>;
  revealRound(roundId: string): Promise<RoundResult[]>;

  // ---- Submissions ----
  submitSong(roundId: string, track: Track, comment?: string): Promise<Submission>;
  getVotableSubmissions(roundId: string): Promise<VotableSubmission[]>;

  // ---- Voting + results ----
  castBallot(roundId: string, allocations: Record<string, number>, comments?: Record<string, string>): Promise<void>;
  getResults(roundId: string): Promise<RoundResult[]>;
}
