// The data-access PORT. Handlers depend only on this interface — never on
// DynamoDB or any in-memory store directly. Two implementations exist:
//   - MemoryRepository (data/memory.ts)  — local dev + tests, no AWS
//   - DynamoRepository (data/dynamo.ts)   — the real single-table backend
// Swapping which one a handler runs against is the whole point of the seam.

import type { Ballot, League, LeagueSettings, Round, Submission } from "../domain/types.ts";
import type { StandingRecordDelta, StandingTotals } from "../domain/standings.ts";
import type { SeasonFreeze } from "../domain/freeze.ts";

export interface Repository {
  // ---- Leagues ----
  createLeague(league: League): Promise<void>;
  /** `consistent`: a strongly consistent read (DynamoDB's default reads are
   *  eventually consistent and can miss a write that just landed). Only the
   *  head-to-head freeze asks for it, to see every member right after its
   *  conditional write; everything else reads as before. */
  getLeague(leagueId: string, opts?: { consistent?: boolean }): Promise<League | undefined>;
  /** Leagues the user is a member of. */
  getLeaguesForUser(userId: string): Promise<League[]>;
  /** All leagues with visibility "public" (fully hydrated with members).
   *  The service filters these down to the "open" ones. */
  getPublicLeagues(): Promise<League[]>;
  /** Every league, any visibility — powers the spectator browse list. */
  getAllLeagues(): Promise<League[]>;
  /** Add a member to a league (idempotent). Returns the updated league. */
  addMember(leagueId: string, userId: string): Promise<League>;
  /** Remove a member and their standing from a league (idempotent). */
  removeMember(leagueId: string, userId: string): Promise<void>;
  /** Replace a league's settings. Returns the updated league. */
  updateLeagueSettings(leagueId: string, settings: LeagueSettings): Promise<League>;
  /** Head-to-head join (HTH-03): add a member ONLY while the season is open
   *  to them — not frozen yet (no, or an empty, `h2hParticipants`), or they're
   *  already in the frozen order (a participant coming back). The check and
   *  the membership write are one atomic conditional write, so a join can
   *  never land after the freeze without being in the schedule, however
   *  stale the caller's earlier read was. Resolves the updated league, or
   *  `undefined` (writing nothing) when the season lock refuses. Standard
   *  leagues use `addMember`. */
  addMemberUnlessSeasonLocked(leagueId: string, userId: string): Promise<League | undefined>;
  /** Head-to-head season freeze (HTH-03): write the frozen participant order,
   *  its secret schedule salt and the schedule-derived roundCount onto the
   *  league, as one conditional write. Resolves `true` when it landed,
   *  `false` (writing nothing) when its condition failed:
   *  - without `replacesSalt`: the initial freeze, write-once — refused when
   *    the season is already frozen (a non-empty `h2hParticipants`; e.g. a
   *    concurrent round-1 open won the race) or the league no longer exists;
   *  - with `replacesSalt`: the round-1 open re-planning its OWN freeze to
   *    take in a member whose join landed between its member snapshot and its
   *    freeze write — refused unless the stored salt is still exactly that
   *    one. Only the opening request does this, before round 1 is written;
   *    once a round has opened, the order never changes. */
  freezeH2HSeason(leagueId: string, freeze: SeasonFreeze, replacesSalt?: string): Promise<boolean>;
  /** Delete a league and every record scoped to it (members, rounds, their
   *  submissions/ballots, standings, and invite codes). */
  deleteLeague(leagueId: string): Promise<void>;

  // ---- Invites ----
  putInvite(code: string, leagueId: string): Promise<void>;
  deleteInvite(code: string): Promise<void>;
  /** Point the league's record at a new invite code (lookup rows are separate). */
  updateInviteCode(leagueId: string, code: string): Promise<void>;
  getLeagueIdForInvite(code: string): Promise<string | undefined>;

  // ---- Rounds ----
  createRound(round: Round): Promise<void>;
  getRound(roundId: string): Promise<Round | undefined>;
  getRoundsForLeague(leagueId: string): Promise<Round[]>;
  updateRound(round: Round): Promise<void>;

  // ---- Submissions ----
  /** Upsert by submission id — a player may hold several per round (the
   *  league's submissionsPerPlayer cap is enforced by the handler, not here). */
  putSubmission(submission: Submission): Promise<void>;
  /** All of one player's submissions for a round (empty if none yet). */
  getSubmissionsForUser(roundId: string, userId: string): Promise<Submission[]>;
  getSubmissionsForRound(roundId: string): Promise<Submission[]>;
  /** Delete one of a player's submissions; no-op if the id isn't theirs. */
  deleteSubmission(roundId: string, userId: string, submissionId: string): Promise<void>;

  // ---- Ballots ----
  putBallot(ballot: Ballot): Promise<void>;
  getBallot(roundId: string, voterId: string): Promise<Ballot | undefined>;
  getBallotsForRound(roundId: string): Promise<Ballot[]>;

  // ---- Standings (running season totals) ----
  /** Every standing row in the league (ex-members included — the board
   *  filters). Counters are always numbers: a row that never had a W/L/D
   *  written (standard leagues, legacy rows) reads back with zeros. */
  getStandings(leagueId: string): Promise<StandingTotals[]>;
  /** Add points to a member's running total (creates at 0 if absent). */
  addStandingPoints(leagueId: string, userId: string, delta: number): Promise<void>;
  /** Add to a member's head-to-head record on the same standing row (each
   *  counter created at 0 if absent; omitted fields add 0). One atomic write
   *  per call — no read-modify-write, so concurrent reveals can't lose a
   *  result. Leaves `points` untouched, as addStandingPoints leaves W/L/D. */
  addStandingRecord(leagueId: string, userId: string, delta: StandingRecordDelta): Promise<void>;
}

/** Lightweight directory of display names — real impl reads from Cognito/profile
 *  items; the memory impl seeds a fixed set. Kept off Repository so the league
 *  loop doesn't depend on a user store that doesn't exist yet. */
export interface UserDirectory {
  getDisplayName(userId: string): Promise<string>;
}
