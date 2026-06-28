// The data-access PORT. Handlers depend only on this interface — never on
// DynamoDB or any in-memory store directly. Two implementations exist:
//   - MemoryRepository (data/memory.ts)  — local dev + tests, no AWS
//   - DynamoRepository (data/dynamo.ts)   — the real single-table backend
// Swapping which one a handler runs against is the whole point of the seam.

import type { Ballot, League, Round, Submission } from "../domain/types.ts";

export interface Repository {
  // ---- Leagues ----
  createLeague(league: League): Promise<void>;
  getLeague(leagueId: string): Promise<League | undefined>;
  /** Leagues the user is a member of. */
  getLeaguesForUser(userId: string): Promise<League[]>;
  /** Add a member to a league (idempotent). Returns the updated league. */
  addMember(leagueId: string, userId: string): Promise<League>;

  // ---- Invites ----
  putInvite(code: string, leagueId: string): Promise<void>;
  getLeagueIdForInvite(code: string): Promise<string | undefined>;

  // ---- Rounds ----
  createRound(round: Round): Promise<void>;
  getRound(roundId: string): Promise<Round | undefined>;
  getRoundsForLeague(leagueId: string): Promise<Round[]>;
  updateRound(round: Round): Promise<void>;

  // ---- Submissions ----
  /** Upsert (one per user per round — re-submit overwrites). */
  putSubmission(submission: Submission): Promise<void>;
  getSubmission(roundId: string, userId: string): Promise<Submission | undefined>;
  getSubmissionsForRound(roundId: string): Promise<Submission[]>;

  // ---- Ballots ----
  putBallot(ballot: Ballot): Promise<void>;
  getBallotsForRound(roundId: string): Promise<Ballot[]>;

  // ---- Standings (running season totals) ----
  getStandings(leagueId: string): Promise<Array<{ userId: string; points: number }>>;
  /** Add points to a member's running total (creates at 0 if absent). */
  addStandingPoints(leagueId: string, userId: string, delta: number): Promise<void>;
}

/** Lightweight directory of display names — real impl reads from Cognito/profile
 *  items; the memory impl seeds a fixed set. Kept off Repository so the league
 *  loop doesn't depend on a user store that doesn't exist yet. */
export interface UserDirectory {
  getDisplayName(userId: string): Promise<string>;
}
