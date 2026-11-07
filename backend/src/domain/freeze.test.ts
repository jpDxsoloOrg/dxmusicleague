// Season-freeze unit tests — pure, no infra. Run: `npm test`.
// Proves the freeze's one random draw is sound: the shuffle is an unbiased
// Fisher–Yates permutation driven only by the injected RNG (so a seeded RNG
// reproduces it), the salt is 128 bits of that RNG as 32 hex chars, the
// round count is the round-robin length, and the lock predicates only ever
// fire for head-to-head leagues.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomInt as cryptoRandomInt } from "node:crypto";
import {
  MIN_H2H_PLAYERS,
  lockedOutOfSeason,
  membersOutsideOrder,
  newScheduleSalt,
  planSeasonFreeze,
  seasonLocked,
  shuffled,
} from "./freeze.ts";
import type { RandomInt } from "./freeze.ts";
import { scheduleLength } from "./schedule.ts";
import type { League } from "./types.ts";

/** Seeded RandomInt (mulberry32) — reproducible draws for tests. */
function seeded(seed: number): RandomInt {
  let a = seed >>> 0;
  return (max) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max);
  };
}

/** A RandomInt that replays a fixed list of draws (and records each bound). */
function scripted(draws: number[]): { rng: RandomInt; bounds: number[] } {
  const bounds: number[] = [];
  let i = 0;
  return {
    bounds,
    rng: (max) => {
      bounds.push(max);
      const v = draws[i++];
      assert.ok(v !== undefined, "scripted RNG ran out of draws");
      assert.ok(v >= 0 && v < max, `draw ${v} out of range [0, ${max})`);
      return v;
    },
  };
}

const players = (n: number) => Array.from({ length: n }, (_, i) => `u-${i}`);
const sorted = (xs: readonly string[]) => [...xs].sort();

test("shuffled returns a permutation of its input and never mutates it", () => {
  for (let n = 0; n <= 9; n++) {
    const ids = players(n);
    const before = [...ids];
    const out = shuffled(ids, seeded(n + 1));
    assert.deepEqual(ids, before, "input untouched");
    assert.notEqual(out, ids, "a new array");
    assert.deepEqual(sorted(out), sorted(ids), `n=${n}: same members, each once`);
  }
});

test("shuffled is driven only by the injected RNG: same seed → same order", () => {
  const ids = players(8);
  assert.deepEqual(shuffled(ids, seeded(42)), shuffled(ids, seeded(42)));
  // And the seed matters: across a handful of seeds we see several orders.
  const orders = new Set(Array.from({ length: 10 }, (_, s) => shuffled(ids, seeded(s + 100)).join(",")));
  assert.ok(orders.size >= 8, `expected distinct orders per seed, got ${orders.size}`);
});

test("shuffled is an exact Fisher–Yates: every RNG draw sequence maps to a distinct permutation", () => {
  // For n = 4 the draws are randomInt(4), randomInt(3), randomInt(2): 24
  // sequences. An unbiased shuffle is a bijection from those onto the 24
  // permutations — each comes out exactly once, so uniform draws give
  // uniform orders. (The classic `randomInt(n)`-every-step bug fails this.)
  const ids = players(4);
  const seen = new Map<string, number>();
  for (let a = 0; a < 4; a++) {
    for (let b = 0; b < 3; b++) {
      for (let c = 0; c < 2; c++) {
        const { rng, bounds } = scripted([a, b, c]);
        const key = shuffled(ids, rng).join(",");
        assert.deepEqual(bounds, [4, 3, 2]);
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
  }
  assert.equal(seen.size, 24);
  assert.ok([...seen.values()].every((count) => count === 1));
});

test("shuffled is statistically uniform over many seeded draws", () => {
  const ids = players(3);
  const counts = new Map<string, number>();
  const rng = seeded(7);
  const trials = 60_000;
  for (let i = 0; i < trials; i++) {
    const key = shuffled(ids, rng).join(",");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  assert.equal(counts.size, 6);
  // Expected 10 000 each, σ ≈ 91; ±400 is > 4σ, yet far tighter than the
  // naive shuffle's skew (8 889 / 11 111).
  for (const [perm, count] of counts) assert.ok(Math.abs(count - trials / 6) < 400, `${perm}: ${count}`);
});

test("newScheduleSalt: 128 bits as 32 lowercase hex chars, one byte per draw", () => {
  const zeros = scripted(Array(16).fill(0));
  assert.equal(newScheduleSalt(zeros.rng), "0".repeat(32));
  assert.deepEqual(zeros.bounds, Array(16).fill(256));
  assert.equal(newScheduleSalt(scripted(Array(16).fill(255)).rng), "f".repeat(32));
  assert.equal(
    newScheduleSalt(scripted([0, 1, 15, 16, 171, 205, 239, 255, 9, 10, 100, 200, 2, 3, 4, 5]).rng),
    "00010f10abcdefff090a64c802030405",
  );
  const salt = newScheduleSalt(seeded(3));
  assert.match(salt, /^[0-9a-f]{32}$/);
  assert.notEqual(newScheduleSalt(seeded(4)), salt);
});

test("planSeasonFreeze: shuffled members, fresh salt, roundCount = round-robin length", () => {
  for (let n = MIN_H2H_PLAYERS; n <= 12; n++) {
    const ids = players(n);
    const plan = planSeasonFreeze(ids, seeded(n));
    assert.deepEqual(sorted(plan.participants), sorted(ids));
    assert.match(plan.salt, /^[0-9a-f]{32}$/);
    assert.equal(plan.roundCount, scheduleLength(n));
  }
  assert.equal(planSeasonFreeze(players(5), seeded(1)).roundCount, 5); // odd: everyone byes once
  assert.equal(planSeasonFreeze(players(4), seeded(1)).roundCount, 3); // even: n − 1
  assert.equal(planSeasonFreeze(players(2), seeded(1)).roundCount, 1);
  // Reproducible under a seed (order AND salt), different under another.
  assert.deepEqual(planSeasonFreeze(players(6), seeded(9)), planSeasonFreeze(players(6), seeded(9)));
  assert.notDeepEqual(planSeasonFreeze(players(6), seeded(9)), planSeasonFreeze(players(6), seeded(10)));
});

test("planSeasonFreeze works with node:crypto's randomInt (the production RNG)", () => {
  const plan = planSeasonFreeze(players(7), cryptoRandomInt);
  assert.deepEqual(sorted(plan.participants), sorted(players(7)));
  assert.match(plan.salt, /^[0-9a-f]{32}$/);
  assert.equal(plan.roundCount, 7);
  assert.notEqual(planSeasonFreeze(players(7), cryptoRandomInt).salt, plan.salt);
});

test("seasonLocked / lockedOutOfSeason fire only for a frozen head-to-head league", () => {
  const frozen: Pick<League, "format" | "h2hParticipants"> = { format: "headToHead", h2hParticipants: ["u-a", "u-b"] };
  assert.equal(seasonLocked(frozen), true);
  assert.equal(lockedOutOfSeason(frozen, "u-new"), true); // a newcomer can't be scheduled
  assert.equal(lockedOutOfSeason(frozen, "u-a"), false); // a frozen participant may come back

  assert.equal(seasonLocked({ format: "headToHead" }), false); // not frozen yet
  assert.equal(seasonLocked({ format: "headToHead", h2hParticipants: [] }), false);
  assert.equal(lockedOutOfSeason({ format: "headToHead" }, "u-new"), false);
  // Standard (or legacy, format-less) leagues never lock, whatever they hold.
  assert.equal(seasonLocked({ format: "standard", h2hParticipants: ["u-a"] }), false);
  assert.equal(lockedOutOfSeason({ format: "standard", h2hParticipants: ["u-a"] }, "u-new"), false);
  assert.equal(seasonLocked({ h2hParticipants: ["u-a"] } as never), false);
});

test("membersOutsideOrder lists members missing from a frozen order — never for un-frozen or standard leagues", () => {
  const frozen = { format: "headToHead" as const, h2hParticipants: ["u-a", "u-b", "u-c"] };
  assert.deepEqual(membersOutsideOrder({ ...frozen, memberIds: ["u-a", "u-c"] }), []); // a participant left: fine
  assert.deepEqual(membersOutsideOrder({ ...frozen, memberIds: ["u-a", "u-x", "u-b", "u-y"] }), ["u-x", "u-y"]);
  assert.deepEqual(membersOutsideOrder({ format: "headToHead", memberIds: ["u-a"] }), []);
  assert.deepEqual(membersOutsideOrder({ format: "headToHead", h2hParticipants: [], memberIds: ["u-a"] }), []);
  assert.deepEqual(membersOutsideOrder({ format: "standard", h2hParticipants: ["u-a"], memberIds: ["u-a", "u-x"] }), []);
});
