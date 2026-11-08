// Mock data so the UI is fully clickable before any backend exists.
// Swap these reads for API calls in Phase 2+ without touching the components.
//
// Head-to-head leagues (HTH-09) are the exception to "canned": the mock runs
// them for real — season freeze, derived matchups, pick ballots, reveal +
// W/L/D banking — over the backend's own pure domain modules, imported
// straight from backend/src/domain (isomorphic by design: no Node APIs), so
// the pairings, the ballot referee's error messages, the tally and the
// standings order can never drift from the API. See the "Head-to-head"
// section at the bottom of this file.

import type { League, LeagueFormat, LeagueSettings, LeagueVisibility, RoundProgression, Round, RoundStatus, Submission, User } from "../domain/types";
import { DEFAULT_LEAGUE_SETTINGS, H2H_FORCED_SETTINGS, leagueFormat } from "../domain/types";
import type { MusicProviderId, Track } from "../music";
import { trackKey } from "../music";
// The backend's isomorphic domain + the shared H2H seed fixture (one source
// for the frontend mock and the in-memory backend — identical ids/data).
import type { Ballot, MatchupTally, Submission as ServerSubmission } from "../../backend/src/domain/types.ts";
import { compareMatchupIds } from "../../backend/src/domain/schedule.ts";
import {
  anonymousSong,
  ballotAuthorVisible,
  departedParticipants,
  deriveRoundMatchups,
  inAnonymousOrder,
  matchupsView,
  memberSongCount,
  membersWithSong,
  roundSettled,
  votingPanelNames,
  votingTurnout,
} from "../../backend/src/domain/matchups.ts";
import type { DeriveOptions, RoundMatchupSet, VotingTurnout } from "../../backend/src/domain/matchups.ts";
import {
  matchupRecords,
  resolveMatchups,
  settleMatchups,
  tallyMatchups,
  validateH2HBallot,
} from "../../backend/src/domain/rules.ts";
import type { SettledRound, SettledSide } from "../../backend/src/domain/rules.ts";
import {
  H2H_MIN_PLAYERS_MESSAGE,
  H2H_ROUND_ONE_FIRST_MESSAGE,
  MIN_H2H_PLAYERS,
  SEASON_LOCKED_MESSAGE,
  lockedOutOfSeason,
  planSeasonFreeze,
  seasonLocked,
} from "../../backend/src/domain/freeze.ts";
import { recordIncrements, sortStandings } from "../../backend/src/domain/standings.ts";
import type { StandingRecordDelta, StandingTotals } from "../../backend/src/domain/standings.ts";
import { headToHeadSeed } from "../../backend/src/data/seedHeadToHead.ts";

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

// The seeded head-to-head league (shared fixture — see the H2H section). Its
// season secrets (frozen order + salt) are split off into the mock's
// server-side store; the League object pages receive never carries them.
const H2H_SEED = headToHeadSeed();
const { h2hParticipants: seedOrder, h2hSalt: seedSalt, ...H2H_SEED_LEAGUE } = H2H_SEED.league;

export const leagues: League[] = [
  {
    id: "lg-synthwave",
    name: "Synthwave Souls",
    ownerId: "u-me",
    musicProvider: "youtube-music",
    format: "standard",
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
    format: "standard",
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
    format: "standard",
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
    format: "standard",
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
    format: "standard",
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
    format: "standard",
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
    format: "standard",
    settings: DEFAULT_LEAGUE_SETTINGS,
    memberIds: ["u-luna", "u-james", "u-sarah", "u-mia"],
    inviteCode: "URBAN-1",
    visibility: "public",
    maxMembers: 10,
    roundCount: 10,
    progression: "manual",
  },
  // Head-to-head, mid-season: round 1 revealed (a draw, a walkover, a bye),
  // round 2 in voting. Owned by the current user.
  H2H_SEED_LEAGUE,
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
  // The head-to-head league's rounds. The reveal's pins (h2hDeparted /
  // h2hTally) live in the H2H store instead. Known shape gap: the API still
  // carries them on revealed H2H rounds wherever it sends a whole round —
  // GET /leagues/:id (`rounds` and `currentRound`), the GET /leagues
  // summaries (`currentRound`), and PATCH /leagues/:id/rounds/:rid (the
  // round it returns after an edit of a revealed round, or when opening
  // voting auto-reveals a round nobody can vote in). They are internal
  // settlement state that no page reads, and only exist after the reveal
  // (nothing to deanonymize), so pages must not rely on them. Closing the gap
  // means stripping them in those backend handlers: getLeagueDetail and
  // listMyLeagues in handlers/leagues.ts, and updateRound in handlers/rounds.ts.
  ...H2H_SEED.rounds.map(({ h2hDeparted: _departed, h2hTally: _tally, ...round }) => round),
];

/** A public league a non-member could discover and claim a spot in. Mirrors the
 *  backend `PublicLeagueSummary` (handlers/leagues.ts). */
export interface PublicLeagueSummary {
  id: string;
  name: string;
  /** Optional here (always sent by the backend) so this frontend still works
   *  against an API that predates it: read it via `leagueFormat(summary)`,
   *  where a missing field means "standard". Same on the two types below. */
  format?: LeagueFormat;
  memberCount: number;
  maxMembers: number;
  openSlots: number;
  firstRoundTheme?: string;
}

/** A league in progress the caller could spectate (read-only). */
export interface BrowseLeagueSummary {
  id: string;
  name: string;
  format?: LeagueFormat;
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
        format: leagueFormat(lg),
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

/** Closed to newcomers — what discovery and the preview advertise: the join
 *  window above, plus (head-to-head only) the season lock from the moment
 *  round 1 opens. Mirrors the backend's `closedToNewPlayers`. */
function closedToNewPlayers(league: League): boolean {
  return h2hSeasonLocked(league) || joinWindowClosed(league.id);
}

/** Discover open public leagues: public, join window still open (round 1 at
 *  most submitting), with open slots, that the current user isn't already in.
 *  Ranked fullest-first. */
export function getOpenPublicLeagues(limit = 12): PublicLeagueSummary[] {
  const open = leagues
    .filter((lg) => lg.visibility === "public")
    .filter((lg) => !lg.memberIds.includes(currentUser.id))
    .filter((lg) => (lg.maxMembers ?? 0) - lg.memberIds.length > 0)
    .filter((lg) => !closedToNewPlayers(lg))
    .map((lg) => {
      const firstRound = rounds
        .filter((r) => r.leagueId === lg.id)
        .sort((a, b) => a.index - b.index)[0];
      const cap = lg.maxMembers ?? 0;
      return {
        id: lg.id,
        name: lg.name,
        format: leagueFormat(lg),
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
  /** Also tells the page how to word `hasStarted`: a head-to-head league
   *  closes when round 1 opens (season locked), not when it stops taking
   *  songs. */
  format?: LeagueFormat;
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
    format: leagueFormat(lg),
    memberCount: lg.memberIds.length,
    maxMembers: cap,
    openSlots,
    firstRoundTheme: leagueRounds[0]?.theme,
    members: lg.memberIds.map((id) => ({ id, displayName: users[id]?.displayName ?? id })),
    hasStarted: closedToNewPlayers(lg),
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
  /** True once the final round has been revealed — the league is closed. */
  finished: boolean;
}

/** Mirrors the backend rule: finished = the last round (index ≥ roundCount)
 *  has been revealed, so the league is closed to new rounds. */
function isLeagueFinished(league: League, leagueRounds: Round[]): boolean {
  if (!league.roundCount) return false;
  const last = [...leagueRounds].sort((a, b) => b.index - a.index)[0];
  return Boolean(
    last && last.index >= league.roundCount && (last.status === "revealed" || last.status === "complete"),
  );
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
        // Head-to-head leagues compute it for real (mock state); the canned
        // standard leagues keep their demo numbers.
        completionPct: isHeadToHead(league) ? h2hCompletionPct(league, currentRound) : (MOCK_COMPLETION[league.id] ?? 0),
        members: league.memberIds.map((id) => users[id]).filter(Boolean),
        finished: isLeagueFinished(league, leagueRounds),
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
  /** Scoring format; defaults to "standard". Immutable after creation. */
  format?: LeagueFormat;
}

/** Create a league owned by the current user and return it. */
export function createLeague(input: CreateLeagueInput): League {
  // Mirrors the backend: absent → standard, unknown → the server's 400 message.
  const format: LeagueFormat = input.format ?? "standard";
  if (format !== "standard" && format !== "headToHead") {
    throw new Error("Pick a league format: standard (points) or head-to-head.");
  }
  createdLeagueSeq += 1;
  const visibility: LeagueVisibility = input.visibility === "public" ? "public" : "private";
  const progression: RoundProgression = input.progression === "timed" ? "timed" : "manual";
  const league: League = {
    id: `lg-new-${createdLeagueSeq}`,
    name: input.name.trim(),
    ownerId: currentUser.id,
    musicProvider: input.musicProvider,
    format,
    // Head-to-head is clamped to its forced settings, like the server does.
    settings: format === "headToHead" ? { ...DEFAULT_LEAGUE_SETTINGS, ...H2H_FORCED_SETTINGS } : DEFAULT_LEAGUE_SETTINGS,
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
  // Head-to-head boards are read from the mock's standing rows (the backend
  // seeds one per member at create/join, points and record at 0).
  if (format === "headToHead") seedStandingRow(league.id, currentUser.id);
  return league;
}

/** Outcome of joining by invite code or claiming a spot. `alreadyMember`
 *  (join by code only): the caller was already in the league, so nothing
 *  changed and only its id is known — all the API's already-member 409
 *  carries. Pages open `league.id` either way. */
export type JoinResult =
  | { ok: true; league: League; alreadyMember?: false }
  | { ok: true; league: Pick<League, "id">; alreadyMember: true }
  | { ok: false; error: string };

/** Join the current user to a league by invite code (case-insensitive). */
export function joinLeague(rawCode: string): JoinResult {
  const code = rawCode.trim().toUpperCase();
  if (!code) return { ok: false, error: "Enter an invite code to join." };
  const leagueId = inviteCodes[code];
  const league = leagues.find((lg) => lg.id === leagueId);
  if (!league) return { ok: false, error: "That code doesn't match any league." };
  // Already in it (a re-opened invite link, your own code): mirrors the API's
  // already-member 409, which ApiClient maps to this same result.
  if (league.memberIds.includes(currentUser.id)) return { ok: true, league: { id: league.id }, alreadyMember: true };
  // Invite codes bypass the join window and the cap — except a head-to-head
  // season that has frozen (round 1 opened): mirrors the backend's lock.
  if (lockedOutOfSeason(seasonView(league), currentUser.id)) return { ok: false, error: SEASON_LOCKED_MESSAGE };
  league.memberIds.push(currentUser.id);
  if (isHeadToHead(league)) seedStandingRow(league.id, currentUser.id);
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
  // Head-to-head: the season lock is checked first, for its distinct reason.
  if (lockedOutOfSeason(seasonView(league), currentUser.id)) return { ok: false, error: SEASON_LOCKED_MESSAGE };
  if (joinWindowClosed(league.id)) {
    return { ok: false, error: "It's too late to join — round 1 has closed submissions." };
  }
  if (league.memberIds.length >= (league.maxMembers ?? 0)) {
    return { ok: false, error: "This league is full." };
  }
  league.memberIds.push(currentUser.id);
  if (isHeadToHead(league)) seedStandingRow(league.id, currentUser.id);
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

/** Owner edits a league's voting settings (mock: mutate in place). The format
 *  is never part of the payload — it can't change after creation. */
export function updateLeagueSettings(
  leagueId: string,
  settings: Pick<
    LeagueSettings,
    "votePoolSize" | "maxPointsPerSong" | "allowSelfVote" | "submissionsPerPlayer" | "downvotePoolSize"
  >,
): League {
  const league = leagues.find((lg) => lg.id === leagueId);
  if (!league) throw new Error("That league doesn't exist.");
  // Same referee rule (and messages) as the backend's settings PATCH,
  // including its "omitted → keep the league's current value" resolution.
  if (leagueFormat(league) === "headToHead") {
    const songs = settings.submissionsPerPlayer ?? (league.settings.submissionsPerPlayer || 1);
    const antiVotes = settings.downvotePoolSize ?? league.settings.downvotePoolSize ?? 0;
    if (songs !== H2H_FORCED_SETTINGS.submissionsPerPlayer) {
      throw new Error("Head-to-head leagues are locked to 1 song per player.");
    }
    if (antiVotes !== H2H_FORCED_SETTINGS.downvotePoolSize) {
      throw new Error("Head-to-head leagues don't use anti-votes.");
    }
  }
  league.settings = { ...league.settings, ...settings };
  return league;
}

/** Owner deletes a league and its rounds + invite codes (mock store cleanup). */
export function deleteLeague(leagueId: string): void {
  forgetHeadToHeadLeague(leagueId); // before the rounds go: it needs their ids
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

/** One row of the league table. Every row carries both scorings, like the
 *  API's: `points` (what a standard league ranks and shows) and the
 *  head-to-head record `wins`/`losses`/`draws` (what an H2H league ranks and
 *  shows, HTH-04) — the unused side is 0. Rows arrive in board order for the
 *  league's format (points desc, or wins desc → losses asc → name). */
export interface Standing {
  rank: number;
  user: User;
  points: number;
  wins: number;
  losses: number;
  draws: number;
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
  // Leagues seeded without a score: every member at 0, in member order — the
  // rows the backend seed writes for them (BUG-08), so each seeded member is
  // on these boards in both modes. (Unlike the backend, the mock's standard
  // create / join / claim add no row, so a player who joins later is not.)
  "lg-indie": [
    { userId: "u-luna", points: 0 },
    { userId: "u-mia", points: 0 },
    { userId: "u-jpop", points: 0 },
  ],
  "lg-midnight": [
    { userId: "u-sarah", points: 0 },
    { userId: "u-james", points: 0 },
    { userId: "u-luna", points: 0 },
  ],
  "lg-retro": [
    { userId: "u-jpop", points: 0 },
    { userId: "u-mia", points: 0 },
  ],
  "lg-urban": [
    { userId: "u-luna", points: 0 },
    { userId: "u-james", points: 0 },
    { userId: "u-sarah", points: 0 },
    { userId: "u-mia", points: 0 },
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
  const league = leagues.find((lg) => lg.id === leagueId);
  if (league && isHeadToHead(league)) return headToHeadStandings(league);
  return (STANDINGS[leagueId] ?? [])
    .map((s, i) => ({ rank: i + 1, user: users[s.userId], points: s.points, wins: 0, losses: 0, draws: 0, note: s.note }))
    .filter((s) => s.user);
}

/** Who's done vs. still pending for the live phase. Identities only — no
 *  tracks, no point allocations. */
export interface RoundParticipation {
  /** Head-to-head voting names only members with a matchup to pick in —
   *  and unless every member has one, only the viewer, if they do (HTH-08
   *  `votingPanelNames`, which MockClient and the API both call) — so a
   *  viewer in neither list has nothing to vote on this round. The round
   *  overview's CTA relies on that. */
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
  /** True once the final round has been revealed — the league is closed. */
  finished: boolean;
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

// ---- head-to-head view models (HTH-05/06/07 wire shapes) ----

/** One matchup of a head-to-head round as a voter sees it (GET
 *  /rounds/:roundId/matchups, HTH-05): the two songs, anonymous — the same
 *  `{ id, track }` shape as the points vote list — or `null` for a side with
 *  no song (walkover; both null = no contest). `isMine` is the only identity
 *  signal: true when the viewer is one of the two players, so the vote page
 *  locks it. Pick state should key by `matchupId`, never by position. */
export interface MatchupView {
  /** `<roundId>~M<n>` — what ballot `picks` are keyed by. */
  matchupId: string;
  a: VotableSubmission | null;
  b: VotableSubmission | null;
  isMine: boolean;
}

/** A head-to-head round's matchups (sorted by matchup id) plus the bye
 *  player's exhibition song — `null` for an even field or a bye with no song.
 *  The exhibition takes no pick; anything with both songs and `!isMine`
 *  does. */
export interface RoundMatchups {
  matchups: MatchupView[];
  bye: VotableSubmission | null;
}

/** The caller's cast ballot (GET my-ballot), pre-filling the vote page. A
 *  head-to-head league's also carries `picks` (matchupId → the submission id
 *  picked to win, HTH-06), returned exactly as stored; a standard league's
 *  has no `picks` key. */
export interface MyBallot {
  allocations: Record<string, number>;
  downvotes: Record<string, number>;
  comments: Record<string, string>;
  picks?: Record<string, string>;
}

/** How a revealed matchup ended (HTH-07). An open set — playoffs may add
 *  outcomes later — so render an unknown value as "no result". The bye isn't
 *  a matchup and has no outcome. */
export type MatchupOutcome = "win" | "draw" | "walkover" | "noContest";

/** A song at the reveal: id + track plus the submitter's note and every voter
 *  comment, as the standard reveal shows them. */
export interface RevealedSong {
  id: string;
  track: Track;
  submitterComment?: string;
  comments: VoterComment[];
}

/** One side of a revealed matchup: the player (named now), their song (`null`
 *  = didn't submit, or had left/been kicked by the reveal), the picks it won
 *  (0 outside a contest) and whether the player had departed (their side
 *  banked no loss). */
export interface MatchupResultSide {
  player: User;
  song: RevealedSong | null;
  votes: number;
  departed: boolean;
}

/** A revealed head-to-head matchup. `winnerUserId` is set for `win` and
 *  `walkover` only. */
export interface MatchupResult {
  matchupId: string;
  a: MatchupResultSide;
  b: MatchupResultSide;
  outcome: MatchupOutcome;
  winnerUserId?: string;
}

/** The bye player's exhibition song, revealed — no matchup, no result. */
export interface ByeResult {
  player: User;
  song: RevealedSong;
}

/** A head-to-head round's results, as the API sends them. */
export interface HeadToHeadResults {
  format: "headToHead";
  /** Every matchup of the round, sorted by matchup id. */
  matchups: MatchupResult[];
  bye: ByeResult | null;
}

/** A revealed round's results in either format — what `getResults` and
 *  `revealRound` resolve to. The API keeps a standard round's payload the
 *  bare `RoundResult[]` it always was (live-beta compatibility) and sends
 *  `HeadToHeadResults` for an H2H round; the data layer normalizes both into
 *  this union, so pages switch on `format`. */
export type RoundResults = { format: "standard"; results: RoundResult[] } | HeadToHeadResults;

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
// roundId -> submissionId -> comment. Persists across navigation within the session.
// MockClient.castBallot saves here on every standard ballot (an empty map when
// the ballot has no comments), so a round's entry also means "the current user
// has voted in this round" — getLeagueDetail's voting panel reads it that way.
const myVoteComments: Record<string, Record<string, string>> = {};

export function saveVoteComments(roundId: string, comments: Record<string, string>): void {
  const cleaned: Record<string, string> = {};
  for (const [id, text] of Object.entries(comments)) {
    if (text.trim()) cleaned[id] = text.trim();
  }
  myVoteComments[roundId] = cleaned;
}

// Submissions to vote on: anonymized, excluding the current user's own pick,
// in submission-id order like the API (`inAnonymousOrder` — the order songs
// were stored in would say who submitted them; BUG-01).
export function getVotableSubmissions(_roundId: string): VotableSubmission[] {
  return inAnonymousOrder(CANON_SUBMISSIONS.filter((s) => s.submitterId !== currentUser.id))
    .map((s) => ({ id: s.id, track: mockTrack(s.pid, s.title, s.artists, s.album, s.dur) }));
}

// Results: ranked by points, submitters revealed, with all voter comments
// (seeded ones plus whatever the current user left while voting).
// Tie-break: equal points → more distinct voters wins, then title A→Z.
export function getRoundResults(roundId: string): RoundResult[] {
  const mine = myVoteComments[roundId] ?? {};
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
  const view = withRematchLink(league);
  if (isHeadToHead(league)) {
    // Real progress + activity from the head-to-head store (see below).
    const live = headToHeadLiveRound(league, currentRound);
    return {
      league: isMember ? view : { ...view, inviteCode: "" },
      rounds: leagueRounds,
      currentRound,
      totalRounds: summary?.totalRounds ?? (league.roundCount || leagueRounds.length),
      standings: getStandings(leagueId),
      submissionProgress: live.submissionProgress,
      votingProgress: live.votingProgress,
      activity: live.activity,
      finished: isLeagueFinished(league, leagueRounds),
    };
  }
  if (currentRound?.status === "submitting") {
    // The canned songs are the same for every league, so some are by players
    // who aren't members here. Like the API's "X of N songs in" (BUG-09), count
    // only members' songs, each up to the allowance, so done never passes the
    // total (Indie's 3 members read "5 of 3" before).
    const allowance = league.settings.submissionsPerPlayer || 1;
    submissionProgress = splitByDone(new Set(CANON_SUBMISSIONS.map((s) => s.submitterId)), {
      done: memberSongCount(league.memberIds, CANON_SUBMISSIONS.map((s) => ({ userId: s.submitterId })), allowance),
      total: members.length * allowance,
    });
  } else if (currentRound?.status === "voting") {
    // Voted: the seeded voters, plus the current user once MockClient.castBallot
    // has filed their ballot under this round's id. The seeded voters are
    // canned for every league, so some aren't members here (James and Mia in
    // Vaporwave Vibes): like the API's "X of N ballots in", count only members
    // who voted, out of the members.
    const voterIds = new Set(CANON_SUBMISSIONS.flatMap((s) => s.seedComments.map((c) => c.voterId)));
    if (myVoteComments[currentRound.id]) voterIds.add(currentUser.id);
    votingProgress = splitByDone(voterIds, {
      done: members.filter((m) => voterIds.has(m.id)).length,
      total: members.length,
    });
  }

  return {
    league: isMember ? view : { ...view, inviteCode: "" },
    rounds: leagueRounds,
    currentRound,
    totalRounds: summary?.totalRounds ?? leagueRounds.length,
    standings: getStandings(leagueId),
    submissionProgress,
    votingProgress,
    activity: ACTIVITY[leagueId] ?? [],
    finished: isLeagueFinished(league, leagueRounds),
  };
}

/** handlers/leagues.ts `withRematchLink` (BUG-13): the detail keeps the
 *  rematch pointer only while that league exists and the viewer is one of
 *  its members — a pointer to a deleted rematch, or to one the viewer isn't
 *  in, is dropped, so the overview never links to a league that's gone. */
function withRematchLink(league: League): League {
  if (!league.rematchLeagueId) return league;
  const rematch = leagues.find((lg) => lg.id === league.rematchLeagueId);
  if (rematch?.memberIds.includes(currentUser.id)) return league;
  const { rematchLeagueId: _hidden, ...rest } = league;
  return rest;
}

/** Owner starts a fresh league with the same players + settings once this one
 *  has finished (mock: mirrors the backend rematchLeague). One live rematch
 *  per league (BUG-13): the old league records it (`rematchLeagueId`), and
 *  asking again returns that league; only once it has been deleted does a
 *  new one replace the pointer. (The mock is synchronous, so the backend's
 *  create-then-claim race handling has nothing to guard here.) */
export function rematchLeague(leagueId: string): League {
  const league = leagues.find((lg) => lg.id === leagueId);
  if (!league) throw new Error("That league doesn't exist.");
  if (league.ownerId !== currentUser.id) throw new Error("Only the league owner can do that.");
  const leagueRounds = rounds.filter((r) => r.leagueId === leagueId);
  if (!isLeagueFinished(league, leagueRounds)) {
    throw new Error("You can start a rematch once every round has been played.");
  }
  const existing = league.rematchLeagueId ? leagues.find((lg) => lg.id === league.rematchLeagueId) : undefined;
  if (existing) return existing;
  createdLeagueSeq += 1;
  const numbered = league.name.match(/^(.*?)(\d+)\s*$/);
  // Never copy the pointer into the clone: it has had no rematch of its own.
  const { rematchLeagueId: _notCopied, ...source } = league;
  const next: League = {
    ...source,
    id: `lg-rematch-${createdLeagueSeq}`,
    name: (numbered ? `${numbered[1]}${Number(numbered[2]) + 1}` : `${league.name} 2`).slice(0, 50),
    // A rematch keeps the format (head-to-head stays head-to-head) and, like
    // the backend's applyFormatSettings, re-applies the H2H forced settings.
    format: leagueFormat(league),
    settings:
      leagueFormat(league) === "headToHead"
        ? { ...league.settings, ...H2H_FORCED_SETTINGS }
        : { ...league.settings },
    memberIds: [...league.memberIds],
    inviteCode: `NEW-${100 + createdLeagueSeq}`,
    startAt: league.progression === "timed" ? new Date().toISOString() : undefined,
  };
  leagues.push(next);
  league.rematchLeagueId = next.id; // replaces a pointer whose league was deleted
  inviteCodes[next.inviteCode] = next.id;
  // Head-to-head: the clone starts un-frozen (the mock keeps season secrets
  // per league id, so there is nothing to copy) and everyone restarts 0–0–0.
  if (isHeadToHead(next)) for (const memberId of next.memberIds) seedStandingRow(next.id, memberId);
  return next;
}

// ============================================================================
// Head-to-head (HTH-09) — the mock's "server side" for H2H leagues.
//
// Unlike the canned standard demo above, an H2H league runs for real here,
// mirroring the backend handler by handler (each function names the one it
// mirrors) so mock mode behaves exactly like the API:
//   - opening round 1 freezes the season (shuffled order + salt + roundCount
//     = schedule length) and locks joining; later rounds need the freeze;
//   - matchups are derived on every read from the frozen order (never
//     stored), with departed players' songs withdrawn while a round is in
//     play — the backend's `deriveRoundMatchups`, imported, not copied;
//   - pick ballots are refereed by the backend's `validateH2HBallot` (same
//     400 messages), stored one per voter with comments;
//   - the reveal tallies, resolves outcomes, banks W/L/D exactly once and
//     pins what it counted, so re-reads match the board;
//   - HTH-08's progress rules: progress counts people — a member is done
//     submitting once they have their one song, done voting once they've
//     picked in every matchup they can vote in; members with nothing to vote
//     on are left out of the voting count, panel and completion %; and a
//     round nobody can vote in goes straight to the reveal when voting
//     opens. The who-voted panel and the activity feed keep HTH-08's
//     anonymity rule: unless every member can vote, neither names anyone
//     but the viewer, and the feed never shows another member's ballot
//     before the panel shows them done (BUG-06). All of it is the backend's
//     domain/matchups.ts — `membersWithSong`, `votingTurnout`,
//     `votingPanelNames`, `ballotAuthorVisible` — imported, not copied
//     (BUG-07).
// Not simulated (as for standard mock leagues): timed auto-advance and
// deadlines stamping, playlists.
// ============================================================================

/** Server-only season secrets per league — the frozen order + salt. Never on
 *  the League objects pages receive, exactly as the API strips them. */
const h2hSeasons = new Map<string, { participants: string[]; salt: string }>();
/** Every H2H round's submissions (all players, not just the current user). */
const h2hSubmissions: ServerSubmission[] = [];
/** One ballot per voter per round, keyed `${roundId}/${voterId}`. */
const h2hBallots = new Map<string, Ballot>();
/** What each reveal counted: the departed set + the tally (Round.h2hDeparted
 *  / Round.h2hTally on the backend). */
const h2hPins = new Map<string, { departed: string[]; tally: MatchupTally[] }>();
/** Standing rows keyed `${leagueId}/${userId}` — points stay 0 in H2H. */
const h2hStandingRows = new Map<string, StandingTotals>();

// Load the shared seed fixture's server-side half.
h2hSeasons.set(H2H_SEED.league.id, { participants: [...seedOrder!], salt: seedSalt! });
h2hSubmissions.push(...H2H_SEED.submissions);
for (const b of H2H_SEED.ballots) h2hBallots.set(`${b.roundId}/${b.voterId}`, b);
for (const r of H2H_SEED.rounds) {
  if (r.h2hTally) h2hPins.set(r.id, { departed: r.h2hDeparted ?? [], tally: r.h2hTally });
}
for (const row of H2H_SEED.standings) h2hStandingRows.set(`${H2H_SEED.league.id}/${row.userId}`, { ...row });

/** Uniform random int in [0, max) for the mock's season freeze (the backend
 *  uses node:crypto; the mock needs no unguessable salt). */
const mockRandomInt = (maxExclusive: number): number => Math.floor(Math.random() * maxExclusive);

function isHeadToHead(league: League): boolean {
  return leagueFormat(league) === "headToHead";
}

/** The league as the schedule/freeze rules read it: format + members + the
 *  (server-only) frozen order and salt. */
function seasonView(league: League) {
  const season = h2hSeasons.get(league.id);
  return { format: league.format, memberIds: league.memberIds, h2hParticipants: season?.participants, h2hSalt: season?.salt };
}

/** Has this H2H league's season frozen (round 1 opened)? False for standard. */
function h2hSeasonLocked(league: League): boolean {
  return seasonLocked(seasonView(league));
}

/** The round as the matchup rules read it — its pinned departed set once
 *  revealed, so a settled round is never re-judged against today's members. */
function roundState(round: Round) {
  return { id: round.id, index: round.index, status: round.status, h2hDeparted: h2hPins.get(round.id)?.departed };
}

const roundSubmissions = (roundId: string): ServerSubmission[] => h2hSubmissions.filter((s) => s.roundId === roundId);
const roundBallots = (roundId: string): Ballot[] => [...h2hBallots.values()].filter((b) => b.roundId === roundId);

/** The round's derived matchups — handlers/matchups.ts `loadRoundMatchups`. */
function roundMatchups(league: League, round: Round, options?: DeriveOptions): RoundMatchupSet {
  return deriveRoundMatchups(seasonView(league), roundState(round), roundSubmissions(round.id), options);
}

const userView = (id: string): User => users[id] ?? { id, displayName: id };

function requireRound(roundId: string): { round: Round; league: League } {
  const round = rounds.find((r) => r.id === roundId);
  if (!round) throw new Error("That round doesn't exist.");
  const league = leagues.find((lg) => lg.id === round.leagueId);
  if (!league) throw new Error("That league doesn't exist.");
  return { round, league };
}

/** Load a round + league as a member — handlers' `roundForMember`. */
function memberRound(roundId: string): { round: Round; league: League } {
  const found = requireRound(roundId);
  if (!found.league.memberIds.includes(currentUser.id)) throw new Error("You're not a member of this league.");
  return found;
}

const deadlinePassed = (iso?: string): boolean => (iso ? Date.now() > new Date(iso).getTime() : false);

/** Is this round (or league) head-to-head? MockClient dispatches on these. */
export function isHeadToHeadRound(roundId: string): boolean {
  const round = rounds.find((r) => r.id === roundId);
  const league = round && leagues.find((lg) => lg.id === round.leagueId);
  return Boolean(league && isHeadToHead(league));
}
export function isHeadToHeadLeague(leagueId: string): boolean {
  const league = leagues.find((lg) => lg.id === leagueId);
  return Boolean(league && isHeadToHead(league));
}

// ---- standings (HTH-04) ----

function seedStandingRow(leagueId: string, userId: string): StandingTotals {
  const key = `${leagueId}/${userId}`;
  let row = h2hStandingRows.get(key);
  if (!row) h2hStandingRows.set(key, (row = { userId, points: 0, wins: 0, losses: 0, draws: 0 }));
  return row;
}

function bankRecord(leagueId: string, userId: string, delta: StandingRecordDelta): void {
  const inc = recordIncrements(delta);
  const row = seedStandingRow(leagueId, userId);
  row.wins += inc.wins;
  row.losses += inc.losses;
  row.draws += inc.draws;
}

/** An H2H board: current members' rows (a departed player's record survives
 *  for a rejoin but leaves the board), in the backend's board order. */
function headToHeadStandings(league: League): Standing[] {
  const members = new Set(league.memberIds);
  const named = [...h2hStandingRows.entries()]
    .filter(([key, row]) => key.startsWith(`${league.id}/`) && members.has(row.userId))
    .map(([, row]) => ({ ...row, displayName: userView(row.userId).displayName }));
  return sortStandings("headToHead", named).map((s, i) => ({
    rank: i + 1,
    user: userView(s.userId),
    points: s.points,
    wins: s.wins,
    losses: s.losses,
    draws: s.draws,
  }));
}

// ---- progress, completion %, activity (handlers/leagues.ts + HTH-08) ----

/** A voting round's turnout (HTH-08) — handlers/matchups.ts
 *  `loadVotingTurnout`: domain `votingTurnout` over the round as it stands
 *  (departed players' songs withdrawn) and the current members. */
function roundTurnout(league: League, round: Round): VotingTurnout {
  return votingTurnout(roundMatchups(league, round), league.memberIds, roundBallots(round.id));
}

function h2hCompletionPct(league: League, round: Round | undefined): number {
  if (!round) return 0;
  const pct = (done: number, total: number) => (total === 0 ? 100 : Math.min(100, Math.round((done / total) * 100)));
  if (round.status === "submitting") {
    const done = membersWithSong(league.memberIds, roundSubmissions(round.id)).length;
    return league.memberIds.length === 0 ? 0 : pct(done, league.memberIds.length);
  }
  if (round.status === "voting") {
    const { eligible, voted } = roundTurnout(league, round);
    return pct(voted.length, eligible.length); // nobody can vote → 100: only the reveal is left
  }
  return roundSettled(round) ? 100 : 0;
}

/** Compact relative timestamp — handlers/leagues.ts `timeAgo`. */
function timeAgo(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The live round's who's-done panels and activity feed, from the store —
 *  handlers/leagues.ts `getLeagueDetail`, for the current user. While voting,
 *  the panel names whom `votingPanelNames` allows (everyone eligible, or just
 *  the viewer) and the feed keeps only the ballots `ballotAuthorVisible`
 *  allows, so mock mode never names a voter the API hides. */
function headToHeadLiveRound(
  league: League,
  round: Round | undefined,
): Pick<LeagueDetail, "submissionProgress" | "votingProgress" | "activity"> {
  if (!round || round.status === "draft") return { activity: [] };
  const subs = roundSubmissions(round.id);
  const ballots = roundBallots(round.id);
  const split = (ids: string[], doneIds: Set<string>, counts: { done: number; total: number }): RoundParticipation => ({
    submitted: ids.filter((id) => doneIds.has(id)).map(userView),
    waiting: ids.filter((id) => !doneIds.has(id)).map(userView),
    doneCount: counts.done,
    totalCount: counts.total,
  });

  let submissionProgress: RoundParticipation | undefined;
  let votingProgress: RoundParticipation | undefined;
  let showBallotBy = (_voterId: string) => true;
  if (round.status === "submitting") {
    // People, not rows: a member is done once they have their one song.
    const doneIds = new Set(membersWithSong(league.memberIds, subs));
    submissionProgress = split(league.memberIds, doneIds, { done: doneIds.size, total: league.memberIds.length });
  } else if (round.status === "voting") {
    // Only members with something to vote on are counted (HTH-08); names
    // only while every member can vote, else just the viewer's own.
    const turnout = roundTurnout(league, round);
    votingProgress = split(votingPanelNames(turnout, league.memberIds, currentUser.id), new Set(turnout.voted), {
      done: turnout.voted.length,
      total: turnout.eligible.length,
    });
    showBallotBy = (voterId) => ballotAuthorVisible(turnout, league.memberIds, currentUser.id, voterId);
  }

  const activity: ActivityItem[] = [
    ...subs.filter((s) => s.submittedAt).map((s) => ({ userId: s.userId, text: "submitted a song", at: s.submittedAt! })),
    ...ballots
      .filter((b) => b.castAt && showBallotBy(b.voterId))
      .map((b) => ({ userId: b.voterId, text: "cast their votes", at: b.castAt })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 12)
    .map((e) => ({ id: `${e.at}~${e.userId}~${e.text}`, user: userView(e.userId), text: e.text, timeAgo: timeAgo(e.at) }));

  return { submissionProgress, votingProgress, activity };
}

/** Drop a deleted league's H2H state (secrets, songs, ballots, pins, rows). */
function forgetHeadToHeadLeague(leagueId: string): void {
  const roundIds = new Set(rounds.filter((r) => r.leagueId === leagueId).map((r) => r.id));
  h2hSeasons.delete(leagueId);
  for (let i = h2hSubmissions.length - 1; i >= 0; i--) {
    if (roundIds.has(h2hSubmissions[i]!.roundId)) h2hSubmissions.splice(i, 1);
  }
  for (const [key, ballot] of h2hBallots) if (roundIds.has(ballot.roundId)) h2hBallots.delete(key);
  for (const id of roundIds) h2hPins.delete(id);
  for (const key of h2hStandingRows.keys()) if (key.startsWith(`${leagueId}/`)) h2hStandingRows.delete(key);
}

// ---- round lifecycle (handlers/rounds.ts) ----

/** createRound's head-to-head guards: owner only; no round 2+ before round 1
 *  has frozen the season; no round past the frozen schedule. A no-op for
 *  standard leagues (the canned demo keeps its permissive mock). */
export function assertCanCreateHeadToHeadRound(leagueId: string, index: number): void {
  const league = leagues.find((lg) => lg.id === leagueId);
  if (!league || !isHeadToHead(league)) return;
  if (league.ownerId !== currentUser.id) throw new Error("Only the league owner can manage rounds.");
  if (index > 1 && !h2hSeasonLocked(league)) throw new Error(H2H_ROUND_ONE_FIRST_MESSAGE);
  if (league.roundCount && index > league.roundCount) {
    throw new Error(
      `This league was set to ${league.roundCount} round${league.roundCount === 1 ? "" : "s"} and they've all been created — start a rematch to keep playing.`,
    );
  }
}

const ALLOWED_NEXT: Record<RoundStatus, RoundStatus[]> = {
  draft: ["submitting"],
  submitting: ["previewing"],
  previewing: ["voting"],
  voting: [],
  revealed: [],
  complete: [],
};

/** updateRound for a head-to-head round: the backend's status-move rules,
 *  the season freeze when round 1 opens, and (HTH-08) straight to reveal
 *  when voting opens on a round nobody can vote in — every pair a walkover /
 *  no contest, or a two-player league whose one matchup is both players'
 *  own: no ballot could ever arrive. */
export function advanceHeadToHeadRound(leagueId: string, roundId: string, status: RoundStatus): Round {
  const league = leagues.find((lg) => lg.id === leagueId);
  if (!league) throw new Error("That league doesn't exist.");
  if (league.ownerId !== currentUser.id) throw new Error("Only the league owner can manage rounds.");
  const round = rounds.find((r) => r.id === roundId && r.leagueId === leagueId);
  if (!round) throw new Error("That round doesn't exist.");
  if (status === round.status) return round;
  if (status === "revealed" || status === "complete") {
    throw new Error("Reveal a round with the reveal endpoint, not a status change.");
  }
  if (!ALLOWED_NEXT[round.status].includes(status)) throw new Error(`Can't move a ${round.status} round to ${status}.`);

  // Freeze before the status write, so a refused open leaves the round in draft.
  if (round.status === "draft") freezeSeasonIfNeeded(league, round);
  round.status = status;

  if (status === "voting" && roundTurnout(league, round).eligible.length === 0) {
    settleRound(league, round); // nobody can vote on anything: reveal now
  }
  return round;
}

/** handlers/rounds.ts `freezeSeasonIfNeeded`: round 1 of an un-frozen league
 *  freezes it (shuffle, salt, roundCount = schedule length); any later round
 *  needs the freeze already in place. Freeze is once. */
function freezeSeasonIfNeeded(league: League, round: Round): void {
  if (round.index !== 1) {
    if (!h2hSeasonLocked(league)) throw new Error(H2H_ROUND_ONE_FIRST_MESSAGE);
    return;
  }
  if (h2hSeasonLocked(league)) return;
  if (league.memberIds.length < MIN_H2H_PLAYERS) throw new Error(H2H_MIN_PLAYERS_MESSAGE);
  const freeze = planSeasonFreeze(league.memberIds, mockRandomInt);
  h2hSeasons.set(league.id, { participants: freeze.participants, salt: freeze.salt });
  league.roundCount = freeze.roundCount;
}

// ---- submissions (handlers/submissions.ts) ----

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/** handlers/submissions.ts `assertNoDuplicate` (same messages): no song, and
 *  no artist, twice in one round. */
function assertNoDuplicate(track: Track, others: ServerSubmission[]): void {
  for (const sub of others) {
    const same =
      track.providerTrackId && sub.track.providerTrackId
        ? track.provider === sub.track.provider && track.providerTrackId === sub.track.providerTrackId
        : norm(track.title) === norm(sub.track.title) &&
          track.artists.map(norm).join(",") === sub.track.artists.map(norm).join(",");
    if (same) throw new Error("That song has already been submitted for this round — pick a different one.");
  }
  const taken = new Set(others.flatMap((s) => s.track.artists.map(norm)));
  const clash = track.artists.find((a) => taken.has(norm(a)));
  if (clash) throw new Error(`A song by ${clash} is already in this round — each artist can only appear once.`);
}

/** submitSong for a head-to-head round: one song per player (the forced
 *  allowance), so a re-submit replaces the pick and keeps its id. */
export function submitHeadToHeadSong(roundId: string, track: Track, comment?: string): Submission {
  const { round } = memberRound(roundId);
  if (round.status !== "submitting") throw new Error("This round isn't accepting submissions right now.");
  if (deadlinePassed(round.submissionDeadline)) throw new Error("The submission deadline has passed.");
  if (!track?.title?.trim()) throw new Error("That track is missing a title.");

  const all = roundSubmissions(roundId);
  const replacing = all.find((s) => s.userId === currentUser.id);
  assertNoDuplicate(track, all.filter((s) => s.id !== replacing?.id));
  const submission: ServerSubmission = {
    id: replacing?.id ?? `sub-${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16)}`,
    roundId,
    userId: currentUser.id,
    track,
    comment: comment?.trim() || undefined,
    submittedAt: new Date().toISOString(),
  };
  const at = replacing ? h2hSubmissions.indexOf(replacing) : -1;
  if (at >= 0) h2hSubmissions[at] = submission;
  else h2hSubmissions.push(submission);
  return submission;
}

export function getMyHeadToHeadSubmissions(roundId: string): Submission[] {
  memberRound(roundId);
  return roundSubmissions(roundId).filter((s) => s.userId === currentUser.id);
}

export function removeHeadToHeadSubmission(roundId: string, submissionId: string): void {
  const { round } = memberRound(roundId);
  if (round.status !== "submitting") throw new Error("Picks are locked once submissions close.");
  if (deadlinePassed(round.submissionDeadline)) throw new Error("The submission deadline has passed.");
  const at = h2hSubmissions.findIndex((s) => s.id === submissionId && s.roundId === roundId && s.userId === currentUser.id);
  if (at < 0) throw new Error("That submission isn't yours to remove.");
  h2hSubmissions.splice(at, 1);
}

/** listVotableSubmissions for a head-to-head round: every song but the
 *  caller's own and departed players' withdrawn ones, anonymized, in
 *  submission-id order (`inAnonymousOrder`), as the API sends it. */
export function getHeadToHeadVotableSubmissions(roundId: string): VotableSubmission[] {
  const { round, league } = memberRound(roundId);
  if (round.status !== "previewing" && round.status !== "voting") {
    throw new Error("The songs aren't revealed yet for this round.");
  }
  const departed = departedParticipants(seasonView(league), roundState(round));
  return inAnonymousOrder(roundSubmissions(roundId).filter((s) => s.userId !== currentUser.id && !departed.has(s.userId)))
    .map(anonymousSong);
}

// ---- matchups + ballots (handlers/matchups.ts, handlers/voting.ts) ----

/** GET /rounds/:roundId/matchups (HTH-05). */
export function getMatchups(roundId: string): RoundMatchups {
  const { round, league } = requireRound(roundId);
  if (!isHeadToHead(league)) throw new Error("This league scores by points, so its rounds don't have matchups.");
  if (!roundSettled(round)) {
    if (!league.memberIds.includes(currentUser.id)) {
      throw new Error("Only league members can see the matchups before the round is revealed.");
    }
    if (round.status !== "voting") throw new Error("The matchups aren't out yet — they're revealed when voting opens.");
  }
  return matchupsView(roundMatchups(league, round), currentUser.id);
}

/** Keep only comments on real songs, trimmed and non-empty. */
function cleanComments(raw: Record<string, string> | undefined, validIds: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, text] of Object.entries(raw ?? {})) {
    if (validIds.has(id) && typeof text === "string" && text.trim()) out[id] = text.trim();
  }
  return out;
}

/** The checks castBallot makes before dispatching on the format. */
function votingRound(roundId: string): { round: Round; league: League } {
  const found = memberRound(roundId);
  if (found.round.status !== "voting") throw new Error("This round isn't open for voting.");
  if (deadlinePassed(found.round.voteDeadline)) throw new Error("The voting deadline has passed.");
  return found;
}

/** A points ballot sent to a head-to-head round — refused like the API does
 *  (the standard mock otherwise accepts any ballot). */
export function rejectPointsBallotOnHeadToHead(
  roundId: string,
  allocations: Record<string, number>,
  downvotes?: Record<string, number>,
): void {
  votingRound(roundId);
  if (Object.keys(allocations ?? {}).length > 0) {
    throw new Error("This is a head-to-head league — pick a winner in each matchup instead of spending points.");
  }
  if (Object.keys(downvotes ?? {}).length > 0) throw new Error("This league doesn't use anti-votes.");
}

/** Cast (or re-cast — it overwrites) a head-to-head ballot: one winner pick
 *  per votable matchup, refereed by the backend's own `validateH2HBallot`
 *  against the round as it stands, plus the round as scheduled so a pick from
 *  before a departure survives a re-cast. Comments may go on any song of the
 *  round (both sides of every matchup, the voter's own included, and the
 *  bye's exhibition song). */
export function castHeadToHeadBallot(
  roundId: string,
  picks: Record<string, string>,
  comments?: Record<string, string>,
): void {
  const { round, league } = votingRound(roundId);
  if (!isHeadToHead(league)) {
    throw new Error("This league scores by points — spend your points on songs instead of picking matchup winners.");
  }
  const matchups = roundMatchups(league, round);
  const asScheduled = roundMatchups(league, round, { departed: [] });
  const cleaned = validateH2HBallot(picks, matchups, currentUser.id, asScheduled);
  const sides = [...asScheduled.matchups.flatMap((m) => [m.a, m.b]), ...(asScheduled.bye ? [asScheduled.bye] : [])];
  const songIds = new Set(sides.flatMap((side) => (side.submission ? [side.submission.id] : [])));
  h2hBallots.set(`${roundId}/${currentUser.id}`, {
    roundId,
    voterId: currentUser.id,
    allocations: {},
    picks: cleaned,
    comments: cleanComments(comments, songIds),
    castAt: new Date().toISOString(),
  });
}

/** GET my-ballot for a head-to-head round: picks exactly as stored. */
export function getMyHeadToHeadBallot(roundId: string): MyBallot | null {
  memberRound(roundId);
  const ballot = h2hBallots.get(`${roundId}/${currentUser.id}`);
  if (!ballot) return null;
  return {
    allocations: ballot.allocations,
    downvotes: ballot.downvotes ?? {},
    comments: ballot.comments ?? {},
    picks: ballot.picks ?? {},
  };
}

// ---- reveal + results (handlers/results.ts, HTH-07) ----

/** Settle a voting round exactly once: departures judged now, ballots
 *  tallied, outcomes resolved, the counted tally + departed set pinned, the
 *  round revealed and every W/L/D banked (zero-vote losses included). */
function settleRound(league: League, round: Round): HeadToHeadResults {
  const departed = [...departedParticipants(seasonView(league), { status: "voting" })].sort();
  const matchups = roundMatchups(league, round, { departed });
  const ballots = roundBallots(round.id);
  const tally = tallyMatchups(matchups, ballots);
  const settled = resolveMatchups(matchups, tally);
  h2hPins.set(round.id, { departed, tally });
  round.status = "revealed";
  for (const { userId, delta } of matchupRecords(settled.matchups)) bankRecord(league.id, userId, delta);
  return resultsPayload(settled, ballots);
}

/** Owner reveal of a head-to-head round. */
export function revealHeadToHeadRound(roundId: string): HeadToHeadResults {
  const { round, league } = requireRound(roundId);
  if (league.ownerId !== currentUser.id) throw new Error("Only the league owner can reveal a round.");
  if (round.status !== "voting") throw new Error("Only a round that's in voting can be revealed.");
  return settleRound(league, round);
}

/** A revealed head-to-head round's results, re-derived from what its reveal
 *  pinned (a seed round without pins re-tallies its ballots). */
export function getHeadToHeadResults(roundId: string): HeadToHeadResults {
  const { round, league } = requireRound(roundId);
  if (!roundSettled(round)) throw new Error("Results aren't available until the round is revealed.");
  const matchups = roundMatchups(league, round);
  const ballots = roundBallots(round.id);
  const pins = h2hPins.get(round.id);
  return resultsPayload(pins ? resolveMatchups(matchups, pins.tally) : settleMatchups(matchups, ballots), ballots);
}

/** handlers/results.ts `headToHeadPayload`: players named, songs with the
 *  submitter's note + voter comments, matchups sorted by id. */
function resultsPayload(settled: SettledRound, ballots: Ballot[]): HeadToHeadResults {
  const song = (sub: ServerSubmission | undefined): RevealedSong | null =>
    sub
      ? {
          id: sub.id,
          track: sub.track,
          ...(sub.comment ? { submitterComment: sub.comment } : {}),
          comments: ballots
            .filter((b) => b.comments?.[sub.id])
            .map((b) => ({ voter: userView(b.voterId), text: b.comments![sub.id]! })),
        }
      : null;
  const side = (s: SettledSide): MatchupResultSide => ({
    player: userView(s.userId),
    song: song(s.submission),
    votes: s.votes,
    departed: s.departed,
  });
  const matchups = [...settled.matchups]
    .sort((x, y) => compareMatchupIds(x.matchupId, y.matchupId))
    .map((m): MatchupResult => ({
      matchupId: m.matchupId,
      a: side(m.a),
      b: side(m.b),
      outcome: m.outcome,
      ...(m.winnerUserId === undefined ? {} : { winnerUserId: m.winnerUserId }),
    }));
  const byeSong = song(settled.bye?.submission);
  const bye = settled.bye && byeSong ? { player: userView(settled.bye.userId), song: byeSong } : null;
  return { format: "headToHead", matchups, bye };
}
