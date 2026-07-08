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
  /** May a player put points on their own submission? */
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

export interface League {
  id: string;
  name: string;
  ownerId: string;
  /** Music service this league runs on, chosen at creation. */
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
  /** Timed mode: when the first round's timer may begin (ISO). */
  startAt?: string;
  /** Timed mode: days each phase lasts before it auto-advances. */
  phaseDays?: number;
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
