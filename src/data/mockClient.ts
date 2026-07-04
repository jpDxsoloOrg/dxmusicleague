// MockClient — wraps the in-memory mock store (mock.ts) as an async DataClient.
// Used for local development with no AWS. Round lifecycle ops mutate the mock
// `rounds` array so the demo stays coherent; the vote/reveal screens keep using
// the canned canonical submissions. Everything resolves instantly.

import type { League, Round, RoundStatus, Submission } from "../domain/types";
import type { Track } from "../music";
import type { CreateRoundInput, DataClient, EditableLeagueSettings } from "./client";
import {
  createLeague,
  currentUser,
  deleteLeague,
  getLeagueDetail,
  getMyLeagueSummaries,
  getOpenPublicLeagues,
  getRoundResults,
  getStandings,
  getVotableSubmissions,
  joinLeague,
  rounds,
  saveVoteComments,
  updateLeagueSettings,
  type CreateLeagueInput,
  type JoinResult,
  type LeagueDetail,
  type LeagueSummary,
  type PublicLeagueSummary,
  type RoundResult,
  type Standing,
  type VotableSubmission,
} from "./mock";

let mockRoundSeq = 0;

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
  async getPublicLeagues(): Promise<PublicLeagueSummary[]> {
    return getOpenPublicLeagues();
  }
  async updateLeagueSettings(leagueId: string, settings: EditableLeagueSettings): Promise<League> {
    return updateLeagueSettings(leagueId, settings);
  }
  async deleteLeague(leagueId: string): Promise<void> {
    deleteLeague(leagueId);
  }
  async getStandings(leagueId: string): Promise<Standing[]> {
    return getStandings(leagueId);
  }

  async createRound(leagueId: string, input: CreateRoundInput): Promise<Round> {
    mockRoundSeq += 1;
    const index = rounds.filter((r) => r.leagueId === leagueId).reduce((m, r) => Math.max(m, r.index), 0) + 1;
    const round: Round = {
      id: `r-mock-${mockRoundSeq}`,
      leagueId,
      index,
      theme: input.theme.trim(),
      description: input.description?.trim() || undefined,
      status: "draft",
    };
    rounds.push(round);
    return round;
  }
  async advanceRound(_leagueId: string, roundId: string, status: RoundStatus): Promise<Round> {
    const round = rounds.find((r) => r.id === roundId);
    if (!round) throw new Error("Round not found.");
    round.status = status;
    return round;
  }
  async revealRound(roundId: string): Promise<RoundResult[]> {
    const round = rounds.find((r) => r.id === roundId);
    if (round) round.status = "revealed";
    return getRoundResults(roundId);
  }

  async submitSong(roundId: string, track: Track, comment?: string): Promise<Submission> {
    // The mock vote screen uses canned submissions; just echo a stub back.
    return { id: "sub-mock", roundId, userId: currentUser.id, track, comment };
  }
  async getVotableSubmissions(roundId: string): Promise<VotableSubmission[]> {
    return getVotableSubmissions(roundId);
  }

  async castBallot(roundId: string, _allocations: Record<string, number>, comments?: Record<string, string>): Promise<void> {
    saveVoteComments(roundId, comments ?? {});
  }
  async getResults(roundId: string): Promise<RoundResult[]> {
    return getRoundResults(roundId);
  }
}
