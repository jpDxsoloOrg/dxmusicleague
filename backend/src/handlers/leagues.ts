// League handlers — the create / join / list / detail loop. Pure business
// logic over the Repository port: no AWS, no HTTP. The HTTP adapters parse a
// request into these calls and serialize the result. Return shapes match the
// frontend's mock functions exactly (src/data/mock.ts) so the pages don't change.

import type { League, LeagueSettings, LeagueVisibility, Round } from "../domain/types.ts";
import { DEFAULT_LEAGUE_SETTINGS } from "../domain/types.ts";
import { badRequest, conflict, forbidden, notFound } from "../domain/errors.ts";
import type { Repository, UserDirectory } from "../data/repository.ts";

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

interface LeagueDetail {
  league: League;
  rounds: Round[];
  currentRound?: Round;
  totalRounds: number;
  standings: Standing[];
  activity: never[]; // activity feed is not backed by data yet — empty for now.
}

// ---- helpers ----

async function toUserViews(users: UserDirectory, ids: string[]): Promise<UserView[]> {
  return Promise.all(ids.map(async (id) => ({ id, displayName: await users.getDisplayName(id) })));
}

function latestRound(rounds: Round[]): Round | undefined {
  return [...rounds].sort((a, b) => b.index - a.index)[0];
}

/** Real completion %: for a voting round, ballots-cast / members; for a
 *  submitting round, submissions / members; otherwise 0/100 by status. */
async function completionPct(repo: Repository, league: League, round: Round | undefined): Promise<number> {
  if (!round) return 0;
  const members = league.memberIds.length || 1;
  if (round.status === "submitting") {
    const subs = await repo.getSubmissionsForRound(round.id);
    return Math.round((subs.length / members) * 100);
  }
  if (round.status === "voting") {
    const ballots = await repo.getBallotsForRound(round.id);
    return Math.round((ballots.length / members) * 100);
  }
  return round.status === "revealed" || round.status === "complete" ? 100 : 0;
}

// ---- id + invite-code generation ----

let leagueSeq = 0;
function newLeagueId(name: string): string {
  leagueSeq += 1;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "league";
  return `lg-${slug}-${leagueSeq}`;
}

let inviteSeq = 0;
function newInviteCode(): string {
  inviteSeq += 1;
  // Short, human-shareable, case-insensitive. e.g. "DXL-1042".
  return `DXL-${1000 + inviteSeq}`;
}

// ---- handlers ----

/** Player-cap bounds for public leagues (owner + at least one other; sane ceiling). */
const MIN_PUBLIC_MEMBERS = 2;
const MAX_PUBLIC_MEMBERS = 50;

export interface CreateLeagueInput {
  name: string;
  musicProvider: League["musicProvider"];
  /** Defaults to "private" when omitted. */
  visibility?: LeagueVisibility;
  /** Required (and only meaningful) when visibility is "public". */
  maxMembers?: number;
}

export async function createLeague(deps: Deps, caller: string, input: CreateLeagueInput): Promise<League> {
  const name = (input?.name ?? "").trim();
  if (!name) throw badRequest("Give your league a name.");
  if (!input?.musicProvider) throw badRequest("Pick a music service.");

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

/** Discover open public leagues: public, not yet started (no round past draft),
 *  with open slots, that the caller isn't already in. Ranked fullest-first
 *  (momentum), tie-broken by name. Caller trims to the top N (e.g. 3) for the
 *  dashboard. */
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
    if (rounds.some((r) => r.status !== "draft")) continue; // already started

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
  /** True once a round has moved past draft — the league is no longer joinable. */
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
    hasStarted: rounds.some((r) => r.status !== "draft"),
    isFull: openSlots <= 0,
    alreadyMember: league.memberIds.includes(caller),
  };
}

export async function listMyLeagues(deps: Deps, caller: string): Promise<LeagueSummary[]> {
  const leagues = await deps.repo.getLeaguesForUser(caller);
  return Promise.all(
    leagues.map(async (league) => {
      const rounds = await deps.repo.getRoundsForLeague(league.id);
      const currentRound = latestRound(rounds);
      return {
        league,
        currentRound,
        totalRounds: rounds.length,
        completionPct: await completionPct(deps.repo, league, currentRound),
        members: await toUserViews(deps.users, league.memberIds),
      };
    }),
  );
}

export async function getLeagueDetail(deps: Deps, caller: string, leagueId: string): Promise<LeagueDetail> {
  const league = await deps.repo.getLeague(leagueId);
  if (!league) throw notFound("That league doesn't exist.");
  if (!league.memberIds.includes(caller)) throw forbidden("You're not a member of this league.");

  const rounds = (await deps.repo.getRoundsForLeague(leagueId)).sort((a, b) => a.index - b.index);
  const currentRound = latestRound(rounds);

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

  return {
    league,
    rounds,
    currentRound,
    totalRounds: rounds.length,
    standings,
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
  if (rounds.some((r) => r.status !== "draft")) throw conflict("This league has already started.");

  // Best-effort capacity check. Not atomic under concurrent claims — acceptable
  // at this scale; promote to a conditional write if contention ever matters.
  const cap = league.maxMembers ?? 0;
  if (league.memberIds.length >= cap) throw conflict("This league is full.");

  const updated = await deps.repo.addMember(leagueId, caller);
  await deps.repo.addStandingPoints(leagueId, caller, 0); // seed standing at 0
  return { league: updated };
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

  // submissionsPerPlayer stays fixed (one song per player) — see LeagueSettings.
  const settings: LeagueSettings = {
    votePoolSize,
    maxPointsPerSong,
    allowSelfVote: Boolean(input?.allowSelfVote),
    submissionsPerPlayer: league.settings.submissionsPerPlayer,
  };
  return deps.repo.updateLeagueSettings(leagueId, settings);
}

export async function deleteLeague(deps: Deps, caller: string, leagueId: string): Promise<{ ok: true }> {
  await ownedLeague(deps, caller, leagueId);
  await deps.repo.deleteLeague(leagueId);
  return { ok: true };
}
