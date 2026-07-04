// MockClient — wraps the in-memory mock store (mock.ts) as an async DataClient.
// Used for local development with no AWS. Round lifecycle ops mutate the mock
// `rounds` array so the demo stays coherent; the vote/reveal screens keep using
// the canned canonical submissions. Everything resolves instantly.

import type { League, Round, RoundStatus, Submission } from "../domain/types";
import type { Track } from "../music";
import type { CreateRoundInput, DataClient, EditableLeagueSettings } from "./client";
import {
  claimPublicSpot,
  createLeague,
  currentUser,
  deleteLeague,
  getLeagueDetail,
  getMyLeagueSummaries,
  getOpenPublicLeagues,
  getPublicLeaguePreview,
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
  type PublicLeaguePreview,
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
  async getPublicLeaguePreview(leagueId: string): Promise<PublicLeaguePreview | undefined> {
    return getPublicLeaguePreview(leagueId);
  }
  async claimSpot(leagueId: string): Promise<JoinResult> {
    return claimPublicSpot(leagueId);
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

  // Remembers the current user's pick per round so the round page can show it
  // back (the real backend persists this; the mock keeps it in memory).
  private mySubs = new Map<string, Submission>();

  async submitSong(roundId: string, track: Track, comment?: string): Promise<Submission> {
    const sub: Submission = { id: `sub-mock-${roundId}`, roundId, userId: currentUser.id, track, comment };
    this.mySubs.set(roundId, sub);
    return sub;
  }
  async getVotableSubmissions(roundId: string): Promise<VotableSubmission[]> {
    return getVotableSubmissions(roundId);
  }
  async getMySubmission(roundId: string): Promise<Submission | null> {
    return this.mySubs.get(roundId) ?? null;
  }

  async castBallot(roundId: string, _allocations: Record<string, number>, comments?: Record<string, string>): Promise<void> {
    saveVoteComments(roundId, comments ?? {});
  }
  async getResults(roundId: string): Promise<RoundResult[]> {
    return getRoundResults(roundId);
  }
}
