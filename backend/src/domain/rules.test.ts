// Rules-engine unit tests — pure, no infra. Run: `npm test` (node --test).
// Proves "the server is the referee" logic in isolation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBallot, rankSubmissions, tallyBallots } from "./rules.ts";
import { DEFAULT_LEAGUE_SETTINGS } from "./types.ts";

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
  assert.deepEqual(tally.get("b"), { points: -3, distinctVoters: 0 });
  assert.deepEqual(tally.get("a"), { points: 5, distinctVoters: 1 });
});
