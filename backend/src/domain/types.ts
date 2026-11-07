// Backend domain types. Deliberately a small, self-contained copy of the
// frontend's `src/domain/types.ts` + the normalized `Track` shape from
// `src/music/types.ts`. The contract between them is the JSON on the wire, so
// the backend owns its own copy rather than reaching across the package
// boundary. Keep the field names identical to the frontend types.

export type MusicProviderId = "spotify" | "youtube-music" | "mock";

// Lifecycle: draft → submitting → previewing → voting → revealed (→ complete).
// `previewing` = submissions are closed and the songs (a public playlist) are
// revealed for listening, but voting hasn't opened yet.
export type RoundStatus = "draft" | "submitting" | "previewing" | "voting" | "revealed" | "complete";

/** A track normalized across providers — mirror of the frontend `Track`. */
export interface Track {
  id: string;
  provider: MusicProviderId;
  providerTrackId: string;
  title: string;
  artists: string[];
  album?: string;
  artworkUrl?: string;
  durationMs?: number;
  previewUrl?: string;
  externalUrl?: string;
}

export interface LeagueSettings {
  votePoolSize: number;
  maxPointsPerSong: number;
  allowSelfVote: boolean;
  submissionsPerPlayer: number;
  /** Anti-votes each voter may place per round (0 disables; each subtracts
   *  a point at tally — totals can go negative). Optional to spend. */
  downvotePoolSize: number;
}

/** Private = joinable by invite code only. Public = discoverable + claimable. */
export type LeagueVisibility = "private" | "public";

/** How rounds move between phases. `manual` = the owner advances each phase.
 *  `timed` = phases auto-advance after `phaseDays` days (see League). */
export type RoundProgression = "manual" | "timed";

/** How a league is scored. `standard` = every voter spreads a points pool over
 *  every song, standings by total points. `headToHead` = round-robin 1v1
 *  matchups each round, most votes wins, standings by W/L/D record. Chosen at
 *  creation and immutable afterwards. Older records (no field) are standard —
 *  always read it through `leagueFormat()`, never raw. */
export type LeagueFormat = "standard" | "headToHead";

export const LEAGUE_FORMATS: readonly LeagueFormat[] = ["standard", "headToHead"];

export interface League {
  id: string;
  name: string;
  ownerId: string;
  musicProvider: MusicProviderId;
  /** Scoring format, fixed at creation. Legacy rows lack it — read it with
   *  `leagueFormat(league)`, which defaults to "standard". */
  format: LeagueFormat;
  settings: LeagueSettings;
  memberIds: string[];
  /** Shareable code players enter to join. Minted at creation, case-insensitive. */
  inviteCode: string;
  /** Who can find/join this league. Older records default to "private". */
  visibility: LeagueVisibility;
  /** Player cap for public leagues; open slots = maxMembers − memberIds.length.
   *  Unset for private (uncapped) leagues. */
  maxMembers?: number;
  /** How many rounds the league will run, chosen by the owner at creation.
   *  Drives the "Round X of N" display and the round stepper. */
  roundCount: number;
  /** Round progression mode. Older records default to "manual". */
  progression: RoundProgression;
  /** Timed mode: when the first round's timer may begin (ISO). Defaults to the
   *  creation time. Ignored in manual mode. */
  startAt?: string;
  /** Timed mode: how many days each phase (submitting/previewing/voting) lasts
   *  before it auto-advances. Ignored in manual mode. */
  phaseDays?: number;
  /** Head-to-head only: the season's frozen participant order — every member
   *  at the moment round 1 opened, shuffled once (rounds.ts freeze hook,
   *  HTH-03). Unset until then (the league is "un-frozen" and still takes
   *  players); once set it never changes and the league takes no new players.
   *  Every round's pairings derive from it (domain/schedule.ts). SERVER-ONLY:
   *  the order would deanonymize future matchups, so `toLeagueView` strips it
   *  from every payload (owner included) and the frontend types never carry
   *  it. Never copied by a rematch. Stored as a plain attribute on META. */
  h2hParticipants?: string[];
  /** Head-to-head only: the secret salt keying the schedule's per-round
   *  presentation order (see domain/schedule.ts). 128 random bits as 32 hex
   *  chars, generated in the same freeze write as `h2hParticipants`.
   *  SERVER-ONLY like the order — stripped from every payload, never copied
   *  by a rematch. */
  h2hSalt?: string;
}

export interface Round {
  id: string;
  leagueId: string;
  index: number;
  theme: string;
  description?: string;
  status: RoundStatus;
  submissionDeadline?: string;
  /** End of the previewing phase (timed mode) — when voting auto-opens. */
  previewDeadline?: string;
  voteDeadline?: string;
  playlistUrl?: string;
}

export interface Submission {
  id: string;
  roundId: string;
  userId: string;
  track: Track;
  comment?: string;
  /** When the pick was (last) submitted — feeds the activity feed. */
  submittedAt?: string;
}

/** A cast ballot: the whole point allocation for one voter in one round. */
export interface Ballot {
  roundId: string;
  voterId: string;
  /** submissionId -> points. Stored as one atomic item. */
  allocations: Record<string, number>;
  /** submissionId -> anti-votes; each subtracts a point at tally. */
  downvotes?: Record<string, number>;
  comments?: Record<string, string>;
  castAt: string;
}

export const DEFAULT_LEAGUE_SETTINGS: LeagueSettings = {
  votePoolSize: 10,
  maxPointsPerSong: 5,
  allowSelfVote: false,
  submissionsPerPlayer: 1,
  downvotePoolSize: 0,
};

/** A league's format, back-compat safe: leagues stored before formats existed
 *  (no field) — or anything unrecognised — read as "standard". This accessor
 *  is the single read path for the field; a raw `league.format` on a legacy
 *  row is `undefined` and would fail an `=== "standard"` check. */
export function leagueFormat(league: { format?: LeagueFormat | null }): LeagueFormat {
  return league.format === "headToHead" ? "headToHead" : "standard";
}

/** Settings a head-to-head league is locked to: one song per player (so a
 *  pairing of players is a pairing of songs) and no anti-votes (a matchup
 *  ballot picks a winner; there is no points pool to subtract from). Creation
 *  and rematch apply these; the settings PATCH rejects anything else. */
export const H2H_FORCED_SETTINGS: Pick<LeagueSettings, "submissionsPerPlayer" | "downvotePoolSize"> = {
  submissionsPerPlayer: 1,
  downvotePoolSize: 0,
};

/** Overlay the format's forced settings onto a settings object (a no-op for
 *  standard leagues). Used by the create and rematch paths to clamp. */
export function applyFormatSettings(format: LeagueFormat, settings: LeagueSettings): LeagueSettings {
  return format === "headToHead" ? { ...settings, ...H2H_FORCED_SETTINGS } : { ...settings };
}
