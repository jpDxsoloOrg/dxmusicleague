// Matchup derivation unit tests — pure, no infra. Run: `npm test`.
// Proves the one shared derivation every H2H reader uses (HTH-05 read API,
// HTH-06 ballots, HTH-07 tally): pairings come from the frozen order + salt,
// each side gets its player's song, a departed player's song is withdrawn
// while the round is in play (never re-judged once it's revealed: it reads
// the departed set the reveal pinned on it, HTH-07), the walkover /
// no-contest / votable definitions, that the anonymized view carries songs
// and `isMine` but never a user id or the frozen order, the round's turnout
// (HTH-08): who can vote and who has, and whom the who-voted panel and the
// activity feed may name as having voted — and that the vote page's view-side
// helpers (HTH-10) read the same votable set off that view as the ballot
// referee demands. BUG-01: anonymous song lists come out in submission-id
// order (`inAnonymousOrder`), and the matchups view never follows the order
// the repository read the submissions in.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anonymousSong,
  ballotAuthorVisible,
  canPickInView,
  departedParticipants,
  deriveRoundMatchups,
  everyoneEligibleVoted,
  inAnonymousOrder,
  inMatchup,
  matchupState,
  matchupsView,
  membersWithSong,
  viewMatchupState,
  viewPick,
  viewPickProgress,
  votableMatchups,
  votersNameable,
  votingPanelNames,
  votingTurnout,
} from "./matchups.ts";
import { validateH2HBallot } from "./rules.ts";
import type { RoundMatchup, RoundMatchupSet } from "./matchups.ts";
import { matchupsForRound } from "./schedule.ts";
import type { League, Submission } from "./types.ts";

const ROUND = { id: "lg~0001", index: 1, status: "voting" as const };
const SALT = "0123456789abcdef0123456789abcdef";
const FIVE = ["u-ana", "u-ben", "u-cyd", "u-dot", "u-eli"];

type FrozenLeague = Pick<League, "format" | "memberIds" | "h2hParticipants" | "h2hSalt">;
const frozen = (over: Partial<FrozenLeague> = {}): FrozenLeague => ({
  format: "headToHead", memberIds: [...FIVE], h2hParticipants: [...FIVE], h2hSalt: SALT, ...over,
});

const sub = (userId: string, id = `sub-${userId.slice(2)}`): Submission => ({
  id, roundId: ROUND.id, userId, comment: "a submitter note",
  track: { id: `mock-${id}`, provider: "mock", providerTrackId: `p-${id}`, title: `Song ${id}`, artists: [`Artist ${id}`] },
});

/** The derived pairing for ROUND, independent of the code under test's attach step. */
const schedule = (participants = FIVE) => matchupsForRound(participants, ROUND.id, ROUND.index, SALT);

test("derives the schedule's pairs (order + salt + round index) and attaches each player's song", () => {
  const subs = FIVE.map((id) => sub(id));
  const set = deriveRoundMatchups(frozen(), ROUND, subs);
  const expected = schedule();

  assert.deepEqual(set.matchups.map((m) => [m.matchupId, m.a.userId, m.b.userId]), expected.matchups.map((m) => [m.matchupId, m.a, m.b]));
  assert.equal(set.bye?.userId, expected.bye);
  for (const m of set.matchups) {
    assert.equal(m.a.submission?.userId, m.a.userId);
    assert.equal(m.b.submission?.userId, m.b.userId);
    assert.equal(m.a.departed || m.b.departed, false);
  }
  assert.equal(set.bye?.submission?.userId, expected.bye);
  // Salt matters: a different salt is a different (valid) presentation.
  const unsalted = deriveRoundMatchups(frozen({ h2hSalt: undefined }), ROUND, subs);
  assert.deepEqual(unsalted.matchups.map((m) => [m.a.userId, m.b.userId]), matchupsForRound(FIVE, ROUND.id, 1).matchups.map((m) => [m.a, m.b]));
  // Deterministic: deriving twice gives the identical set.
  assert.deepEqual(deriveRoundMatchups(frozen(), ROUND, subs), set);
});

test("no schedule → no matchups: standard leagues and un-frozen H2H leagues derive an empty set", () => {
  const subs = FIVE.map((id) => sub(id));
  assert.deepEqual(deriveRoundMatchups(frozen({ format: "standard" }), ROUND, subs), { matchups: [] });
  assert.deepEqual(deriveRoundMatchups(frozen({ h2hParticipants: undefined, h2hSalt: undefined }), ROUND, subs), { matchups: [] });
  assert.deepEqual(deriveRoundMatchups(frozen({ h2hParticipants: [] }), ROUND, subs), { matchups: [] });
});

test("a player without a song: no submission → empty side; departed player's song is withdrawn", () => {
  const { matchups, bye } = schedule();
  const [first, second] = matchups;
  // first.a never submitted; second.b submitted but has since left the league.
  const subs = FIVE.filter((id) => id !== first!.a).map((id) => sub(id));
  const set = deriveRoundMatchups(frozen({ memberIds: FIVE.filter((id) => id !== second!.b) }), ROUND, subs);

  const m0 = set.matchups[0]!;
  assert.deepEqual(m0.a, { userId: first!.a, departed: false });
  assert.equal(m0.b.submission?.userId, first!.b);
  const m1 = set.matchups[1]!;
  assert.equal(m1.a.submission?.userId, second!.a);
  assert.deepEqual(m1.b, { userId: second!.b, departed: true }); // song withdrawn
  assert.equal(set.bye?.submission?.userId, bye);

  // Departed bye player: the exhibition song goes too.
  const byeGone = deriveRoundMatchups(frozen({ memberIds: FIVE.filter((id) => id !== bye) }), ROUND, FIVE.map((id) => sub(id)));
  assert.deepEqual(byeGone.bye, { userId: bye, departed: true });

  // Rejoining puts the song back while the round is in play.
  assert.equal(deriveRoundMatchups(frozen(), ROUND, subs).matchups[1]!.b.submission?.userId, second!.b);
});

test("a revealed round is never re-judged against today's member list; a pinned departed set overrides", () => {
  const { matchups, bye } = schedule();
  const leaver = matchups[1]!.b;
  const subs = FIVE.map((id) => sub(id));
  const before = deriveRoundMatchups(frozen(), { ...ROUND, status: "revealed" }, subs);

  // A player leaves after the reveal: the settled round reads exactly as before.
  const gone = frozen({ memberIds: FIVE.filter((id) => id !== leaver && id !== bye) });
  for (const status of ["revealed", "complete"] as const) {
    assert.deepEqual(deriveRoundMatchups(gone, { ...ROUND, status }, subs), before, status);
    assert.equal(departedParticipants(gone, { status }).size, 0, status);
  }
  // ...while a round still in play withdraws both departed songs.
  for (const status of ["submitting", "previewing", "voting"] as const) {
    assert.deepEqual([...departedParticipants(gone, { status })].sort(), [leaver, bye].sort(), status);
  }
  assert.equal(deriveRoundMatchups(gone, ROUND, subs).matchups[1]!.b.submission, undefined);

  // HTH-07's pin: the set that held at the reveal wins over current membership
  // either way — a departure pinned at reveal stays withdrawn even after the
  // player rejoins, and nobody else is withdrawn.
  const pinned = deriveRoundMatchups(frozen(), { ...ROUND, status: "revealed" }, subs, { departed: [leaver] });
  assert.deepEqual(pinned.matchups[1]!.b, { userId: leaver, departed: true });
  assert.equal(pinned.matchups[0]!.a.submission?.userId, matchups[0]!.a);
  assert.equal(pinned.bye?.submission?.userId, bye);
  assert.equal(deriveRoundMatchups(gone, ROUND, subs, { departed: [] }).matchups[1]!.b.submission?.userId, leaver);

  // Standard and un-frozen leagues have no participants to withdraw.
  assert.equal(departedParticipants(frozen({ format: "standard", memberIds: [] }), ROUND).size, 0);
  assert.equal(departedParticipants(frozen({ h2hParticipants: undefined, memberIds: [] }), ROUND).size, 0);
});

test("the reveal's pin on the round (h2hDeparted) is what a revealed round withdraws by default — whatever membership says later", () => {
  const { matchups, bye } = schedule();
  const leaver = matchups[1]!.b;
  const subs = FIVE.map((id) => sub(id));
  const revealed = { ...ROUND, status: "revealed" as const, h2hDeparted: [leaver] };

  // The leaver has since rejoined (full member list) — still withdrawn, nobody else is.
  assert.deepEqual([...departedParticipants(frozen(), revealed)], [leaver]);
  const set = deriveRoundMatchups(frozen(), revealed, subs);
  assert.deepEqual(set.matchups[1]!.b, { userId: leaver, departed: true });
  assert.equal(set.bye?.submission?.userId, bye);
  // Identical to passing the pinned set explicitly.
  assert.deepEqual(set, deriveRoundMatchups(frozen(), { ...ROUND, status: "revealed" }, subs, { departed: [leaver] }));
  // Someone else leaves after the reveal: the pinned set still decides.
  const later = frozen({ memberIds: FIVE.filter((id) => id !== bye) });
  assert.deepEqual(deriveRoundMatchups(later, revealed, subs), set);
  // An empty pin = nobody withdrawn; a round in play ignores any pin and judges current membership.
  assert.equal(departedParticipants(later, { ...revealed, h2hDeparted: [] }).size, 0);
  assert.deepEqual([...departedParticipants(later, { ...revealed, status: "voting" })], [bye]);
  // No schedule, nothing to withdraw — a pin on a standard round is ignored.
  assert.equal(departedParticipants(frozen({ format: "standard" }), revealed).size, 0);
});

test("a player with several submissions (hand-edited data) is represented by the smallest id, whatever the read order", () => {
  const extra = [sub("u-ana", "sub-zz"), sub("u-ana", "sub-aa"), sub("u-ana", "sub-mm")];
  const rest = FIVE.slice(1).map((id) => sub(id));
  for (const subs of [[...extra, ...rest], [...rest, ...extra].reverse()]) {
    const set = deriveRoundMatchups(frozen(), ROUND, subs);
    const sides = [...set.matchups.flatMap((m) => [m.a, m.b]), ...(set.bye ? [set.bye] : [])];
    assert.equal(sides.find((s) => s.userId === "u-ana")?.submission?.id, "sub-aa");
  }
});

const side = (userId: string, song: boolean) => (song ? { userId, departed: false, submission: sub(userId) } : { userId, departed: false });
const m = (i: number, a: [string, boolean], b: [string, boolean]): RoundMatchup => ({
  matchupId: `${ROUND.id}~M${i}`, a: side(...a), b: side(...b),
});

test("matchupState: both songs = contest, one = walkover, none = noContest", () => {
  assert.equal(matchupState(m(0, ["u-ana", true], ["u-ben", true])), "contest");
  assert.equal(matchupState(m(0, ["u-ana", true], ["u-ben", false])), "walkover");
  assert.equal(matchupState(m(0, ["u-ana", false], ["u-ben", true])), "walkover");
  assert.equal(matchupState(m(0, ["u-ana", false], ["u-ben", false])), "noContest");
});

test("votableMatchups: every contest except the voter's own; walkovers and no-contests take no votes", () => {
  const set: RoundMatchupSet = {
    matchups: [
      m(0, ["u-ana", true], ["u-ben", true]),
      m(1, ["u-cyd", true], ["u-dot", false]),
      m(2, ["u-eli", true], ["u-fay", true]),
      m(3, ["u-gus", false], ["u-hal", false]),
    ],
    bye: side("u-ivy", true),
  };
  const ids = (voter: string) => votableMatchups(set, voter).map((x) => x.matchupId.slice(-2));
  assert.deepEqual(ids("u-ana"), ["M2"]); // not their own
  assert.deepEqual(ids("u-cyd"), ["M0", "M2"]); // own walkover is no loss of options
  assert.deepEqual(ids("u-ivy"), ["M0", "M2"]); // the bye player votes on every contest
  assert.deepEqual(ids("u-gus"), ["M0", "M2"]);
  assert.equal(inMatchup(set.matchups[1]!, "u-dot"), true); // song or not, still in it
  assert.equal(inMatchup(set.matchups[1]!, "u-ana"), false);
});

test("matchupsView: anonymized songs (id + track only), null for missing sides, isMine per viewer, sorted by matchup id", () => {
  // Out of order on purpose, with 11+ pairs' worth of ids: M10 must sort after M2.
  const set: RoundMatchupSet = {
    matchups: [
      m(10, ["u-ana", true], ["u-ben", false]),
      m(2, ["u-cyd", false], ["u-dot", false]),
      m(0, ["u-eli", true], ["u-fay", true]),
    ],
    bye: side("u-gus", true),
  };
  const view = matchupsView(set, "u-ben");
  assert.deepEqual(view.matchups.map((x) => x.matchupId), [`${ROUND.id}~M0`, `${ROUND.id}~M2`, `${ROUND.id}~M10`]);
  assert.deepEqual(view.matchups.map((x) => x.isMine), [false, false, true]);
  assert.deepEqual(view.matchups[0]!.a, anonymousSong(sub("u-eli")));
  assert.deepEqual(Object.keys(view.matchups[0]!.a!).sort(), ["id", "track"]);
  assert.equal(view.matchups[1]!.a, null);
  assert.equal(view.matchups[1]!.b, null);
  assert.equal(view.matchups[2]!.b, null);
  assert.deepEqual(view.bye, anonymousSong(sub("u-gus")));
  // A spectator (or anyone outside the pairs) never matches; isMine follows
  // the schedule, so a player whose side has no song (didn't submit, or
  // withdrawn after leaving) still matches theirs.
  assert.ok(matchupsView(set, "u-zed").matchups.every((x) => !x.isMine));
  assert.deepEqual(matchupsView(set, "u-dot").matchups.map((x) => x.isMine), [false, true, false]);
  // No identity on the wire: no user id, no submitter note.
  const json = JSON.stringify(view);
  for (const id of ["u-ana", "u-ben", "u-cyd", "u-dot", "u-eli", "u-fay", "u-gus"]) assert.ok(!json.includes(`"${id}"`), id);
  assert.ok(!json.includes("submitter note"));
  assert.deepEqual(matchupsView({ matchups: [] }, "u-ana"), { matchups: [], bye: null });
});

// ---- BUG-01: the order of an anonymous list names nobody -------------------

test("inAnonymousOrder: a copy sorted by submission id (code-unit order, never locale), every element kept, input untouched", () => {
  // Read order deliberately unrelated to the ids; one upper-case id pins the
  // comparison to code units ("sub-B…" < "sub-a…"), so every runtime agrees.
  const rows = [sub("u-dot", "sub-c41f"), sub("u-ben", "sub-e07a"), sub("u-eli", "sub-0d93"), sub("u-cyd", "sub-a3f8"), sub("u-ana", "sub-B9a6")];
  const before = structuredClone(rows);
  const sorted = inAnonymousOrder(rows);
  assert.deepEqual(sorted.map((s) => s.id), ["sub-0d93", "sub-B9a6", "sub-a3f8", "sub-c41f", "sub-e07a"]);
  assert.deepEqual(rows, before, "the input array is not reordered or changed");
  assert.notEqual(sorted, rows);
  // The same elements (by reference): nothing dropped, added or copied.
  assert.equal(sorted.length, rows.length);
  for (const row of rows) assert.ok(sorted.includes(row), row.id);
  // Whatever order the repository hands back, the output is the same.
  assert.deepEqual(inAnonymousOrder([...rows].reverse()), sorted);
  assert.deepEqual(inAnonymousOrder([rows[3]!, rows[0]!, rows[4]!, rows[2]!, rows[1]!]), sorted);
  // Works on the anonymized shape as well (the frontend mock's canned list).
  assert.deepEqual(inAnonymousOrder(rows.map(anonymousSong)), sorted.map(anonymousSong));
  assert.deepEqual(inAnonymousOrder([]), []);
});

test("matchupsView doesn't depend on the order the submissions were read in: sides come from the salted pairing, matchups sort by id", () => {
  // The submission ids sort in a different order from the players.
  const subs = FIVE.map((id, i) => sub(id, `sub-${["q7", "c2", "x9", "a4", "m1"][i]}`));
  const view = (rows: Submission[]) => matchupsView(deriveRoundMatchups(frozen(), ROUND, rows), "u-cyd");
  const expected = view(subs);
  for (const rows of [[...subs].reverse(), inAnonymousOrder(subs), [subs[2]!, subs[4]!, subs[0]!, subs[3]!, subs[1]!]]) {
    assert.deepEqual(view(rows), expected, rows.map((s) => s.id).join(","));
  }
});

// ---- turnout (HTH-08): who a round waits on --------------------------------

test("membersWithSong: current members with a song, in member order — a departed player's song doesn't count, nor does a second row", () => {
  const subs = [sub("u-eli"), sub("u-ana"), sub("u-ana", "sub-ana-2"), sub("u-zed")]; // u-zed has left
  assert.deepEqual(membersWithSong(FIVE, subs), ["u-ana", "u-eli"]);
  assert.deepEqual(membersWithSong(FIVE, []), []);
  assert.deepEqual(membersWithSong([], subs), []);
});

test("votingTurnout: eligible = members with a matchup to pick in; voted = picked one of the two songs in every one of them", () => {
  const set: RoundMatchupSet = {
    matchups: [m(0, ["u-ana", true], ["u-ben", true]), m(1, ["u-cyd", true], ["u-dot", true])],
    bye: side("u-eli", true),
  };
  const [m0, m1] = set.matchups.map((x) => x.matchupId) as [string, string];
  const pick = (matchupId: string, userId: string) => [matchupId, `sub-${userId.slice(2)}`] as const;
  const turnout = votingTurnout(set, FIVE, [
    { voterId: "u-eli", picks: Object.fromEntries([pick(m0, "u-ana"), pick(m1, "u-dot")]) }, // bye: both contests
    { voterId: "u-ana", picks: Object.fromEntries([pick(m1, "u-cyd")]) }, // all of theirs
    { voterId: "u-ben" }, // comments-only row: no picks at all
    { voterId: "u-cyd", picks: Object.fromEntries([pick(m0, "u-eli")]) }, // not one of the pair's songs
    // u-dot: no ballot
  ]);
  assert.deepEqual(turnout.eligible, FIVE, "everyone has a contest to judge");
  assert.deepEqual(turnout.voted, ["u-ana", "u-eli"]);
  assert.equal(everyoneEligibleVoted(turnout), false);
  // The bye player missing one of their two picks hasn't voted.
  const partial = votingTurnout(set, ["u-eli"], [{ voterId: "u-eli", picks: Object.fromEntries([pick(m0, "u-ben")]) }]);
  assert.deepEqual(partial, { eligible: ["u-eli"], voted: [] });
  // A departed voter's ballot is nobody's vote here (the tally still counts it).
  assert.deepEqual(votingTurnout(set, ["u-ana"], [{ voterId: "u-zed", picks: Object.fromEntries([pick(m1, "u-cyd")]) }]).voted, []);
});

test("votingTurnout: the pair of the round's only contest has nothing to vote on — left out, their comments-only row is no vote; nobody able to vote → everyoneEligibleVoted", () => {
  const set: RoundMatchupSet = {
    matchups: [m(0, ["u-ana", true], ["u-ben", true]), m(1, ["u-cyd", true], ["u-dot", false])],
    bye: side("u-eli", false),
  };
  const m0 = set.matchups[0]!.matchupId;
  const ballots = [{ voterId: "u-ana" }, { voterId: "u-ben", picks: {} }];
  const t = votingTurnout(set, FIVE, ballots);
  assert.deepEqual(t, { eligible: ["u-cyd", "u-dot", "u-eli"], voted: [] });
  const done = votingTurnout(set, FIVE, [
    ...ballots,
    ...["u-cyd", "u-dot", "u-eli"].map((voterId) => ({ voterId, picks: { [m0]: "sub-ben" } })),
  ]);
  assert.deepEqual(done.voted, ["u-cyd", "u-dot", "u-eli"]);
  assert.equal(everyoneEligibleVoted(done), true);

  // All walkovers / no contests: nobody can vote, so nobody is waited for.
  const dead: RoundMatchupSet = { matchups: [m(0, ["u-ana", true], ["u-ben", false]), m(1, ["u-cyd", false], ["u-dot", false])] };
  assert.deepEqual(votingTurnout(dead, FIVE, []), { eligible: [], voted: [] });
  assert.equal(everyoneEligibleVoted(votingTurnout(dead, FIVE, [])), true);
  // A two-player league: the one matchup is both players' own.
  const duo: RoundMatchupSet = { matchups: [m(0, ["u-ana", true], ["u-ben", true])] };
  assert.deepEqual(votingTurnout(duo, ["u-ana", "u-ben"], [{ voterId: "u-ana", picks: {} }]), { eligible: [], voted: [] });
});

test("votingTurnout over derived rounds: a departure shrinks a voter's set (an earlier full ballot still counts); a rejoin restores a contest the ballot never picked in (not voted until re-cast)", () => {
  const subs = FIVE.map((id) => sub(id));
  const { matchups, bye } = schedule();
  const [first, second] = matchups as [{ matchupId: string; a: string; b: string }, { matchupId: string; a: string; b: string }];
  const songOf = (id: string) => `sub-${id.slice(2)}`;

  // Everyone a member: the bye player picks in both contests.
  const full = deriveRoundMatchups(frozen(), ROUND, subs);
  const byeBallot = { voterId: bye!, picks: { [first.matchupId]: songOf(first.a), [second.matchupId]: songOf(second.b) } };
  assert.ok(votingTurnout(full, FIVE, [byeBallot]).voted.includes(bye!));

  // first.b leaves mid-voting: their pair is a walkover, the bye now has one
  // matchup to pick in, and the ballot they already cast still covers it.
  const members = FIVE.filter((id) => id !== first.b);
  const shrunk = deriveRoundMatchups(frozen({ memberIds: members }), ROUND, subs);
  const t = votingTurnout(shrunk, members, [byeBallot]);
  assert.ok(t.voted.includes(bye!));
  assert.equal(t.eligible.includes(first.b), false, "a departed player is nobody the round waits for");
  assert.equal(t.eligible.includes(second.a), false, "their set emptied: the only contest left is their own");

  // A ballot cast while first.b was gone has no pick in their pair; once they
  // rejoin, the pair is a contest again and that ballot no longer covers it.
  const castWhileGone = { voterId: bye!, picks: { [second.matchupId]: songOf(second.a) } };
  assert.ok(votingTurnout(shrunk, members, [castWhileGone]).voted.includes(bye!));
  const rejoined = votingTurnout(full, FIVE, [castWhileGone]);
  assert.ok(rejoined.eligible.includes(bye!));
  assert.equal(rejoined.voted.includes(bye!), false, "must re-cast to pick in the restored contest");
});

test("votingPanelNames: everyone eligible (two+ contests) → every member named; one contest → only the viewer, if eligible, so the bye / walkover songs and the contest's pair stay anonymous", () => {
  const two: RoundMatchupSet = {
    matchups: [m(0, ["u-ana", true], ["u-ben", true]), m(1, ["u-cyd", true], ["u-dot", true])],
    bye: side("u-eli", true),
  };
  const all = votingTurnout(two, FIVE, []);
  for (const viewer of [...FIVE, "u-zed"]) assert.deepEqual(votingPanelNames(all, FIVE, viewer), FIVE, viewer);

  // One contest (ana–ben) plus a walkover and the bye: cyd, dot and eli can
  // vote; naming them would say ana and ben are the contest's pair.
  const one: RoundMatchupSet = {
    matchups: [m(0, ["u-ana", true], ["u-ben", true]), m(1, ["u-cyd", true], ["u-dot", false])],
    bye: side("u-eli", true),
  };
  const t = votingTurnout(one, FIVE, []);
  assert.deepEqual(t.eligible, ["u-cyd", "u-dot", "u-eli"]);
  assert.deepEqual(votingPanelNames(t, FIVE, "u-eli"), ["u-eli"]);
  assert.deepEqual(votingPanelNames(t, FIVE, "u-dot"), ["u-dot"]);
  assert.deepEqual(votingPanelNames(t, FIVE, "u-ana"), [], "the contest's pair: nothing to vote on, in neither list");
  assert.deepEqual(votingPanelNames(t, FIVE, "u-zed"), [], "a spectator");

  // Nobody can vote: nobody is named.
  const dead: RoundMatchupSet = { matchups: [m(0, ["u-ana", true], ["u-ben", false])] };
  assert.deepEqual(votingPanelNames(votingTurnout(dead, ["u-ana", "u-ben"], []), ["u-ana", "u-ben"], "u-ana"), []);
});

test("ballotAuthorVisible: the feed names other members' ballots only while everyone can vote (votersNameable); otherwise each viewer sees just their own — a three-player round's bye voter isn't attributable", () => {
  const two: RoundMatchupSet = {
    matchups: [m(0, ["u-ana", true], ["u-ben", true]), m(1, ["u-cyd", true], ["u-dot", true])],
    bye: side("u-eli", true),
  };
  const all = votingTurnout(two, FIVE, []);
  assert.equal(votersNameable(all, FIVE), true);
  for (const viewer of [...FIVE, "u-zed"]) {
    for (const voter of [...FIVE, "u-zed"]) assert.equal(ballotAuthorVisible(all, FIVE, viewer, voter), true, `${viewer} sees ${voter}`);
  }

  // Three players: one contest (ana–ben) and eli's bye. Only eli can vote, so
  // eli's entry next to "1 of 1" would say eli has the bye; ana's comments-only
  // entry next to "0 of 1" would say ana is in the contest.
  const TRIO = ["u-ana", "u-ben", "u-eli"];
  const trio: RoundMatchupSet = { matchups: [m(0, ["u-ana", true], ["u-ben", true])], bye: side("u-eli", true) };
  const t = votingTurnout(trio, TRIO, [{ voterId: "u-eli", picks: { [trio.matchups[0]!.matchupId]: "sub-ana" } }, { voterId: "u-ana" }]);
  assert.deepEqual(t, { eligible: ["u-eli"], voted: ["u-eli"] });
  assert.equal(votersNameable(t, TRIO), false);
  for (const viewer of [...TRIO, "u-zed"]) {
    for (const voter of TRIO) {
      assert.equal(ballotAuthorVisible(t, TRIO, viewer, voter), viewer === voter, `${viewer} sees ${voter}'s ballot?`);
    }
  }
  // A departed voter's ballot is no exception.
  assert.equal(ballotAuthorVisible(t, TRIO, "u-ben", "u-gone"), false);

  // Nobody can vote: only one's own ballot.
  const dead: RoundMatchupSet = { matchups: [m(0, ["u-ana", true], ["u-ben", false])] };
  const none = votingTurnout(dead, ["u-ana", "u-ben"], [{ voterId: "u-ben" }]);
  assert.equal(votersNameable(none, ["u-ana", "u-ben"]), false);
  assert.equal(ballotAuthorVisible(none, ["u-ana", "u-ben"], "u-ana", "u-ben"), false);
  assert.equal(ballotAuthorVisible(none, ["u-ana", "u-ben"], "u-ben", "u-ben"), true);
});

// ---- the vote page's view-side helpers (HTH-10) ----------------------------

/** Every user id a view can be built for in `set`: its players, the bye, and
 *  a spectator who isn't in the round at all. */
const viewers = (set: RoundMatchupSet): string[] => [
  ...set.matchups.flatMap((x) => [x.a.userId, x.b.userId]),
  ...(set.bye ? [set.bye.userId] : []),
  "u-zed",
];

test("view helpers: the matchups a view offers a pick in are exactly votableMatchups for its viewer, and the state reads the same", () => {
  const handMade: RoundMatchupSet = {
    matchups: [
      m(0, ["u-ana", true], ["u-ben", true]),
      m(1, ["u-cyd", true], ["u-dot", false]),
      m(2, ["u-eli", true], ["u-fay", true]),
      m(3, ["u-gus", false], ["u-hal", false]),
    ],
    bye: side("u-ivy", true),
  };
  // A real derived round too: one player never submitted, one has left.
  const { matchups: pairs } = schedule();
  const derived = deriveRoundMatchups(
    frozen({ memberIds: FIVE.filter((id) => id !== pairs[1]!.b) }),
    ROUND,
    FIVE.filter((id) => id !== pairs[0]!.a).map((id) => sub(id)),
  );
  for (const set of [handMade, derived]) {
    for (const viewer of viewers(set)) {
      const view = matchupsView(set, viewer);
      assert.deepEqual(
        view.matchups.filter(canPickInView).map((x) => x.matchupId),
        votableMatchups(set, viewer).map((x) => x.matchupId),
        viewer,
      );
      for (const x of view.matchups) {
        const source = set.matchups.find((y) => y.matchupId === x.matchupId)!;
        assert.equal(viewMatchupState(x), matchupState(source));
      }
    }
  }
  // Own contest: locked. Own walkover / anyone's no contest: nothing to pick.
  const ana = matchupsView(handMade, "u-ana").matchups;
  assert.deepEqual(ana.map(canPickInView), [false, false, true, false]);
  assert.deepEqual(ana.map(viewMatchupState), ["contest", "walkover", "contest", "noContest"]);
});

test("viewPickProgress: counts valid picks in votable matchups only — the gate the vote page holds submit behind", () => {
  const set: RoundMatchupSet = {
    matchups: [
      m(0, ["u-ana", true], ["u-ben", true]),
      m(1, ["u-cyd", true], ["u-dot", false]),
      m(2, ["u-eli", true], ["u-fay", true]),
    ],
    bye: side("u-ivy", true),
  };
  const id = (i: number) => `${ROUND.id}~M${i}`;
  const bye = matchupsView(set, "u-ivy"); // votes on both contests
  assert.deepEqual(viewPickProgress(bye, {}), { votable: 2, picked: 0 });
  assert.deepEqual(viewPickProgress(bye, { [id(0)]: "sub-ana" }), { votable: 2, picked: 1 }); // partial
  assert.deepEqual(viewPickProgress(bye, { [id(0)]: "sub-ana", [id(2)]: "sub-fay" }), { votable: 2, picked: 2 }); // full
  // Foreign / stale ids and picks on the walkover count for nothing.
  assert.deepEqual(viewPickProgress(bye, { [id(0)]: "sub-eli", [id(1)]: "sub-cyd", [id(2)]: "nope" }), { votable: 2, picked: 0 });
  assert.equal(viewPick(bye.matchups[0]!, { [id(0)]: "sub-ben" }), "sub-ben");
  assert.equal(viewPick(bye.matchups[0]!, { [id(0)]: "sub-fay" }), undefined);
  assert.equal(viewPick(bye.matchups[0]!, {}), undefined);
  // A pick on the viewer's own matchup never counts toward the gate.
  const ana = matchupsView(set, "u-ana");
  assert.deepEqual(viewPickProgress(ana, { [id(0)]: "sub-ana" }), { votable: 1, picked: 0 });
  assert.deepEqual(viewPickProgress(ana, { [id(0)]: "sub-ana", [id(2)]: "sub-eli" }), { votable: 1, picked: 1 });
  // Nothing votable (a two-player league): complete at 0 of 0.
  const duo: RoundMatchupSet = { matchups: [m(0, ["u-ana", true], ["u-ben", true])] };
  assert.deepEqual(viewPickProgress(matchupsView(duo, "u-ana"), {}), { votable: 0, picked: 0 });
});

test("viewPickProgress agrees with validateH2HBallot: complete by the gate ⇔ accepted by the referee", () => {
  const { matchups: pairs } = schedule();
  // Five players, one never submitted (their pair is a walkover), so voters
  // differ: the bye player picks in every contest, a paired player in all but
  // their own, the walkover's players in every contest.
  const set = deriveRoundMatchups(frozen(), ROUND, FIVE.filter((id) => id !== pairs[0]!.a).map((id) => sub(id)));
  let dropped = 0;
  for (const viewer of FIVE) {
    const view = matchupsView(set, viewer);
    const full: Record<string, string> = {};
    for (const x of view.matchups.filter(canPickInView)) full[x.matchupId] = x.b!.id;
    const progress = viewPickProgress(view, full);
    assert.equal(progress.picked, progress.votable, viewer);
    assert.deepEqual(validateH2HBallot(full, set, viewer), full, viewer);
    // Drop any one pick: the gate blocks it, and so does the referee.
    for (const matchupId of Object.keys(full)) {
      const { [matchupId]: _dropped, ...partial } = full;
      assert.equal(viewPickProgress(view, partial).picked, progress.votable - 1);
      assert.throws(() => validateH2HBallot(partial, set, viewer), /Pick a winner in every matchup you can vote in/);
      dropped++;
    }
  }
  assert.ok(dropped >= 3, "the bye player and the walkover's two players each had a pick to drop");
});
