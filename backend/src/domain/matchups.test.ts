// Matchup derivation unit tests — pure, no infra. Run: `npm test`.
// Proves the one shared derivation every H2H reader uses (HTH-05 read API,
// HTH-06 ballots, HTH-07 tally): pairings come from the frozen order + salt,
// each side gets its player's song, a departed player's song is withdrawn
// while the round is in play (never re-judged once it's revealed: it reads
// the departed set the reveal pinned on it, HTH-07), the walkover /
// no-contest / votable definitions, and
// that the anonymized view carries songs and `isMine` but never a user id or
// the frozen order.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anonymousSong,
  departedParticipants,
  deriveRoundMatchups,
  inMatchup,
  matchupState,
  matchupsView,
  votableMatchups,
} from "./matchups.ts";
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
