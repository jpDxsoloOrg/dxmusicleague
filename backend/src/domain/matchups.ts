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
//   - the tally and outcomes at reveal (HTH-07) — walkovers, no-contests, byes;
//   - the round's turnout (HTH-08) — who can still vote, for the completion %,
//     the voting panel and the everyone-voted advance.
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
// banked at reveal. The departed set that held AT the reveal isn't derivable
// from current data, so the reveal pins it on the round (`Round.h2hDeparted`,
// written by `finalizeReveal` in handlers/results.ts in the same conditional
// write that settles the round) and every later read withdraws exactly those
// songs: a revealed round reads exactly as it was settled. A revealed round
// without a pinned set (none exist outside hand-made data) withdraws nobody —
// every submitted song shows, as standard results do. See
// `departedParticipants`.
//
// Anonymity: the derived set carries submitter ids and stays server-side.
// `matchupsView` is the only shape that leaves the server before the reveal —
// songs as `AnonSong` (the same mapper the standard vote list uses) plus a
// per-viewer `isMine` flag, never the frozen order and never a user id.

import { compareMatchupIds, matchupsForRound } from "./schedule.ts";
import { seasonLocked } from "./freeze.ts";
import type { Ballot, League, Round, Submission, Track } from "./types.ts";

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

/**
 * The one order an anonymous song list goes out in: by submission id (code
 * units, never locale, so every runtime agrees). Returns a sorted copy; the
 * input is left as it was.
 *
 * Why not the order the songs were read in: repository order follows the
 * submitter. MemoryRepository reads in insertion order — submission time,
 * which the activity feed shows ("X submitted a song"); DynamoDB reads in
 * sort-key order, SK = `SUB#<userId>#<subId>` — submitter user id, the same
 * every round, so one revealed round maps every later list. Either way, the
 * position of a song names its owner, and in a head-to-head round the
 * matched-up song ids then name who plays whom before the reveal. Submission
 * ids are `sub-<random UUID>`, new every round and kept across a re-submit
 * (handlers/submissions.ts), so their order is stable within a round and says
 * nothing about who or when. Used by the anonymous vote list
 * (`listVotableSubmissions`), the round's public Spotify playlist
 * (`createPlaylistForRound`) and the frontend mock's vote lists.
 */
export function inAnonymousOrder<T extends { id: string }>(subs: readonly T[]): T[] {
  return [...subs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
 * member now; once it's revealed, exactly the set the reveal pinned on it
 * (`round.h2hDeparted`; nobody when unpinned) — a revealed round is never
 * re-judged against today's member list (see the module header). Empty for
 * standard and un-frozen leagues. The one definition behind the matchups, the
 * anonymous song list's H2H filter (handlers/submissions.ts), ballots and the
 * results (HTH-07).
 */
export function departedParticipants(
  league: ScheduleLeague,
  round: Pick<Round, "status" | "h2hDeparted">,
): Set<string> {
  if (!seasonLocked(league)) return new Set();
  if (roundSettled(round)) return new Set(round.h2hDeparted ?? []);
  const members = new Set(league.memberIds);
  return new Set(league.h2hParticipants!.filter((id) => !members.has(id)));
}

export interface DeriveOptions {
  /** Override who counts as departed (songs withdrawn). The reveal passes the
   *  set it is about to pin; HTH-06 passes `[]` to see the round as
   *  scheduled. Default: `departedParticipants(league, round)` — which
   *  already reads a revealed round's pinned set. */
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
  round: Pick<Round, "id" | "index" | "status" | "h2hDeparted">,
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
 *  on a re-cast. So ballot validation (`validateH2HBallot`, domain/rules.ts)
 *  never rejects a pick on a walkover / no-contest matchup: it keeps one made
 *  before a departure (so a rejoin restores it) and drops anything else.
 *  Count only picks in THIS set (as it stands at the reveal) — a stored
 *  ballot can hold inert picks outside it.
 *
 *  HTH-08 (completion %, everyone-voted): a ballot row is not proof of a
 *  vote. A member whose set is empty (e.g. both players of a two-player
 *  league) can still store a comments-only row, and a row cast while a
 *  player was departed has no pick in that pair if the player rejoins. So
 *  progress counts only voters whose set is non-empty, and only ballots
 *  that pick in all of it — see `votingTurnout`. */
export function votableMatchups(set: RoundMatchupSet, voterId: string): RoundMatchup[] {
  return set.matchups.filter((m) => matchupState(m) === "contest" && !inMatchup(m, voterId));
}

// ---- turnout: who a head-to-head round is waiting on (HTH-08) --------------
//
// Progression (the timed everyone-submitted / everyone-voted advance), the
// dashboard's completion % and the round's who-submitted / who-voted panels
// count people, and a head-to-head round counts them differently from a
// points round in two ways — the only format branches progression needs:
//
//   - Submitting: a member is done once they have a song. Only CURRENT
//     members' songs count: a departed player's song is withdrawn (their pair
//     plays as a walkover), so it must not stand in for a member who still
//     hasn't submitted — in H2H that member would lose by walkover the moment
//     the phase closed early.
//   - Voting: only members with something to vote on are waited for —
//     `votableMatchups` non-empty. A member with an empty set (both players of
//     a two-player league; the pair of a round's only contest) can never cast
//     a vote, so counting them would keep the round from ever finishing early
//     and the completion % from ever reaching 100. And a member counts as
//     voted only when their ballot picks in EVERY matchup they can vote in
//     now — exactly the picks the tally would count — so a comments-only row,
//     or a row cast before a departed player rejoined (their pair is a contest
//     again, with no pick in it), isn't mistaken for a vote.
//
// When nobody can vote at all (every pair a walkover / no contest, or a
// two-player league), the voting phase has nothing to wait for: the round
// goes straight to the reveal (handlers/progression.ts).
//
// Anonymity — the who-voted panel must not name who is eligible. Two or
// more contests give every member something to judge, and with none nobody
// can vote, so the case that matters is a round with exactly one contest:
// the members with nothing to vote on are then precisely that contest's
// pair. Naming the eligible voters (or marking the others "n/a") would name
// that pair, and with it the owner of every song outside the contest — the
// bye song, and any walkover song (a no-show is already named by the
// submissions panel) — while each of the two contest players would learn
// who their opponent is, i.e. who wrote the other song in their own matchup
// (in a three-player league, that attributes every song in the round). That
// is exactly what GET /matchups hides (`isMine` is its only identity signal,
// HTH-05). So unless every member is eligible, the panel names nobody but
// the viewer (`votingPanelNames`); the counts stay, since the number of
// eligible voters follows from the matchups payload anyway.
//
// The same goes for every other place that says who has cast a ballot: the
// activity feed's "cast their votes" entries. Next to a voted / eligible
// count, a named ballot is attributable from one snapshot — an entry that
// moved the count is an eligible voter's (in a three-player league, the bye
// player's), one that didn't is a contest player's comments-only row. So
// the rule is one predicate, `votersNameable`: while it's false, nobody but
// the viewer is named as having voted, in the panel or the feed
// (`ballotAuthorVisible`). What's left is the count itself, which names
// nobody. And while it's true, the feed names another member only once the
// panel shows them done (in `voted`). Every eligible voter must cast a
// complete ballot, so a row from a member the panel shows waiting was
// written while a departure had left them less to vote on (it's incomplete
// since the departed player rejoined), and a comments-only one while they
// had nothing at all — i.e. while they were in the round's only contest,
// which names them as its pair, e.g. the viewer's anonymous opponent
// (BUG-06). The feed's other-member entries are thus always the panel's
// done list (a departed voter is in neither, so their ballot is left out
// too): it never names more than the panel. Two residuals remain, both read
// across time. Names shown while every member could vote remain in a
// viewer's memory if a departure mid-voting then leaves a single contest,
// and the count after it can be read against them. And the reverse, after
// a rejoin: each feed entry carries its ballot's cast time (in its id and
// time-ago), which the panel doesn't. A done voter whose ballot was cast
// while the departed player was away must be that player's opponent, since
// anyone else would now have to pick in the restored matchup too. So whoever
// knows the absence window, the player who left and came back above all,
// can read the opponent from one snapshot. (Without the times, the panel's
// done list says the same when read against a look from before the leave.)

/** The current members who have a song in the round — a head-to-head
 *  round's submission phase is done when every member is in this set (one
 *  song each). In member order. */
export function membersWithSong(
  memberIds: readonly string[],
  submissions: ReadonlyArray<Pick<Submission, "userId">>,
): string[] {
  const submitted = new Set(submissions.map((s) => s.userId));
  return memberIds.filter((id) => submitted.has(id));
}

/** A head-to-head voting round's turnout. */
export interface VotingTurnout {
  /** The members with at least one matchup to pick in — the only voters
   *  the round waits for, in member order. Everyone else can still comment
   *  (a comments-only ballot), never vote. */
  eligible: string[];
  /** The eligible members whose ballot picks one of the two songs in every
   *  matchup they can vote in now. In member order. */
  voted: string[];
}

/**
 * Who can vote in the round and who has. `set` is the round as it stands —
 * departed players' songs withdrawn, as ballots are refereed (handlers
 * `loadRoundMatchups`); `memberIds` the league's current members (a departed
 * voter's ballot still counts at the tally, but nobody waits for them).
 */
export function votingTurnout(
  set: RoundMatchupSet,
  memberIds: readonly string[],
  ballots: ReadonlyArray<Pick<Ballot, "voterId" | "picks">>,
): VotingTurnout {
  const picksByVoter = new Map(ballots.map((b) => [b.voterId, b.picks ?? {}]));
  const eligible: string[] = [];
  const voted: string[] = [];
  for (const id of memberIds) {
    const votable = votableMatchups(set, id);
    if (votable.length === 0) continue;
    eligible.push(id);
    const picks = picksByVoter.get(id);
    const picked = (m: RoundMatchup) =>
      picks !== undefined &&
      Object.hasOwn(picks, m.matchupId) &&
      (picks[m.matchupId] === m.a.submission!.id || picks[m.matchupId] === m.b.submission!.id);
    if (votable.every(picked)) voted.push(id);
  }
  return { eligible, voted };
}

/** Has every member who can vote voted? True when nobody can vote at all:
 *  a round with nothing to vote on waits for nobody. */
export function everyoneEligibleVoted(turnout: VotingTurnout): boolean {
  return turnout.voted.length === turnout.eligible.length;
}

/**
 * The members a head-to-head who-voted panel may name to `viewerId`, in
 * member order (each then shown as done = in `turnout.voted`, or waiting).
 * When every current member can vote (two or more contests), that's everyone:
 * eligibility says nothing about who is in which matchup. Otherwise the
 * eligible set is "everyone but the only contest's pair", which would
 * deanonymize the bye / walkover songs and each contest player's opponent
 * (see "Anonymity" above), so the panel names only the viewer, and only if
 * they're eligible — something they already know from their own matchups.
 * The counts are sent either way. A member named in neither list therefore
 * has nothing to vote on this round (a comments-only ballot at most).
 */
export function votingPanelNames(turnout: VotingTurnout, memberIds: readonly string[], viewerId: string): string[] {
  if (votersNameable(turnout, memberIds)) return turnout.eligible;
  return turnout.eligible.filter((id) => id === viewerId);
}

/**
 * May a head-to-head voting round say who has voted? Only while every
 * current member can vote (`eligible` is a subset of `memberIds` in member
 * order, so equal length means equal). Otherwise the eligible voters are
 * "everyone but the only contest's pair" (or nobody), and any name tied to a
 * ballot gives that line away — see "Anonymity" above. The who-voted panel
 * (`votingPanelNames`) and the activity feed (`ballotAuthorVisible`) both
 * follow it.
 */
export function votersNameable(turnout: VotingTurnout, memberIds: readonly string[]): boolean {
  return turnout.eligible.length === memberIds.length;
}

/**
 * Whether a head-to-head voting round's activity feed may show `viewerId`
 * the "cast their votes" entry for `voterId`'s ballot: always their own;
 * another member's only while `votersNameable` AND once they're in
 * `turnout.voted` — exactly the names the who-voted panel shows as done, so
 * the feed never names more than the panel. (Its entries' cast times are
 * the one thing it adds; see the residuals under "Anonymity" above.)
 *
 * Without `votersNameable`, another member's entry next to the voted /
 * eligible count would say which side of the only contest they are on — in
 * a three-player league, who has the bye. And while everyone can vote, a row
 * from a member the panel shows waiting is just as telling: every eligible
 * voter must cast a complete ballot (`validateH2HBallot`), so a comments-only
 * row was written while its author had nothing to vote on — while a
 * departure had left their matchup the round's only contest — which names
 * them as its pair, e.g. the viewer's anonymous opponent (BUG-06). Those rows
 * are left out, as are rows left incomplete when a departed player rejoined
 * and departed voters' ballots (in neither panel list). Applies only while
 * the round is in voting; once it's revealed, so is everything else.
 */
export function ballotAuthorVisible(
  turnout: VotingTurnout,
  memberIds: readonly string[],
  viewerId: string,
  voterId: string,
): boolean {
  return voterId === viewerId || (votersNameable(turnout, memberIds) && turnout.voted.includes(voterId));
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

// ---- reading the view back (the vote page, HTH-10) -------------------------
// The vote page only ever holds the anonymous view, yet its submit gate must
// demand exactly what `validateH2HBallot` will: a pick in every votable
// matchup. These read that off the view alone (`isMine` + which songs are
// present), and for the viewer a view was built for they agree with
// `votableMatchups` by construction (`isMine` IS `inMatchup`, and a side's
// song is null exactly when the side has none) — matchups.test.ts pins it.
// Structural types, so the frontend's own view-model types (src/data/mock.ts)
// fit them as they are.

/** The parts of a matchup view the helpers below read. */
export interface PickableMatchupView {
  matchupId: string;
  a: { id: string } | null;
  b: { id: string } | null;
  isMine: boolean;
}

/** `matchupState` read off a view: by which songs the payload carries. */
export function viewMatchupState(m: Pick<PickableMatchupView, "a" | "b">): MatchupState {
  const songs = Number(m.a !== null) + Number(m.b !== null);
  return songs === 2 ? "contest" : songs === 1 ? "walkover" : "noContest";
}

/** Can the viewer pick a winner here? A contest that isn't their own — the
 *  view's twin of `votableMatchups`. */
export function canPickInView(m: PickableMatchupView): boolean {
  return !m.isMine && viewMatchupState(m) === "contest";
}

/** The pick a ballot holds for a matchup, if it is one of the matchup's two
 *  songs (a stale or foreign id is no pick). */
export function viewPick(m: PickableMatchupView, picks: Readonly<Record<string, string>>): string | undefined {
  const pick = Object.hasOwn(picks, m.matchupId) ? picks[m.matchupId] : undefined;
  return pick !== undefined && (pick === m.a?.id || pick === m.b?.id) ? pick : undefined;
}

/** How far a ballot is against a view: the matchups the viewer must pick in
 *  (`votable`) and how many of those hold a valid pick (`picked`). Picks
 *  anywhere else — the viewer's own matchup, a walkover, an id that isn't one
 *  of the pair's songs — count for nothing. Complete when they're equal (a
 *  viewer with nothing votable is complete at 0 of 0, as the referee agrees). */
export function viewPickProgress(
  view: { matchups: readonly PickableMatchupView[] },
  picks: Readonly<Record<string, string>>,
): { votable: number; picked: number } {
  const votable = view.matchups.filter(canPickInView);
  return { votable: votable.length, picked: votable.filter((m) => viewPick(m, picks) !== undefined).length };
}
