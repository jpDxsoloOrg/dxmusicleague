// Rules-engine unit tests — pure, no infra. Run: `npm test` (node --test).
// Proves "the server is the referee" logic in isolation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBallot, validateH2HBallot, rankSubmissions, tallyBallots } from "./rules.ts";
import { DEFAULT_LEAGUE_SETTINGS } from "./types.ts";
import type { Submission } from "./types.ts";
import { votableMatchups } from "./matchups.ts";
import type { MatchupSide, RoundMatchupSet } from "./matchups.ts";

const ctx = {
  settings: DEFAULT_LEAGUE_SETTINGS, // pool 10, cap 5, no self-vote
  validSubmissionIds: new Set(["s1", "s2", "s3"]),
  ownSubmissionId: "s1",
};

test("accepts a full, in-bounds ballot and drops zero entries", () => {
  const cleaned = validateBallot({ allocations: { s2: 5, s3: 5, s1: 0 } }, ctx);
  assert.deepEqual(cleaned, { allocations: { s2: 5, s3: 5 }, downvotes: {} });
});

test("rejects ballots that don't spend the whole pool", () => {
  assert.throws(() => validateBallot({ allocations: { s2: 5, s3: 4 } }, ctx), /exactly 10/);
});

test("rejects exceeding the per-song cap", () => {
  assert.throws(() => validateBallot({ allocations: { s2: 6, s3: 4 } }, ctx), /more than 5/);
});

test("rejects self-votes when disallowed", () => {
  assert.throws(() => validateBallot({ allocations: { s1: 5, s2: 5 } }, ctx), /your own/);
});

test("rejects unknown submission ids", () => {
  assert.throws(() => validateBallot({ allocations: { s2: 5, sX: 5 } }, ctx), /Unknown submission/);
});

test("tally + tie-break: equal points → more distinct voters wins, then title", () => {
  const tally = tallyBallots([
    { allocations: { a: 5, b: 5 } }, // voter 1
    { allocations: { a: 5, b: 3, c: 2 } }, // voter 2
    { allocations: { b: 4, c: 6 } }, // voter 3 (c over cap in real life, but tally is rule-agnostic)
  ]);
  // a: 10 pts / 2 voters; b: 12 pts / 3 voters; c: 8 pts / 2 voters
  const ranked = rankSubmissions([
    { submissionId: "a", title: "Alpha", points: tally.get("a")!.points, distinctVoters: tally.get("a")!.distinctVoters },
    { submissionId: "b", title: "Bravo", points: tally.get("b")!.points, distinctVoters: tally.get("b")!.distinctVoters },
    { submissionId: "c", title: "Charlie", points: tally.get("c")!.points, distinctVoters: tally.get("c")!.distinctVoters },
  ]);
  assert.deepEqual(ranked.map((r) => r.submissionId), ["b", "a", "c"]);
  assert.equal(ranked[0]!.rank, 1);
});

test("tie-break falls through to title A→Z when points and voters match", () => {
  const ranked = rankSubmissions([
    { submissionId: "z", title: "Zebra", points: 5, distinctVoters: 1 },
    { submissionId: "a", title: "Apple", points: 5, distinctVoters: 1 },
  ]);
  assert.deepEqual(ranked.map((r) => r.submissionId), ["a", "z"]);
});

test("anti-votes: optional up to the pool, subtract at tally, negatives allowed", () => {
  const antiCtx = { ...ctx, settings: { ...DEFAULT_LEAGUE_SETTINGS, downvotePoolSize: 2 } };
  // Spending fewer than the anti pool (or none) is fine.
  const cleaned = validateBallot({ allocations: { s2: 5, s3: 5 }, downvotes: { s2: 1, s3: 0 } }, antiCtx);
  assert.deepEqual(cleaned.downvotes, { s2: 1 });
  // Over the pool / own song / unknown id are rejected.
  assert.throws(() => validateBallot({ allocations: { s2: 5, s3: 5 }, downvotes: { s2: 3 } }, antiCtx), /at most 2/);
  assert.throws(() => validateBallot({ allocations: { s2: 5, s3: 5 }, downvotes: { s1: 1 } }, antiCtx), /your own/);
  assert.throws(() => validateBallot({ allocations: { s2: 5, s3: 5 }, downvotes: { sX: 1 } }, antiCtx), /Unknown/);
  // Tally subtracts and can go negative; anti-votes don't count as voters.
  const tally = tallyBallots([
    { allocations: { a: 5 }, downvotes: { b: 2 } },
    { allocations: {}, downvotes: { b: 1 } },
  ]);
  assert.deepEqual(tally.get("b"), { points: -3, distinctVoters: 0, pointsFor: 0, pointsAgainst: 3 });
  assert.deepEqual(tally.get("a"), { points: 5, distinctVoters: 1, pointsFor: 5, pointsAgainst: 0 });
});

// ---- Head-to-head ballots: validateH2HBallot (HTH-06) ----------------------
//
// A hand-built derived round (the shape deriveRoundMatchups returns), so each
// rule is exercised in isolation:
//   M0  u-a (s-a) vs u-b (s-b)   contest
//   M1  u-c (s-c) vs u-d (s-d)   contest
//   M2  u-e (s-e) vs u-f (—)     walkover (u-f didn't submit)
//   M3  u-g (—)   vs u-h (—)     no contest
//   bye u-i (s-i)                exhibition song, not a matchup

const R = "lg~0001";
const M = (n: number) => `${R}~M${n}`;

function sub(id: string, userId: string): Submission {
  return {
    id, roundId: R, userId,
    track: { id: `t-${id}`, provider: "mock", providerTrackId: `t-${id}`, title: `Song ${id}`, artists: ["Artist"] },
  };
}
/** A matchup side: with a song (`subId`) or without one. */
function side(userId: string, subId?: string, departed = false): MatchupSide {
  return subId ? { userId, departed, submission: sub(subId, userId) } : { userId, departed };
}

const ROUND_SET: RoundMatchupSet = {
  matchups: [
    { matchupId: M(0), a: side("u-a", "s-a"), b: side("u-b", "s-b") },
    { matchupId: M(1), a: side("u-c", "s-c"), b: side("u-d", "s-d") },
    { matchupId: M(2), a: side("u-e", "s-e"), b: side("u-f") },
    { matchupId: M(3), a: side("u-g"), b: side("u-h") },
  ],
  bye: side("u-i", "s-i"),
};

test("H2H ballot: a pick in every votable matchup passes and comes back exactly; the bye player picks in all contests, a paired player in all but their own", () => {
  // The bye player can vote in both contests.
  assert.deepEqual(validateH2HBallot({ [M(0)]: "s-a", [M(1)]: "s-d" }, ROUND_SET, "u-i"), { [M(0)]: "s-a", [M(1)]: "s-d" });
  // A paired player picks only in the other contest — their own isn't asked for.
  assert.deepEqual(validateH2HBallot({ [M(1)]: "s-c" }, ROUND_SET, "u-a"), { [M(1)]: "s-c" });
  // A walkover / no-contest player (u-e, u-g) still votes in both contests.
  for (const voter of ["u-e", "u-f", "u-g", "u-h"]) {
    assert.deepEqual(validateH2HBallot({ [M(0)]: "s-b", [M(1)]: "s-c" }, ROUND_SET, voter), { [M(0)]: "s-b", [M(1)]: "s-c" });
  }
  // Completeness is THE shared votable set (domain/matchups.ts), not a second
  // definition: for every voter, exactly votableMatchups' ids are required.
  for (const voter of ["u-a", "u-b", "u-c", "u-d", "u-e", "u-f", "u-g", "u-h", "u-i"]) {
    const required = votableMatchups(ROUND_SET, voter);
    const picks = Object.fromEntries(required.map((m) => [m.matchupId, m.a.submission!.id]));
    assert.deepEqual(validateH2HBallot(picks, ROUND_SET, voter), picks, voter);
    if (required.length > 0) {
      const short = Object.fromEntries(Object.entries(picks).slice(1));
      assert.throws(() => validateH2HBallot(short, ROUND_SET, voter), /every matchup/, voter);
    }
  }
});

test("H2H ballot: a missing pick is rejected (the exact-spend analog — no partial ballots)", () => {
  assert.throws(
    () => validateH2HBallot({ [M(0)]: "s-a" }, ROUND_SET, "u-i"),
    /Pick a winner in every matchup you can vote in: 2 matchups \(you picked 1\)/,
  );
  assert.throws(() => validateH2HBallot({}, ROUND_SET, "u-i"), /2 matchups \(you picked 0\)/);
  assert.throws(() => validateH2HBallot(undefined, ROUND_SET, "u-i"), /you picked 0/);
  assert.throws(() => validateH2HBallot({}, ROUND_SET, "u-a"), /1 matchup \(you picked 0\)/);
  // A pick only in a walkover doesn't make up for a missing contest pick.
  assert.throws(() => validateH2HBallot({ [M(0)]: "s-a", [M(2)]: "s-e" }, ROUND_SET, "u-i"), /you picked 1/);
});

test("H2H ballot: an extra pick on a matchup that isn't in this round is rejected — including anything keyed by the bye", () => {
  const full = { [M(0)]: "s-a", [M(1)]: "s-d" };
  assert.throws(() => validateH2HBallot({ ...full, [`${R}~M9`]: "s-a" }, ROUND_SET, "u-i"), /Unknown matchup in ballot: lg~0001~M9/);
  assert.throws(() => validateH2HBallot({ ...full, "lg~0002~M0": "s-a" }, ROUND_SET, "u-i"), /Unknown matchup/); // another round's
  assert.throws(() => validateH2HBallot({ ...full, made_up: "s-a" }, ROUND_SET, "u-i"), /Unknown matchup/);
  // The bye is an exhibition, not a matchup: there is no id to pick it under.
  assert.throws(() => validateH2HBallot({ [M(1)]: "s-c", bye: "s-i" }, ROUND_SET, "u-a"), /Unknown matchup/);
  assert.throws(() => validateH2HBallot({ [M(1)]: "s-c", "s-i": "s-i" }, ROUND_SET, "u-a"), /Unknown matchup/);
  // The rejection is about the extra pick: the same ballot without it passes.
  assert.deepEqual(validateH2HBallot(full, ROUND_SET, "u-i"), full);
  assert.deepEqual(validateH2HBallot({ [M(1)]: "s-c" }, ROUND_SET, "u-a"), { [M(1)]: "s-c" });
});

test("H2H ballot: no pick in the voter's own matchup (the self-vote rule) — whichever song, even when it's a walkover", () => {
  // u-a's ballot is otherwise complete (M1), but also picks in M0 (their own).
  assert.throws(() => validateH2HBallot({ [M(0)]: "s-b", [M(1)]: "s-c" }, ROUND_SET, "u-a"), /your own matchup/);
  assert.throws(() => validateH2HBallot({ [M(0)]: "s-a", [M(1)]: "s-c" }, ROUND_SET, "u-a"), /your own matchup/);
  assert.throws(() => validateH2HBallot({ [M(0)]: "s-a", [M(1)]: "s-c" }, ROUND_SET, "u-b"), /your own matchup/);
  // Own walkover / no-contest: still the voter's own matchup → rejected, not stripped.
  assert.throws(() => validateH2HBallot({ [M(0)]: "s-a", [M(1)]: "s-c", [M(2)]: "s-e" }, ROUND_SET, "u-e"), /your own matchup/);
  assert.throws(() => validateH2HBallot({ [M(0)]: "s-a", [M(1)]: "s-c", [M(3)]: "s-a" }, ROUND_SET, "u-h"), /your own matchup/);
});

test("H2H ballot: the picked song must be one of that matchup's two songs (foreign submission ids rejected)", () => {
  const rest = { [M(1)]: "s-c" };
  assert.throws(() => validateH2HBallot({ [M(0)]: "s-c", ...rest }, ROUND_SET, "u-i"), /isn't in matchup lg~0001~M0/); // another matchup's song
  assert.throws(() => validateH2HBallot({ [M(0)]: "s-i", ...rest }, ROUND_SET, "u-i"), /isn't in matchup/); // the bye's exhibition song
  assert.throws(() => validateH2HBallot({ [M(0)]: "s-nope", ...rest }, ROUND_SET, "u-i"), /isn't in matchup/); // made up
  assert.throws(() => validateH2HBallot({ [M(0)]: "", ...rest }, ROUND_SET, "u-i"), /isn't in matchup/);
  // Not a submission id at all.
  for (const bad of [1, null, true, { id: "s-a" }, ["s-a"]]) {
    assert.throws(() => validateH2HBallot({ [M(0)]: bad, ...rest }, ROUND_SET, "u-i"), /Each pick must be the id/, JSON.stringify(bad));
  }
  // And the picks themselves must be a map.
  for (const bad of [["s-a"], "s-a", 3, true]) {
    assert.throws(() => validateH2HBallot(bad, ROUND_SET, "u-i"), /Picks must map each matchup/, JSON.stringify(bad));
  }
});

test("H2H ballot: picks on walkover and no-contest matchups are never rejected and never count — dropped whatever they hold", () => {
  const cleaned = validateH2HBallot({ [M(0)]: "s-a", [M(1)]: "s-d", [M(2)]: "s-e", [M(3)]: "s-g" }, ROUND_SET, "u-i");
  assert.deepEqual(cleaned, { [M(0)]: "s-a", [M(1)]: "s-d" });
  // Dropped whatever they name — the walkover's missing side, garbage, even a
  // non-string (refereed only in a contest; the same with or without the
  // as-scheduled set, since these pairs were never contests).
  for (const asScheduled of [undefined, ROUND_SET]) {
    for (const junk of ["s-f", "s-e", "garbage", "s-a", 7, null, { id: "s-e" }]) {
      assert.deepEqual(
        validateH2HBallot({ [M(1)]: "s-c", [M(2)]: junk, [M(3)]: junk }, ROUND_SET, "u-a", asScheduled),
        { [M(1)]: "s-c" },
        JSON.stringify(junk),
      );
    }
  }
  // A walkover pick never stands in for a missing contest pick.
  assert.throws(() => validateH2HBallot({ [M(2)]: "s-e" }, ROUND_SET, "u-a", ROUND_SET), /you picked 0/);
});

test("H2H ballot: a departure mid-voting — the pre-filled pick in a pair that became a walkover goes through and is KEPT (inert), so a rejoin restores it", () => {
  // u-d departs: M1 (u-c vs u-d) is a walkover now; as scheduled it's still a contest.
  const afterDeparture: RoundMatchupSet = {
    ...ROUND_SET,
    matchups: ROUND_SET.matchups.map((m) => (m.matchupId === M(1) ? { ...m, b: side("u-d", undefined, true) } : m)),
  };
  // The stale pick (even naming the departed player's withdrawn song) is kept,
  // but no longer required or counted: M0 alone completes the bye player's ballot.
  assert.deepEqual(validateH2HBallot({ [M(0)]: "s-a", [M(1)]: "s-d" }, afterDeparture, "u-i", ROUND_SET), { [M(0)]: "s-a", [M(1)]: "s-d" });
  assert.deepEqual(validateH2HBallot({ [M(0)]: "s-a", [M(1)]: "s-c" }, afterDeparture, "u-i", ROUND_SET), { [M(0)]: "s-a", [M(1)]: "s-c" });
  assert.deepEqual(validateH2HBallot({ [M(0)]: "s-a" }, afterDeparture, "u-i", ROUND_SET), { [M(0)]: "s-a" });
  assert.deepEqual(validateH2HBallot({ [M(1)]: "s-c" }, afterDeparture, "u-a", ROUND_SET), { [M(1)]: "s-c" }); // nothing left to vote in
  assert.deepEqual(votableMatchups(afterDeparture, "u-i").map((m) => m.matchupId), [M(0)], "the kept pick isn't votable");
  // Anything that isn't one of the pair's two songs as scheduled is dropped, not kept.
  for (const junk of ["s-a", "s-i", "garbage", 7]) {
    assert.deepEqual(validateH2HBallot({ [M(0)]: "s-a", [M(1)]: junk }, afterDeparture, "u-i", ROUND_SET), { [M(0)]: "s-a" }, String(junk));
  }
  // Without the as-scheduled set nothing can be recognised as pre-departure: dropped.
  assert.deepEqual(validateH2HBallot({ [M(0)]: "s-a", [M(1)]: "s-d" }, afterDeparture, "u-i"), { [M(0)]: "s-a" });
  // The departed player's opponent: M1 is still their own matchup → rejected.
  assert.throws(() => validateH2HBallot({ [M(0)]: "s-a", [M(1)]: "s-c" }, afterDeparture, "u-c", ROUND_SET), /your own matchup/);
  // Once the player rejoins (M1 is a contest again) the kept pick is a full, valid pick.
  assert.deepEqual(validateH2HBallot({ [M(0)]: "s-a", [M(1)]: "s-d" }, ROUND_SET, "u-i", ROUND_SET), { [M(0)]: "s-a", [M(1)]: "s-d" });
});

test("H2H ballot: nothing votable (a two-player league's only matchup is the voter's own) → an empty ballot passes", () => {
  const duo: RoundMatchupSet = { matchups: [{ matchupId: M(0), a: side("u-a", "s-a"), b: side("u-b", "s-b") }] };
  assert.deepEqual(validateH2HBallot({}, duo, "u-a"), {});
  assert.deepEqual(validateH2HBallot(undefined, duo, "u-b"), {});
  assert.deepEqual(validateH2HBallot(null, duo, "u-b"), {});
  assert.throws(() => validateH2HBallot({ [M(0)]: "s-b" }, duo, "u-a"), /your own matchup/);
  // An un-frozen / standard league derives an empty set: nothing to pick, nothing accepted.
  assert.deepEqual(validateH2HBallot({}, { matchups: [] }, "u-a"), {});
  assert.throws(() => validateH2HBallot({ [M(0)]: "s-a" }, { matchups: [] }, "u-a"), /Unknown matchup/);
});
