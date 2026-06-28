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
  assert.deepEqual(cleaned, { s2: 5, s3: 5 });
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
    { a: 5, b: 5 }, // voter 1
    { a: 5, b: 3, c: 2 }, // voter 2
    { b: 4, c: 6 }, // voter 3 (c over cap in real life, but tally is rule-agnostic)
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
