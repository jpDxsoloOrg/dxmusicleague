// In-memory Repository — local dev + tests, no AWS. Seeded with the same
// fixture leagues/rounds/users as the frontend mock (src/data/mock.ts) so the
// app behaves identically whether it talks to this or to DynamoDB.

import type { Ballot, League, LeagueSettings, Round, Submission, Track } from "../domain/types.ts";
import { DEFAULT_LEAGUE_SETTINGS, leagueFormat } from "../domain/types.ts";
import type { StandingPointsDelta, StandingRecordDelta, StandingTotals } from "../domain/standings.ts";
import { mergePointDeltas, recordIncrements } from "../domain/standings.ts";
import type { SeasonFreeze } from "../domain/freeze.ts";
import { roundSettled } from "../domain/matchups.ts";
import type { Repository, UserDirectory } from "./repository.ts";
import { headToHeadSeed } from "./seedHeadToHead.ts";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** Fixed display-name directory, mirroring the frontend mock's `users`. */
const SEED_USERS: Record<string, string> = {
  "u-me": "Curator Max",
  "u-sarah": "Sarah",
  "u-james": "James",
  "u-mia": "Mia",
  "u-jpop": "J-Pop",
  "u-luna": "Luna",
};

/** The repos' storage-level "frozen" test — a non-empty frozen order — the
 *  same definition DynamoRepository's conditions use and domain/freeze.ts's
 *  `seasonLocked` applies (minus the format check: only head-to-head leagues
 *  ever reach these writes). */
const isFrozen = (lg: League): boolean => (lg.h2hParticipants?.length ?? 0) > 0;

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

  /** `seed` loads the fixture leagues (local dev; handler tests pass false).
   *  `now` is the clock the seed is laid out from — its deadlines and
   *  activity timestamps — defaulting to the moment the repo is built (the
   *  local server's start), so the seeded rounds are playable whenever it
   *  starts. Tests inject a fixed one. */
  constructor(seed = true, opts: { now?: Date } = {}) {
    if (seed) this.loadSeed(opts.now ?? new Date());
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
  async getLeague(leagueId: string, _opts?: { consistent?: boolean }): Promise<League | undefined> {
    // Every read here is strongly consistent, so the port's `consistent`
    // option needs no handling.
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
    // leave/kick and reappear when the player rejoins (a standard league, or
    // a head-to-head lobby: a locked H2H season can't be rejoined, HTH-14).
    const lg = this.leagues.get(leagueId);
    if (lg) lg.memberIds = lg.memberIds.filter((id) => id !== userId);
  }
  async updateLeagueSettings(leagueId: string, settings: LeagueSettings): Promise<League> {
    const lg = this.leagues.get(leagueId);
    if (!lg) throw new Error(`League not found: ${leagueId}`);
    lg.settings = { ...settings };
    return this.readLeague(lg);
  }
  async addMemberUnlessSeasonLocked(leagueId: string, userId: string): Promise<League | undefined> {
    // Same contract as DynamoRepository's transactional join: the season check
    // and the membership write happen together (synchronously here), so no
    // freeze can slip in between them. Frozen refuses everyone — newcomers
    // and former participants alike (HTH-14).
    const lg = this.leagues.get(leagueId);
    if (!lg) throw new Error(`League not found: ${leagueId}`);
    if (isFrozen(lg)) return undefined;
    if (!lg.memberIds.includes(userId)) lg.memberIds.push(userId);
    return this.readLeague(lg);
  }
  async freezeH2HSeason(leagueId: string, freeze: SeasonFreeze, replacesSalt?: string): Promise<boolean> {
    // Same contract as DynamoRepository's conditional write: the initial
    // freeze lands once (a second attempt — or one on a league that no longer
    // exists — writes nothing and reports it lost); a re-plan lands only over
    // the exact salt it read.
    const lg = this.leagues.get(leagueId);
    if (!lg) return false;
    if (replacesSalt === undefined ? isFrozen(lg) : lg.h2hSalt !== replacesSalt) return false;
    lg.h2hParticipants = [...freeze.participants];
    lg.h2hSalt = freeze.salt;
    lg.roundCount = freeze.roundCount;
    return true;
  }
  async setRematchPointer(leagueId: string, rematchId: string, replacesStale?: string): Promise<boolean> {
    // Same contract as DynamoRepository's conditional write: lands while no
    // pointer is set, or over exactly the stale one the caller names; never
    // on a league that no longer exists. Check and write are synchronous, so
    // of two racing rematches only the first claim lands.
    const lg = this.leagues.get(leagueId);
    if (!lg) return false;
    if (lg.rematchLeagueId !== undefined && lg.rematchLeagueId !== replacesStale) return false;
    lg.rematchLeagueId = rematchId;
    return true;
  }
  async deleteLeague(leagueId: string, _opts?: { consistent?: boolean }): Promise<void> {
    // Every read here is strongly consistent; `consistent` changes nothing.
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
  async getRound(roundId: string, _opts?: { consistent?: boolean }): Promise<Round | undefined> {
    // Every read here is strongly consistent; `consistent` changes nothing.
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
  async updateRoundUnlessSettled(round: Round): Promise<boolean> {
    // Same contract as DynamoRepository's conditional put: the check and the
    // write happen together (synchronously here — no await in between).
    const stored = this.rounds.get(round.id);
    if (!stored || roundSettled(stored)) return false;
    this.rounds.set(round.id, structuredClone(round));
    return true;
  }
  async revealRoundOnce(
    round: Round,
    records: ReadonlyArray<{ userId: string; delta: StandingRecordDelta }> = [],
  ): Promise<boolean> {
    // Atomic like DynamoRepository's transaction: every increment is
    // validated before anything is touched, then the claim and the banking
    // happen together (synchronously), so of two racing reveals only the
    // first lands and banks.
    const increments = records.map((r) => ({ userId: r.userId, inc: recordIncrements(r.delta) }));
    const stored = this.rounds.get(round.id);
    if (!stored || roundSettled(stored)) return false;
    this.rounds.set(round.id, structuredClone(round));
    for (const { userId, inc } of increments) this.bankRecord(round.leagueId, userId, inc);
    return true;
  }
  async revealPointsRoundOnce(round: Round, points: ReadonlyArray<StandingPointsDelta> = []): Promise<boolean> {
    // The standard round's twin of revealRoundOnce, just as atomic: one
    // validated increment per player first, then the claim and the banking
    // together (synchronously). Rows are banked in the order given, so a
    // player's row is first written in the same order as when the reveal
    // banked result by result (the order getStandings returns ties in).
    const increments = mergePointDeltas(points);
    const stored = this.rounds.get(round.id);
    if (!stored || roundSettled(stored)) return false;
    this.rounds.set(round.id, structuredClone(round));
    for (const { userId, delta } of increments) this.bankPoints(round.leagueId, userId, delta);
    return true;
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
  async getBallotsForRound(roundId: string, _opts?: { consistent?: boolean }): Promise<Ballot[]> {
    // Every read here is strongly consistent; `consistent` changes nothing.
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
    this.bankPoints(leagueId, userId, delta);
  }
  private bankPoints(leagueId: string, userId: string, delta: number): void {
    const row = this.standingRow(leagueId, userId);
    row.points = (row.points ?? 0) + delta;
  }
  async addStandingRecord(leagueId: string, userId: string, delta: StandingRecordDelta): Promise<void> {
    this.bankRecord(leagueId, userId, recordIncrements(delta)); // validated before touching the row
  }
  private bankRecord(leagueId: string, userId: string, inc: ReturnType<typeof recordIncrements>): void {
    const row = this.standingRow(leagueId, userId);
    row.wins = (row.wins ?? 0) + inc.wins;
    row.losses = (row.losses ?? 0) + inc.losses;
    row.draws = (row.draws ?? 0) + inc.draws;
  }

  // ---- Seed (mirrors src/data/mock.ts) ----
  /** Load the fixture leagues. Every date in it hangs off `now` — deadlines
   *  `days` ahead, like the mock's `isoInDays`, and the head-to-head
   *  fixture's activity timestamps behind — so one clock lays out the whole
   *  seed and its live rounds are open whenever the server starts. (A fixed
   *  base date here once expired every seeded deadline three days after it
   *  was written, BUG-08.) The seeded leagues are manual, so a deadline only
   *  gates submits and ballots — nothing auto-advances; a server left running
   *  past one sees that round close, and a restart re-seeds it. */
  private loadSeed(now: Date): void {
    const isoInDays = (days: number): string => new Date(now.getTime() + days * DAY_MS).toISOString();
    const isoHoursAgo = (hours: number): string => new Date(now.getTime() - hours * HOUR_MS).toISOString();

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

    // Vaporwave's round 1 is in voting, so it needs its songs: one per member,
    // the mock's canonical picks (src/data/mock.ts CANON_SUBMISSIONS — same
    // ids, mock-catalog tracks and note; J-Pop, who has none there, takes the
    // left-over "Blinding Lights"). With all four in, every voter has three
    // songs on offer, and 3 × the 5-point cap takes the league's whole
    // 12-point pool (two songs would shrink what a voter spends to the 10
    // they can take — `effectivePool`, domain/rules.ts).
    const canonTrack = (pid: string, title: string, artist: string, album: string, durationMs: number): Track =>
      ({ id: `mock:${pid}`, provider: "mock", providerTrackId: pid, title, artists: [artist], album, durationMs });
    const seedSubmissions: Submission[] = [
      { id: "sub-1", roundId: "r-vw-1", userId: "u-sarah", track: canonTrack("m6", "Levitating", "Dua Lipa", "Future Nostalgia", 203000),
        comment: "Instant serotonin — I had to.", submittedAt: isoHoursAgo(30) },
      { id: "sub-2", roundId: "r-vw-1", userId: "u-jpop", track: canonTrack("m5", "Blinding Lights", "The Weeknd", "After Hours", 200000),
        submittedAt: isoHoursAgo(28) },
      { id: "sub-4", roundId: "r-vw-1", userId: "u-luna", track: canonTrack("m10", "Heat Waves", "Glass Animals", "Dreamland", 238000),
        submittedAt: isoHoursAgo(27) },
      { id: "sub-5", roundId: "r-vw-1", userId: "u-me", track: canonTrack("m1", "Midnight City", "M83", "Hurry Up, We're Dreaming", 243000),
        submittedAt: isoHoursAgo(26) },
    ];
    for (const s of seedSubmissions) this.submissions.set(`${s.roundId}/${s.userId}/${s.id}`, s);

    // Seed running standings so league-detail looks alive (mirrors mock STANDINGS).
    const seedStandings: Record<string, Array<[string, number]>> = {
      "lg-synthwave": [["u-james", 450], ["u-sarah", 420], ["u-mia", 390], ["u-me", 360], ["u-luna", 300]],
      "lg-vaporwave": [["u-sarah", 410], ["u-me", 380], ["u-jpop", 350], ["u-luna", 300]],
      "lg-bassline": [["u-mia", 420], ["u-sarah", 415], ["u-james", 390], ["u-me", 380], ["u-jpop", 360], ["u-luna", 340]],
    };
    for (const [leagueId, rows] of Object.entries(seedStandings)) {
      for (const [userId, points] of rows) this.standings.set(`${leagueId}/${userId}`, { points });
    }
    // Every other seeded member gets the row create / join / claim would have
    // written — points 0, in member order — so a board never leaves out a
    // member (Indie Anthems and the public draft leagues had none).
    for (const lg of seedLeagues) {
      for (const userId of lg.memberIds) {
        const key = `${lg.id}/${userId}`;
        if (!this.standings.has(key)) this.standings.set(key, { points: 0 });
      }
    }

    // The head-to-head league (HTH-09): mid-season, frozen, round 1 revealed
    // and banked, round 2 in voting — the same fixture module the frontend
    // mock loads (data/seedHeadToHead.ts), so both modes show one league.
    // Its timestamps hang off the same `now` (activity feed only; no deadlines).
    const h2h = headToHeadSeed(now);
    this.leagues.set(h2h.league.id, h2h.league);
    this.invites.set(h2h.league.inviteCode, h2h.league.id);
    for (const r of h2h.rounds) this.rounds.set(r.id, r);
    for (const s of h2h.submissions) this.submissions.set(`${s.roundId}/${s.userId}/${s.id}`, s);
    for (const b of h2h.ballots) this.ballots.set(`${b.roundId}/${b.voterId}`, b);
    for (const { userId, ...row } of h2h.standings) this.standings.set(`${h2h.league.id}/${userId}`, row);
  }
}
