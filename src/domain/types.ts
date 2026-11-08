// Core game domain. Mirrors the data model in musicLeagueClone.md §5, kept
// provider-agnostic: a league picks a music service, and submissions store a
// normalized Track snapshot rather than anything Spotify-specific.

import type { MusicProviderId, Track } from "../music/types";

// Lifecycle: draft → submitting → previewing → voting → revealed (→ complete).
// `previewing` = submissions closed, songs revealed as a playlist for listening,
// voting not yet open.
export type RoundStatus = "draft" | "submitting" | "previewing" | "voting" | "revealed" | "complete";

export interface User {
  id: string;
  displayName: string;
  avatarUrl?: string;
}

export interface LeagueSettings {
  /** Points each voter distributes across submissions per round. */
  votePoolSize: number;
  /** Most points a voter may place on any single submission, forcing them to
   *  spread the pool across multiple songs. Must be ≤ votePoolSize. */
  maxPointsPerSong: number;
  /** Deprecated — always false. Self-voting is never allowed, in any league
   *  (BUG-17): there is no such option any more, the client never sends it,
   *  and the server stores and returns false whatever it is sent. Kept only
   *  because leagues stored before it was removed may still hold `true`.
   *  Mirrors backend/src/domain/types.ts. */
  allowSelfVote: boolean;
  /** Submissions allowed per player per round. Locked to 1 today; kept as a
   *  field so multiple-per-player can be enabled later without a migration. */
  submissionsPerPlayer: number;
  /** Anti-votes each voter may place per round (0 disables; each subtracts
   *  a point at tally — totals can go negative). Optional to spend. */
  downvotePoolSize: number;
}

/** Private = joinable by invite code only. Public = discoverable + claimable. */
export type LeagueVisibility = "private" | "public";

/** How rounds move between phases. `manual` = owner advances each phase;
 *  `timed` = phases auto-advance after `phaseDays` days. */
export type RoundProgression = "manual" | "timed";

/** How a league is scored. `standard` = every voter spreads a points pool over
 *  every song, standings by total points. `headToHead` = round-robin 1v1
 *  matchups each round, most votes wins, standings by W/L/D record. Chosen at
 *  creation and immutable afterwards. Mirror of the backend's LeagueFormat —
 *  always read it through `leagueFormat()`, never raw (older leagues and older
 *  API responses carry no field). */
export type LeagueFormat = "standard" | "headToHead";

export interface League {
  id: string;
  name: string;
  ownerId: string;
  /** Music service this league runs on, chosen at creation. */
  musicProvider: MusicProviderId;
  /** Scoring format, fixed at creation. Read it with `leagueFormat(league)`,
   *  which defaults to "standard" when the field is absent. */
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
  /** Timed mode: when the first round's timer may begin (ISO). */
  startAt?: string;
  /** Timed mode: days each phase lasts before it auto-advances. */
  phaseDays?: number;
  /** Once this finished league has been rematched: the rematch league's id.
   *  A finished league has at most one live rematch (BUG-13). Only the league
   *  detail's copy is filtered: it is present only while that league exists
   *  and the viewer is one of its members — the overview's "Go to the
   *  rematch" link (and, for the owner, instead of "Run it back"). Elsewhere
   *  (dashboard summaries, join/settings responses) it is the raw stored
   *  pointer, which may name a deleted league or one the viewer left, so
   *  link from the detail only. */
  rematchLeagueId?: string;
}

export interface Round {
  id: string;
  leagueId: string;
  /** 1-based round number within the league. */
  index: number;
  theme: string;
  description?: string;
  status: RoundStatus;
  submissionDeadline?: string; // ISO 8601
  /** End of the previewing phase (timed mode) — when voting auto-opens. */
  previewDeadline?: string; // ISO 8601
  voteDeadline?: string; // ISO 8601
  /** Public playlist URL, set on reveal. */
  playlistUrl?: string;
}

export interface Submission {
  id: string;
  roundId: string;
  userId: string;
  /** Normalized, provider-agnostic snapshot of the chosen track. */
  track: Track;
  comment?: string;
}

export interface Vote {
  id: string;
  roundId: string;
  voterId: string;
  submissionId: string;
  points: number;
}

export const DEFAULT_LEAGUE_SETTINGS: LeagueSettings = {
  votePoolSize: 10,
  maxPointsPerSong: 5,
  allowSelfVote: false,
  submissionsPerPlayer: 1,
  downvotePoolSize: 0,
};

/** A league's format, back-compat safe: a league without the field (legacy
 *  record, or a response from a backend that predates formats) — or anything
 *  unrecognised — reads as "standard". Mirrors backend/src/domain/types.ts. */
export function leagueFormat(league: { format?: LeagueFormat | null }): LeagueFormat {
  return league.format === "headToHead" ? "headToHead" : "standard";
}

/** Settings a head-to-head league is locked to (one song per player, no
 *  anti-votes). The server clamps these at creation and 400s a settings edit
 *  that changes them. Mirrors backend/src/domain/types.ts. */
export const H2H_FORCED_SETTINGS: Pick<LeagueSettings, "submissionsPerPlayer" | "downvotePoolSize"> = {
  submissionsPerPlayer: 1,
  downvotePoolSize: 0,
};

/** Overlay the settings a new league is forced to: self-voting off in every
 *  format (BUG-17), plus the format's forced settings (none for standard).
 *  Always a copy. The mock's create and rematch use it, as the server's do.
 *  Mirrors backend/src/domain/types.ts. */
export function applyFormatSettings(format: LeagueFormat, settings: LeagueSettings): LeagueSettings {
  const clamped: LeagueSettings = { ...settings, allowSelfVote: false };
  return format === "headToHead" ? { ...clamped, ...H2H_FORCED_SETTINGS } : clamped;
}

/** Has a head-to-head season been scheduled? The server freezes the season
 *  (player order, round count = everyone plays everyone once) when round 1
 *  opens, and no later round can exist before that. Seen from the client,
 *  that is any round past draft, or any round after the first. Until then
 *  `league.roundCount` is only the provisional number sent at creation, so
 *  pages say "set when round 1 opens" instead of showing it. Pass every
 *  round you have (a summary's current round is enough). */
export function h2hScheduleSet(rounds: ReadonlyArray<Pick<Round, "index" | "status">>): boolean {
  return rounds.some((r) => r.index > 1 || r.status !== "draft");
}
