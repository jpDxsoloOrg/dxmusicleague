// In-memory Repository — local dev + tests, no AWS. Seeded with the same
// fixture leagues/rounds/users as the frontend mock (src/data/mock.ts) so the
// app behaves identically whether it talks to this or to DynamoDB.

import type { Ballot, League, LeagueSettings, Round, Submission } from "../domain/types.ts";
import { DEFAULT_LEAGUE_SETTINGS, leagueFormat } from "../domain/types.ts";
import type { StandingRecordDelta, StandingTotals } from "../domain/standings.ts";
import { recordIncrements } from "../domain/standings.ts";
import type { Repository, UserDirectory } from "./repository.ts";

/** Fixed display-name directory, mirroring the frontend mock's `users`. */
const SEED_USERS: Record<string, string> = {
  "u-me": "Curator Max",
  "u-sarah": "Sarah",
  "u-james": "James",
  "u-mia": "Mia",
  "u-jpop": "J-Pop",
  "u-luna": "Luna",
};

export class MemoryUserDirectory implements UserDirectory {
  async getDisplayName(userId: string): Promise<string> {
    return SEED_USERS[userId] ?? userId;
  }
}

/** A stored standing row — only the counters written so far are present. */
type StoredStanding = Partial<Omit<StandingTotals, "userId">>;

export class MemoryRepository implements Repository {
  private leagues = new Map<string, League>();
  private invites = new Map<string, string>(); // code -> leagueId
  private rounds = new Map<string, Round>();
  private submissions = new Map<string, Submission>(); // `${roundId}/${userId}`
  private ballots = new Map<string, Ballot>(); // `${roundId}/${voterId}`
  // `${leagueId}/${userId}` -> the standing row. Counters are optional here
  // exactly as attributes are on a Dynamo item: a row only carries what has
  // been written to it (points-only rows = standard/legacy), and getStandings
  // applies the same read-time zero defaults as DynamoRepository.
  private standings = new Map<string, StoredStanding>();

  constructor(seed = true) {
    if (seed) this.loadSeed();
  }

  // ---- Leagues ----
  /** A detached copy of a stored league, with the same read-time defaults as
   *  DynamoRepository.getLeague (a legacy record without `format` reads as
   *  "standard"), so tests over this repo see what production would. */
  private readLeague(lg: League): League {
    return { ...structuredClone(lg), format: leagueFormat(lg) };
  }
  async createLeague(league: League): Promise<void> {
    this.leagues.set(league.id, structuredClone(league));
  }
  async getLeague(leagueId: string): Promise<League | undefined> {
    const lg = this.leagues.get(leagueId);
    return lg ? this.readLeague(lg) : undefined;
  }
  async getLeaguesForUser(userId: string): Promise<League[]> {
    return [...this.leagues.values()]
      .filter((lg) => lg.memberIds.includes(userId))
      .map((lg) => this.readLeague(lg));
  }
  async getPublicLeagues(): Promise<League[]> {
    return [...this.leagues.values()]
      .filter((lg) => lg.visibility === "public")
      .map((lg) => this.readLeague(lg));
  }
  async getAllLeagues(): Promise<League[]> {
    return [...this.leagues.values()].map((lg) => this.readLeague(lg));
  }
  async addMember(leagueId: string, userId: string): Promise<League> {
    const lg = this.leagues.get(leagueId);
    if (!lg) throw new Error(`League not found: ${leagueId}`);
    if (!lg.memberIds.includes(userId)) lg.memberIds.push(userId);
    return this.readLeague(lg);
  }
  async removeMember(leagueId: string, userId: string): Promise<void> {
    // Standing deliberately kept (mirrors DynamoRepository) — points survive a
    // leave/kick and reappear when the player rejoins.
    const lg = this.leagues.get(leagueId);
    if (lg) lg.memberIds = lg.memberIds.filter((id) => id !== userId);
  }
  async updateLeagueSettings(leagueId: string, settings: LeagueSettings): Promise<League> {
    const lg = this.leagues.get(leagueId);
    if (!lg) throw new Error(`League not found: ${leagueId}`);
    lg.settings = { ...settings };
    return this.readLeague(lg);
  }
  async deleteLeague(leagueId: string): Promise<void> {
    const lg = this.leagues.get(leagueId);
    if (!lg) return;
    // Drop every record scoped to this league so nothing is orphaned.
    const roundIds = [...this.rounds.values()].filter((r) => r.leagueId === leagueId).map((r) => r.id);
    const roundSet = new Set(roundIds);
    for (const id of roundIds) this.rounds.delete(id);
    for (const key of this.submissions.keys()) {
      if (roundSet.has(key.split("/")[0]!)) this.submissions.delete(key);
    }
    for (const key of this.ballots.keys()) {
      if (roundSet.has(key.split("/")[0]!)) this.ballots.delete(key);
    }
    for (const key of this.standings.keys()) {
      if (key.startsWith(`${leagueId}/`)) this.standings.delete(key);
    }
    for (const [code, lid] of this.invites.entries()) {
      if (lid === leagueId) this.invites.delete(code);
    }
    this.leagues.delete(leagueId);
  }

  // ---- Invites ----
  async putInvite(code: string, leagueId: string): Promise<void> {
    this.invites.set(code.toUpperCase(), leagueId);
  }
  async getLeagueIdForInvite(code: string): Promise<string | undefined> {
    return this.invites.get(code.toUpperCase());
  }
  async deleteInvite(code: string): Promise<void> {
    this.invites.delete(code.toUpperCase());
  }
  async updateInviteCode(leagueId: string, code: string): Promise<void> {
    const lg = this.leagues.get(leagueId);
    if (lg) lg.inviteCode = code;
  }

  // ---- Rounds ----
  async createRound(round: Round): Promise<void> {
    this.rounds.set(round.id, structuredClone(round));
  }
  async getRound(roundId: string): Promise<Round | undefined> {
    const r = this.rounds.get(roundId);
    return r ? structuredClone(r) : undefined;
  }
  async getRoundsForLeague(leagueId: string): Promise<Round[]> {
    return [...this.rounds.values()]
      .filter((r) => r.leagueId === leagueId)
      .map((r) => structuredClone(r));
  }
  async updateRound(round: Round): Promise<void> {
    this.rounds.set(round.id, structuredClone(round));
  }

  // ---- Submissions ----
  async putSubmission(submission: Submission): Promise<void> {
    this.submissions.set(`${submission.roundId}/${submission.userId}/${submission.id}`, structuredClone(submission));
  }
  async getSubmissionsForUser(roundId: string, userId: string): Promise<Submission[]> {
    return [...this.submissions.values()]
      .filter((s) => s.roundId === roundId && s.userId === userId)
      .map((s) => structuredClone(s));
  }
  async getSubmissionsForRound(roundId: string): Promise<Submission[]> {
    return [...this.submissions.values()]
      .filter((s) => s.roundId === roundId)
      .map((s) => structuredClone(s));
  }
  async deleteSubmission(roundId: string, userId: string, submissionId: string): Promise<void> {
    this.submissions.delete(`${roundId}/${userId}/${submissionId}`);
  }

  // ---- Ballots ----
  async putBallot(ballot: Ballot): Promise<void> {
    this.ballots.set(`${ballot.roundId}/${ballot.voterId}`, structuredClone(ballot));
  }
  async getBallot(roundId: string, voterId: string): Promise<Ballot | undefined> {
    const b = this.ballots.get(`${roundId}/${voterId}`);
    return b ? structuredClone(b) : undefined;
  }
  async getBallotsForRound(roundId: string): Promise<Ballot[]> {
    return [...this.ballots.values()]
      .filter((b) => b.roundId === roundId)
      .map((b) => structuredClone(b));
  }

  // ---- Standings ----
  async getStandings(leagueId: string): Promise<StandingTotals[]> {
    const prefix = `${leagueId}/`;
    return [...this.standings.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, row]) => ({
        userId: key.slice(prefix.length),
        points: row.points ?? 0,
        wins: row.wins ?? 0,
        losses: row.losses ?? 0,
        draws: row.draws ?? 0,
      }));
  }
  /** The live stored row for a member, created empty on first write (Map
   *  insertion order = first-write order, which getStandings preserves). */
  private standingRow(leagueId: string, userId: string): StoredStanding {
    const key = `${leagueId}/${userId}`;
    let row = this.standings.get(key);
    if (!row) this.standings.set(key, (row = {}));
    return row;
  }
  async addStandingPoints(leagueId: string, userId: string, delta: number): Promise<void> {
    const row = this.standingRow(leagueId, userId);
    row.points = (row.points ?? 0) + delta;
  }
  async addStandingRecord(leagueId: string, userId: string, delta: StandingRecordDelta): Promise<void> {
    const inc = recordIncrements(delta); // validate before touching the row
    const row = this.standingRow(leagueId, userId);
    row.wins = (row.wins ?? 0) + inc.wins;
    row.losses = (row.losses ?? 0) + inc.losses;
    row.draws = (row.draws ?? 0) + inc.draws;
  }

  // ---- Seed (mirrors src/data/mock.ts) ----
  private loadSeed(): void {
    const isoInDays = (days: number): string => {
      // Fixed epoch base keeps seed deterministic across runs/tests.
      const base = new Date("2026-06-28T00:00:00.000Z");
      base.setDate(base.getDate() + days);
      return base.toISOString();
    };

    const seedLeagues: League[] = [
      { id: "lg-synthwave", name: "Synthwave Souls", ownerId: "u-me", musicProvider: "youtube-music", format: "standard",
        settings: DEFAULT_LEAGUE_SETTINGS, memberIds: ["u-me", "u-sarah", "u-james", "u-mia", "u-luna"], inviteCode: "SYNTH-23", visibility: "private", roundCount: 12, progression: "manual" },
      { id: "lg-vaporwave", name: "Vaporwave Vibes", ownerId: "u-sarah", musicProvider: "youtube-music", format: "standard",
        settings: { ...DEFAULT_LEAGUE_SETTINGS, votePoolSize: 12 }, memberIds: ["u-me", "u-sarah", "u-jpop", "u-luna"], inviteCode: "VAPOR-88", visibility: "private", roundCount: 8, progression: "manual" },
      { id: "lg-bassline", name: "Bassline Battle", ownerId: "u-james", musicProvider: "youtube-music", format: "standard",
        settings: DEFAULT_LEAGUE_SETTINGS, memberIds: ["u-me", "u-james", "u-mia", "u-jpop", "u-sarah", "u-luna"], inviteCode: "BASS-42", visibility: "private", roundCount: 8, progression: "manual" },
      { id: "lg-indie", name: "Indie Anthems", ownerId: "u-luna", musicProvider: "youtube-music", format: "standard",
        settings: DEFAULT_LEAGUE_SETTINGS, memberIds: ["u-luna", "u-mia", "u-jpop"], inviteCode: "INDIE-25", visibility: "private", roundCount: 8, progression: "manual" },
      // Public, not-yet-started leagues with open slots — discoverable by u-me (not a member).
      { id: "lg-midnight", name: "Midnight Drives", ownerId: "u-sarah", musicProvider: "spotify", format: "standard",
        settings: DEFAULT_LEAGUE_SETTINGS, memberIds: ["u-sarah", "u-james", "u-luna"], inviteCode: "NIGHT-1", visibility: "public", maxMembers: 8, roundCount: 8, progression: "manual" },
      { id: "lg-retro", name: "Retro Futures", ownerId: "u-jpop", musicProvider: "spotify", format: "standard",
        settings: DEFAULT_LEAGUE_SETTINGS, memberIds: ["u-jpop", "u-mia"], inviteCode: "RETRO-1", visibility: "public", maxMembers: 6, roundCount: 6, progression: "manual" },
      { id: "lg-urban", name: "Urban Beats", ownerId: "u-luna", musicProvider: "spotify", format: "standard",
        settings: DEFAULT_LEAGUE_SETTINGS, memberIds: ["u-luna", "u-james", "u-sarah", "u-mia"], inviteCode: "URBAN-1", visibility: "public", maxMembers: 10, roundCount: 10, progression: "manual" },
    ];
    for (const lg of seedLeagues) {
      this.leagues.set(lg.id, lg);
      this.invites.set(lg.inviteCode, lg.id); // keep the invite lookup in sync with each league's code
    }

    const seedRounds: Round[] = [
      { id: "r-sw-3", leagueId: "lg-synthwave", index: 3, theme: "Songs for a road trip", status: "submitting", submissionDeadline: isoInDays(2) },
      { id: "r-sw-2", leagueId: "lg-synthwave", index: 2, theme: "Neon Nights", status: "complete" },
      { id: "r-sw-1", leagueId: "lg-synthwave", index: 1, theme: "First Impressions", status: "complete" },
      { id: "r-vw-1", leagueId: "lg-vaporwave", index: 1, theme: "Mall Soundtrack", status: "voting", voteDeadline: isoInDays(1) },
      { id: "r-bb-4", leagueId: "lg-bassline", index: 4, theme: "Drop the Bass", status: "revealed", playlistUrl: "https://example.com/mock-playlist/bb4" },
      { id: "r-in-2", leagueId: "lg-indie", index: 2, theme: "Bedroom Pop Gems", status: "submitting", submissionDeadline: isoInDays(3) },
      { id: "r-in-1", leagueId: "lg-indie", index: 1, theme: "Garage Revival", status: "complete" },
      // Draft first rounds for the open public leagues (not started — still gathering members).
      { id: "r-mn-1", leagueId: "lg-midnight", index: 1, theme: "Late-night highway anthems", status: "draft" },
      { id: "r-rf-1", leagueId: "lg-retro", index: 1, theme: "80s sci-fi soundtracks", status: "draft" },
      { id: "r-ub-1", leagueId: "lg-urban", index: 1, theme: "Lo-fi study session", status: "draft" },
    ];
    for (const r of seedRounds) this.rounds.set(r.id, r);

    // Seed running standings so league-detail looks alive (mirrors mock STANDINGS).
    const seedStandings: Record<string, Array<[string, number]>> = {
      "lg-synthwave": [["u-james", 450], ["u-sarah", 420], ["u-mia", 390], ["u-me", 360], ["u-luna", 300]],
      "lg-vaporwave": [["u-sarah", 410], ["u-me", 380], ["u-jpop", 350], ["u-luna", 300]],
      "lg-bassline": [["u-mia", 420], ["u-sarah", 415], ["u-james", 390], ["u-me", 380], ["u-jpop", 360], ["u-luna", 340]],
    };
    for (const [leagueId, rows] of Object.entries(seedStandings)) {
      for (const [userId, points] of rows) this.standings.set(`${leagueId}/${userId}`, { points });
    }
  }
}
