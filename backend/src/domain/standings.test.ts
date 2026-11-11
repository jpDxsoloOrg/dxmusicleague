// Standings rules tests — the pure, format-aware board order, the W/L/D
// increment normalizer and the standard reveal's per-player points
// increments (BUG-04) (domain/standings.ts). No repository, no handlers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { compareStandings, mergePointDeltas, recordIncrements, revealPointDeltas, sortStandings } from "./standings.ts";
import type { RankableStanding } from "./standings.ts";

const row = (userId: string, displayName: string, over: Partial<RankableStanding> = {}): RankableStanding => ({
  userId, displayName, points: 0, wins: 0, losses: 0, draws: 0, ...over,
});

test("standard order is points desc; equal points keep their input order; W/L/D ignored", () => {
  const rows = [
    row("u-a", "Zed", { points: 3, wins: 5 }),
    row("u-b", "Amy", { points: 9 }),
    row("u-c", "Bob", { points: 3 }),
    row("u-d", "Cat", { points: 3, losses: 4 }),
  ];
  assert.deepEqual(sortStandings("standard", rows).map((r) => r.userId), ["u-b", "u-a", "u-c", "u-d"]);
});

test("head-to-head order: wins desc → losses asc → name → id; draws and points don't rank", () => {
  const rows = [
    row("u-1", "Dee", { wins: 2, losses: 0, points: 100 }),
    row("u-2", "Cal", { wins: 3, losses: 2 }),
    row("u-3", "Bea", { wins: 3, losses: 1 }),
    row("u-4", "Ann", { wins: 1, losses: 1, draws: 1 }),
    row("u-6", "Ann", { wins: 1, losses: 1 }), // same name as u-5 → id breaks the tie
    row("u-5", "Ann", { wins: 1, losses: 1, draws: 2 }),
    row("u-7", "Abe", { wins: 1, losses: 1 }),
  ];
  assert.deepEqual(
    sortStandings("headToHead", rows).map((r) => r.userId),
    ["u-3", "u-2", "u-1", "u-7", "u-4", "u-5", "u-6"],
  );
});

test("head-to-head name tiebreak uses a pinned collation, not the host locale", () => {
  // An unpinned localeCompare ranks these by the process locale: en puts
  // "Örjan" first, sv puts "Zed" first. The board must not depend on LANG
  // (or on a browser's locale once the frontend mock shares this comparator).
  const rows = [row("u-1", "Zed", { wins: 1 }), row("u-2", "Örjan", { wins: 1 })];
  assert.deepEqual(sortStandings("headToHead", rows).map((r) => r.displayName), ["Örjan", "Zed"]);
});

test("compareStandings is a consistent comparator (antisymmetric, 0 only for the same player)", () => {
  const cmp = compareStandings("headToHead");
  const a = row("u-a", "Ann", { wins: 1 });
  const b = row("u-b", "Ann", { wins: 1 });
  assert.ok(cmp(a, b) < 0 && cmp(b, a) > 0);
  assert.equal(cmp(a, { ...a }), 0);
  assert.equal(compareStandings("standard")(a, b), 0); // standard: a points tie is a tie (stable sort keeps order)
});

test("sortStandings returns a sorted copy and leaves its input alone", () => {
  const rows = [row("u-a", "A", { wins: 0 }), row("u-b", "B", { wins: 1 })];
  const sorted = sortStandings("headToHead", rows);
  assert.deepEqual(sorted.map((r) => r.userId), ["u-b", "u-a"]);
  assert.deepEqual(rows.map((r) => r.userId), ["u-a", "u-b"]);
  assert.notEqual(sorted, rows);
});

test("recordIncrements fills omitted fields with 0 and rejects non-integers", () => {
  assert.deepEqual(recordIncrements({}), { wins: 0, losses: 0, draws: 0 });
  assert.deepEqual(recordIncrements({ draws: 1 }), { wins: 0, losses: 0, draws: 1 });
  assert.deepEqual(recordIncrements({ wins: 1, losses: 2, draws: 3 }), { wins: 1, losses: 2, draws: 3 });
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
    assert.throws(() => recordIncrements({ losses: bad }), /losses increment must be an integer/);
  }
  assert.throws(() => recordIncrements({ wins: "1" as unknown as number }), /wins increment must be an integer/);
});

test("mergePointDeltas: one entry per player, repeats summed in first-appearance order; a sum of 0 is kept (its write still makes the row); non-integers rejected", () => {
  assert.deepEqual(mergePointDeltas([]), []);
  assert.deepEqual(
    mergePointDeltas([
      { userId: "u-b", delta: 7 },
      { userId: "u-a", delta: 3 },
      { userId: "u-b", delta: -2 },
      { userId: "u-c", delta: 4 },
      { userId: "u-c", delta: -4 },
      { userId: "u-a", delta: 0 },
    ]),
    [{ userId: "u-b", delta: 5 }, { userId: "u-a", delta: 3 }, { userId: "u-c", delta: 0 }],
  );
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0.5, "3" as unknown as number]) {
    assert.throws(() => mergePointDeltas([{ userId: "u-a", delta: 1 }, { userId: "u-b", delta: bad }]), /points increment must be an integer/);
  }
});

test("revealPointDeltas: a standard reveal banks each submitter's results summed (submissionsPerPlayer > 1), negative totals included, zero-point results skipped", () => {
  // Ranked results, as computeResults orders them.
  const results = [
    { userId: "u-me", points: 10 },
    { userId: "u-james", points: 10 },
    { userId: "u-me", points: 5 },
    { userId: "u-sarah", points: 0 }, // skipped, as the reveal always did
    { userId: "u-james", points: 0 },
    { userId: "u-sarah", points: -3 }, // anti-votes: banks below 0
  ];
  assert.deepEqual(revealPointDeltas(results), [
    { userId: "u-me", delta: 15 },
    { userId: "u-james", delta: 10 },
    { userId: "u-sarah", delta: -3 },
  ]);
  // Every result 0 (nobody voted): nothing to bank.
  assert.deepEqual(revealPointDeltas([{ userId: "u-me", points: 0 }, { userId: "u-sarah", points: 0 }]), []);
  // The total each player gains equals the per-result sum the old banking wrote.
  const perResult = new Map<string, number>();
  for (const r of results) if (r.points !== 0) perResult.set(r.userId, (perResult.get(r.userId) ?? 0) + r.points);
  assert.deepEqual(new Map(revealPointDeltas(results).map((d) => [d.userId, d.delta])), perResult);
});
