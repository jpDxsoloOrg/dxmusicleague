// Core game domain. Mirrors the data model in musicLeagueClone.md §5, kept
// provider-agnostic: a league picks a music service, and submissions store a
// normalized Track snapshot rather than anything Spotify-specific.

import type { MusicProviderId, Track } from "../music/types";

export type RoundStatus = "draft" | "submitting" | "voting" | "revealed" | "complete";

export interface User {
  id: string;
  displayName: string;
  avatarUrl?: string;
}

export interface LeagueSettings {
  /** Points each voter distributes across submissions per round. */
  votePoolSize: number;
  /** May a player put points on their own submission? */
  allowSelfVote: boolean;
  /** Submissions allowed per player per round (1 for now). */
  submissionsPerPlayer: number;
}

export interface League {
  id: string;
  name: string;
  ownerId: string;
  /** Music service this league runs on, chosen at creation. */
  musicProvider: MusicProviderId;
  settings: LeagueSettings;
  memberIds: string[];
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
  allowSelfVote: false,
  submissionsPerPlayer: 1,
};
