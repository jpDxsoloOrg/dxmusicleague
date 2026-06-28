// MockClient — wraps the in-memory mock store (mock.ts) as an async DataClient.
// Used for local development with no AWS. Everything resolves instantly; the
// async signatures just match the ApiClient so pages are written one way.

import type { League } from "../domain/types";
import type { DataClient } from "./client";
import {
  createLeague,
  getLeagueDetail,
  getMyLeagueSummaries,
  getRoundResults,
  getStandings,
  getVotableSubmissions,
  joinLeague,
  saveVoteComments,
  type CreateLeagueInput,
  type JoinResult,
  type LeagueDetail,
  type LeagueSummary,
  type RoundResult,
  type Standing,
  type VotableSubmission,
} from "./mock";

export class MockClient implements DataClient {
  async getMyLeagueSummaries(): Promise<LeagueSummary[]> {
    return getMyLeagueSummaries();
  }
  async getLeagueDetail(leagueId: string): Promise<LeagueDetail | undefined> {
    return getLeagueDetail(leagueId);
  }
  async createLeague(input: CreateLeagueInput): Promise<League> {
    return createLeague(input);
  }
  async joinLeague(code: string): Promise<JoinResult> {
    return joinLeague(code);
  }
  async getStandings(leagueId: string): Promise<Standing[]> {
    return getStandings(leagueId);
  }
  async getVotableSubmissions(leagueId: string): Promise<VotableSubmission[]> {
    return getVotableSubmissions(leagueId);
  }
  async saveVoteComments(leagueId: string, comments: Record<string, string>): Promise<void> {
    saveVoteComments(leagueId, comments);
  }
  async getRoundResults(leagueId: string): Promise<RoundResult[]> {
    return getRoundResults(leagueId);
  }
}
