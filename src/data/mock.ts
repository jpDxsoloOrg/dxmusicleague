// Mock data so the UI is fully clickable before any backend exists.
// Swap these reads for API calls in Phase 2+ without touching the components.

import type { League, Round, User } from "../domain/types";
import { DEFAULT_LEAGUE_SETTINGS } from "../domain/types";
import type { MusicProviderId, Track } from "../music";
import { trackKey } from "../music";

export const currentUser: User = {
  id: "u-me",
  displayName: "Curator Max",
};

export const users: Record<string, User> = {
  "u-me": currentUser,
  "u-sarah": { id: "u-sarah", displayName: "Sarah" },
  "u-james": { id: "u-james", displayName: "James" },
  "u-mia": { id: "u-mia", displayName: "Mia" },
  "u-jpop": { id: "u-jpop", displayName: "J-Pop" },
  "u-luna": { id: "u-luna", displayName: "Luna" },
};

export const leagues: League[] = [
  {
    id: "lg-synthwave",
    name: "Synthwave Souls",
    ownerId: "u-me",
    musicProvider: "mock",
    settings: DEFAULT_LEAGUE_SETTINGS,
    memberIds: ["u-me", "u-sarah", "u-james", "u-mia", "u-luna"],
  },
  {
    id: "lg-vaporwave",
    name: "Vaporwave Vibes",
    ownerId: "u-sarah",
    musicProvider: "mock",
    settings: { ...DEFAULT_LEAGUE_SETTINGS, votePoolSize: 12 },
    memberIds: ["u-me", "u-sarah", "u-jpop", "u-luna"],
  },
  {
    id: "lg-bassline",
    name: "Bassline Battle",
    ownerId: "u-james",
    musicProvider: "mock",
    settings: DEFAULT_LEAGUE_SETTINGS,
    memberIds: ["u-me", "u-james", "u-mia", "u-jpop", "u-sarah", "u-luna"],
  },
  // A league the current user is NOT in yet — joinable via invite code below.
  {
    id: "lg-indie",
    name: "Indie Anthems",
    ownerId: "u-luna",
    musicProvider: "mock",
    settings: DEFAULT_LEAGUE_SETTINGS,
    memberIds: ["u-luna", "u-mia", "u-jpop"],
  },
];

// Invite codes for the Join-a-league flow (mock stand-in for real share links).
// Code (case-insensitive) → leagueId.
export const inviteCodes: Record<string, string> = {
  "SYNTH-23": "lg-synthwave",
  "VAPOR-88": "lg-vaporwave",
  "INDIE-25": "lg-indie",
};

// A few rounds per league. Status drives the dashboard pill + completion bar.
export const rounds: Round[] = [
  { id: "r-sw-3", leagueId: "lg-synthwave", index: 3, theme: "Songs for a road trip", status: "submitting", submissionDeadline: isoInDays(2) },
  { id: "r-sw-2", leagueId: "lg-synthwave", index: 2, theme: "Neon Nights", status: "complete" },
  { id: "r-sw-1", leagueId: "lg-synthwave", index: 1, theme: "First Impressions", status: "complete" },
  { id: "r-vw-1", leagueId: "lg-vaporwave", index: 1, theme: "Mall Soundtrack", status: "voting", voteDeadline: isoInDays(1) },
  { id: "r-bb-4", leagueId: "lg-bassline", index: 4, theme: "Drop the Bass", status: "revealed", playlistUrl: "https://example.com/mock-playlist/bb4" },
  { id: "r-in-2", leagueId: "lg-indie", index: 2, theme: "Bedroom Pop Gems", status: "submitting", submissionDeadline: isoInDays(3) },
  { id: "r-in-1", leagueId: "lg-indie", index: 1, theme: "Garage Revival", status: "complete" },
];

/** Trending leagues a player could discover/join (not yet a member). */
export const trendingLeagues = [
  { id: "tl-1", name: "Midnight Drives", members: 128, tag: "Late-Night" },
  { id: "tl-2", name: "Retro Futures", members: 86, tag: "Synthpop" },
  { id: "tl-3", name: "Urban Beats", members: 204, tag: "Lo-Fi / Hip-Hop" },
];

// ---- view-model helpers (computed in the data layer, not the components) ----

export interface LeagueSummary {
  league: League;
  currentRound?: Round;
  totalRounds: number;
  /** 0-100, how complete the current round's phase is (mocked). */
  completionPct: number;
  members: User[];
}

const MOCK_COMPLETION: Record<string, number> = {
  "lg-synthwave": 76,
  "lg-vaporwave": 30,
  "lg-bassline": 100,
};

export function getMyLeagueSummaries(): LeagueSummary[] {
  return leagues
    .filter((lg) => lg.memberIds.includes(currentUser.id))
    .map((league) => {
      const leagueRounds = rounds.filter((r) => r.leagueId === league.id);
      const currentRound = [...leagueRounds].sort((a, b) => b.index - a.index)[0];
      return {
        league,
        currentRound,
        totalRounds: Math.max(league.id === "lg-synthwave" ? 12 : 8, leagueRounds.length),
        completionPct: MOCK_COMPLETION[league.id] ?? 0,
        members: league.memberIds.map((id) => users[id]).filter(Boolean),
      };
    });
}

// ---- create / join (mock mutations of the in-memory store) ----
// These push into the module-level arrays, so a created/joined league persists
// across navigation within the session. Phase 2 swaps these for API calls.

let createdLeagueSeq = 0;

export interface CreateLeagueInput {
  name: string;
  musicProvider: MusicProviderId;
}

/** Create a league owned by the current user and return it. */
export function createLeague(input: CreateLeagueInput): League {
  createdLeagueSeq += 1;
  const league: League = {
    id: `lg-new-${createdLeagueSeq}`,
    name: input.name.trim(),
    ownerId: currentUser.id,
    musicProvider: input.musicProvider,
    settings: DEFAULT_LEAGUE_SETTINGS,
    memberIds: [currentUser.id],
  };
  leagues.push(league);
  // Mint a shareable invite code so the new league is joinable too.
  inviteCodes[`NEW-${100 + createdLeagueSeq}`] = league.id;
  return league;
}

export type JoinResult =
  | { ok: true; league: League }
  | { ok: false; error: string };

/** Join the current user to a league by invite code (case-insensitive). */
export function joinLeague(rawCode: string): JoinResult {
  const code = rawCode.trim().toUpperCase();
  if (!code) return { ok: false, error: "Enter an invite code to join." };
  const leagueId = inviteCodes[code];
  const league = leagues.find((lg) => lg.id === leagueId);
  if (!league) return { ok: false, error: "That code doesn't match any league." };
  if (league.memberIds.includes(currentUser.id)) {
    return { ok: false, error: `You're already a member of ${league.name}.` };
  }
  league.memberIds.push(currentUser.id);
  return { ok: true, league };
}

function isoInDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

// ---- league detail (round overview screen) ----

export interface Standing {
  rank: number;
  user: User;
  points: number;
  note?: string;
}

export interface ActivityItem {
  id: string;
  user: User;
  text: string;
  timeAgo: string;
}

const STANDINGS: Record<string, Array<{ userId: string; points: number; note?: string }>> = {
  "lg-synthwave": [
    { userId: "u-james", points: 450, note: "On a 3-day streak" },
    { userId: "u-sarah", points: 420, note: "Lounge Resident" },
    { userId: "u-mia", points: 390, note: "Rising Star" },
    { userId: "u-me", points: 360 },
    { userId: "u-luna", points: 300 },
  ],
  "lg-vaporwave": [
    { userId: "u-sarah", points: 410 },
    { userId: "u-me", points: 380 },
    { userId: "u-jpop", points: 350 },
    { userId: "u-luna", points: 300 },
  ],
  "lg-bassline": [
    { userId: "u-mia", points: 420 },
    { userId: "u-sarah", points: 415 },
    { userId: "u-james", points: 390 },
    { userId: "u-me", points: 380 },
    { userId: "u-jpop", points: 360 },
    { userId: "u-luna", points: 340 },
  ],
};

const ACTIVITY: Record<string, ActivityItem[]> = {
  "lg-synthwave": [
    { id: "a1", user: users["u-sarah"], text: "submitted a song", timeAgo: "2m ago" },
    { id: "a2", user: users["u-james"], text: "joined this round", timeAgo: "18m ago" },
    { id: "a3", user: users["u-mia"], text: "voted in Round 2", timeAgo: "1h ago" },
  ],
  "lg-vaporwave": [
    { id: "a1", user: users["u-me"], text: "cast their votes", timeAgo: "5m ago" },
    { id: "a2", user: users["u-jpop"], text: "cast their votes", timeAgo: "40m ago" },
  ],
  "lg-bassline": [
    { id: "a1", user: users["u-mia"], text: "won Round 4 🏆", timeAgo: "3h ago" },
    { id: "a2", user: users["u-james"], text: "submitted a song", timeAgo: "yesterday" },
  ],
};

export function getStandings(leagueId: string): Standing[] {
  return (STANDINGS[leagueId] ?? [])
    .map((s, i) => ({ rank: i + 1, user: users[s.userId], points: s.points, note: s.note }))
    .filter((s) => s.user);
}

export interface LeagueDetail {
  league: League;
  rounds: Round[]; // ascending by index
  currentRound?: Round;
  totalRounds: number;
  standings: Standing[];
  activity: ActivityItem[];
}

// ---- round submissions (shared by the vote + reveal screens) ----
// One canonical set per round. During voting they're anonymous and the voter's own
// pick is hidden; on reveal submitters, points, and all voter comments are shown.

export interface VoterComment {
  voter: User;
  text: string;
}

export interface VotableSubmission {
  id: string;
  track: Track;
}

export interface RoundResult {
  rank: number;
  track: Track;
  submitter: User;
  points: number;
  comments: VoterComment[];
}

function mockTrack(
  pid: string,
  title: string,
  artists: string[],
  album?: string,
  durationMs?: number,
): Track {
  return { id: trackKey("mock", pid), provider: "mock", providerTrackId: pid, title, artists, album, durationMs };
}

interface CanonSubmission {
  id: string;
  pid: string;
  title: string;
  artists: string[];
  album: string;
  dur: number;
  submitterId: string;
  points: number;
  seedComments: Array<{ voterId: string; text: string }>;
}

const CANON_SUBMISSIONS: CanonSubmission[] = [
  { id: "sub-1", pid: "m6", title: "Levitating", artists: ["Dua Lipa"], album: "Future Nostalgia", dur: 203000, submitterId: "u-sarah", points: 85,
    seedComments: [{ voterId: "u-james", text: "Instant dancefloor filler." }, { voterId: "u-mia", text: "Perfect road-trip energy." }] },
  { id: "sub-2", pid: "m5", title: "Blinding Lights", artists: ["The Weeknd"], album: "After Hours", dur: 200000, submitterId: "u-james", points: 72,
    seedComments: [{ voterId: "u-luna", text: "That synth line never gets old." }] },
  { id: "sub-3", pid: "m7", title: "Good 4 U", artists: ["Olivia Rodrigo"], album: "SOUR", dur: 178000, submitterId: "u-mia", points: 64,
    seedComments: [] },
  { id: "sub-4", pid: "m10", title: "Heat Waves", artists: ["Glass Animals"], album: "Dreamland", dur: 238000, submitterId: "u-luna", points: 58,
    seedComments: [{ voterId: "u-sarah", text: "Sneaky good pick." }] },
  { id: "sub-5", pid: "m1", title: "Midnight City", artists: ["M83"], album: "Hurry Up, We're Dreaming", dur: 243000, submitterId: "u-me", points: 50,
    seedComments: [{ voterId: "u-james", text: "A certified classic." }] },
];

// In-memory store of the current user's per-song vote comments (no backend yet).
// leagueId -> submissionId -> comment. Persists across navigation within the session.
const myVoteComments: Record<string, Record<string, string>> = {};

export function saveVoteComments(leagueId: string, comments: Record<string, string>): void {
  const cleaned: Record<string, string> = {};
  for (const [id, text] of Object.entries(comments)) {
    if (text.trim()) cleaned[id] = text.trim();
  }
  myVoteComments[leagueId] = cleaned;
}

// Submissions to vote on: anonymized, excluding the current user's own pick.
export function getVotableSubmissions(_leagueId: string): VotableSubmission[] {
  return CANON_SUBMISSIONS
    .filter((s) => s.submitterId !== currentUser.id)
    .map((s) => ({ id: s.id, track: mockTrack(s.pid, s.title, s.artists, s.album, s.dur) }));
}

// Results: ranked by points, submitters revealed, with all voter comments
// (seeded ones plus whatever the current user left while voting).
export function getRoundResults(leagueId: string): RoundResult[] {
  const mine = myVoteComments[leagueId] ?? {};
  return [...CANON_SUBMISSIONS]
    .sort((a, b) => b.points - a.points)
    .map((s, i) => {
      const comments: VoterComment[] = s.seedComments
        .map((c) => ({ voter: users[c.voterId], text: c.text }))
        .filter((c) => c.voter);
      const myText = mine[s.id];
      if (myText) comments.push({ voter: currentUser, text: myText });
      return {
        rank: i + 1,
        track: mockTrack(s.pid, s.title, s.artists, s.album, s.dur),
        submitter: users[s.submitterId],
        points: s.points,
        comments,
      };
    })
    .filter((r) => r.submitter);
}

export function getLeagueDetail(leagueId: string): LeagueDetail | undefined {
  const league = leagues.find((lg) => lg.id === leagueId);
  if (!league) return undefined;
  const summary = getMyLeagueSummaries().find((s) => s.league.id === leagueId);
  const leagueRounds = rounds
    .filter((r) => r.leagueId === leagueId)
    .sort((a, b) => a.index - b.index);
  return {
    league,
    rounds: leagueRounds,
    currentRound: summary?.currentRound,
    totalRounds: summary?.totalRounds ?? leagueRounds.length,
    standings: getStandings(leagueId),
    activity: ACTIVITY[leagueId] ?? [],
  };
}
