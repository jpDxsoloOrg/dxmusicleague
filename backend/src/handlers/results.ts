// Round results — tally ballots, rank with the tie-break, and settle a round.
// Extracted from voting.ts so both the voting handlers and the timed
// auto-advance (progression.ts) can share `finalizeReveal` without an import
// cycle. Pure over the Repository port.
//
// Head-to-head (HTH-07): the same two entry points dispatch on the league's
// format. An H2H round settles as matchups — most votes wins the pair, a tie
// is a draw, a player without a song loses by walkover, a pair without songs
// is no contest, the bye's song is an exhibition — and the reveal banks W/L/D
// (not points) exactly once, pinning what it counted on the round so every
// later read agrees with the board. The tally and outcomes are pure domain
// rules (domain/rules.ts `tallyMatchups` / `resolveMatchups` /
// `matchupRecords`) over the shared matchup loader (handlers/matchups.ts —
// domain-only imports, so no cycle); this file only loads, banks and shapes
// the payload.
//
// Wire compatibility for the live beta: a standard round's results stay the
// bare `RoundResult[]` array, byte for byte, on both GET results and the
// reveal response, so an older frontend never breaks against this backend.
// Only a head-to-head round answers with an object, `{ format: "headToHead",
// matchups, bye }`; the frontend data layer (HTH-09) normalizes the two into
// its own `{ format, ... }` union.

import type { Ballot, League, Round, Submission, Track } from "../domain/types.ts";
import { leagueFormat } from "../domain/types.ts";
import { conflict, notFound } from "../domain/errors.ts";
import { compareMatchupIds } from "../domain/schedule.ts";
import { departedParticipants } from "../domain/matchups.ts";
import { matchupRecords, rankSubmissions, resolveMatchups, settleMatchups, tallyBallots, tallyMatchups } from "../domain/rules.ts";
import type { MatchupOutcome, SettledRound, SettledSide } from "../domain/rules.ts";
import { loadRoundMatchups } from "./matchups.ts";
import type { Deps } from "./leagues.ts";

export type { MatchupOutcome } from "../domain/rules.ts";

interface UserView { id: string; displayName: string }
interface VoterComment { voter: UserView; text: string }
export interface RoundResult {
  rank: number;
  track: Track;
  submitter: UserView;
  /** Net total: pointsFor − pointsAgainst. May be negative with anti-votes. */
  points: number;
  /** Sum of positive votes. */
  pointsFor: number;
  /** Sum of anti-votes (positive number; 0 when none / league has them off). */
  pointsAgainst: number;
  /** The submitter's own note about their pick, written at submit time. */
  submitterComment?: string;
  comments: VoterComment[];
}

/** Tally ballots, rank with the tie-break, attach submitter names and voter
 *  comments. Used by reveal and GET results — a standard (points) round's
 *  results; the format dispatch is in `finalizeReveal` / `roundResults`, so
 *  this stays exactly the original ranked-list computation. */
export async function computeResults(deps: Deps, roundId: string): Promise<RoundResult[]> {
  const subs = await deps.repo.getSubmissionsForRound(roundId);
  const ballots = await deps.repo.getBallotsForRound(roundId);
  const tally = tallyBallots(ballots.map((b) => ({ allocations: b.allocations, downvotes: b.downvotes })));

  const ranked = rankSubmissions(
    subs.map((s) => ({
      submissionId: s.id,
      title: s.track.title,
      points: tally.get(s.id)?.points ?? 0,
      distinctVoters: tally.get(s.id)?.distinctVoters ?? 0,
      pointsFor: tally.get(s.id)?.pointsFor ?? 0,
      pointsAgainst: tally.get(s.id)?.pointsAgainst ?? 0,
      userId: s.userId,
      track: s.track,
    })),
  );

  const noteBySubmission = new Map(subs.map((s) => [s.id, s.comment]));
  return Promise.all(
    ranked.map(async (r) => ({
      rank: r.rank,
      track: r.track,
      submitter: { id: r.userId, displayName: await deps.users.getDisplayName(r.userId) },
      points: r.points,
      pointsFor: r.pointsFor,
      pointsAgainst: r.pointsAgainst,
      submitterComment: noteBySubmission.get(r.submissionId) || undefined,
      comments: await commentsFor(deps, r.submissionId, ballots),
    })),
  );
}

async function commentsFor(deps: Deps, submissionId: string, ballots: Ballot[]): Promise<VoterComment[]> {
  const withComment = ballots.filter((b) => b.comments?.[submissionId]);
  return Promise.all(
    withComment.map(async (b) => ({
      voter: { id: b.voterId, displayName: await deps.users.getDisplayName(b.voterId) },
      text: b.comments![submissionId]!,
    })),
  );
}

/** How `finalizeReveal` answers when it loses a head-to-head reveal race. */
export interface FinalizeRevealOptions {
  /** Head-to-head only. When another reveal settled the round first, the
   *  default answers with the round as it was settled — right for the reveal
   *  endpoint and the timed advance, which only want it revealed. A caller
   *  whose own edits ride on the claim (rounds.updateRound opening voting on
   *  a round nobody can vote in, HTH-08) passes `true` to get the 409 the
   *  H2H round write answers in the same race, not a 200 that silently
   *  dropped its edits. */
  conflictIfSettled?: boolean;
}

/** Tally + rank a voting round, bank each submitter's points, mark it revealed,
 *  and persist. Shared by the owner reveal endpoint and timed auto-advance, so
 *  both settle a round identically. Mutates `round.status`. A head-to-head
 *  league's round settles as matchups instead (`finalizeHeadToHeadReveal`);
 *  a standard round takes exactly the original path. */
export async function finalizeReveal(
  deps: Deps,
  round: Round,
  options: FinalizeRevealOptions = {},
): Promise<RoundResultsPayload> {
  const league = await deps.repo.getLeague(round.leagueId);
  if (league && leagueFormat(league) === "headToHead") return finalizeHeadToHeadReveal(deps, league, round, options);

  const results = await computeResults(deps, round.id);
  for (const r of results) {
    // Negative totals (anti-votes) bank too — the leaderboard can go below 0.
    if (r.points !== 0) await deps.repo.addStandingPoints(round.leagueId, r.submitter.id, r.points);
  }
  round.status = "revealed";
  await deps.repo.updateRound(round);
  return results;
}

/** Any revealed round's results, as GET results and the reveal answer them:
 *  the standard ranked list (the bare array, unchanged) or, for a
 *  head-to-head league, the matchup payload. */
export async function roundResults(deps: Deps, round: Round): Promise<RoundResultsPayload> {
  const league = await deps.repo.getLeague(round.leagueId);
  if (league && leagueFormat(league) === "headToHead") return headToHeadResults(deps, league, round);
  return computeResults(deps, round.id);
}

// ---- Head-to-head (HTH-07) -------------------------------------------------

/** A song as the reveal shows it: the anonymous song's id + track plus what
 *  the standard reveal adds per song — the submitter's own note and every
 *  voter comment. Who submitted it is the side's `player` (or the bye's). */
export interface RevealedSong {
  /** The submission id — what ballot picks and comments are keyed by. */
  id: string;
  track: Track;
  /** The submitter's own note about their pick, written at submit time. */
  submitterComment?: string;
  comments: VoterComment[];
}

/** One side of a revealed matchup. */
export interface MatchupResultSide {
  /** The player in this slot of the frozen schedule — revealed now, as the
   *  standard reveal reveals submitters (song or not). */
  player: UserView;
  /** Their song; `null` when they didn't submit, or had departed (left / been
   *  kicked) by the reveal — their pair is then a walkover or no contest. */
  song: RevealedSong | null;
  /** Picks this side won. Always 0 outside a contest (stray picks ignored). */
  votes: number;
  /** True when the player had departed by the reveal. Their side banked no
   *  loss; only the player who stayed banked the walkover win. */
  departed: boolean;
}

/** A revealed head-to-head matchup: both sides with their votes, the outcome,
 *  and the winner (`win` / `walkover` only). */
export interface MatchupResult {
  /** `<roundId>~M<n>` — the id ballots keyed their picks by. */
  matchupId: string;
  a: MatchupResultSide;
  b: MatchupResultSide;
  /** Open set (playoffs may add outcomes, HTH-13): treat an unknown value as
   *  "no result". */
  outcome: MatchupOutcome;
  /** The winner's user id, for `win` and `walkover`; absent for `draw` /
   *  `noContest`. */
  winnerUserId?: string;
}

/** The bye player's exhibition song, revealed: no matchup, no result. */
export interface ByeResult {
  player: UserView;
  song: RevealedSong;
}

/** A head-to-head round's results payload. `bye` is `null` for an even field,
 *  or when the bye player has no song — they didn't submit, or had departed
 *  by the reveal (as in GET /matchups). */
export interface HeadToHeadResults {
  format: "headToHead";
  /** Every matchup of the round, sorted by matchup id. */
  matchups: MatchupResult[];
  bye: ByeResult | null;
}

/** What GET results / the reveal answer: a standard round's bare ranked list
 *  (unchanged for the live beta) or a head-to-head round's matchup payload.
 *  Discriminate with `Array.isArray`. */
export type RoundResultsPayload = RoundResult[] | HeadToHeadResults;

/**
 * Settle a head-to-head round, exactly once, and bank its W/L/D.
 *
 * Departures are judged as the round stands now — it is still in play, so
 * every frozen participant who isn't a member any more has their song
 * withdrawn and their pair plays as a walkover (domain `departedParticipants`).
 * The ballots are tallied over those matchups, and the outcomes and each
 * player's W/L/D (`matchupRecords`) follow from that tally.
 *
 * Exactly once: ONE atomic repository write (`revealRoundOnce`) both claims
 * the round — status `revealed`, plus the departed set (`h2hDeparted`) and
 * the tally (`h2hTally`) pinned on it — and banks every record, landing only
 * while the stored round isn't settled. Two reveals racing — the owner's and
 * a timed auto-advance, or two auto-advancing reads, each holding a round
 * object read while it was still voting — both tally, but only the one whose
 * write lands banks; the other banks nothing and answers with the round as it
 * was settled (re-read strongly consistently, so it sees the winner's write).
 * A write that fails banks nothing and leaves the round in voting, so the
 * reveal can be retried. Every record is written, unlike the standard path's
 * `points !== 0` skip: a zero-vote loss still banks its L and a 0–0 draw its
 * D.
 *
 * Because the tally is pinned, a ballot that lands after this read the
 * ballots (it passed castBallot's status check just before the reveal) can
 * never change the revealed outcomes: GET results reads the pinned tally,
 * not the ballot rows.
 *
 * Mutates `round` to what is stored afterwards (status `revealed` and the
 * pins), like the standard path mutates `round.status` — unless the caller
 * asked for a 409 on a lost race (`conflictIfSettled`), which leaves `round`
 * as it was.
 */
async function finalizeHeadToHeadReveal(
  deps: Deps,
  league: League,
  round: Round,
  options: FinalizeRevealOptions,
): Promise<HeadToHeadResults> {
  const departed = [...departedParticipants(league, { status: "voting" })].sort();
  const [matchups, ballots] = await Promise.all([
    loadRoundMatchups(deps, league, round, { departed }),
    deps.repo.getBallotsForRound(round.id),
  ]);
  const tally = tallyMatchups(matchups, ballots);
  const settled = resolveMatchups(matchups, tally);

  const claimed: Round = { ...round, status: "revealed", h2hDeparted: departed, h2hTally: tally };
  if (!(await deps.repo.revealRoundOnce(claimed, matchupRecords(settled.matchups)))) {
    // Another reveal settled it first (or it's gone): nothing was banked.
    const stored = await deps.repo.getRound(round.id, { consistent: true });
    if (!stored) throw notFound("That round doesn't exist.");
    if (options.conflictIfSettled) throw conflict("That round was just revealed. Reload to see the results.");
    Object.assign(round, stored);
    return headToHeadResults(deps, league, stored);
  }
  Object.assign(round, claimed);
  return headToHeadPayload(deps, settled, ballots);
}

/** A revealed head-to-head round's results, re-derived on read from what the
 *  reveal pinned on the round: the departed set (the loader reads it) and the
 *  tally — so this is exactly what was banked, however membership or the
 *  ballot rows have changed since. A revealed round without a pinned tally
 *  (hand-made data, e.g. a seed) re-tallies its ballots. */
async function headToHeadResults(deps: Deps, league: League, round: Round): Promise<HeadToHeadResults> {
  const [matchups, ballots] = await Promise.all([
    loadRoundMatchups(deps, league, round),
    deps.repo.getBallotsForRound(round.id),
  ]);
  const settled = round.h2hTally ? resolveMatchups(matchups, round.h2hTally) : settleMatchups(matchups, ballots);
  return headToHeadPayload(deps, settled, ballots);
}

/** Shape a settled round for the wire: players named, songs with the
 *  submitter's note and voter comments (the standard reveal's `commentsFor`),
 *  matchups sorted by id. */
async function headToHeadPayload(deps: Deps, settled: SettledRound, ballots: Ballot[]): Promise<HeadToHeadResults> {
  const player = async (userId: string): Promise<UserView> => ({
    id: userId,
    displayName: await deps.users.getDisplayName(userId),
  });
  const song = async (sub: Submission | undefined): Promise<RevealedSong | null> =>
    sub
      ? {
          id: sub.id,
          track: sub.track,
          ...(sub.comment ? { submitterComment: sub.comment } : {}),
          comments: await commentsFor(deps, sub.id, ballots),
        }
      : null;
  const side = async (s: SettledSide): Promise<MatchupResultSide> => ({
    player: await player(s.userId),
    song: await song(s.submission),
    votes: s.votes,
    departed: s.departed,
  });

  const matchups = await Promise.all(
    [...settled.matchups]
      .sort((x, y) => compareMatchupIds(x.matchupId, y.matchupId))
      .map(async (m): Promise<MatchupResult> => ({
        matchupId: m.matchupId,
        a: await side(m.a),
        b: await side(m.b),
        outcome: m.outcome,
        ...(m.winnerUserId === undefined ? {} : { winnerUserId: m.winnerUserId }),
      })),
  );
  const byeSong = await song(settled.bye?.submission);
  const bye = settled.bye && byeSong ? { player: await player(settled.bye.userId), song: byeSong } : null;
  return { format: "headToHead", matchups, bye };
}
