// Voting handlers — cast a ballot, reveal a round, read results. The actual
// game rules (full-pool ballots, per-song cap, no self-vote, the tie-break; for
// head-to-head leagues the winner-pick rules) live in domain/rules.ts and are
// reused here; these handlers just supply context and do the I/O. Same
// (deps, caller, ...) shape as the other handlers.
//
// Head-to-head (HTH-06): a ballot is one winner pick per matchup the voter can
// vote in, stored on the SAME one-row-per-voter Ballot item as a points ballot
// (`allocations: {}` + `picks`), so everything that counts ballots per voter
// (completion %, the timed everyone-voted reveal) works unchanged.

import type { Ballot, League, Round, Submission } from "../domain/types.ts";
import { leagueFormat } from "../domain/types.ts";
import { badRequest, forbidden, notFound } from "../domain/errors.ts";
import { validateBallot, validateH2HBallot } from "../domain/rules.ts";
import type { RoundMatchupSet } from "../domain/matchups.ts";
import { computeResults, finalizeReveal, type RoundResult } from "./results.ts";
import { autoAdvanceRound } from "./progression.ts";
import { loadRoundMatchups } from "./matchups.ts";
import type { Deps } from "./leagues.ts";

const deadlinePassed = (iso?: string): boolean => (iso ? Date.now() > new Date(iso).getTime() : false);

/** Load a round + league, asserting league membership. */
async function roundForMember(deps: Deps, caller: string, roundId: string) {
  const round = await deps.repo.getRound(roundId);
  if (!round) throw notFound("That round doesn't exist.");
  const league = await deps.repo.getLeague(round.leagueId);
  if (!league || !league.memberIds.includes(caller)) {
    throw forbidden("You're not a member of this league.");
  }
  return { round, league };
}

export interface CastBallotInput {
  /** Standard: submissionId -> points. Head-to-head ballots carry none (an
   *  empty map is tolerated; any points are rejected). */
  allocations?: Record<string, number>;
  downvotes?: Record<string, number>;
  /** submissionId -> comment text, in either format. */
  comments?: Record<string, string>;
  /** Head-to-head: matchupId -> the submissionId picked to win it. Rejected
   *  on a standard league. */
  picks?: Record<string, string>;
}

/** Does a raw body field hold at least one entry? (`undefined`, `null` and
 *  `{}` don't — clients may send the other format's field empty.) */
const hasEntries = (v: unknown): boolean =>
  v !== undefined && v !== null && (typeof v !== "object" || Object.keys(v).length > 0);

export async function castBallot(
  deps: Deps,
  caller: string,
  roundId: string,
  input: CastBallotInput,
): Promise<{ ok: true }> {
  const { round, league } = await roundForMember(deps, caller, roundId);
  if (round.status !== "voting") throw badRequest("This round isn't open for voting.");
  if (deadlinePassed(round.voteDeadline)) throw badRequest("The voting deadline has passed.");

  const ballot =
    leagueFormat(league) === "headToHead"
      ? await headToHeadBallot(deps, caller, league, round, input)
      : await pointsBallot(deps, caller, league, round, input);
  await deps.repo.putBallot(ballot); // overwrites any earlier ballot from this voter
  // Timed leagues: if this was the last outstanding vote, reveal the round now
  // rather than waiting for the deadline.
  await autoAdvanceRound(deps, league, round);
  return { ok: true };
}

/** A standard (points) league's ballot — the original path, unchanged apart
 *  from refusing head-to-head picks. */
async function pointsBallot(
  deps: Deps,
  caller: string,
  league: League,
  round: Round,
  input: CastBallotInput,
): Promise<Ballot> {
  if (hasEntries(input?.picks)) {
    throw badRequest("This league scores by points — spend your points on songs instead of picking matchup winners.");
  }
  const subs = await deps.repo.getSubmissionsForRound(round.id);
  const validSubmissionIds = new Set(subs.map((s) => s.id));
  const ownSubmissionId = subs.find((s) => s.userId === caller)?.id;

  const allocations = input?.allocations && typeof input.allocations === "object" ? input.allocations : {};

  // The rules engine throws ApiError(400) on any broken rule; returns the
  // cleaned (positive-only) allocations and downvotes on success.
  const cleaned = validateBallot(
    { allocations, downvotes: input?.downvotes, comments: input?.comments },
    { settings: league.settings, validSubmissionIds, ownSubmissionId },
  );

  return {
    roundId: round.id,
    voterId: caller,
    allocations: cleaned.allocations,
    downvotes: cleaned.downvotes,
    comments: cleanComments(input?.comments, validSubmissionIds),
    castAt: new Date().toISOString(),
  };
}

/** A head-to-head league's ballot: one winner pick per votable matchup,
 *  refereed by `validateH2HBallot` over the round's derived matchups (the
 *  shared HTH-05 loader, so ballots, the matchups read and the tally agree on
 *  who faces whom and which pairs are contests). Stored as `allocations: {}` +
 *  `picks` on the voter's one Ballot row. */
async function headToHeadBallot(
  deps: Deps,
  caller: string,
  league: League,
  round: Round,
  input: CastBallotInput,
): Promise<Ballot> {
  if (hasEntries(input?.allocations)) {
    throw badRequest("This is a head-to-head league — pick a winner in each matchup instead of spending points.");
  }
  if (hasEntries(input?.downvotes)) throw badRequest("This league doesn't use anti-votes.");

  // The round as it stands (departed players' songs withdrawn) referees the
  // ballot; the round as scheduled (nobody withdrawn) recognises a pick or a
  // comment made before a departure, so a re-cast keeps it and a rejoin
  // brings it back. Both through the shared loader.
  const [matchups, asScheduled] = await Promise.all([
    loadRoundMatchups(deps, league, round),
    loadRoundMatchups(deps, league, round, { departed: [] }),
  ]);
  const picks = validateH2HBallot(input?.picks, matchups, caller, asScheduled);
  return {
    roundId: round.id,
    voterId: caller,
    allocations: {},
    picks,
    // Comments aren't votes: every frozen participant's song takes one — both
    // songs of every matchup (the voter's own matchup and walkovers included)
    // and the bye's exhibition song. A departed player's withdrawn song too,
    // as a standard ballot keeps comments on a departed player's song: the
    // vote page no longer shows it, but a pre-filled re-cast mustn't lose the
    // comment (and a rejoin shows it again).
    comments: cleanComments(input?.comments, new Set(roundSongs(asScheduled).map((s) => s.id))),
    castAt: new Date().toISOString(),
  };
}

/** Every song a derived round shows: both sides of each matchup + the bye. */
function roundSongs(set: RoundMatchupSet): Submission[] {
  const sides = [...set.matchups.flatMap((m) => [m.a, m.b]), ...(set.bye ? [set.bye] : [])];
  return sides.flatMap((side) => (side.submission ? [side.submission] : []));
}

/** The caller's own cast ballot for a round (or null before they vote), so the
 *  vote page can pre-fill points + comments instead of starting blank — a blind
 *  re-cast used to silently wipe the earlier ballot's comments. Head-to-head
 *  leagues get `picks` too, exactly as stored (a pick in a matchup that has
 *  since become a walkover is still returned, and a re-cast keeps it — see
 *  `validateH2HBallot`). A standard league's payload is unchanged (no `picks`
 *  key). */
export async function getMyBallot(
  deps: Deps,
  caller: string,
  roundId: string,
): Promise<{
  allocations: Record<string, number>;
  downvotes: Record<string, number>;
  comments: Record<string, string>;
  picks?: Record<string, string>;
} | null> {
  const { league } = await roundForMember(deps, caller, roundId);
  const ballot = await deps.repo.getBallot(roundId, caller);
  if (!ballot) return null;
  const mine = { allocations: ballot.allocations, downvotes: ballot.downvotes ?? {}, comments: ballot.comments ?? {} };
  return leagueFormat(league) === "headToHead" ? { ...mine, picks: ballot.picks ?? {} } : mine;
}

/** Keep only comments on real submissions, trimmed and non-empty. */
function cleanComments(raw: unknown, validIds: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const [id, text] of Object.entries(raw as Record<string, unknown>)) {
      if (validIds.has(id) && typeof text === "string" && text.trim()) out[id] = text.trim();
    }
  }
  return out;
}

export async function revealRound(deps: Deps, caller: string, roundId: string): Promise<RoundResult[]> {
  const round = await deps.repo.getRound(roundId);
  if (!round) throw notFound("That round doesn't exist.");
  const league = await deps.repo.getLeague(round.leagueId);
  if (!league) throw notFound("That league doesn't exist.");
  if (league.ownerId !== caller) throw forbidden("Only the league owner can reveal a round.");
  if (round.status !== "voting") throw badRequest("Only a round that's in voting can be revealed.");

  return finalizeReveal(deps, round);
}

export async function getResults(deps: Deps, _caller: string, roundId: string): Promise<RoundResult[]> {
  // Revealed results are readable by any signed-in user (spectators included) —
  // they're the public outcome of the round, not ballot internals.
  const round = await deps.repo.getRound(roundId);
  if (!round) throw notFound("That round doesn't exist.");
  if (round.status !== "revealed" && round.status !== "complete") {
    throw badRequest("Results aren't available until the round is revealed.");
  }
  return computeResults(deps, roundId);
}
