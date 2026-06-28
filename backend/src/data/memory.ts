// In-memory Repository — local dev + tests, no AWS. Seeded with the same
// fixture leagues/rounds/users as the frontend mock (src/data/mock.ts) so the
// app behaves identically whether it talks to this or to DynamoDB.

import type { Ballot, League, Round, Submission } from "../domain/types.ts";
import { DEFAULT_LEAGUE_SETTINGS } from "../domain/types.ts";
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

export class MemoryRepository implements Repository {
  private leagues = new Map<string, League>();
  private invites = new Map<string, string>(); // code -> leagueId
  private rounds = new Map<string, Round>();
  private submissions = new Map<string, Submission>(); // `${roundId}/${userId}`
  private ballots = new Map<string, Ballot>(); // `${roundId}/${voterId}`
  private standings = new Map<string, number>(); // `${leagueId}/${userId}` -> points

  constructor(seed = true) {
    if (seed) this.loadSeed();
  }

  // ---- Leagues ----
  async createLeague(league: League): Promise<void> {
    this.leagues.set(league.id, structuredClone(league));
  }
  async getLeague(leagueId: string): Promise<League | undefined> {
    const lg = this.leagues.get(leagueId);
    return lg ? structuredClone(lg) : undefined;
  }
  async getLeaguesForUser(userId: string): Promise<League[]> {
    return [...this.leagues.values()]
      .filter((lg) => lg.memberIds.includes(userId))
      .map((lg) => structuredClone(lg));
  }
  async addMember(leagueId: string, userId: string): Promise<League> {
    const lg = this.leagues.get(leagueId);
    if (!lg) throw new Error(`League not found: ${leagueId}`);
    if (!lg.memberIds.includes(userId)) lg.memberIds.push(userId);
    return structuredClone(lg);
  }

  // ---- Invites ----
  async putInvite(code: string, leagueId: string): Promise<void> {
    this.invites.set(code.toUpperCase(), leagueId);
  }
  async getLeagueIdForInvite(code: string): Promise<string | undefined> {
    return this.invites.get(code.toUpperCase());
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
    this.submissions.set(`${submission.roundId}/${submission.userId}`, structuredClone(submission));
  }
  async getSubmission(roundId: string, userId: string): Promise<Submission | undefined> {
    const s = this.submissions.get(`${roundId}/${userId}`);
    return s ? structuredClone(s) : undefined;
  }
  async getSubmissionsForRound(roundId: string): Promise<Submission[]> {
    return [...this.submissions.values()]
      .filter((s) => s.roundId === roundId)
      .map((s) => structuredClone(s));
  }

  // ---- Ballots ----
  async putBallot(ballot: Ballot): Promise<void> {
    this.ballots.set(`${ballot.roundId}/${ballot.voterId}`, structuredClone(ballot));
  }
  async getBallotsForRound(roundId: string): Promise<Ballot[]> {
    return [...this.ballots.values()]
      .filter((b) => b.roundId === roundId)
      .map((b) => structuredClone(b));
  }

  // ---- Standings ----
  async getStandings(leagueId: string): Promise<Array<{ userId: string; points: number }>> {
    const prefix = `${leagueId}/`;
    return [...this.standings.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, points]) => ({ userId: key.slice(prefix.length), points }));
  }
  async addStandingPoints(leagueId: string, userId: string, delta: number): Promise<void> {
    const key = `${leagueId}/${userId}`;
    this.standings.set(key, (this.standings.get(key) ?? 0) + delta);
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
      { id: "lg-synthwave", name: "Synthwave Souls", ownerId: "u-me", musicProvider: "youtube-music",
        settings: DEFAULT_LEAGUE_SETTINGS, memberIds: ["u-me", "u-sarah", "u-james", "u-mia", "u-luna"] },
      { id: "lg-vaporwave", name: "Vaporwave Vibes", ownerId: "u-sarah", musicProvider: "youtube-music",
        settings: { ...DEFAULT_LEAGUE_SETTINGS, votePoolSize: 12 }, memberIds: ["u-me", "u-sarah", "u-jpop", "u-luna"] },
      { id: "lg-bassline", name: "Bassline Battle", ownerId: "u-james", musicProvider: "youtube-music",
        settings: DEFAULT_LEAGUE_SETTINGS, memberIds: ["u-me", "u-james", "u-mia", "u-jpop", "u-sarah", "u-luna"] },
      { id: "lg-indie", name: "Indie Anthems", ownerId: "u-luna", musicProvider: "youtube-music",
        settings: DEFAULT_LEAGUE_SETTINGS, memberIds: ["u-luna", "u-mia", "u-jpop"] },
    ];
    for (const lg of seedLeagues) this.leagues.set(lg.id, lg);

    const seedInvites: Record<string, string> = {
      "SYNTH-23": "lg-synthwave",
      "VAPOR-88": "lg-vaporwave",
      "INDIE-25": "lg-indie",
    };
    for (const [code, leagueId] of Object.entries(seedInvites)) this.invites.set(code, leagueId);

    const seedRounds: Round[] = [
      { id: "r-sw-3", leagueId: "lg-synthwave", index: 3, theme: "Songs for a road trip", status: "submitting", submissionDeadline: isoInDays(2) },
      { id: "r-sw-2", leagueId: "lg-synthwave", index: 2, theme: "Neon Nights", status: "complete" },
      { id: "r-sw-1", leagueId: "lg-synthwave", index: 1, theme: "First Impressions", status: "complete" },
      { id: "r-vw-1", leagueId: "lg-vaporwave", index: 1, theme: "Mall Soundtrack", status: "voting", voteDeadline: isoInDays(1) },
      { id: "r-bb-4", leagueId: "lg-bassline", index: 4, theme: "Drop the Bass", status: "revealed", playlistUrl: "https://example.com/mock-playlist/bb4" },
      { id: "r-in-2", leagueId: "lg-indie", index: 2, theme: "Bedroom Pop Gems", status: "submitting", submissionDeadline: isoInDays(3) },
      { id: "r-in-1", leagueId: "lg-indie", index: 1, theme: "Garage Revival", status: "complete" },
    ];
    for (const r of seedRounds) this.rounds.set(r.id, r);

    // Seed running standings so league-detail looks alive (mirrors mock STANDINGS).
    const seedStandings: Record<string, Array<[string, number]>> = {
      "lg-synthwave": [["u-james", 450], ["u-sarah", 420], ["u-mia", 390], ["u-me", 360], ["u-luna", 300]],
      "lg-vaporwave": [["u-sarah", 410], ["u-me", 380], ["u-jpop", 350], ["u-luna", 300]],
      "lg-bassline": [["u-mia", 420], ["u-sarah", 415], ["u-james", 390], ["u-me", 380], ["u-jpop", 360], ["u-luna", 340]],
    };
    for (const [leagueId, rows] of Object.entries(seedStandings)) {
      for (const [userId, points] of rows) this.standings.set(`${leagueId}/${userId}`, points);
    }
  }
}
