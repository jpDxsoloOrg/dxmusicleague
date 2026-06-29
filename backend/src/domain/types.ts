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
}

export interface League {
  id: string;
  name: string;
  ownerId: string;
  musicProvider: MusicProviderId;
  settings: LeagueSettings;
  memberIds: string[];
}

export interface Round {
  id: string;
  leagueId: string;
  index: number;
  theme: string;
  description?: string;
  status: RoundStatus;
  submissionDeadline?: string;
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
  comments?: Record<string, string>;
  castAt: string;
}

export const DEFAULT_LEAGUE_SETTINGS: LeagueSettings = {
  votePoolSize: 10,
  maxPointsPerSong: 5,
  allowSelfVote: false,
  submissionsPerPlayer: 1,
};
