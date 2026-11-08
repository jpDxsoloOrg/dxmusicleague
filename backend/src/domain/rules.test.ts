// Rules-engine unit tests — pure, no infra. Run: `npm test` (node --test).
// Proves "the server is the referee" logic in isolation: points ballots (the
// effective pool, BUG-02; the self-vote rule over every own song, BUG-11) and
// their tally, head-to-head ballots (HTH-06), and the head-to-head tally,
// outcomes and the W/L/D each reveal banks (HTH-07).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  effectivePool,
  matchupOutcome,
  matchupRecords,
  rankSubmissions,
  resolveMatchups,
  settleMatchups,
  tallyBallots,
  tallyMatchups,
  validateBallot,
  validateH2HBallot,
} from "./rules.ts";
import { DEFAULT_LEAGUE_SETTINGS } from "./types.ts";
import type { Submission } from "./types.ts";
import { votableMatchups } from "./matchups.ts";
import type { MatchupSide, RoundMatchupSet } from "./matchups.ts";

const ctx = {
  settings: DEFAULT_LEAGUE_SETTINGS, // pool 10, cap 5, no self-vote
  validSubmissionIds: new Set(["s1", "s2", "s3"]),
  ownSubmissionIds: new Set(["s1"]),
  votableSongCount: 2, // s2 + s3 — the voter's own s1 isn't on offer
};

test("accepts a full, in-bounds ballot and drops zero entries", () => {
  const cleaned = validateBallot({ allocations: { s2: 5, s3: 5, s1: 0 } }, ctx);
  assert.deepEqual(cleaned, { allocations: { s2: 5, s3: 5 }, downvotes: {} });
});

test("rejects ballots that don't spend the whole pool", () => {
  assert.throws(() => validateBallot({ allocations: { s2: 5, s3: 4 } }, ctx), /exactly 10/);
});

test("the exact-pool message is unchanged when the songs on offer can take the whole pool", () => {
  assert.throws(() => validateBallot({ allocations: { s2: 5, s3: 4 } }, ctx), {
    message: "You must spend exactly 10 points (you spent 9).",
  });
  assert.throws(() => validateBallot({ allocations: {} }, ctx), {
    message: "You must spend exactly 10 points (you spent 0).",
  });
});

// ---- The effective pool (BUG-02): what the songs on offer can take ---------
//
// No song takes more than the cap, so when (songs on offer × cap) < pool the
// full pool can't be placed: the ballot spends exactly what can be.

test("effectivePool = min(pool, songs on offer × cap)", () => {
  assert.equal(effectivePool(DEFAULT_LEAGUE_SETTINGS, 2), 10); // 2 × 5 = 10: the whole pool
  assert.equal(effectivePool(DEFAULT_LEAGUE_SETTINGS, 5), 10);
  assert.equal(effectivePool(DEFAULT_LEAGUE_SETTINGS, 1), 5); // a two-player league
  assert.equal(effectivePool(DEFAULT_LEAGUE_SETTINGS, 0), 0); // nothing on offer
  assert.equal(effectivePool({ votePoolSize: 12, maxPointsPerSong: 4 }, 2), 8);
  assert.equal(effectivePool({ votePoolSize: 12, maxPointsPerSong: 4 }, 3), 12);
  assert.equal(effectivePool({ votePoolSize: 10, maxPointsPerSong: 1 }, 6), 6);
  assert.equal(effectivePool({ votePoolSize: 10, maxPointsPerSong: 2 }, 4), 8); // mock Synthwave Souls at cap 2
});

test("two-player league (pool 10, cap 5): one song on offer → a 5-point ballot is the full ballot", () => {
  const two = { settings: DEFAULT_LEAGUE_SETTINGS, validSubmissionIds: new Set(["s1", "s2"]), ownSubmissionIds: new Set(["s1"]), votableSongCount: 1 };
  assert.deepEqual(validateBallot({ allocations: { s2: 5 } }, two), { allocations: { s2: 5 }, downvotes: {} });
  assert.throws(() => validateBallot({ allocations: { s2: 4 } }, two), {
    message: "You must spend exactly 5 points (you spent 4) — that's all the songs on offer can take this round.",
  });
  assert.throws(() => validateBallot({ allocations: { s2: 6 } }, two), /more than 5/);
  assert.throws(() => validateBallot({ allocations: { s1: 5 } }, two), /your own/);
});

test("pool 12 / cap 4: two songs on offer take 8, three take the whole 12", () => {
  const settings = { ...DEFAULT_LEAGUE_SETTINGS, votePoolSize: 12, maxPointsPerSong: 4 };
  const twoSongs = { settings, validSubmissionIds: new Set(["s1", "s2", "s3"]), ownSubmissionIds: new Set(["s1"]), votableSongCount: 2 };
  assert.deepEqual(validateBallot({ allocations: { s2: 4, s3: 4 } }, twoSongs).allocations, { s2: 4, s3: 4 });
  assert.throws(() => validateBallot({ allocations: { s2: 4, s3: 3 } }, twoSongs), /exactly 8 points \(you spent 7\)/);
  // A voter with no song in the round has all three on offer: the full pool.
  const threeSongs = { settings, validSubmissionIds: new Set(["s1", "s2", "s3"]), ownSubmissionIds: new Set<string>(), votableSongCount: 3 };
  assert.deepEqual(validateBallot({ allocations: { s1: 4, s2: 4, s3: 4 } }, threeSongs).allocations, { s1: 4, s2: 4, s3: 4 });
  assert.throws(() => validateBallot({ allocations: { s2: 4, s3: 4 } }, threeSongs), {
    message: "You must spend exactly 12 points (you spent 8).",
  });
});

test("a low cap (pool 10, cap 1) with six songs on offer → 6 points is the full ballot", () => {
  const ids = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"];
  const lowCap = {
    settings: { ...DEFAULT_LEAGUE_SETTINGS, maxPointsPerSong: 1 },
    validSubmissionIds: new Set(ids),
    ownSubmissionIds: new Set(["s1"]),
    votableSongCount: 6,
  };
  const all = Object.fromEntries(ids.slice(1).map((id) => [id, 1]));
  assert.deepEqual(validateBallot({ allocations: all }, lowCap).allocations, all);
  assert.throws(() => validateBallot({ allocations: { ...all, s6: 0 } }, lowCap), /exactly 6 points \(you spent 5\)/);
});

test("no songs on offer (only the voter submitted) → the effective pool is 0: an empty ballot passes, a point doesn't", () => {
  const none = { settings: DEFAULT_LEAGUE_SETTINGS, validSubmissionIds: new Set(["s1"]), ownSubmissionIds: new Set(["s1"]), votableSongCount: 0 };
  assert.deepEqual(validateBallot({ allocations: {} }, none), { allocations: {}, downvotes: {} });
  assert.deepEqual(validateBallot({ allocations: { s1: 0 } }, none), { allocations: {}, downvotes: {} });
  assert.throws(() => validateBallot({ allocations: { s1: 1 } }, none), /your own/);
  // Self-voting on: the own song still isn't counted (the vote page never
  // offers it), so the safe smaller pool still holds.
  const selfVote = { ...none, settings: { ...DEFAULT_LEAGUE_SETTINGS, allowSelfVote: true } };
  assert.throws(() => validateBallot({ allocations: { s1: 1 } }, selfVote), /exactly 0 points \(you spent 1\)/);
});

test("rejects exceeding the per-song cap", () => {
  assert.throws(() => validateBallot({ allocations: { s2: 6, s3: 4 } }, ctx), /more than 5/);
});

test("rejects self-votes when disallowed", () => {
  assert.throws(() => validateBallot({ allocations: { s1: 5, s2: 5 } }, ctx), /your own/);
});

// ---- The self-vote rule guards EVERY own song (BUG-11) ---------------------
//
// With more than one song per player the voter owns several submissions; the
// rule used to compare against a single id, so only one of them was guarded.

/** Two songs each (pool 10, cap 5, 1 anti-vote): the voter owns s1 and s2. */
const twoOwn = {
  settings: { ...DEFAULT_LEAGUE_SETTINGS, submissionsPerPlayer: 2, downvotePoolSize: 1 },
  validSubmissionIds: new Set(["s1", "s2", "s3", "s4"]),
  ownSubmissionIds: new Set(["s1", "s2"]),
  votableSongCount: 2, // s3 + s4
};

test("self-voting off, two own songs: points on EITHER one are refused with the existing message", () => {
  for (const own of ["s1", "s2"]) {
    assert.throws(() => validateBallot({ allocations: { [own]: 5, s3: 5 } }, twoOwn), {
      message: "You can't vote for your own submission.",
    });
  }
  // Zero points on an own song is no vote: accepted and dropped.
  assert.deepEqual(validateBallot({ allocations: { s1: 0, s2: 0, s3: 5, s4: 5 } }, twoOwn).allocations, { s3: 5, s4: 5 });
});

test("self-voting off, two own songs: anti-votes on EITHER one are refused with the existing message", () => {
  for (const own of ["s1", "s2"]) {
    assert.throws(() => validateBallot({ allocations: { s3: 5, s4: 5 }, downvotes: { [own]: 1 } }, twoOwn), {
      message: "You can't anti-vote your own submission.",
    });
  }
  assert.deepEqual(validateBallot({ allocations: { s3: 5, s4: 5 }, downvotes: { s1: 0, s3: 1 } }, twoOwn).downvotes, { s3: 1 });
});

test("self-voting on, two own songs: either one takes points and anti-votes, as before", () => {
  const selfVote = { ...twoOwn, settings: { ...twoOwn.settings, allowSelfVote: true } };
  assert.deepEqual(validateBallot({ allocations: { s1: 5, s3: 5 }, downvotes: { s2: 1 } }, selfVote), {
    allocations: { s1: 5, s3: 5 },
    downvotes: { s2: 1 },
  });
  assert.deepEqual(validateBallot({ allocations: { s2: 5, s4: 5 }, downvotes: { s1: 1 } }, selfVote), {
    allocations: { s2: 5, s4: 5 },
    downvotes: { s1: 1 },
  });
});

test("a voter with no song in the round (empty own set) may vote for anything", () => {
  const spectatorish = { ...twoOwn, ownSubmissionIds: new Set<string>(), votableSongCount: 4 };
  assert.deepEqual(validateBallot({ allocations: { s1: 5, s2: 5 }, downvotes: { s3: 1 } }, spectatorish), {
    allocations: { s1: 5, s2: 5 },
    downvotes: { s3: 1 },
  });
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

// ---- Head-to-head tally, outcomes and records (HTH-07) ----

/** Six players, three contests: every matchup has four eligible voters (the
 *  players of the other two pairs). */
const SIX_SET: RoundMatchupSet = {
  matchups: [
    { matchupId: M(0), a: side("u-a", "s-a"), b: side("u-b", "s-b") },
    { matchupId: M(1), a: side("u-c", "s-c"), b: side("u-d", "s-d") },
    { matchupId: M(2), a: side("u-e", "s-e"), b: side("u-f", "s-f") },
  ],
};
const ballot = (voterId: string, picks?: Record<string, string>) => ({ voterId, ...(picks ? { picks } : {}) });

test("H2H tally: 3v1 → a win and a loss banked; 2v2 → a draw for both; 4v0 → the 0-vote side still banks its L", () => {
  const ballots = [
    // M0: u-c, u-d, u-e pick u-a's song, u-f picks u-b's (3–1).
    // M1: u-a, u-e pick u-c's, u-b, u-f pick u-d's (2–2).
    // M2: all four of u-a..u-d pick u-e's (4–0).
    ballot("u-a", { [M(1)]: "s-c", [M(2)]: "s-e" }),
    ballot("u-b", { [M(1)]: "s-d", [M(2)]: "s-e" }),
    ballot("u-c", { [M(0)]: "s-a", [M(2)]: "s-e" }),
    ballot("u-d", { [M(0)]: "s-a", [M(2)]: "s-e" }),
    ballot("u-e", { [M(0)]: "s-a", [M(1)]: "s-c" }),
    ballot("u-f", { [M(0)]: "s-b", [M(1)]: "s-d" }),
  ];
  assert.deepEqual(tallyMatchups(SIX_SET, ballots), [
    { matchupId: M(0), votesA: 3, votesB: 1 },
    { matchupId: M(1), votesA: 2, votesB: 2 },
    { matchupId: M(2), votesA: 4, votesB: 0 },
  ]);

  const settled = settleMatchups(SIX_SET, ballots);
  assert.deepEqual(
    settled.matchups.map((m) => [m.matchupId, m.outcome, m.winnerUserId, m.a.votes, m.b.votes]),
    [
      [M(0), "win", "u-a", 3, 1],
      [M(1), "draw", undefined, 2, 2],
      [M(2), "win", "u-e", 4, 0],
    ],
  );
  assert.equal("winnerUserId" in settled.matchups[1]!, false, "a draw has no winner key at all");
  assert.equal(settled.bye, undefined, "even field: no bye");
  // The sides keep everything the derivation knew (user, song, departure flag).
  assert.deepEqual(settled.matchups[0]!.a, { ...SIX_SET.matchups[0]!.a, votes: 3 });

  assert.deepEqual(matchupRecords(settled.matchups), [
    { userId: "u-a", delta: { wins: 1 } },
    { userId: "u-b", delta: { losses: 1 } },
    { userId: "u-c", delta: { draws: 1 } },
    { userId: "u-d", delta: { draws: 1 } },
    { userId: "u-e", delta: { wins: 1 } },
    { userId: "u-f", delta: { losses: 1 } }, // 0 votes — still an L (no `points !== 0`-style skip)
  ]);
});

test("H2H tally: a 0–0 contest is a draw that banks a D for both; side b can win", () => {
  const settled = settleMatchups(SIX_SET, [ballot("u-a", { [M(1)]: "s-d", [M(2)]: "s-f" })]);
  assert.deepEqual(settled.matchups.map((m) => [m.outcome, m.winnerUserId ?? null]), [
    ["draw", null], // nobody picked in M0: 0–0
    ["win", "u-d"],
    ["win", "u-f"],
  ]);
  assert.deepEqual(matchupRecords(settled.matchups).filter((r) => r.userId === "u-a" || r.userId === "u-b"), [
    { userId: "u-a", delta: { draws: 1 } },
    { userId: "u-b", delta: { draws: 1 } },
  ]);
  assert.deepEqual(matchupOutcome(SIX_SET.matchups[0]!, { votesA: 1, votesB: 2 }), { outcome: "win", winnerUserId: "u-b" });
  assert.deepEqual(matchupOutcome(SIX_SET.matchups[0]!, { votesA: 0, votesB: 0 }), { outcome: "draw" });
});

test("H2H tally: only real votes count — own-matchup, walkover / no-contest, foreign-song and unknown-matchup picks are inert", () => {
  // ROUND_SET: M0 a–b and M1 c–d are contests, M2 is a walkover (u-e has a
  // song, u-f doesn't), M3 is no contest, u-i has the bye.
  const ballots = [
    // The bye player: valid picks in M0 and M1, plus stray picks in the walkover / no contest.
    ballot("u-i", { [M(0)]: "s-b", [M(1)]: "s-c", [M(2)]: "s-e", [M(3)]: "s-a" }),
    // u-a picks in their own matchup (inert) and validly in M1.
    ballot("u-a", { [M(0)]: "s-a", [M(1)]: "s-c" }),
    // u-e picks another matchup's song in M0 (inert), the bye's song in M1 (inert).
    ballot("u-e", { [M(0)]: "s-c", [M(1)]: "s-i" }),
    // Unknown matchup ids and a points-only ballot (no picks) add nothing.
    ballot("u-g", { [`${R}~M9`]: "s-a", "lg~0002~M0": "s-b" }),
    ballot("u-h"),
  ];
  assert.deepEqual(tallyMatchups(ROUND_SET, ballots), [
    { matchupId: M(0), votesA: 0, votesB: 1 },
    { matchupId: M(1), votesA: 2, votesB: 0 },
    { matchupId: M(2), votesA: 0, votesB: 0 }, // walkover: stray votes ignored
    { matchupId: M(3), votesA: 0, votesB: 0 },
  ]);
  // No ballots: every matchup is still listed, 0–0.
  assert.deepEqual(tallyMatchups(ROUND_SET, []).map((t) => t.votesA + t.votesB), [0, 0, 0, 0]);
});

test("H2H outcomes: a walkover banks W for the player with the song and L for the no-show; no contest and the bye bank nothing", () => {
  const settled = settleMatchups(ROUND_SET, [ballot("u-i", { [M(0)]: "s-a", [M(1)]: "s-d", [M(2)]: "s-f" })]);
  const [m0, m1, m2, m3] = settled.matchups;
  assert.deepEqual([m0!.outcome, m0!.winnerUserId], ["win", "u-a"]);
  assert.deepEqual([m1!.outcome, m1!.winnerUserId], ["win", "u-d"]);
  assert.deepEqual([m2!.outcome, m2!.winnerUserId, m2!.a.votes, m2!.b.votes], ["walkover", "u-e", 0, 0]);
  assert.equal(m3!.outcome, "noContest");
  assert.equal("winnerUserId" in m3!, false);
  assert.deepEqual(settled.bye, ROUND_SET.bye, "the bye rides along untouched — an exhibition, not a matchup");

  // A walkover where side b has the song: b wins.
  const flipped = settleMatchups({ matchups: [{ matchupId: M(0), a: side("u-a"), b: side("u-b", "s-b") }] }, []);
  assert.deepEqual([flipped.matchups[0]!.outcome, flipped.matchups[0]!.winnerUserId], ["walkover", "u-b"]);

  const records = matchupRecords(settled.matchups);
  assert.deepEqual(records, [
    { userId: "u-a", delta: { wins: 1 } },
    { userId: "u-b", delta: { losses: 1 } },
    { userId: "u-d", delta: { wins: 1 } },
    { userId: "u-c", delta: { losses: 1 } },
    { userId: "u-e", delta: { wins: 1 } },
    { userId: "u-f", delta: { losses: 1 } },
  ]);
  const touched = new Set(records.map((r) => r.userId));
  for (const untouched of ["u-g", "u-h", "u-i"]) assert.ok(!touched.has(untouched), `${untouched} banks nothing`);
  // Exactly one entry per player: nobody plays twice in a round.
  assert.equal(touched.size, records.length);
});

test("H2H outcomes: a departed player's pair is a walkover for whoever stayed — only the stayer's W is banked, the departed side takes no L", () => {
  // u-d left mid-round (song withdrawn); u-h left without submitting, facing u-g who didn't submit either.
  const set: RoundMatchupSet = {
    matchups: [
      { matchupId: M(0), a: side("u-c", "s-c"), b: side("u-d", undefined, true) },
      { matchupId: M(1), a: side("u-g"), b: side("u-h", undefined, true) },
      { matchupId: M(2), a: side("u-a", "s-a"), b: side("u-b", "s-b") },
    ],
  };
  // A pick kept from before u-d departed (naming u-d's withdrawn song) is inert.
  const settled = settleMatchups(set, [ballot("u-g", { [M(0)]: "s-d", [M(2)]: "s-b" })]);
  assert.deepEqual(settled.matchups.map((m) => [m.outcome, m.winnerUserId ?? null, m.a.votes, m.b.votes]), [
    ["walkover", "u-c", 0, 0],
    ["noContest", null, 0, 0],
    ["win", "u-b", 0, 1],
  ]);
  assert.equal(settled.matchups[0]!.b.departed, true);
  assert.deepEqual(matchupRecords(settled.matchups), [
    { userId: "u-c", delta: { wins: 1 } }, // u-d: nothing
    { userId: "u-b", delta: { wins: 1 } },
    { userId: "u-a", delta: { losses: 1 } },
  ]);
});

test("H2H resolveMatchups: settles from a tally already counted (the one the reveal pinned), ignoring the ballots entirely; settleMatchups = tally + resolve; a matchup missing from the tally is 0–0", () => {
  const pinned = [
    { matchupId: M(0), votesA: 0, votesB: 2 },
    { matchupId: M(2), votesA: 1, votesB: 1 },
  ];
  const settled = resolveMatchups(SIX_SET, pinned);
  assert.deepEqual(
    settled.matchups.map((m) => [m.matchupId, m.outcome, m.winnerUserId, m.a.votes, m.b.votes]),
    [
      [M(0), "win", "u-b", 0, 2],
      [M(1), "draw", undefined, 0, 0],
      [M(2), "draw", undefined, 1, 1],
    ],
  );
  const ballots = [ballot("u-c", { [M(0)]: "s-a", [M(2)]: "s-e" }), ballot("u-a", { [M(1)]: "s-c" })];
  assert.deepEqual(settleMatchups(SIX_SET, ballots), resolveMatchups(SIX_SET, tallyMatchups(SIX_SET, ballots)));
});

test("H2H outcomes: an un-frozen / standard round settles to nothing; an outcome this version doesn't know banks nothing", () => {
  assert.deepEqual(settleMatchups({ matchups: [] }, [ballot("u-a", { [M(0)]: "s-a" })]), { matchups: [] });
  assert.deepEqual(tallyMatchups({ matchups: [] }, []), []);
  const future = { ...settleMatchups(SIX_SET, []).matchups[0]!, outcome: "forfeit" as never, winnerUserId: "u-a" };
  assert.deepEqual(matchupRecords([future]), []);
});
