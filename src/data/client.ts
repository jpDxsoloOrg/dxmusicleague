// The frontend data-access port. Pages talk to a `DataClient`, never to the
// mock store or fetch directly — the same seam pattern as the music providers
// and the auth backends. Two implementations (mockClient.ts, apiClient.ts) are
// chosen by env in data/index.ts, so the app runs fully on mock data locally
// and against the deployed API on AWS.
//
// Return shapes are exactly today's mock functions (src/data/mock.ts), so the
// pages only change *how* they fetch (async), not what they render.

import type { League } from "../domain/types";
import type {
  CreateLeagueInput,
  JoinResult,
  LeagueDetail,
  LeagueSummary,
  RoundResult,
  Standing,
  VotableSubmission,
} from "./mock";

export interface DataClient {
  // ---- League loop (backed by the deployed API) ----
  getMyLeagueSummaries(): Promise<LeagueSummary[]>;
  getLeagueDetail(leagueId: string): Promise<LeagueDetail | undefined>;
  createLeague(input: CreateLeagueInput): Promise<League>;
  joinLeague(code: string): Promise<JoinResult>;
  getStandings(leagueId: string): Promise<Standing[]>;

  // ---- Round / voting (not on the backend yet — build-order steps 3-4) ----
  getVotableSubmissions(leagueId: string): Promise<VotableSubmission[]>;
  saveVoteComments(leagueId: string, comments: Record<string, string>): Promise<void>;
  getRoundResults(leagueId: string): Promise<RoundResult[]>;
}
