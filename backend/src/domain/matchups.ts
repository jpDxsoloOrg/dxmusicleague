// Head-to-head matchups with their songs attached — pure, no I/O, no Node
// APIs (isomorphic like domain/schedule.ts and domain/freeze.ts, so the
// frontend mock can reuse it in HTH-09).
//
// A round's matchups are never stored. Every read derives them: the pairings
// come from the league's frozen participant order + schedule salt + the
// round's index (domain/schedule.ts), and each player's song is attached from
// the round's submissions. This module is that one derivation, shared so every
// reader sees the same picture of a round:
//   - the matchups read API (handlers/matchups.ts, HTH-05) — anonymized;
//   - H2H ballot validation (HTH-06) — which matchups a voter must pick in;
//   - the tally and outcomes at reveal (HTH-07) — walkovers, no-contests, byes.
//
// A side "has no song" when that player didn't submit OR their song is
// withdrawn because they departed (left or were kicked mid-season). While a
// round is in play (anything before `revealed`), departures are judged against
// the member list as it is now: a departed player's song is withdrawn even if
// they submitted it before leaving, so their pair plays as a walkover for
// whoever stayed (HTH-07's rule) and voters are never asked to judge it.
// Rejoining puts the song back. (Deliberately more than the ticket's "no
// special casing beyond null songs": a departed player's submission is still
// stored, so without the withdrawal their pair would stay a contest.)
//
// A revealed round (`revealed` / `complete`) is settled history and is never
// re-judged against today's member list: that list can't tell a departure
// before the reveal from one after it, so a later leave/kick would rewrite a
// contest that was actually voted on into a walkover and contradict the W/L
// banked at reveal. So by default a revealed round withdraws nobody (every
// submitted song shows, as standard results do). The departed set that held
// AT the reveal is not derivable from current data — HTH-07 must pin it in
// `finalizeReveal` (the moment it banks) and pass it back as
// `options.departed` on every later read, so a revealed round reads exactly
// as it was settled. See `departedParticipants`.
//
// Anonymity: the derived set carries submitter ids and stays server-side.
// `matchupsView` is the only shape that leaves the server before the reveal —
// songs as `AnonSong` (the same mapper the standard vote list uses) plus a
// per-viewer `isMine` flag, never the frozen order and never a user id.

import { compareMatchupIds, matchupsForRound } from "./schedule.ts";
import { seasonLocked } from "./freeze.ts";
import type { League, Round, Submission, Track } from "./types.ts";

type ScheduleLeague = Pick<League, "format" | "memberIds" | "h2hParticipants" | "h2hSalt">;

/** A song as voters see it before the reveal: the opaque submission id and
 *  the track — never the submitter, never their note. The one anonymizing
 *  mapper: the standard vote list (`listVotableSubmissions`) and the H2H
 *  matchups read both use it, so the two payloads can't drift. */
export interface AnonSong {
  id: string;
  track: Track;
}

export function anonymousSong(sub: Pick<Submission, "id" | "track">): AnonSong {
  return { id: sub.id, track: sub.track };
}

/** One player's slot in a matchup (or the bye), with their song if they have
 *  one this round. Server-side only — it names the player. */
export interface MatchupSide {
  userId: string;
  /** True when the player's song is withdrawn because they departed (left or
   *  were kicked) — judged per `departedParticipants`. HTH-07: a departed side
   *  takes no L; only the player who stayed banks the walkover W. */
  departed: boolean;
  /** The player's song; absent when they didn't submit or have departed. */
  submission?: Submission;
}

export interface RoundMatchup {
  /** `<roundId>~M<pairIndex>` (schedule.ts `matchupId`) — ballots key picks by it. */
  matchupId: string;
  a: MatchupSide;
  b: MatchupSide;
}

/** A round's derived matchups, in matchup-id order, plus the bye (odd fields
 *  only — absent for even ones). */
export interface RoundMatchupSet {
  matchups: RoundMatchup[];
  bye?: MatchupSide;
}

/** What a matchup is, by which sides have a song:
 *  - `contest`: both songs present — voters pick a winner;
 *  - `walkover`: exactly one song — its player wins without a vote;
 *  - `noContest`: neither — nobody gets a result.
 *  (HTH-07 turns these into outcomes; the bye is not a matchup at all.) */
export type MatchupState = "contest" | "walkover" | "noContest";

/** Is the round settled history (revealed or complete) rather than in play? */
export function roundSettled(round: Pick<Round, "status">): boolean {
  return round.status === "revealed" || round.status === "complete";
}

/**
 * The participants whose songs a round withdraws because they departed, by
 * default: while the round is in play, every frozen participant who isn't a
 * member now; once it's revealed, nobody (see the module header — a revealed
 * round is never re-judged against today's member list). Empty for standard
 * and un-frozen leagues. The one definition behind the matchups, the
 * anonymous song list's H2H filter (handlers/submissions.ts) and ballots.
 */
export function departedParticipants(league: ScheduleLeague, round: Pick<Round, "status">): Set<string> {
  if (!seasonLocked(league) || roundSettled(round)) return new Set();
  const members = new Set(league.memberIds);
  return new Set(league.h2hParticipants!.filter((id) => !members.has(id)));
}

export interface DeriveOptions {
  /** Override who counts as departed (songs withdrawn) — for HTH-07: the set
   *  pinned at the round's reveal, so a revealed round reads exactly as it
   *  was settled whatever the member list says later. Default:
   *  `departedParticipants(league, round)`. */
  departed?: Iterable<string>;
}

/**
 * Derive a round's matchups and attach each player's song.
 *
 * Empty (`{ matchups: [] }`) for a standard league or a head-to-head league
 * whose season hasn't frozen yet — there is no schedule to derive from. A
 * player with several submissions (impossible while H2H forces one song per
 * player, but hand-edited data must not crash reads) is represented by the
 * one with the smallest id, so every reader and both repositories pick the
 * same song.
 */
export function deriveRoundMatchups(
  league: ScheduleLeague,
  round: Pick<Round, "id" | "index" | "status">,
  submissions: readonly Submission[],
  options: DeriveOptions = {},
): RoundMatchupSet {
  if (!seasonLocked(league)) return { matchups: [] };

  const departedSet = new Set(options.departed ?? departedParticipants(league, round));
  const songByUser = new Map<string, Submission>();
  for (const sub of submissions) {
    const held = songByUser.get(sub.userId);
    if (!held || sub.id < held.id) songByUser.set(sub.userId, sub);
  }
  const side = (userId: string): MatchupSide => {
    const departed = departedSet.has(userId);
    const submission = departed ? undefined : songByUser.get(userId);
    return submission ? { userId, departed, submission } : { userId, departed };
  };

  // Already in pair-index (= matchup-id) order — matchupsForRound's contract.
  const scheduled = matchupsForRound(league.h2hParticipants!, round.id, round.index, league.h2hSalt);
  const matchups = scheduled.matchups.map((m) => ({ matchupId: m.matchupId, a: side(m.a), b: side(m.b) }));
  return scheduled.bye === undefined ? { matchups } : { matchups, bye: side(scheduled.bye) };
}

export function matchupState(m: RoundMatchup): MatchupState {
  const songs = Number(Boolean(m.a.submission)) + Number(Boolean(m.b.submission));
  return songs === 2 ? "contest" : songs === 1 ? "walkover" : "noContest";
}

/** Is `userId` one of the matchup's two players (song or not)? */
export function inMatchup(m: RoundMatchup, userId: string): boolean {
  return m.a.userId === userId || m.b.userId === userId;
}

/** The matchups `voterId` gets a pick in: every contest except their own.
 *  This is THE votable-set definition — ballot completeness (HTH-06), the
 *  tally (HTH-07) and the "who can still vote" checks (HTH-08) all use it.
 *  The set can shrink mid-voting: a departure turns a contest into a walkover
 *  after picks may already be cast in it, and my-ballot pre-fills those picks
 *  on a re-cast. So ballot validation (HTH-06) should drop picks on matchups
 *  outside this set (walkover / no-contest) rather than reject the ballot. */
export function votableMatchups(set: RoundMatchupSet, voterId: string): RoundMatchup[] {
  return set.matchups.filter((m) => matchupState(m) === "contest" && !inMatchup(m, voterId));
}

// ---- the voting-phase payload (GET /rounds/:roundId/matchups) --------------

/** One matchup as a viewer sees it: the two songs, anonymized, or `null` for
 *  a side without one (walkover; both null = no contest). `isMine` is the only
 *  identity signal: true when the viewer is one of the two players, so the UI
 *  can lock that matchup — the opponent stays anonymous. It follows the
 *  frozen schedule, not current membership: a player who has since left still
 *  matches their own matchup when they read a revealed round as a spectator;
 *  a spectator who never played never matches. */
export interface MatchupView {
  matchupId: string;
  a: AnonSong | null;
  b: AnonSong | null;
  isMine: boolean;
}

/** The round's matchups (sorted by matchup id) plus the bye player's
 *  exhibition song — `null` when the field is even or the bye player has no
 *  song. */
export interface RoundMatchupsView {
  matchups: MatchupView[];
  bye: AnonSong | null;
}

const songOf = (side: MatchupSide | undefined): AnonSong | null =>
  side?.submission ? anonymousSong(side.submission) : null;

/** The anonymized view of a derived set for one viewer (any user id; someone
 *  who isn't in the round's schedule simply never matches `isMine`). */
export function matchupsView(set: RoundMatchupSet, viewerId: string): RoundMatchupsView {
  return {
    matchups: [...set.matchups]
      .sort((x, y) => compareMatchupIds(x.matchupId, y.matchupId))
      .map((m) => ({ matchupId: m.matchupId, a: songOf(m.a), b: songOf(m.b), isMine: inMatchup(m, viewerId) })),
    bye: songOf(set.bye),
  };
}
