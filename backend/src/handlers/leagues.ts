// League handlers — the create / join / list / detail loop. Pure business
// logic over the Repository port: no AWS, no HTTP. The HTTP adapters parse a
// request into these calls and serialize the result. Return shapes match the
// frontend's mock functions exactly (src/data/mock.ts) so the pages don't change.

import { randomInt, randomUUID } from "node:crypto";
import type { League, LeagueFormat, LeagueSettings, LeagueVisibility, RoundProgression, Round } from "../domain/types.ts";
import { DEFAULT_LEAGUE_SETTINGS, H2H_FORCED_SETTINGS, LEAGUE_FORMATS, applyFormatSettings, leagueFormat } from "../domain/types.ts";
import { alreadyMember, badRequest, conflict, forbidden, notFound } from "../domain/errors.ts";
import { sortStandings } from "../domain/standings.ts";
import { SEASON_LOCKED_MESSAGE, lockedOutOfSeason, seasonLocked } from "../domain/freeze.ts";
import type { RandomInt } from "../domain/freeze.ts";
import { ballotAuthorVisible, memberSongCount, membersWithAllSongs, membersWithBallot, membersWithSong, votingPanelNames } from "../domain/matchups.ts";
import type { Repository, UserDirectory } from "../data/repository.ts";
import { autoAdvanceRound } from "./progression.ts";
import { loadVotingTurnout } from "./matchups.ts";

export interface Deps {
  repo: Repository;
  users: UserDirectory;
  /** Randomness seam for the head-to-head season freeze (participant shuffle
   *  + schedule salt) — the feature's only nondeterminism. Unset in
   *  production, where rounds.ts falls back to node:crypto's `randomInt`;
   *  tests inject a seeded generator. */
  randomInt?: RandomInt;
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
  /** True once the final round has been revealed — the league is closed. */
  finished: boolean;
}

/** One row of the league table. Every row carries both scorings: `points`
 *  (what a standard league ranks and shows) and the head-to-head record
 *  `wins`/`losses`/`draws` (what an H2H league ranks and shows). The unused
 *  side is simply 0 — a standard league's rows are the same as before with
 *  three zeroed fields added. */
interface Standing {
  rank: number;
  user: UserView;
  points: number;
  wins: number;
  losses: number;
  draws: number;
}

/** Who's done vs. pending for the current phase. Names only — no tracks, no
 *  point allocations — so this leaks nothing about anyone's pick or vote. */
interface RoundParticipation {
  /** Head-to-head voting: only while every member has a matchup to pick in;
   *  otherwise just the caller, if they can vote (HTH-08, `votingPanelNames`
   *  in domain/matchups.ts) — so a member in neither list has nothing to vote
   *  on this round. */
  submitted: UserView[];
  waiting: UserView[];
  /** Units done vs. expected: songs (members × allowance) while submitting,
   *  ballots (one per member) while voting. Drives the "X of N in" count.
   *  Current members only (BUG-09): each member's songs count up to their
   *  allowance and a departed player's songs or ballot not at all, so done
   *  never passes total. Head-to-head: members with their song; members
   *  who've picked in every matchup they can vote in, of those with one to
   *  pick in. */
  doneCount: number;
  totalCount: number;
}

/** One row of the current round's activity feed — who did what, when. Derived
 *  on read from submission/ballot timestamps (no event log). Names only.
 *  Head-to-head voting: other members' ballots show only once the who-voted
 *  panel names them as done — none while it withholds names (HTH-08,
 *  BUG-06, `ballotAuthorVisible`). */
interface ActivityItem {
  id: string;
  user: UserView;
  text: string;
  timeAgo: string;
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
  /** Latest events in the current round, newest first. */
  activity: ActivityItem[];
  /** True once the final round has been revealed — the league is closed. */
  finished: boolean;
}

// ---- helpers ----

/** The league as clients see it: a copy without the head-to-head season
 *  secrets. `h2hParticipants` (the frozen order) would let any player
 *  deanonymize every future matchup and `h2hSalt` is the key that hides it,
 *  so neither leaves the server for anyone, owner included — pairings are
 *  only ever served derived and anonymized (HTH-05). Every handler that
 *  returns a League returns it through here. */
export function toLeagueView(league: League): League {
  const view: League = { ...league };
  delete view.h2hParticipants;
  delete view.h2hSalt;
  return view;
}

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

/** A league is finished once its final round (index ≥ roundCount) has been
 *  revealed. Derived from the rounds rather than stored, so leagues that
 *  already played out before this rule existed close retroactively, and the
 *  lazy timed auto-advance needs no extra write. A finished league takes no
 *  new rounds, leaves the browse list, and becomes eligible for a rematch. */
export function isLeagueFinished(league: League, rounds: Round[]): boolean {
  if (!league.roundCount) return false; // legacy league with no planned count
  const last = latestRound(rounds);
  return Boolean(
    last && last.index >= league.roundCount && (last.status === "revealed" || last.status === "complete"),
  );
}

/** Compact relative timestamp for the activity feed. */
function timeAgo(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Real completion %: for a voting round, members who've cast a ballot /
 *  members; for a submitting round, members' songs (each member's counted up
 *  to their allowance) / total slots; otherwise 0/100 by status. Current
 *  members only (BUG-09, domain/matchups.ts "points turnout"): a departed
 *  player's songs and ballot count toward nobody, so the % follows the
 *  members still to go and never passes 100. Head-to-head leagues count
 *  their own people (`headToHeadCompletionPct`). */
async function completionPct(deps: Deps, league: League, round: Round | undefined): Promise<number> {
  if (!round) return 0;
  if (leagueFormat(league) === "headToHead") return headToHeadCompletionPct(deps, league, round);
  const repo = deps.repo;
  const members = league.memberIds.length || 1;
  if (round.status === "submitting") {
    const subs = await repo.getSubmissionsForRound(round.id);
    const allowance = league.settings.submissionsPerPlayer || 1;
    const songs = memberSongCount(league.memberIds, subs, allowance);
    return Math.min(100, Math.round((songs / (members * allowance)) * 100));
  }
  if (round.status === "voting") {
    const ballots = await repo.getBallotsForRound(round.id);
    return Math.min(100, Math.round((membersWithBallot(league.memberIds, ballots).length / members) * 100));
  }
  return round.status === "revealed" || round.status === "complete" ? 100 : 0;
}

/** Head-to-head completion % (HTH-08) — the same turnout progression waits
 *  on (domain/matchups.ts): while submitting, the members who have their one
 *  song (a departed player's withdrawn song doesn't count); while voting, the
 *  members who've picked in every matchup they can vote in, out of those who
 *  have one to pick in — members with nothing to vote on are left out, or the
 *  % could never reach 100. Nobody able to vote → 100 (nothing to wait for).
 *  Other phases: 0/100 by status, as for points. */
async function headToHeadCompletionPct(deps: Deps, league: League, round: Round): Promise<number> {
  const pct = (done: number, total: number) => (total === 0 ? 100 : Math.min(100, Math.round((done / total) * 100)));
  if (round.status === "submitting") {
    const subs = await deps.repo.getSubmissionsForRound(round.id);
    return league.memberIds.length === 0 ? 0 : pct(membersWithSong(league.memberIds, subs).length, league.memberIds.length);
  }
  if (round.status === "voting") {
    const turnout = await loadVotingTurnout(deps, league, round);
    return pct(turnout.voted.length, turnout.eligible.length);
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
  /** Scoring format; defaults to "standard" when omitted. Fixed for the
   *  league's lifetime — no route can change it after creation. */
  format?: LeagueFormat;
}

/** Resolve the requested format: absent → "standard"; anything that isn't a
 *  known format is a 400 rather than a silent fallback, so a typo can't
 *  quietly create a points league the owner didn't ask for. */
function parseFormat(raw: unknown): LeagueFormat {
  if (raw === undefined || raw === null) return "standard";
  if (typeof raw === "string" && (LEAGUE_FORMATS as readonly string[]).includes(raw)) return raw as LeagueFormat;
  throw badRequest("Pick a league format: standard (points) or head-to-head.");
}

export async function createLeague(deps: Deps, caller: string, input: CreateLeagueInput): Promise<League> {
  const name = (input?.name ?? "").trim();
  if (!name) throw badRequest("Give your league a name.");
  if (!input?.musicProvider) throw badRequest("Pick a music service.");
  const format = parseFormat(input?.format);

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
    format,
    // Head-to-head clamps to its forced settings (1 song, no anti-votes);
    // standard gets the plain defaults, exactly as before formats existed.
    settings: applyFormatSettings(format, DEFAULT_LEAGUE_SETTINGS),
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
  return toLeagueView(league);
}

/** A public league a non-member could discover and claim a spot in. */
export interface PublicLeagueSummary {
  id: string;
  name: string;
  /** The league's format, so a player sees a head-to-head league for what it
   *  is before claiming a spot. Read via `leagueFormat()` (legacy → standard). */
  format: LeagueFormat;
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

/** Whether the league is closed to new players — what discovery and the
 *  public preview advertise. The rounds-based join window above, plus, for
 *  head-to-head only, the season lock: the round robin is scheduled over
 *  exactly the players frozen when round 1 opened, so an H2H league stops
 *  taking newcomers at that moment, not when round 1's submissions close.
 *  Standard leagues: identical to `joinWindowClosed`. */
function closedToNewPlayers(league: League, rounds: Round[]): boolean {
  return seasonLocked(league) || joinWindowClosed(rounds);
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
    // Past round 1's submitting phase, or a head-to-head season already locked.
    if (closedToNewPlayers(league, rounds)) continue;

    const firstRound = [...rounds].sort((a, b) => a.index - b.index)[0];
    open.push({
      id: league.id,
      name: league.name,
      format: leagueFormat(league),
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
  /** As on `PublicLeagueSummary`: what a spectator is about to watch. */
  format: LeagueFormat;
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
    if (isLeagueFinished(league, rounds)) continue; // played out — nothing left to watch
    const current = latestRound(rounds);
    out.push({
      id: league.id,
      name: league.name,
      format: leagueFormat(league),
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
  /** As on `PublicLeagueSummary`. With it the page can also word a closed
   *  head-to-head league right: its `hasStarted` turns true when round 1
   *  OPENS (season locked), not when round 1's submissions close. */
  format: LeagueFormat;
  memberCount: number;
  maxMembers: number;
  openSlots: number;
  firstRoundTheme?: string;
  members: UserView[];
  /** True once the join window closed (round 1 past submitting, or — head-to-
   *  head — the season locked when round 1 opened) — no longer joinable. */
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
    format: leagueFormat(league),
    memberCount: league.memberIds.length,
    maxMembers: cap,
    openSlots,
    firstRoundTheme: firstRound?.theme,
    members: await toUserViews(deps.users, league.memberIds),
    hasStarted: closedToNewPlayers(league, rounds),
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
        league: toLeagueView(league),
        currentRound,
        // The owner's planned count; fall back to created rounds for legacy leagues.
        totalRounds: league.roundCount || rounds.length,
        completionPct: await completionPct(deps, league, currentRound),
        members: await toUserViews(deps.users, league.memberIds),
        finished: isLeagueFinished(league, rounds),
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

  // Standing rows persist for ex-members (so a returning player keeps their
  // points / W-L-D record) — the board displays current members only.
  const rawStandings = await deps.repo.getStandings(leagueId);
  const memberSet = new Set(league.memberIds);
  // Names resolve before sorting: an H2H board breaks record ties by name.
  const named = await Promise.all(
    rawStandings
      .filter((s) => memberSet.has(s.userId))
      .map(async (s) => ({ ...s, displayName: await deps.users.getDisplayName(s.userId) })),
  );
  // Format-aware order (points desc, or wins desc → losses asc → name); rank
  // is the position after sorting, as before.
  const standings: Standing[] = sortStandings(leagueFormat(league), named).map((s, i) => ({
    rank: i + 1,
    user: { id: s.userId, displayName: s.displayName },
    points: s.points,
    wins: s.wins,
    losses: s.losses,
    draws: s.draws,
  }));

  // Who's done vs. pending for the live phase (identities only): submissions
  // while submitting, ballots while voting. With a multi-song allowance a
  // member counts as done once they've used every slot. The counts are the
  // current members' too (BUG-09): "X of N songs in" counts each member's
  // songs up to their allowance, "X of N ballots in" the members with a
  // ballot — a departed player's songs and ballot (which still rank and
  // score) count for nobody, so the numbers match the names beside them and
  // done never passes the total. The same reads feed the activity list
  // ("X submitted a song", "Y cast their votes"), which still shows every
  // row.
  //
  // Head-to-head (HTH-08) counts people, as progression and the completion %
  // do (domain/matchups.ts "turnout"): "X of N songs in" counts members with
  // their one song (a departed player's withdrawn song doesn't count), and
  // "X of N ballots in" counts the members with a matchup to pick in — done
  // once they've picked in every one of them. A member with nothing to vote
  // on (the pair of the round's only contest) isn't counted, rather than
  // shown waiting on a vote they can't cast. The voting panel's NAMES are
  // the eligible voters only while that is every member; otherwise naming
  // them would unmask the bye / walkover songs and each contest player's
  // opponent, so the panel names just the caller, if eligible
  // (`votingPanelNames`, see "Anonymity" there). A member in neither list has
  // nothing to vote on. The activity feed follows the same rule: while the
  // panel withholds names, its "cast their votes" entries show the caller's
  // own ballot only — next to the voted / eligible count, any other named
  // ballot would say which side of the only contest its author is on
  // (`ballotAuthorVisible`). Otherwise they show the caller's own ballot and
  // those of the members the panel shows as done — never the row of a member
  // it shows waiting (comments-only, or incomplete since a rejoin), which can
  // say its author was in the only contest a departure had left (BUG-06),
  // nor a departed voter's.
  let submissionProgress: RoundParticipation | undefined;
  let votingProgress: RoundParticipation | undefined;
  let showBallotBy = (_voterId: string) => true;
  const activity: ActivityItem[] = [];
  if (currentRound && currentRound.status !== "draft") {
    const [subs, ballots] = await Promise.all([
      deps.repo.getSubmissionsForRound(currentRound.id),
      deps.repo.getBallotsForRound(currentRound.id),
    ]);
    const headToHead = leagueFormat(league) === "headToHead";

    if (currentRound.status === "submitting" && headToHead) {
      const doneIds = new Set(membersWithSong(league.memberIds, subs));
      submissionProgress = await splitByDone(deps.users, league.memberIds, doneIds, {
        done: doneIds.size,
        total: league.memberIds.length,
      });
    } else if (currentRound.status === "submitting") {
      const allowance = league.settings.submissionsPerPlayer || 1;
      const doneIds = new Set(membersWithAllSongs(league.memberIds, subs, allowance));
      submissionProgress = await splitByDone(deps.users, league.memberIds, doneIds, {
        done: memberSongCount(league.memberIds, subs, allowance),
        total: league.memberIds.length * allowance,
      });
    } else if (currentRound.status === "voting" && headToHead) {
      const turnout = await loadVotingTurnout(deps, league, currentRound, { submissions: subs, ballots });
      const named = votingPanelNames(turnout, league.memberIds, caller);
      votingProgress = await splitByDone(deps.users, named, new Set(turnout.voted), {
        done: turnout.voted.length,
        total: turnout.eligible.length,
      });
      showBallotBy = (voterId) => ballotAuthorVisible(turnout, league.memberIds, caller, voterId);
    } else if (currentRound.status === "voting") {
      const voted = membersWithBallot(league.memberIds, ballots);
      votingProgress = await splitByDone(deps.users, league.memberIds, new Set(voted), {
        done: voted.length,
        total: league.memberIds.length,
      });
    }

    // Activity: derived from timestamps, never revealing tracks or points.
    const events = [
      ...subs
        .filter((s) => s.submittedAt)
        .map((s) => ({ userId: s.userId, text: "submitted a song", at: s.submittedAt! })),
      ...ballots
        .filter((b) => b.castAt && showBallotBy(b.voterId))
        .map((b) => ({ userId: b.voterId, text: "cast their votes", at: b.castAt })),
    ]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 12);
    for (const e of events) {
      activity.push({
        id: `${e.at}~${e.userId}~${e.text}`,
        user: { id: e.userId, displayName: await deps.users.getDisplayName(e.userId) },
        text: e.text,
        timeAgo: timeAgo(e.at),
      });
    }
  }

  const view = await withRematchLink(deps, toLeagueView(league), caller);
  return {
    league: isMember ? view : { ...view, inviteCode: "" },
    rounds,
    currentRound,
    // The owner's planned count; fall back to created rounds for legacy leagues.
    totalRounds: league.roundCount || rounds.length,
    standings,
    submissionProgress,
    votingProgress,
    activity,
    // After autoAdvanceRound so a reveal that just cascaded counts immediately.
    finished: isLeagueFinished(league, rounds),
  };
}

export async function joinLeague(deps: Deps, caller: string, rawCode: string): Promise<{ league: League }> {
  const code = (rawCode ?? "").trim().toUpperCase();
  if (!code) throw badRequest("Enter an invite code to join.");

  const leagueId = await deps.repo.getLeagueIdForInvite(code);
  const league = leagueId ? await deps.repo.getLeague(leagueId) : undefined;
  if (!league) throw notFound("That code doesn't match any league.");
  // Re-opening an invite link for a league you're in: a 409 whose body also
  // names the league (code "already-member"), so the client can open it.
  if (league.memberIds.includes(caller)) throw alreadyMember(league);
  // The invite path deliberately bypasses the join window and the player cap
  // (standard leagues: an owner can always bring a friend in). Head-to-head
  // is the exception: once round 1 opens the season is frozen, and a newcomer
  // can't be added to a round robin that's already scheduled.
  if (lockedOutOfSeason(league, caller)) throw conflict(SEASON_LOCKED_MESSAGE);

  const updated = await addJoiningMember(deps, league, caller);
  await deps.repo.addStandingPoints(league.id, caller, 0);
  return { league: toLeagueView(updated) };
}

/** The membership write for both join paths. Standard leagues: the plain
 *  write, exactly as before. Head-to-head: the lock check above ran on a read
 *  that may already be stale — a round-1 open can freeze the season between
 *  it and this write — so the write goes through the repo's season-gated
 *  conditional join, which re-checks atomically and refuses with the same
 *  "season locked" 409. */
async function addJoiningMember(deps: Deps, league: League, caller: string): Promise<League> {
  if (leagueFormat(league) !== "headToHead") return deps.repo.addMember(league.id, caller);
  const updated = await deps.repo.addMemberUnlessSeasonLocked(league.id, caller);
  if (!updated) throw conflict(SEASON_LOCKED_MESSAGE);
  return updated;
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

  // Head-to-head: the season lock (round 1 opened) shuts newcomers out even
  // while round 1 is still submitting — checked first so the UI gets the
  // distinct "season locked" reason.
  if (lockedOutOfSeason(league, caller)) throw conflict(SEASON_LOCKED_MESSAGE);
  const rounds = await deps.repo.getRoundsForLeague(leagueId);
  if (joinWindowClosed(rounds)) {
    throw conflict("It's too late to join — round 1 has closed submissions.");
  }

  // Best-effort capacity check. Not atomic under concurrent claims — acceptable
  // at this scale; promote to a conditional write if contention ever matters.
  const cap = league.maxMembers ?? 0;
  if (league.memberIds.length >= cap) throw conflict("This league is full.");

  const updated = await addJoiningMember(deps, league, caller);
  await deps.repo.addStandingPoints(leagueId, caller, 0); // seed standing at 0
  return { league: toLeagueView(updated) };
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
  return { league: toLeagueView({ ...league, inviteCode: code }) };
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
  // Format itself is never read from the input: it's immutable after creation.
  const headToHead = leagueFormat(league) === "headToHead";

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
  // Head-to-head pairs players, so each must bring exactly one song. Reject
  // (not clamp): the server is the referee and the owner should see why.
  if (headToHead && submissionsPerPlayer !== H2H_FORCED_SETTINGS.submissionsPerPlayer) {
    throw badRequest("Head-to-head leagues are locked to 1 song per player.");
  }
  if (!(submissionsPerPlayer >= 1 && submissionsPerPlayer <= 5)) {
    throw badRequest("Songs per player must be between 1 and 5.");
  }

  // Anti-votes: 0 (off, the default) up to 2 per voter per round.
  const downvotePoolSize =
    input?.downvotePoolSize === undefined
      ? league.settings.downvotePoolSize ?? 0
      : asInt(input.downvotePoolSize);
  // A matchup ballot picks a winner — there's no points pool to subtract from.
  if (headToHead && downvotePoolSize !== H2H_FORCED_SETTINGS.downvotePoolSize) {
    throw badRequest("Head-to-head leagues don't use anti-votes.");
  }
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
  return toLeagueView(await deps.repo.updateLeagueSettings(leagueId, settings));
}

export async function deleteLeague(deps: Deps, caller: string, leagueId: string): Promise<{ ok: true }> {
  await ownedLeague(deps, caller, leagueId);
  await deps.repo.deleteLeague(leagueId);
  return { ok: true };
}

/** "Szn Music Group 1" → "Szn Music Group 2"; no trailing number → append " 2".
 *  Keeps room for the id slug + a fresh suffix within the 50-char name cap. */
function rematchName(name: string): string {
  const numbered = name.match(/^(.*?)(\d+)\s*$/);
  const next = numbered ? `${numbered[1]}${Number(numbered[2]) + 1}` : `${name} 2`;
  return next.slice(0, 50);
}

/** Owner-only: once a league has finished, spin up a fresh one with the same
 *  players, settings, and format — everyone starts again at 0 points (and a
 *  0–0–0 record in head-to-head). The old league stays readable (results,
 *  standings) but closed.
 *
 *  One live rematch per league (BUG-13): the old league records the league
 *  it spawned (`rematchLeagueId`), and asking again — a second tab, a stale
 *  page, a retried or concurrent POST — returns that league (200) instead of
 *  enrolling everyone in yet another copy. Only once that league has been
 *  deleted does a rematch create a new one, replacing the pointer. Race-safe
 *  by create-then-claim: the new league is written first, then claimed with
 *  the repo's conditional `setRematchPointer`; a request whose claim loses
 *  deletes its league again and returns the winner's. (Claiming first would
 *  let a concurrent request see a pointer to a league not written yet, take
 *  it for a deleted one and overwrite it.) The standing seeds and invite
 *  code are written only once the claim has landed, so a losing request
 *  has nothing but the league itself to remove; should the winner fail
 *  part-way through them, the owner's retry finishes them.
 *
 *  Head-to-head: the clone starts UN-frozen. Its fields are copied one by one
 *  and `h2hParticipants` / `h2hSalt` deliberately are not, so the clone takes
 *  players again until its own round 1 opens, then freezes with its own
 *  shuffle and salt, and its roundCount is re-derived from its own member
 *  count at that moment (the value copied here is only provisional). */
export async function rematchLeague(deps: Deps, caller: string, leagueId: string): Promise<League> {
  const league = await ownedLeague(deps, caller, leagueId);
  const rounds = await deps.repo.getRoundsForLeague(leagueId);
  if (!isLeagueFinished(league, rounds)) {
    throw conflict("You can start a rematch once every round has been played.");
  }

  // Already rematched, and that league still exists: it's the answer —
  // finished first if the request that made it died part-way (see repairRematch).
  const existing = await liveRematch(deps, league);
  if (existing) {
    await repairRematch(deps, existing);
    return toLeagueView(existing);
  }

  const name = rematchName(league.name);
  // Copy the format explicitly (fields are copied one by one, so a missing
  // line here would silently revert a head-to-head rematch to points).
  const format = leagueFormat(league);
  const next: League = {
    id: newLeagueId(name),
    name,
    ownerId: caller,
    musicProvider: league.musicProvider,
    format,
    settings: applyFormatSettings(format, league.settings),
    memberIds: [...league.memberIds],
    inviteCode: newInviteCode(),
    visibility: league.visibility,
    maxMembers: league.maxMembers,
    // Head-to-head: provisional — the clone's own freeze overrides it.
    roundCount: league.roundCount,
    progression: league.progression,
    // Timed leagues restart their clock now; the old startAt is history.
    startAt: league.progression === "timed" ? new Date().toISOString() : undefined,
    phaseDays: league.phaseDays,
    // h2hParticipants / h2hSalt: never copied (see above). Nor is
    // rematchLeagueId: the clone has had no rematch of its own yet.
  };
  await deps.repo.createLeague(next);
  // Claim it as THE rematch; a request that claimed first wins (ours is gone).
  // A pointer read just now whose league is gone is the one we may replace.
  // Only then the standings and invite, so a loser has just the league to remove.
  const winner = await claimRematch(deps, leagueId, next, league.rematchLeagueId);
  if (winner) return toLeagueView(winner);
  await seedRematch(deps, next);
  return toLeagueView(next);
}

/** A claimed rematch's remaining writes: everyone's 0-point standing row,
 *  then its invite code. Every one of them is idempotent (an ADD of 0, a
 *  plain Put), so running it again is harmless — and the invite goes LAST:
 *  a rematch whose invite row exists is complete, which is how
 *  `repairRematch` tells one whose request died part-way (after the claim)
 *  from a whole one with a single read. */
async function seedRematch(deps: Deps, rematch: League): Promise<void> {
  for (const memberId of rematch.memberIds) {
    await deps.repo.addStandingPoints(rematch.id, memberId, 0); // seed everyone at 0
    // H2H: an explicit 0–0–0 record on the fresh row too (reads would default
    // it anyway; this keeps the clone's rows complete). Standard rematches
    // write exactly what they always did.
    if (leagueFormat(rematch) === "headToHead") {
      await deps.repo.addStandingRecord(rematch.id, memberId, { wins: 0, losses: 0, draws: 0 });
    }
  }
  await deps.repo.putInvite(rematch.inviteCode, rematch.id);
}

/** The idempotent answer's safety net: if the request that claimed this
 *  rematch failed after its claim landed (before or during `seedRematch`),
 *  the owner's retry lands here and finishes the job instead of handing back
 *  a league nobody can join with its code and that has no standing rows. A
 *  whole rematch costs one read (its invite row, written last); should that
 *  read lag a rematch made a moment ago, the idempotent writes just run
 *  again. */
async function repairRematch(deps: Deps, rematch: League): Promise<void> {
  if ((await deps.repo.getLeagueIdForInvite(rematch.inviteCode)) === rematch.id) return;
  await seedRematch(deps, rematch);
}

/** How many times a rematch whose claim lost re-reads the pointer and, finding
 *  its league deleted too, claims over it again before giving up (409). Each
 *  retry needs another rematch to have been deleted in between, so more than
 *  one is already unlikely. */
const REMATCH_CLAIM_ATTEMPTS = 3;

/** The league `league` was rematched into, if it has been and that league
 *  still exists. Read strongly consistent: the rematch league is written
 *  before the pointer to it, so a consistent read finds it unless it was
 *  deleted — whereas an eventually consistent one could miss a rematch made
 *  a moment ago, and the caller would then replace a live pointer. */
async function liveRematch(deps: Deps, league: League): Promise<League | undefined> {
  if (!league.rematchLeagueId) return undefined;
  return deps.repo.getLeague(league.rematchLeagueId, { consistent: true });
}

/** Claim `next` (already written) as `leagueId`'s rematch, replacing at most
 *  `stale` — a pointer read earlier whose league is gone. Resolves
 *  `undefined` once the claim lands. When another rematch claimed first,
 *  `next` is deleted and that rematch's league is returned instead. A lost
 *  claim re-reads the pointer strongly consistent (the first read may have
 *  been stale either way): `next` itself there means the claim landed after
 *  all; another live league is the winner; a deleted one is claimed over
 *  again. Whatever else ends the attempt before a claim has landed — the
 *  claim or one of those reads erroring, a 404/409 — deletes `next` too and
 *  propagates; should the claim have landed after all (its response lost),
 *  the pointer dangles, which every reader treats as "no rematch". */
async function claimRematch(deps: Deps, leagueId: string, next: League, stale: string | undefined): Promise<League | undefined> {
  // Best effort: the winner to return, or the error to report, matters more
  // than a failed clean-up — which is logged with the orphan's id instead.
  const discard = () =>
    deps.repo.deleteLeague(next.id, { consistent: true }).catch((err: unknown) => {
      console.error(`Couldn't discard the losing rematch league ${next.id}:`, err);
    });
  let replaces = stale;
  try {
    for (let attempt = 1; ; attempt++) {
      if (await deps.repo.setRematchPointer(leagueId, next.id, replaces)) return undefined;

      const current = await deps.repo.getLeague(leagueId, { consistent: true });
      // Our own pointer: the write did land — an SDK retry of it (the first
      // response lost) then failed its own write-once condition.
      if (current?.rematchLeagueId === next.id) return undefined;
      const winner = current && (await liveRematch(deps, current));
      if (winner) {
        await discard();
        return winner;
      }
      if (!current) throw notFound("That league doesn't exist.");
      if (attempt >= REMATCH_CLAIM_ATTEMPTS) throw conflict("Couldn't start the rematch just now — try again.");
      replaces = current.rematchLeagueId; // points at a deleted league too: claim over that one
    }
  } catch (err) {
    await discard(); // unclaimed as far as we know: it mustn't linger on members' dashboards
    throw err;
  }
}

/** The league detail's copy of the rematch pointer (BUG-13): kept only while
 *  the rematch league exists and the caller is one of its members — what the
 *  overview's "Go to the rematch" link needs. A pointer to a deleted league
 *  is dropped (the owner is offered "Run it back" again), as is one to a
 *  rematch the caller isn't in (they left it, or are spectating). Read
 *  strongly consistent, like `liveRematch`: one extra read, and only for a
 *  league that has a pointer, so a rematch made or deleted a moment ago is
 *  never missed or still linked. */
async function withRematchLink(deps: Deps, view: League, caller: string): Promise<League> {
  if (!view.rematchLeagueId) return view;
  const rematch = await deps.repo.getLeague(view.rematchLeagueId, { consistent: true });
  if (rematch?.memberIds.includes(caller)) return view;
  const { rematchLeagueId: _hidden, ...rest } = view;
  return rest;
}
