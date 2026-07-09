// League handlers — the create / join / list / detail loop. Pure business
// logic over the Repository port: no AWS, no HTTP. The HTTP adapters parse a
// request into these calls and serialize the result. Return shapes match the
// frontend's mock functions exactly (src/data/mock.ts) so the pages don't change.

import { randomInt, randomUUID } from "node:crypto";
import type { League, LeagueSettings, LeagueVisibility, RoundProgression, Round } from "../domain/types.ts";
import { DEFAULT_LEAGUE_SETTINGS } from "../domain/types.ts";
import { badRequest, conflict, forbidden, notFound } from "../domain/errors.ts";
import type { Repository, UserDirectory } from "../data/repository.ts";
import { autoAdvanceRound } from "./progression.ts";

export interface Deps {
  repo: Repository;
  users: UserDirectory;
}

// ---- view models (mirror src/data/mock.ts) ----

interface UserView {
  id: string;
  displayName: string;
}

interface LeagueSummary {
  league: League;
  currentRound?: Round;
  totalRounds: number;
  completionPct: number;
  members: UserView[];
}

interface Standing {
  rank: number;
  user: UserView;
  points: number;
}

/** Who's done vs. pending for the current phase. Names only — no tracks, no
 *  point allocations — so this leaks nothing about anyone's pick or vote. */
interface RoundParticipation {
  submitted: UserView[];
  waiting: UserView[];
  /** Units done vs. expected: songs (members × allowance) while submitting,
   *  ballots (one per member) while voting. Drives the "X of N in" count. */
  doneCount: number;
  totalCount: number;
}

interface LeagueDetail {
  league: League;
  rounds: Round[];
  currentRound?: Round;
  totalRounds: number;
  standings: Standing[];
  /** Present only while the current round is submitting. */
  submissionProgress?: RoundParticipation;
  /** Present only while the current round is voting ("submitted" = ballot cast). */
  votingProgress?: RoundParticipation;
  activity: never[]; // activity feed is not backed by data yet — empty for now.
}

// ---- helpers ----

async function toUserViews(users: UserDirectory, ids: string[]): Promise<UserView[]> {
  return Promise.all(ids.map(async (id) => ({ id, displayName: await users.getDisplayName(id) })));
}

/** Split a league's members into done / pending given the ids that finished. */
async function splitByDone(
  users: UserDirectory,
  memberIds: string[],
  doneIds: Set<string>,
  counts: { done: number; total: number },
): Promise<RoundParticipation> {
  return {
    submitted: await toUserViews(users, memberIds.filter((id) => doneIds.has(id))),
    waiting: await toUserViews(users, memberIds.filter((id) => !doneIds.has(id))),
    doneCount: counts.done,
    totalCount: counts.total,
  };
}

function latestRound(rounds: Round[]): Round | undefined {
  return [...rounds].sort((a, b) => b.index - a.index)[0];
}

/** Real completion %: for a voting round, ballots-cast / members; for a
 *  submitting round, submissions / total slots; otherwise 0/100 by status. */
async function completionPct(repo: Repository, league: League, round: Round | undefined): Promise<number> {
  if (!round) return 0;
  const members = league.memberIds.length || 1;
  if (round.status === "submitting") {
    const subs = await repo.getSubmissionsForRound(round.id);
    const slots = members * (league.settings.submissionsPerPlayer || 1);
    return Math.min(100, Math.round((subs.length / slots) * 100));
  }
  if (round.status === "voting") {
    const ballots = await repo.getBallotsForRound(round.id);
    return Math.round((ballots.length / members) * 100);
  }
  return round.status === "revealed" || round.status === "complete" ? 100 : 0;
}

// ---- id + invite-code generation ----
// Must be RANDOM, not a counter: handlers run on Lambda where a module-level
// counter resets on every cold start, so sequential ids/codes collide across
// invocations (two leagues both getting "DXL-1001", overwriting each other's
// invite mapping). `crypto` gives per-call uniqueness with no shared state.

function newLeagueId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "league";
  return `lg-${slug}-${randomUUID().slice(0, 8)}`;
}

// Unambiguous alphabet (no I/L/O/0/1) so codes are easy to read aloud/share.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function newInviteCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  // Short, human-shareable, case-insensitive. e.g. "DXL-7K2QF9".
  return `DXL-${code}`;
}

// ---- handlers ----

/** Player-cap bounds for public leagues (owner + at least one other; sane ceiling). */
const MIN_PUBLIC_MEMBERS = 2;
const MAX_PUBLIC_MEMBERS = 50;
/** How many rounds a league may run. */
const MIN_ROUNDS = 1;
const MAX_ROUNDS = 20;
/** How long each phase may last in timed mode. */
const MIN_PHASE_DAYS = 1;
const MAX_PHASE_DAYS = 30;

export interface CreateLeagueInput {
  name: string;
  musicProvider: League["musicProvider"];
  /** Defaults to "private" when omitted. */
  visibility?: LeagueVisibility;
  /** Required (and only meaningful) when visibility is "public". */
  maxMembers?: number;
  /** How many rounds the league will run (1–20). */
  roundCount?: number;
  /** Round progression; defaults to "manual". */
  progression?: RoundProgression;
  /** Timed mode: ISO start time (defaults to now) and days per phase (1–30). */
  startAt?: string;
  phaseDays?: number;
}

export async function createLeague(deps: Deps, caller: string, input: CreateLeagueInput): Promise<League> {
  const name = (input?.name ?? "").trim();
  if (!name) throw badRequest("Give your league a name.");
  if (!input?.musicProvider) throw badRequest("Pick a music service.");

  const roundCount = asInt(input?.roundCount);
  if (!(roundCount >= MIN_ROUNDS)) throw badRequest(`A league needs at least ${MIN_ROUNDS} round.`);
  if (roundCount > MAX_ROUNDS) throw badRequest(`A league can have at most ${MAX_ROUNDS} rounds.`);

  const progression: RoundProgression = input?.progression === "timed" ? "timed" : "manual";
  let startAt: string | undefined;
  let phaseDays: number | undefined;
  if (progression === "timed") {
    const days = asInt(input?.phaseDays);
    if (!(days >= MIN_PHASE_DAYS)) throw badRequest(`Each phase must last at least ${MIN_PHASE_DAYS} day.`);
    if (days > MAX_PHASE_DAYS) throw badRequest(`Each phase can last at most ${MAX_PHASE_DAYS} days.`);
    phaseDays = days;
    const parsed = input?.startAt ? new Date(input.startAt) : new Date();
    startAt = Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  }

  const visibility: LeagueVisibility = input?.visibility === "public" ? "public" : "private";
  let maxMembers: number | undefined;
  if (visibility === "public") {
    const cap = asInt(input?.maxMembers);
    if (!(cap >= MIN_PUBLIC_MEMBERS)) {
      throw badRequest(`Public leagues need a player cap of at least ${MIN_PUBLIC_MEMBERS}.`);
    }
    if (cap > MAX_PUBLIC_MEMBERS) throw badRequest(`Player cap can't exceed ${MAX_PUBLIC_MEMBERS}.`);
    maxMembers = cap;
  }

  const league: League = {
    id: newLeagueId(name),
    name,
    ownerId: caller,
    musicProvider: input.musicProvider,
    settings: { ...DEFAULT_LEAGUE_SETTINGS },
    memberIds: [caller],
    inviteCode: newInviteCode(),
    visibility,
    maxMembers,
    roundCount,
    progression,
    startAt,
    phaseDays,
  };
  await deps.repo.createLeague(league);
  await deps.repo.putInvite(league.inviteCode, league.id);
  await deps.repo.addStandingPoints(league.id, caller, 0); // seed standing at 0
  return league;
}

/** A public league a non-member could discover and claim a spot in. */
export interface PublicLeagueSummary {
  id: string;
  name: string;
  memberCount: number;
  maxMembers: number;
  openSlots: number;
  /** Round 1's theme once the owner has set it; undefined while unannounced. */
  firstRoundTheme?: string;
}

/** The join window: a league takes new members until round 1 moves past the
 *  submitting phase — late joiners can still submit a song and play the whole
 *  league. Closed once any round is beyond submitting (or a later round exists). */
function joinWindowClosed(rounds: Round[]): boolean {
  return rounds.some((r) => !(r.status === "draft" || (r.index === 1 && r.status === "submitting")));
}

/** Discover open public leagues: public, join window still open (round 1 at
 *  most submitting), with open slots, that the caller isn't already in. Ranked
 *  fullest-first (momentum), tie-broken by name. Caller trims to the top N
 *  (e.g. 3) for the dashboard. */
export async function listOpenPublicLeagues(
  deps: Deps,
  caller: string,
  limit = 12,
): Promise<PublicLeagueSummary[]> {
  const leagues = await deps.repo.getPublicLeagues();
  const open: PublicLeagueSummary[] = [];

  for (const league of leagues) {
    if (league.visibility !== "public") continue;
    if (league.memberIds.includes(caller)) continue; // already a member
    const cap = league.maxMembers ?? 0;
    const openSlots = cap - league.memberIds.length;
    if (openSlots <= 0) continue; // full

    const rounds = await deps.repo.getRoundsForLeague(league.id);
    if (joinWindowClosed(rounds)) continue; // past round 1's submitting phase

    const firstRound = [...rounds].sort((a, b) => a.index - b.index)[0];
    open.push({
      id: league.id,
      name: league.name,
      memberCount: league.memberIds.length,
      maxMembers: cap,
      openSlots,
      firstRoundTheme: firstRound?.theme,
    });
  }

  open.sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name));
  return open.slice(0, Math.max(0, limit));
}

/** A league in progress that the caller could spectate (read-only). */
export interface BrowseLeagueSummary {
  id: string;
  name: string;
  visibility: LeagueVisibility;
  memberCount: number;
  totalRounds: number;
  currentRound?: { index: number; theme: string; status: Round["status"] };
}

/** Leagues in progress (any visibility) that the caller isn't in — open for
 *  spectating: anyone signed in can view rounds, standings, and revealed
 *  results, but never the invite code, and joining/voting stays member-only.
 *  "In progress" = at least one round beyond draft. Ranked biggest-first. */
export async function listBrowseLeagues(deps: Deps, caller: string, limit = 24): Promise<BrowseLeagueSummary[]> {
  const leagues = await deps.repo.getAllLeagues();
  const out: BrowseLeagueSummary[] = [];
  for (const league of leagues) {
    if (league.memberIds.includes(caller)) continue;
    const rounds = await deps.repo.getRoundsForLeague(league.id);
    if (!rounds.some((r) => r.status !== "draft")) continue; // not running yet
    const current = latestRound(rounds);
    out.push({
      id: league.id,
      name: league.name,
      visibility: league.visibility,
      memberCount: league.memberIds.length,
      totalRounds: league.roundCount || rounds.length,
      currentRound: current ? { index: current.index, theme: current.theme, status: current.status } : undefined,
    });
  }
  out.sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name));
  return out.slice(0, Math.max(0, limit));
}

/** A non-member's view of a public league: enough to decide whether to claim a
 *  spot. Never exposes private-league data (those 404 here). */
export interface PublicLeaguePreview {
  id: string;
  name: string;
  memberCount: number;
  maxMembers: number;
  openSlots: number;
  firstRoundTheme?: string;
  members: UserView[];
  /** True once the join window closed (round 1 past submitting) — no longer joinable. */
  hasStarted: boolean;
  isFull: boolean;
  /** True when the caller already belongs (UI links them straight in instead). */
  alreadyMember: boolean;
}

export async function getPublicLeaguePreview(
  deps: Deps,
  caller: string,
  leagueId: string,
): Promise<PublicLeaguePreview> {
  const league = await deps.repo.getLeague(leagueId);
  // 404 for missing OR non-public — a private league must not be discoverable.
  if (!league || league.visibility !== "public") throw notFound("That public league doesn't exist.");

  const rounds = await deps.repo.getRoundsForLeague(leagueId);
  const firstRound = [...rounds].sort((a, b) => a.index - b.index)[0];
  const cap = league.maxMembers ?? 0;
  const openSlots = Math.max(0, cap - league.memberIds.length);

  return {
    id: league.id,
    name: league.name,
    memberCount: league.memberIds.length,
    maxMembers: cap,
    openSlots,
    firstRoundTheme: firstRound?.theme,
    members: await toUserViews(deps.users, league.memberIds),
    hasStarted: joinWindowClosed(rounds),
    isFull: openSlots <= 0,
    alreadyMember: league.memberIds.includes(caller),
  };
}

export async function listMyLeagues(deps: Deps, caller: string): Promise<LeagueSummary[]> {
  const leagues = await deps.repo.getLeaguesForUser(caller);
  return Promise.all(
    leagues.map(async (league) => {
      const rounds = await deps.repo.getRoundsForLeague(league.id);
      const currentRound = await autoAdvanceRound(deps, league, latestRound(rounds));
      return {
        league,
        currentRound,
        // The owner's planned count; fall back to created rounds for legacy leagues.
        totalRounds: league.roundCount || rounds.length,
        completionPct: await completionPct(deps.repo, league, currentRound),
        members: await toUserViews(deps.users, league.memberIds),
      };
    }),
  );
}

export async function getLeagueDetail(deps: Deps, caller: string, leagueId: string): Promise<LeagueDetail> {
  const league = await deps.repo.getLeague(leagueId);
  if (!league) throw notFound("That league doesn't exist.");
  // Non-members may spectate (read-only) — but must never see the invite code,
  // or a private league would stop being invite-only.
  const isMember = league.memberIds.includes(caller);

  const rounds = (await deps.repo.getRoundsForLeague(leagueId)).sort((a, b) => a.index - b.index);
  // Lazy timed advance BEFORE reading standings, so a just-revealed round's
  // points are already banked in the response.
  const currentRound = await autoAdvanceRound(deps, league, latestRound(rounds));

  const rawStandings = await deps.repo.getStandings(leagueId);
  const standings: Standing[] = (
    await Promise.all(
      rawStandings
        .sort((a, b) => b.points - a.points)
        .map(async (s, i) => ({
          rank: i + 1,
          user: { id: s.userId, displayName: await deps.users.getDisplayName(s.userId) },
          points: s.points,
        })),
    )
  );

  // Who's done vs. pending for the live phase (identities only): submissions
  // while submitting, ballots while voting. With a multi-song allowance a
  // member counts as done once they've used every slot.
  let submissionProgress: RoundParticipation | undefined;
  let votingProgress: RoundParticipation | undefined;
  if (currentRound?.status === "submitting") {
    const subs = await deps.repo.getSubmissionsForRound(currentRound.id);
    const allowance = league.settings.submissionsPerPlayer || 1;
    const countByUser = new Map<string, number>();
    for (const s of subs) countByUser.set(s.userId, (countByUser.get(s.userId) ?? 0) + 1);
    const doneIds = new Set(league.memberIds.filter((id) => (countByUser.get(id) ?? 0) >= allowance));
    submissionProgress = await splitByDone(deps.users, league.memberIds, doneIds, {
      done: subs.length,
      total: league.memberIds.length * allowance,
    });
  } else if (currentRound?.status === "voting") {
    const ballots = await deps.repo.getBallotsForRound(currentRound.id);
    votingProgress = await splitByDone(deps.users, league.memberIds, new Set(ballots.map((b) => b.voterId)), {
      done: ballots.length,
      total: league.memberIds.length,
    });
  }

  return {
    league: isMember ? league : { ...league, inviteCode: "" },
    rounds,
    currentRound,
    // The owner's planned count; fall back to created rounds for legacy leagues.
    totalRounds: league.roundCount || rounds.length,
    standings,
    submissionProgress,
    votingProgress,
    activity: [],
  };
}

export async function joinLeague(deps: Deps, caller: string, rawCode: string): Promise<{ league: League }> {
  const code = (rawCode ?? "").trim().toUpperCase();
  if (!code) throw badRequest("Enter an invite code to join.");

  const leagueId = await deps.repo.getLeagueIdForInvite(code);
  const league = leagueId ? await deps.repo.getLeague(leagueId) : undefined;
  if (!league) throw notFound("That code doesn't match any league.");
  if (league.memberIds.includes(caller)) throw conflict(`You're already a member of ${league.name}.`);

  const updated = await deps.repo.addMember(league.id, caller);
  await deps.repo.addStandingPoints(league.id, caller, 0);
  return { league: updated };
}

/** Claim a spot in an open public league — creates the caller's membership.
 *  Enforces the same rules discovery/preview advertise: public, not started,
 *  not full, not already a member. */
export async function claimPublicSpot(
  deps: Deps,
  caller: string,
  leagueId: string,
): Promise<{ league: League }> {
  const league = await deps.repo.getLeague(leagueId);
  // 404 for missing OR non-public — private leagues aren't claimable this way.
  if (!league || league.visibility !== "public") throw notFound("That public league doesn't exist.");
  if (league.memberIds.includes(caller)) throw conflict(`You're already a member of ${league.name}.`);

  const rounds = await deps.repo.getRoundsForLeague(leagueId);
  if (joinWindowClosed(rounds)) {
    throw conflict("It's too late to join — round 1 has closed submissions.");
  }

  // Best-effort capacity check. Not atomic under concurrent claims — acceptable
  // at this scale; promote to a conditional write if contention ever matters.
  const cap = league.maxMembers ?? 0;
  if (league.memberIds.length >= cap) throw conflict("This league is full.");

  const updated = await deps.repo.addMember(leagueId, caller);
  await deps.repo.addStandingPoints(leagueId, caller, 0); // seed standing at 0
  return { league: updated };
}

/** Leave a league — removes the caller's own membership (and standing). The
 *  owner can't leave (they delete the league instead). */
export async function leaveLeague(
  deps: Deps,
  caller: string,
  leagueId: string,
  targetUserId: string,
): Promise<{ ok: true }> {
  const league = await deps.repo.getLeague(leagueId);
  if (!league) throw notFound("That league doesn't exist.");

  // Removing someone else is an owner power (kick); anyone may remove themself.
  const isSelf = targetUserId === caller;
  if (!isSelf && league.ownerId !== caller) {
    throw forbidden("Only the league owner can remove other players.");
  }
  if (!league.memberIds.includes(targetUserId)) {
    throw badRequest(isSelf ? "You're not a member of this league." : "They're not a member of this league.");
  }
  if (league.ownerId === targetUserId) {
    throw badRequest("You own this league — delete it instead of leaving.");
  }
  await deps.repo.removeMember(leagueId, targetUserId);
  return { ok: true };
}

/** Owner-only: mint a fresh invite code and retire the old one — anyone still
 *  holding the old code or link can no longer join. */
export async function regenerateInvite(deps: Deps, caller: string, leagueId: string): Promise<{ league: League }> {
  const league = await ownedLeague(deps, caller, leagueId);
  const oldCode = league.inviteCode;
  const code = newInviteCode();
  await deps.repo.putInvite(code, league.id);
  await deps.repo.updateInviteCode(league.id, code);
  if (oldCode) await deps.repo.deleteInvite(oldCode);
  return { league: { ...league, inviteCode: code } };
}

/** Load a league and assert the caller owns it. */
async function ownedLeague(deps: Deps, caller: string, leagueId: string): Promise<League> {
  const league = await deps.repo.getLeague(leagueId);
  if (!league) throw notFound("That league doesn't exist.");
  if (league.ownerId !== caller) throw forbidden("Only the league owner can do that.");
  return league;
}

const asInt = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : NaN);

export interface UpdateSettingsInput {
  votePoolSize: unknown;
  maxPointsPerSong: unknown;
  allowSelfVote: unknown;
  submissionsPerPlayer?: unknown;
  downvotePoolSize?: unknown;
}

export async function updateLeagueSettings(
  deps: Deps,
  caller: string,
  leagueId: string,
  input: UpdateSettingsInput,
): Promise<League> {
  const league = await ownedLeague(deps, caller, leagueId);

  const votePoolSize = asInt(input?.votePoolSize);
  const maxPointsPerSong = asInt(input?.maxPointsPerSong);
  if (!(votePoolSize >= 1)) throw badRequest("Vote pool must be at least 1 point.");
  if (!(maxPointsPerSong >= 1)) throw badRequest("Max points per song must be at least 1.");
  if (maxPointsPerSong > votePoolSize) {
    throw badRequest("Max points per song can't exceed the vote pool.");
  }

  // Songs per player: 1 (classic) up to 5 — more helps small leagues fill a
  // round out. Absent in the payload → keep the league's current value.
  const submissionsPerPlayer =
    input?.submissionsPerPlayer === undefined
      ? league.settings.submissionsPerPlayer || 1
      : asInt(input.submissionsPerPlayer);
  if (!(submissionsPerPlayer >= 1 && submissionsPerPlayer <= 5)) {
    throw badRequest("Songs per player must be between 1 and 5.");
  }

  // Anti-votes: 0 (off, the default) up to 2 per voter per round.
  const downvotePoolSize =
    input?.downvotePoolSize === undefined
      ? league.settings.downvotePoolSize ?? 0
      : asInt(input.downvotePoolSize);
  if (!(downvotePoolSize >= 0 && downvotePoolSize <= 2)) {
    throw badRequest("Anti-votes per player must be between 0 and 2.");
  }

  const settings: LeagueSettings = {
    votePoolSize,
    maxPointsPerSong,
    allowSelfVote: Boolean(input?.allowSelfVote),
    submissionsPerPlayer,
    downvotePoolSize,
  };
  return deps.repo.updateLeagueSettings(leagueId, settings);
}

export async function deleteLeague(deps: Deps, caller: string, leagueId: string): Promise<{ ok: true }> {
  await ownedLeague(deps, caller, leagueId);
  await deps.repo.deleteLeague(leagueId);
  return { ok: true };
}
