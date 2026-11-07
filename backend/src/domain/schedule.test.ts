// Round-robin pairing engine unit tests — pure, no infra. Run: `npm test`.
// Proves the circle-method schedule is a complete, fair round robin (every
// pair meets exactly once, byes rotate through everyone) with or without the
// league's secret salt, that pairings are deterministic (so deriving them on
// every read is safe), and that with the salt a revealed round doesn't let
// anyone predict which anonymous slot belongs to whom in the next one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { compareMatchupIds, matchupId, matchupsForRound, pairingsForRound, scheduleLength } from "./schedule.ts";
import type { RoundPairings } from "./schedule.ts";

/** `n` distinct participant ids in a fixed (frozen) order. */
const players = (n: number) => Array.from({ length: n }, (_, i) => `u-${String(i).padStart(2, "0")}`);

/** Both ways callers can derive pairings: legacy (no salt) and production (salted). */
const MODES = [
  { label: "unsalted", salt: undefined },
  { label: "salted", salt: "test-salt-6f1c2a" },
] as const;

/** Every round of one full cycle, 1-based like round ids. */
function season(ids: string[], salt?: string): RoundPairings[] {
  return Array.from({ length: scheduleLength(ids.length) }, (_, i) => pairingsForRound(ids, i + 1, salt));
}

/** Order-insensitive key for an unordered pair. */
const pairKey = (a: string, b: string) => [a, b].sort().join(" v ");

/** A round's pairs as a sorted list of unordered keys — ignores presentation. */
const pairSet = (pairs: [string, string][]) => pairs.map(([a, b]) => pairKey(a, b)).sort();

/** Every unordered pair of `ids` — the C(n,2) set a full round robin must cover. */
function allPairs(ids: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) out.push(pairKey(ids[i]!, ids[j]!));
  }
  return out.sort();
}

/** Asserts no one appears twice in a round and that pairs + bye cover the field exactly. */
function assertRoundCoversField(round: RoundPairings, ids: string[], label: string) {
  const seen = round.pairs.flat();
  if (round.bye !== undefined) seen.push(round.bye);
  assert.equal(new Set(seen).size, seen.length, `${label}: someone appears twice`);
  assert.deepEqual([...seen].sort(), [...ids].sort(), `${label}: pairs + bye must cover the field`);
  for (const [a, b] of round.pairs) assert.notEqual(a, b, `${label}: self-pairing`);
}

/** Count how often each unordered pair is played across a season. */
function pairCounts(rounds: RoundPairings[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rounds) {
    for (const [a, b] of r.pairs) counts.set(pairKey(a, b), (counts.get(pairKey(a, b)) ?? 0) + 1);
  }
  return counts;
}

/**
 * Reference oracle: the textbook circle method with no presentation shuffle —
 * participants[0] fixed, the rest rotated `rotation` seats, seat i vs seat
 * m-1-i, in seat order.
 */
function textbookRound(ids: string[], rotation: number): RoundPairings {
  const seats: (string | null)[] = ids.length % 2 === 0 ? [...ids] : [...ids, null];
  const rest = seats.slice(1);
  const lineup = [seats[0] ?? null, ...rest.map((_, i) => rest[(i - rotation + rest.length * 2) % rest.length] ?? null)];
  const pairs: [string, string][] = [];
  let bye: string | undefined;
  for (let i = 0; i < lineup.length / 2; i++) {
    const x = lineup[i] ?? null;
    const y = lineup[lineup.length - 1 - i] ?? null;
    if (x === null) bye = y ?? undefined;
    else if (y === null) bye = x;
    else pairs.push([x, y]);
  }
  return bye === undefined ? { pairs } : { pairs, bye };
}

test("scheduleLength: n-1 rounds for even fields, n for odd, 0 when degenerate", () => {
  assert.equal(scheduleLength(2), 1);
  assert.equal(scheduleLength(3), 3);
  assert.equal(scheduleLength(4), 3);
  assert.equal(scheduleLength(5), 5);
  assert.equal(scheduleLength(6), 5);
  assert.equal(scheduleLength(11), 11);
  assert.equal(scheduleLength(12), 11);
  assert.equal(scheduleLength(1), 1); // a lone player just byes
  assert.equal(scheduleLength(0), 0);
  assert.equal(scheduleLength(-3), 0);
  assert.equal(scheduleLength(4.5), 0);
  assert.equal(scheduleLength(Number.NaN), 0);
});

test("n=4: 3 rounds, every pair exactly once, nobody plays twice in a round, no byes", () => {
  const ids = players(4);
  for (const { label, salt } of MODES) {
    const rounds = season(ids, salt);
    assert.equal(rounds.length, 3);
    rounds.forEach((r, i) => {
      assert.equal(r.pairs.length, 2, `${label} round ${i + 1} has 2 matchups`);
      assert.equal("bye" in r, false, `${label} round ${i + 1} has no bye key`);
      assertRoundCoversField(r, ids, `${label} round ${i + 1}`);
    });
    const counts = pairCounts(rounds);
    assert.deepEqual([...counts.keys()].sort(), allPairs(ids));
    assert.ok([...counts.values()].every((c) => c === 1), `${label}: each pair meets exactly once`);
  }
});

test("n=5: 5 rounds, every pair exactly once, every player byes exactly once", () => {
  const ids = ["u-me", "u-sarah", "u-james", "u-mia", "u-luna"];
  for (const { label, salt } of MODES) {
    const rounds = season(ids, salt);
    assert.equal(rounds.length, 5);
    const byes: string[] = [];
    rounds.forEach((r, i) => {
      assert.equal(r.pairs.length, 2, `${label} round ${i + 1} has 2 matchups`);
      assert.ok(r.bye !== undefined, `${label} round ${i + 1} has a bye`);
      assert.ok(!r.pairs.flat().includes(r.bye), `${label} round ${i + 1}: the bye player doesn't also play`);
      assertRoundCoversField(r, ids, `${label} round ${i + 1}`);
      byes.push(r.bye);
    });
    assert.deepEqual([...byes].sort(), [...ids].sort(), `${label}: everyone byes exactly once`);
    const counts = pairCounts(rounds);
    assert.deepEqual([...counts.keys()].sort(), allPairs(ids));
    assert.ok([...counts.values()].every((c) => c === 1), `${label}: each pair meets exactly once`);
  }
});

test("n=2 edge case: one round, one matchup, no bye", () => {
  for (const { salt } of MODES) {
    const rounds = season(["u-a", "u-b"], salt);
    assert.equal(rounds.length, 1);
    const [only] = rounds;
    assert.equal(only!.pairs.length, 1);
    assert.equal(pairKey(...only!.pairs[0]!), pairKey("u-a", "u-b"));
    assert.equal("bye" in only!, false);
  }
});

test("n=3 edge case: three rounds of one matchup + one bye each, rotating through everyone", () => {
  const ids = ["u-a", "u-b", "u-c"];
  for (const { label, salt } of MODES) {
    const rounds = season(ids, salt);
    assert.equal(rounds.length, 3);
    for (const r of rounds) {
      assert.equal(r.pairs.length, 1);
      assertRoundCoversField(r, ids, `${label} n=3`);
    }
    assert.deepEqual(rounds.map((r) => r.bye).sort(), ids);
    assert.deepEqual(rounds.map((r) => pairKey(...r.pairs[0]!)).sort(), allPairs(ids));
  }
});

test("degenerate fields don't crash: 1 player byes, 0 players yields nothing", () => {
  for (const { salt } of MODES) {
    assert.deepEqual(pairingsForRound(["u-solo"], 1, salt), { pairs: [], bye: "u-solo" });
    assert.deepEqual(pairingsForRound(["u-solo"], 4, salt), { pairs: [], bye: "u-solo" });
    assert.deepEqual(pairingsForRound([], 1, salt), { pairs: [] });
  }
});

test("property: for n in 2..12 the cycle covers all C(n,2) pairs exactly once, byes rotate fairly", () => {
  for (const { label, salt } of MODES) {
    for (let n = 2; n <= 12; n++) {
      const ids = players(n);
      const rounds = season(ids, salt);
      const at = `${label} n=${n}`;
      assert.equal(rounds.length, n % 2 === 0 ? n - 1 : n, `${at}: cycle length`);

      rounds.forEach((r, i) => {
        assert.equal(r.pairs.length, Math.floor(n / 2), `${at} round ${i + 1}: matchup count`);
        assert.equal(r.bye !== undefined, n % 2 === 1, `${at} round ${i + 1}: bye iff odd`);
        assertRoundCoversField(r, ids, `${at} round ${i + 1}`);
      });

      // Union of every round's pairs is exactly the complete set, each once.
      const played = rounds.flatMap((r) => pairSet(r.pairs)).sort();
      assert.equal(played.length, (n * (n - 1)) / 2, `${at}: C(n,2) matchups in total`);
      assert.deepEqual(played, allPairs(ids), `${at}: every pair exactly once`);

      if (n % 2 === 1) {
        const byes = rounds.map((r) => r.bye!).sort();
        assert.deepEqual(byes, [...ids].sort(), `${at}: everyone byes exactly once`);
      }
    }
  }
});

test("determinism: same inputs give deep-equal output on every call, inputs untouched", () => {
  for (const { salt } of MODES) {
    for (const n of [2, 4, 5, 8, 11]) {
      const ids = Object.freeze(players(n)); // a mutation attempt would throw
      for (let r = 1; r <= scheduleLength(n); r++) {
        const first = pairingsForRound(ids, r, salt);
        assert.deepEqual(pairingsForRound(ids, r, salt), first);
        assert.deepEqual(pairingsForRound([...ids], r, salt), first, "a fresh copy of the order is equivalent");
        assert.notEqual(pairingsForRound(ids, r, salt).pairs, first.pairs, "callers get fresh arrays");
        assert.deepEqual(
          matchupsForRound(ids, `lg~${r}`, r, salt),
          matchupsForRound([...ids], `lg~${r}`, r, salt),
        );
      }
    }
  }
});

test("rounds past the end of the cycle wrap modulo the cycle instead of crashing", () => {
  for (const { salt } of MODES) {
    const ids = players(5); // cycle of 5
    assert.deepEqual(pairingsForRound(ids, 6, salt), pairingsForRound(ids, 1, salt));
    assert.deepEqual(pairingsForRound(ids, 13, salt), pairingsForRound(ids, 3, salt));
    // Defensive normalisation for malformed indexes (hand-edited data).
    assert.deepEqual(pairingsForRound(ids, 0, salt), pairingsForRound(ids, 5, salt));
    assert.deepEqual(pairingsForRound(ids, -1, salt), pairingsForRound(ids, 4, salt));
    assert.deepEqual(pairingsForRound(ids, 2.7, salt), pairingsForRound(ids, 2, salt));
    assert.deepEqual(pairingsForRound(ids, Number.NaN, salt), pairingsForRound(ids, 1, salt));
    const even = players(4); // cycle of 3
    assert.deepEqual(pairingsForRound(even, 4, salt), pairingsForRound(even, 1, salt));
  }
});

test("matchupId format snapshot: <roundId>~M<pairIndex>", () => {
  assert.equal(matchupId("office-league-3f9a~0001", 0), "office-league-3f9a~0001~M0");
  assert.equal(matchupId("office-league-3f9a~0002", 1), "office-league-3f9a~0002~M1");
  assert.equal(matchupId("lg~0012", 10), "lg~0012~M10");
  // Same inputs, same id — ballot keys depend on it.
  assert.equal(matchupId("lg~0003", 2), matchupId("lg~0003", 2));
});

test("compareMatchupIds sorts by round, then numeric pair index (M2 before M10)", () => {
  const ids = ["lg~0001~M10", "lg~0002~M0", "lg~0001~M2", "lg~0001~M0", "lg~0001~M1"];
  assert.deepEqual([...ids].sort(compareMatchupIds), [
    "lg~0001~M0",
    "lg~0001~M1",
    "lg~0001~M2",
    "lg~0001~M10",
    "lg~0002~M0",
  ]);
  assert.equal(compareMatchupIds("lg~0001~M3", "lg~0001~M3"), 0);

  // A 24-player private league has 12 matchups a round: "sorted by matchupId"
  // must reproduce matchupsForRound's order, which a plain string sort doesn't.
  const order = matchupsForRound(players(24), "lg~0003", 3, "s").matchups.map((m) => m.matchupId);
  assert.deepEqual([...order].reverse().sort(compareMatchupIds), order);
  assert.notDeepEqual([...order].sort(), order, "plain string sort puts M10 before M2");

  // Ids that don't parse sort last (string order), keeping the order total.
  assert.deepEqual(["junk", "lg~0001~M1", "lg~0001~M01", "lg~0001~M0"].sort(compareMatchupIds), [
    "lg~0001~M0",
    "lg~0001~M1",
    "junk",
    "lg~0001~M01",
  ]);
});

test("matchupsForRound attaches ids by pair index, carries the bye and passes the salt through", () => {
  const odd = players(5);
  for (const { salt } of MODES) {
    const pairings = pairingsForRound(odd, 2, salt);
    const view = matchupsForRound(odd, "lg~0002", 2, salt);
    assert.deepEqual(view, {
      matchups: pairings.pairs.map(([a, b], i) => ({ matchupId: `lg~0002~M${i}`, a, b })),
      bye: pairings.bye,
    });
  }

  const even = matchupsForRound(players(6), "lg~0001", 1);
  assert.deepEqual(
    even.matchups.map((m) => m.matchupId),
    ["lg~0001~M0", "lg~0001~M1", "lg~0001~M2"],
  );
  assert.equal("bye" in even, false);
});

test("stable across releases: these outputs must never change under live leagues", () => {
  // Pairings are derived on every read, so changing the algorithm reshuffles
  // every running league mid-season (ballots keyed by matchupId would point at
  // different pairs). Change these snapshots only together with a migration.
  const ids = ["u-me", "u-sarah", "u-james", "u-mia", "u-luna"];
  assert.deepEqual(matchupsForRound(ids, "lg~0001", 1), {
    matchups: [
      { matchupId: "lg~0001~M0", a: "u-luna", b: "u-sarah" },
      { matchupId: "lg~0001~M1", a: "u-james", b: "u-mia" },
    ],
    bye: "u-me",
  });
  assert.deepEqual(pairingsForRound(ids, 2), {
    pairs: [
      ["u-sarah", "u-james"],
      ["u-me", "u-luna"],
    ],
    bye: "u-mia",
  });
  assert.deepEqual(pairingsForRound(ids, 1, ""), pairingsForRound(ids, 1), "an empty salt means no salt");

  assert.deepEqual(matchupsForRound(ids, "lg~0001", 1, "fixture-salt"), {
    matchups: [
      { matchupId: "lg~0001~M0", a: "u-luna", b: "u-sarah" },
      { matchupId: "lg~0001~M1", a: "u-mia", b: "u-james" },
    ],
    bye: "u-me",
  });
  assert.deepEqual(pairingsForRound(ids, 2, "fixture-salt"), {
    pairs: [
      ["u-me", "u-sarah"],
      ["u-mia", "u-luna"],
    ],
    bye: "u-james",
  });
});

test("unsalted: pair sets follow the textbook circle method, but slots are presented scrambled", () => {
  let rounds = 0;
  let presentedInSeatOrder = 0;
  for (let n = 4; n <= 12; n++) {
    const ids = players(n);
    season(ids).forEach((r, i) => {
      const ref = textbookRound(ids, i);
      assert.deepEqual(pairSet(r.pairs), pairSet(ref.pairs), `n=${n} round ${i + 1}: textbook pairs`);
      assert.equal(r.bye, ref.bye, `n=${n} round ${i + 1}: textbook bye`);
      rounds++;
      if (JSON.stringify(r.pairs) === JSON.stringify(ref.pairs)) presentedInSeatOrder++;
    });
  }
  assert.ok(presentedInSeatOrder < rounds / 4, `${presentedInSeatOrder}/${rounds} rounds kept raw seat order`);
});

test("salted: each round plays one textbook rotation, each rotation once, in a salt-chosen order", () => {
  const ids = players(8); // cycle of 7
  const firstRotations = new Set<number>();
  for (let s = 0; s < 40; s++) {
    const salt = `salt-${s}`;
    const used = season(ids, salt).map((r, i) => {
      const rotation = Array.from({ length: 7 }, (_, k) => k).find(
        (k) => JSON.stringify(pairSet(textbookRound(ids, k).pairs)) === JSON.stringify(pairSet(r.pairs)),
      );
      assert.ok(rotation !== undefined, `${salt} round ${i + 1} is not a circle-method rotation`);
      return rotation;
    });
    assert.deepEqual([...used].sort(), [0, 1, 2, 3, 4, 5, 6], `${salt}: every rotation exactly once`);
    firstRotations.add(used[0]!);
  }
  assert.ok(firstRotations.size >= 4, "round 1 doesn't always play the same rotation");

  assert.notDeepEqual(pairingsForRound(ids, 1, "salt-a"), pairingsForRound(ids, 1, "salt-b"));
  assert.deepEqual(pairingsForRound(ids, 1, "salt-a"), pairingsForRound([...ids], 1, "salt-a"));
});

test("anonymity: the fixed seat doesn't sit in a stable matchup slot or side across rounds", () => {
  // Raw circle-method seats would put participants[0] in pair 0 / side a every
  // round, so one revealed round would deanonymize the rest of the season.
  for (const { label, salt } of MODES) {
    let atFirstSlot = 0;
    let onSideB = 0;
    let placements = 0;
    for (let n = 6; n <= 12; n++) {
      const ids = players(n);
      const slots = new Set<string>();
      const sides = new Set<string>();
      for (const r of season(ids, salt)) {
        const at = r.pairs.findIndex((p) => p.includes(ids[0]!));
        if (at === -1) continue; // bye round
        const side = r.pairs[at]![0] === ids[0] ? "a" : "b";
        slots.add(`${at}${side}`);
        sides.add(side);
        placements++;
        if (at === 0 && side === "a") atFirstSlot++;
        if (side === "b") onSideB++;
      }
      assert.ok(slots.size > 1, `${label} n=${n}: participants[0] always lands in the same slot`);
      assert.equal(sides.size, 2, `${label} n=${n}: participants[0] is never flipped to the other side`);
    }
    assert.ok(atFirstSlot < placements / 2, `${label}: participants[0] is mostly pair 0 side a`);
    const flipRate = onSideB / placements;
    assert.ok(flipRate > 0.25 && flipRate < 0.75, `${label}: participants[0] on side b ${onSideB}/${placements}`);
  }
});

test("attack: a revealed round predicts the next round's slots without a salt, but not with one", () => {
  // The attacker is player u-00. They have this source, round 1's revealed
  // slots (matchupId -> a/b userIds, plus the bye) and, during round 2's vote,
  // their own slot (isMine + their own song). Unsalted, that is enough: replay
  // the public algorithm over every candidate order and keep the consistent ones.
  const me = "u-00";
  const mySlot = (r: RoundPairings) => {
    const at = r.pairs.findIndex((p) => p.includes(me));
    return at === -1 ? "bye" : `${at}${r.pairs[at]![0] === me ? "a" : "b"}`;
  };
  const secret = ["u-02", "u-05", "u-00", "u-03", "u-01", "u-04"]; // the frozen order
  const revealed = JSON.stringify(pairingsForRound(secret, 1));
  const actual = pairingsForRound(secret, 2);
  const predictions = new Set<string>();
  for (const candidate of permutations(players(6))) {
    if (JSON.stringify(pairingsForRound(candidate, 1)) !== revealed) continue;
    const round2 = pairingsForRound(candidate, 2);
    if (mySlot(round2) === mySlot(actual)) predictions.add(JSON.stringify(round2));
  }
  assert.deepEqual([...predictions], [JSON.stringify(actual)], "unsalted: every round-2 slot is attributed");

  // Salted, grant the attacker strictly more — the exact frozen order — and
  // group many secret salts by what round 1 revealed. Within a group the best
  // possible play is guessing the group's most common round-2 slot map, so
  // that hit rate bounds any attack. (Unsalted it would be 100%.)
  for (const n of [4, 5]) {
    const ids = players(n);
    const trials = 3000;
    const groups = new Map<string, Map<string, number>>();
    for (let s = 0; s < trials; s++) {
      const salt = `secret-${s}`;
      const round1 = JSON.stringify(pairingsForRound(ids, 1, salt));
      const round2 = JSON.stringify(pairingsForRound(ids, 2, salt));
      const group = groups.get(round1) ?? new Map<string, number>();
      group.set(round2, (group.get(round2) ?? 0) + 1);
      groups.set(round1, group);
    }
    let bestGuessHits = 0;
    for (const group of groups.values()) bestGuessHits += Math.max(...group.values());
    assert.ok(bestGuessHits / trials < 0.25, `n=${n}: round 2 guessed ${bestGuessHits}/${trials} times`);
  }
});

/** Every ordering of `xs` (small inputs only). */
function* permutations<T>(xs: T[]): Generator<T[]> {
  if (xs.length <= 1) {
    yield xs;
    return;
  }
  for (let i = 0; i < xs.length; i++) {
    for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) yield [xs[i]!, ...rest];
  }
}
