// MockClient — wraps the in-memory mock store (mock.ts) as an async DataClient.
// Used for local development with no AWS. Round lifecycle ops mutate the mock
// `rounds` array so the demo stays coherent; for standard leagues the
// vote/reveal screens keep using the canned canonical submissions. Head-to-head
// leagues (HTH-09) dispatch to mock.ts's H2H section instead, which runs them
// for real over the backend's domain rules — same matchups, ballot referee,
// tally and W/L/D as the API, same error messages. Everything resolves
// instantly.

import type { League, Round, RoundStatus, Submission } from "../domain/types";
import type { Track } from "../music";
import type { CreateRoundInput, DataClient, EditableLeagueSettings } from "./client";
import {
  advanceHeadToHeadRound,
  assertCanCreateHeadToHeadRound,
  castHeadToHeadBallot,
  claimPublicSpot,
  getBrowseLeagues,
  createLeague,
  currentUser,
  deleteLeague,
  getHeadToHeadResults,
  getHeadToHeadVotableSubmissions,
  getLeagueDetail,
  getMatchups,
  getMyHeadToHeadBallot,
  getMyHeadToHeadSubmissions,
  getMyLeagueSummaries,
  getOpenPublicLeagues,
  getPublicLeaguePreview,
  getRoundResults,
  getStandings,
  getVotableSubmissions,
  isHeadToHeadLeague,
  isHeadToHeadRound,
  joinLeague,
  kickMember,
  leaveLeague,
  regenerateInvite,
  rejectPointsBallotOnHeadToHead,
  rejectSelfVotes,
  rematchLeague,
  removeHeadToHeadSubmission,
  revealHeadToHeadRound,
  rounds,
  saveVoteComments,
  submitHeadToHeadSong,
  updateLeagueSettings,
  type BrowseLeagueSummary,
  type CreateLeagueInput,
  type JoinResult,
  type LeagueDetail,
  type LeagueSummary,
  type MyBallot,
  type PublicLeaguePreview,
  type PublicLeagueSummary,
  type RoundMatchups,
  type RoundResults,
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
  async leaveLeague(leagueId: string): Promise<void> {
    leaveLeague(leagueId);
  }
  async getBrowseLeagues(): Promise<BrowseLeagueSummary[]> {
    return getBrowseLeagues();
  }
  async kickMember(leagueId: string, userId: string): Promise<void> {
    kickMember(leagueId, userId);
  }
  async regenerateInvite(leagueId: string): Promise<League> {
    return regenerateInvite(leagueId);
  }
  async updateLeagueSettings(leagueId: string, settings: EditableLeagueSettings): Promise<League> {
    return updateLeagueSettings(leagueId, settings);
  }
  async deleteLeague(leagueId: string): Promise<void> {
    deleteLeague(leagueId);
  }
  async rematchLeague(leagueId: string): Promise<League> {
    return rematchLeague(leagueId);
  }
  async getStandings(leagueId: string): Promise<Standing[]> {
    return getStandings(leagueId);
  }

  async createRound(leagueId: string, input: CreateRoundInput): Promise<Round> {
    const index = rounds.filter((r) => r.leagueId === leagueId).reduce((m, r) => Math.max(m, r.index), 0) + 1;
    assertCanCreateHeadToHeadRound(leagueId, index); // no-op for standard leagues
    mockRoundSeq += 1;
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
  async advanceRound(leagueId: string, roundId: string, status: RoundStatus): Promise<Round> {
    if (isHeadToHeadLeague(leagueId)) return advanceHeadToHeadRound(leagueId, roundId, status);
    const round = rounds.find((r) => r.id === roundId);
    if (!round) throw new Error("Round not found.");
    round.status = status;
    return round;
  }
  async revealRound(roundId: string): Promise<RoundResults> {
    if (isHeadToHeadRound(roundId)) return revealHeadToHeadRound(roundId);
    const round = rounds.find((r) => r.id === roundId);
    if (round) round.status = "revealed";
    return { format: "standard", results: getRoundResults(roundId) };
  }

  // Remembers the current user's picks per round so the round page can show
  // them back (the real backend persists these; the mock keeps them in memory).
  // Mirrors the backend rules: allowance 1 replaces, larger allowances add
  // until the cap, and a pick can be removed while submitting.
  private mySubs = new Map<string, Submission[]>();

  private allowanceForRound(roundId: string): number {
    const leagueId = rounds.find((r) => r.id === roundId)?.leagueId;
    const league = leagueId ? getLeagueDetail(leagueId)?.league : undefined;
    return league?.settings.submissionsPerPlayer || 1;
  }

  async submitSong(roundId: string, track: Track, comment?: string): Promise<Submission> {
    if (isHeadToHeadRound(roundId)) return submitHeadToHeadSong(roundId, track, comment);
    const mine = this.mySubs.get(roundId) ?? [];
    const allowance = this.allowanceForRound(roundId);
    if (allowance > 1 && mine.length >= allowance) {
      throw new Error(`You've already submitted ${allowance} songs for this round — remove one to change your picks.`);
    }
    const sub: Submission = {
      id: `sub-mock-${roundId}-${mine.length + 1}`,
      roundId,
      userId: currentUser.id,
      track,
      comment,
    };
    this.mySubs.set(roundId, allowance === 1 ? [{ ...sub, id: mine[0]?.id ?? sub.id }] : [...mine, sub]);
    return sub;
  }
  async getVotableSubmissions(roundId: string): Promise<VotableSubmission[]> {
    if (isHeadToHeadRound(roundId)) return getHeadToHeadVotableSubmissions(roundId);
    return getVotableSubmissions(roundId);
  }
  async getMySubmissions(roundId: string): Promise<Submission[]> {
    if (isHeadToHeadRound(roundId)) return getMyHeadToHeadSubmissions(roundId);
    return this.mySubs.get(roundId) ?? [];
  }
  async removeSubmission(roundId: string, submissionId: string): Promise<void> {
    if (isHeadToHeadRound(roundId)) return removeHeadToHeadSubmission(roundId, submissionId);
    const mine = this.mySubs.get(roundId) ?? [];
    this.mySubs.set(roundId, mine.filter((s) => s.id !== submissionId));
  }

  // Last cast ballot per round, so the vote page can pre-fill on a revisit.
  // (Standard rounds only — head-to-head ballots live in mock.ts's store.)
  private myBallots = new Map<
    string,
    { allocations: Record<string, number>; downvotes: Record<string, number>; comments: Record<string, string> }
  >();

  async castBallot(
    roundId: string,
    allocations: Record<string, number>,
    comments?: Record<string, string>,
    downvotes?: Record<string, number>,
  ): Promise<void> {
    if (isHeadToHeadRound(roundId)) {
      rejectPointsBallotOnHeadToHead(roundId, allocations, downvotes); // throws for any points
      return castHeadToHeadBallot(roundId, {}, comments); // an empty pick set — refereed like the API
    }
    // Never on any of the caller's own songs, in any league — as the API (BUG-17).
    rejectSelfVotes(allocations, downvotes, (this.mySubs.get(roundId) ?? []).map((s) => s.id));
    this.myBallots.set(roundId, { allocations, downvotes: downvotes ?? {}, comments: comments ?? {} });
    saveVoteComments(roundId, comments ?? {});
  }
  async castMatchupBallot(roundId: string, picks: Record<string, string>, comments?: Record<string, string>): Promise<void> {
    // The API's points path refuses picks only when there are some: an empty
    // pick set on a standard round is just an (empty) points ballot.
    if (!isHeadToHeadRound(roundId) && Object.keys(picks ?? {}).length === 0) {
      return this.castBallot(roundId, {}, comments);
    }
    castHeadToHeadBallot(roundId, picks, comments); // refuses picks on a standard round, as the API does
  }
  async getMyBallot(roundId: string): Promise<MyBallot | null> {
    if (isHeadToHeadRound(roundId)) return getMyHeadToHeadBallot(roundId);
    return this.myBallots.get(roundId) ?? null;
  }
  async getMatchups(roundId: string): Promise<RoundMatchups> {
    return getMatchups(roundId);
  }
  async getResults(roundId: string): Promise<RoundResults> {
    if (isHeadToHeadRound(roundId)) return getHeadToHeadResults(roundId);
    return { format: "standard", results: getRoundResults(roundId) };
  }
}
