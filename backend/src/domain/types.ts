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

export interface League {
  id: string;
  name: string;
  ownerId: string;
  musicProvider: MusicProviderId;
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
