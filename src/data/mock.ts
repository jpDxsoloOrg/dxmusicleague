// Mock data so the UI is fully clickable before any backend exists.
// Swap these reads for API calls in Phase 2+ without touching the components.

import type { League, LeagueSettings, LeagueVisibility, RoundProgression, Round, RoundStatus, User } from "../domain/types";
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
    musicProvider: "youtube-music",
    settings: DEFAULT_LEAGUE_SETTINGS,
    memberIds: ["u-me", "u-sarah", "u-james", "u-mia", "u-luna"],
    inviteCode: "SYNTH-23",
    visibility: "private",
    roundCount: 12,
    progression: "manual",
  },
  {
    id: "lg-vaporwave",
    name: "Vaporwave Vibes",
    ownerId: "u-sarah",
    musicProvider: "youtube-music",
    settings: { ...DEFAULT_LEAGUE_SETTINGS, votePoolSize: 12 },
    memberIds: ["u-me", "u-sarah", "u-jpop", "u-luna"],
    inviteCode: "VAPOR-88",
    visibility: "private",
    roundCount: 8,
    progression: "manual",
  },
  {
    id: "lg-bassline",
    name: "Bassline Battle",
    ownerId: "u-james",
    musicProvider: "youtube-music",
    settings: DEFAULT_LEAGUE_SETTINGS,
    memberIds: ["u-me", "u-james", "u-mia", "u-jpop", "u-sarah", "u-luna"],
    inviteCode: "BASS-42",
    visibility: "private",
    roundCount: 8,
    progression: "manual",
  },
  // A league the current user is NOT in yet — joinable via invite code below.
  {
    id: "lg-indie",
    name: "Indie Anthems",
    ownerId: "u-luna",
    musicProvider: "youtube-music",
    settings: DEFAULT_LEAGUE_SETTINGS,
    memberIds: ["u-luna", "u-mia", "u-jpop"],
    inviteCode: "INDIE-25",
    visibility: "private",
    roundCount: 8,
    progression: "manual",
  },
  // Public, not-yet-started leagues with open slots — discoverable by u-me (not a member).
  {
    id: "lg-midnight",
    name: "Midnight Drives",
    ownerId: "u-sarah",
    musicProvider: "spotify",
    settings: DEFAULT_LEAGUE_SETTINGS,
    memberIds: ["u-sarah", "u-james", "u-luna"],
    inviteCode: "NIGHT-1",
    visibility: "public",
    maxMembers: 8,
    roundCount: 8,
    progression: "manual",
  },
  {
    id: "lg-retro",
    name: "Retro Futures",
    ownerId: "u-jpop",
    musicProvider: "spotify",
    settings: DEFAULT_LEAGUE_SETTINGS,
    memberIds: ["u-jpop", "u-mia"],
    inviteCode: "RETRO-1",
    visibility: "public",
    maxMembers: 6,
    roundCount: 6,
    progression: "manual",
  },
  {
    id: "lg-urban",
    name: "Urban Beats",
    ownerId: "u-luna",
    musicProvider: "spotify",
    settings: DEFAULT_LEAGUE_SETTINGS,
    memberIds: ["u-luna", "u-james", "u-sarah", "u-mia"],
    inviteCode: "URBAN-1",
    visibility: "public",
    maxMembers: 10,
    roundCount: 10,
    progression: "manual",
  },
];

// Invite-code → leagueId lookup for the Join-a-league flow, derived from each
// league's own code so the two never drift. (Mock stand-in for real share links.)
export const inviteCodes: Record<string, string> = Object.fromEntries(
  leagues.map((lg) => [lg.inviteCode, lg.id]),
);

// A few rounds per league. Status drives the dashboard pill + completion bar.
export const rounds: Round[] = [
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

/** A public league a non-member could discover and claim a spot in. Mirrors the
 *  backend `PublicLeagueSummary` (handlers/leagues.ts). */
export interface PublicLeagueSummary {
  id: string;
  name: string;
  memberCount: number;
  maxMembers: number;
  openSlots: number;
  firstRoundTheme?: string;
}

/** A league in progress the caller could spectate (read-only). */
export interface BrowseLeagueSummary {
  id: string;
  name: string;
  visibility: LeagueVisibility;
  memberCount: number;
  totalRounds: number;
  currentRound?: { index: number; theme: string; status: RoundStatus };
}

/** Leagues in progress (any visibility) the current user isn't in — open to
 *  spectate. Mirrors the backend: running = any round beyond draft. */
export function getBrowseLeagues(limit = 24): BrowseLeagueSummary[] {
  const out = leagues
    .filter((lg) => !lg.memberIds.includes(currentUser.id))
    .filter((lg) => rounds.some((r) => r.leagueId === lg.id && r.status !== "draft"))
    .map((lg) => {
      const leagueRounds = rounds.filter((r) => r.leagueId === lg.id).sort((a, b) => b.index - a.index);
      const current = leagueRounds[0];
      return {
        id: lg.id,
        name: lg.name,
        visibility: lg.visibility,
        memberCount: lg.memberIds.length,
        totalRounds: lg.roundCount || leagueRounds.length,
        currentRound: current ? { index: current.index, theme: current.theme, status: current.status } : undefined,
      };
    });
  out.sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name));
  return out.slice(0, limit);
}

/** The join window: a league takes new members until round 1 moves past the
 *  submitting phase (mirrors the backend rule). */
function joinWindowClosed(leagueId: string): boolean {
  return rounds.some(
    (r) => r.leagueId === leagueId && !(r.status === "draft" || (r.index === 1 && r.status === "submitting")),
  );
}

/** Discover open public leagues: public, join window still open (round 1 at
 *  most submitting), with open slots, that the current user isn't already in.
 *  Ranked fullest-first. */
export function getOpenPublicLeagues(limit = 12): PublicLeagueSummary[] {
  const open = leagues
    .filter((lg) => lg.visibility === "public")
    .filter((lg) => !lg.memberIds.includes(currentUser.id))
    .filter((lg) => (lg.maxMembers ?? 0) - lg.memberIds.length > 0)
    .filter((lg) => !joinWindowClosed(lg.id))
    .map((lg) => {
      const firstRound = rounds
        .filter((r) => r.leagueId === lg.id)
        .sort((a, b) => a.index - b.index)[0];
      const cap = lg.maxMembers ?? 0;
      return {
        id: lg.id,
        name: lg.name,
        memberCount: lg.memberIds.length,
        maxMembers: cap,
        openSlots: cap - lg.memberIds.length,
        firstRoundTheme: firstRound?.theme,
      };
    });
  open.sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name));
  return open.slice(0, Math.max(0, limit));
}

/** A non-member's preview of a public league. Mirrors the backend
 *  `PublicLeaguePreview` (handlers/leagues.ts). */
export interface PublicLeaguePreview {
  id: string;
  name: string;
  memberCount: number;
  maxMembers: number;
  openSlots: number;
  firstRoundTheme?: string;
  members: { id: string; displayName: string }[];
  hasStarted: boolean;
  isFull: boolean;
  alreadyMember: boolean;
}

/** Preview a public league by id. Returns undefined for private/missing leagues
 *  (mirrors the API's 404). */
export function getPublicLeaguePreview(leagueId: string): PublicLeaguePreview | undefined {
  const lg = leagues.find((l) => l.id === leagueId && l.visibility === "public");
  if (!lg) return undefined;
  const leagueRounds = rounds.filter((r) => r.leagueId === lg.id).sort((a, b) => a.index - b.index);
  const cap = lg.maxMembers ?? 0;
  const openSlots = Math.max(0, cap - lg.memberIds.length);
  return {
    id: lg.id,
    name: lg.name,
    memberCount: lg.memberIds.length,
    maxMembers: cap,
    openSlots,
    firstRoundTheme: leagueRounds[0]?.theme,
    members: lg.memberIds.map((id) => ({ id, displayName: users[id]?.displayName ?? id })),
    hasStarted: joinWindowClosed(lg.id),
    isFull: openSlots <= 0,
    alreadyMember: lg.memberIds.includes(currentUser.id),
  };
}

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
        totalRounds: league.roundCount || leagueRounds.length,
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
  /** Defaults to "private" when omitted. */
  visibility?: LeagueVisibility;
  /** Required (and only meaningful) when visibility is "public". */
  maxMembers?: number;
  /** How many rounds the league will run (1–20). */
  roundCount?: number;
  /** Round progression; defaults to "manual". */
  progression?: RoundProgression;
  /** Timed mode: ISO start (defaults to now) and days per phase. */
  startAt?: string;
  phaseDays?: number;
}

/** Create a league owned by the current user and return it. */
export function createLeague(input: CreateLeagueInput): League {
  createdLeagueSeq += 1;
  const visibility: LeagueVisibility = input.visibility === "public" ? "public" : "private";
  const progression: RoundProgression = input.progression === "timed" ? "timed" : "manual";
  const league: League = {
    id: `lg-new-${createdLeagueSeq}`,
    name: input.name.trim(),
    ownerId: currentUser.id,
    musicProvider: input.musicProvider,
    settings: DEFAULT_LEAGUE_SETTINGS,
    memberIds: [currentUser.id],
    // Mint a shareable invite code so the new league is joinable too.
    inviteCode: `NEW-${100 + createdLeagueSeq}`,
    visibility,
    maxMembers: visibility === "public" ? input.maxMembers : undefined,
    roundCount: input.roundCount && input.roundCount >= 1 ? input.roundCount : 8,
    progression,
    startAt: progression === "timed" ? (input.startAt ?? new Date().toISOString()) : undefined,
    phaseDays: progression === "timed" ? input.phaseDays : undefined,
  };
  leagues.push(league);
  inviteCodes[league.inviteCode] = league.id;
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

/** Claim a spot in an open public league (mock: mutate in place). Mirrors the
 *  backend claimPublicSpot guards. */
export function claimPublicSpot(leagueId: string): JoinResult {
  const league = leagues.find((lg) => lg.id === leagueId && lg.visibility === "public");
  if (!league) return { ok: false, error: "That public league doesn't exist." };
  if (league.memberIds.includes(currentUser.id)) {
    return { ok: false, error: `You're already a member of ${league.name}.` };
  }
  if (joinWindowClosed(league.id)) {
    return { ok: false, error: "It's too late to join — round 1 has closed submissions." };
  }
  if (league.memberIds.length >= (league.maxMembers ?? 0)) {
    return { ok: false, error: "This league is full." };
  }
  league.memberIds.push(currentUser.id);
  return { ok: true, league };
}

/** Leave a league (mock: drop the current user from memberIds). */
export function leaveLeague(leagueId: string): void {
  const league = leagues.find((lg) => lg.id === leagueId);
  if (!league) throw new Error("That league doesn't exist.");
  if (league.ownerId === currentUser.id) throw new Error("You own this league — delete it instead of leaving.");
  league.memberIds = league.memberIds.filter((id) => id !== currentUser.id);
}

/** Owner kicks another member (mock: mutate in place). */
export function kickMember(leagueId: string, userId: string): void {
  const league = leagues.find((lg) => lg.id === leagueId);
  if (!league) throw new Error("That league doesn't exist.");
  if (league.ownerId !== currentUser.id) throw new Error("Only the league owner can remove other players.");
  if (userId === league.ownerId) throw new Error("The owner can't be removed.");
  league.memberIds = league.memberIds.filter((id) => id !== userId);
}

/** Owner mints a fresh invite code; the old one stops working (mock). */
export function regenerateInvite(leagueId: string): League {
  const league = leagues.find((lg) => lg.id === leagueId);
  if (!league) throw new Error("That league doesn't exist.");
  if (league.ownerId !== currentUser.id) throw new Error("Only the league owner can change the invite code.");
  delete inviteCodes[league.inviteCode];
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "DXL-";
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  league.inviteCode = code;
  inviteCodes[code] = league.id;
  return league;
}

/** Owner edits a league's voting settings (mock: mutate in place). */
export function updateLeagueSettings(
  leagueId: string,
  settings: Pick<LeagueSettings, "votePoolSize" | "maxPointsPerSong" | "allowSelfVote" | "submissionsPerPlayer">,
): League {
  const league = leagues.find((lg) => lg.id === leagueId);
  if (!league) throw new Error("That league doesn't exist.");
  league.settings = { ...league.settings, ...settings };
  return league;
}

/** Owner deletes a league and its rounds + invite codes (mock store cleanup). */
export function deleteLeague(leagueId: string): void {
  const idx = leagues.findIndex((lg) => lg.id === leagueId);
  if (idx >= 0) leagues.splice(idx, 1);
  for (let i = rounds.length - 1; i >= 0; i--) {
    if (rounds[i]!.leagueId === leagueId) rounds.splice(i, 1);
  }
  for (const code of Object.keys(inviteCodes)) {
    if (inviteCodes[code] === leagueId) delete inviteCodes[code];
  }
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

/** Who's done vs. still pending for the live phase. Identities only — no
 *  tracks, no point allocations. */
export interface RoundParticipation {
  submitted: User[];
  waiting: User[];
  /** Units done vs. expected: songs (members × allowance) while submitting,
   *  ballots (one per member) while voting. Drives the "X of N in" count. */
  doneCount: number;
  totalCount: number;
}

export interface LeagueDetail {
  league: League;
  rounds: Round[]; // ascending by index
  currentRound?: Round;
  totalRounds: number;
  standings: Standing[];
  /** Present only while the current round is submitting. */
  submissionProgress?: RoundParticipation;
  /** Present only while the current round is voting ("submitted" = ballot cast). */
  votingProgress?: RoundParticipation;
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
  /** Net total: pointsFor − pointsAgainst. May be negative with anti-votes. */
  points: number;
  /** Sum of positive votes. */
  pointsFor: number;
  /** Sum of anti-votes (positive number; 0 when none). */
  pointsAgainst: number;
  /** The submitter's own note about their pick, written at submit time. */
  submitterComment?: string;
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
  /** The submitter's own note about the pick (shown at reveal). */
  note?: string;
  points: number;
  /** Distinct voters who placed points on this song — the tie-break key. */
  voters: number;
  seedComments: Array<{ voterId: string; text: string }>;
}

// sub-2 and sub-3 are deliberately tied on points to exercise the tie-break
// rule: equal points → more distinct voters wins, so "Good 4 U" (6 voters)
// edges out "Blinding Lights" (5 voters). See getRoundResults below.
const CANON_SUBMISSIONS: CanonSubmission[] = [
  { id: "sub-1", pid: "m6", title: "Levitating", artists: ["Dua Lipa"], album: "Future Nostalgia", dur: 203000, submitterId: "u-sarah", note: "Instant serotonin — I had to.", points: 85, voters: 7,
    seedComments: [{ voterId: "u-james", text: "Instant dancefloor filler." }, { voterId: "u-mia", text: "Perfect road-trip energy." }] },
  { id: "sub-2", pid: "m5", title: "Blinding Lights", artists: ["The Weeknd"], album: "After Hours", dur: 200000, submitterId: "u-james", points: 72, voters: 5,
    seedComments: [{ voterId: "u-luna", text: "That synth line never gets old." }] },
  { id: "sub-3", pid: "m7", title: "Good 4 U", artists: ["Olivia Rodrigo"], album: "SOUR", dur: 178000, submitterId: "u-mia", points: 72, voters: 6,
    seedComments: [] },
  { id: "sub-4", pid: "m10", title: "Heat Waves", artists: ["Glass Animals"], album: "Dreamland", dur: 238000, submitterId: "u-luna", points: 58, voters: 4,
    seedComments: [{ voterId: "u-sarah", text: "Sneaky good pick." }] },
  { id: "sub-5", pid: "m1", title: "Midnight City", artists: ["M83"], album: "Hurry Up, We're Dreaming", dur: 243000, submitterId: "u-me", points: 50, voters: 4,
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
// Tie-break: equal points → more distinct voters wins, then title A→Z.
export function getRoundResults(leagueId: string): RoundResult[] {
  const mine = myVoteComments[leagueId] ?? {};
  return [...CANON_SUBMISSIONS]
    .sort((a, b) =>
      b.points - a.points ||
      b.voters - a.voters ||
      a.title.localeCompare(b.title))
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
        pointsFor: s.points,
        pointsAgainst: 0,
        submitterComment: s.note,
        comments,
      };
    })
    .filter((r) => r.submitter);
}

export function getLeagueDetail(leagueId: string): LeagueDetail | undefined {
  const league = leagues.find((lg) => lg.id === leagueId);
  if (!league) return undefined;
  // Spectators (non-members) may look, but never see the invite code.
  const isMember = league.memberIds.includes(currentUser.id);
  const summary = getMyLeagueSummaries().find((s) => s.league.id === leagueId);
  const leagueRounds = rounds
    .filter((r) => r.leagueId === leagueId)
    .sort((a, b) => a.index - b.index);
  // Summaries only cover the user's own leagues; for spectated ones fall back
  // to the latest round directly.
  const currentRound = summary?.currentRound ?? [...leagueRounds].sort((a, b) => b.index - a.index)[0];

  // Who's done vs. pending for the live phase, derived from the canonical
  // picks (submitting) or the seeded voter ids (voting).
  const members = league.memberIds.map((id) => users[id]).filter(Boolean);
  const splitByDone = (doneIds: Set<string>, counts: { done: number; total: number }): RoundParticipation => ({
    submitted: members.filter((m) => doneIds.has(m.id)),
    waiting: members.filter((m) => !doneIds.has(m.id)),
    doneCount: counts.done,
    totalCount: counts.total,
  });
  let submissionProgress: RoundParticipation | undefined;
  let votingProgress: RoundParticipation | undefined;
  if (currentRound?.status === "submitting") {
    const allowance = league.settings.submissionsPerPlayer || 1;
    submissionProgress = splitByDone(new Set(CANON_SUBMISSIONS.map((s) => s.submitterId)), {
      done: CANON_SUBMISSIONS.length,
      total: members.length * allowance,
    });
  } else if (currentRound?.status === "voting") {
    const voterIds = new Set(CANON_SUBMISSIONS.flatMap((s) => s.seedComments.map((c) => c.voterId)));
    if (myVoteComments[leagueId]) voterIds.add(currentUser.id);
    votingProgress = splitByDone(voterIds, { done: voterIds.size, total: members.length });
  }

  return {
    league: isMember ? league : { ...league, inviteCode: "" },
    rounds: leagueRounds,
    currentRound,
    totalRounds: summary?.totalRounds ?? leagueRounds.length,
    standings: getStandings(leagueId),
    submissionProgress,
    votingProgress,
    activity: ACTIVITY[leagueId] ?? [],
  };
}
