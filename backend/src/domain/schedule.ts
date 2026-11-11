// Round-robin pairing engine for head-to-head leagues — pure, no I/O, no Node
// APIs. It is isomorphic on purpose: the frontend mock imports (or mirrors) it
// in HTH-09, so it must typecheck under both tsconfigs and touch nothing but
// plain arrays, strings and web-standard globals (TextEncoder, DataView).
//
// Pairings are never stored. Every read derives them from the league's frozen
// participant order (`h2hParticipants`, shuffled once when round 1 opens —
// HTH-03), its secret salt (generated at the same moment) and the round's
// 1-based index, so the backend, the mock client and any future playoff code
// (HTH-13) can never drift apart. This module is deliberately deterministic
// over whatever it is given; the only randomness in the feature is drawn once,
// at freeze time.
//
// Algorithm: the classic circle (polygon) method. Seat everyone at a table,
// keep participants[0] fixed, rotate everyone else one seat per rotation, and
// pair seat i with seat m-1-i. An odd field gets a virtual BYE seat, so exactly
// one player sits out each round and the bye visits everyone exactly once per
// cycle. Over a full cycle every unordered pair meets exactly once.
//
// Anonymity: raw circle-method seats are stable (participants[0] would always
// be pair 0, side a, and everyone else walks round the table predictably), so
// one revealed round would expose the seating and deanonymize every later
// round's matchup slots. The pairs are therefore *presented* in a per-round
// order: pair order and a/b sides are shuffled by a seeded PRNG. That stays
// fully deterministic (stable matchup ids and ballot keys across reads); what
// matters is what keys it:
//
// - With the league's `salt` (random, server-only; HTH-03 creates it next to
//   `h2hParticipants`, strips it from every payload and never copies it on
//   rematch), each round's presentation seed, and the order in which the
//   season plays the cycle's rotations, come from SHA-256 over (salt, label,
//   order). Revealed rounds then say nothing about later rounds' slots, even
//   to someone who knows the frozen order and has this source.
// - Without a salt (back-compat, tests) the shuffle is seeded by the frozen
//   order alone, and that is weak: a revealed round narrows the order to about
//   (n/2)!·2^(n/2) candidates, and replaying this public code against them
//   recovers it, and every later round's slots, in milliseconds for any
//   realistic field. Production callers must pass the salt.
//
// What no shuffle can hide (inherent to a round robin): revealed rounds show
// who has already met whom, so the pairings themselves grow inferable as the
// season goes on — the final round's pairs and bye are fully determined by the
// earlier ones. The salt protects which slot (and so which anonymous song)
// belongs to whom, not the pair set.

/** One round's pairings. `bye` (the player sitting out) is set only when the
 *  field is odd; it is absent, not `undefined`, for even fields. */
export interface RoundPairings {
  pairs: [string, string][];
  bye?: string;
}

/** A pairing with its stable matchup id attached (see `matchupsForRound`). */
export interface ScheduledMatchup {
  matchupId: string;
  a: string;
  b: string;
}

export interface RoundMatchups {
  matchups: ScheduledMatchup[];
  bye?: string;
}

/**
 * Rounds in one full round-robin cycle for `n` players: `n - 1` when `n` is
 * even, `n` when odd (one extra round so the bye rotates through everyone
 * exactly once). Degenerate inputs (fewer than one player, non-integers)
 * yield 0 rounds.
 */
export function scheduleLength(n: number): number {
  if (!Number.isInteger(n) || n < 1) return 0;
  return n % 2 === 0 ? n - 1 : n;
}

/**
 * The pairs (and bye, for odd fields) for one round of the cycle.
 *
 * `participants` is the frozen order and must hold distinct ids; it is never
 * mutated. `roundIndex` is 1-based to match round ids (`<leagueId>~<index4>`,
 * `Round.index`). An index past the end of the cycle wraps modulo the cycle
 * (HTH-03 caps `roundCount` so this shouldn't happen, but a hand-edited league
 * must not crash reads): round `scheduleLength(n) + 1` is identical to round 1.
 *
 * `salt` is the league's secret (see the header). With it, round k plays a
 * salt-chosen rotation of the circle and is presented in a salt-keyed order;
 * without it (or with `""`), round k plays rotation k-1, presented in an order
 * keyed by `participants` alone. Either way a full cycle covers every pair
 * exactly once. Each pair is `[a, b]` in presentation order; array position is
 * the pair index used by `matchupId`.
 */
export function pairingsForRound(
  participants: readonly string[],
  roundIndex: number,
  salt?: string,
): RoundPairings {
  const n = participants.length;
  const cycle = scheduleLength(n);
  if (cycle === 0) return { pairs: [] };
  const position = cyclePosition(roundIndex, cycle);
  const rotation = salt ? rotationOrder(participants, cycle, salt)[position]! : position;

  // Seat the table: an odd field gets a virtual BYE seat (null) so seats pair up.
  const seats: (string | null)[] = n % 2 === 0 ? [...participants] : [...participants, null];
  const m = seats.length; // even; the rotating seats number m - 1 === cycle
  const lineup: (string | null)[] = [seats[0] ?? null];
  for (let i = 0; i < cycle; i++) {
    // Rotate the non-fixed seats `rotation` places round the table.
    lineup.push(seats[1 + ((i - rotation + cycle) % cycle)] ?? null);
  }

  const pairs: [string, string][] = [];
  let bye: string | undefined;
  for (let i = 0; i < m / 2; i++) {
    const x = lineup[i] ?? null;
    const y = lineup[m - 1 - i] ?? null;
    if (x === null) bye = y ?? undefined;
    else if (y === null) bye = x;
    else pairs.push([x, y]);
  }

  const seed = salt
    ? keyedSeed(salt, `round:${rotation}`, participants)
    : fnv1a(`${rotation}\u0001${participants.join("\u0000")}`);
  scramble(pairs, mulberry32(seed));
  return bye === undefined ? { pairs } : { pairs, bye };
}

/**
 * Stable id for a matchup: `<roundId>~M<pairIndex>`, where `pairIndex` is the
 * 0-based position in `pairingsForRound(...).pairs`. Deterministic across
 * reads — H2H ballots key picks by it (HTH-06), results report it (HTH-07)
 * and future playoff rounds may reference it (HTH-13). Not zero-padded, so
 * "sorted by matchupId" means `compareMatchupIds` (or simply the order
 * `matchupsForRound` returns), never a plain string sort (`M10` < `M2`).
 */
export function matchupId(roundId: string, pairIndex: number): string {
  return `${roundId}~M${pairIndex}`;
}

/**
 * Comparator for matchup ids: by round id, then by numeric pair index, so a
 * round's matchups sort exactly as `matchupsForRound` returns them even with
 * 11+ pairs (private leagues have no member cap). Ids that don't parse as
 * `<roundId>~M<n>` sort after all ids that do, by plain string order, so the
 * comparator stays a total order on any input.
 */
export function compareMatchupIds(x: string, y: string): number {
  const px = parseMatchupId(x);
  const py = parseMatchupId(y);
  if (px && py) {
    if (px.roundId !== py.roundId) return px.roundId < py.roundId ? -1 : 1;
    return px.pairIndex - py.pairIndex;
  }
  if (px) return -1;
  if (py) return 1;
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Convenience over `pairingsForRound` + `matchupId`: the round's matchups with
 * their ids attached, in pair-index order, plus the bye (odd fields only).
 * `salt` is passed straight through — production callers must supply it.
 */
export function matchupsForRound(
  participants: readonly string[],
  roundId: string,
  roundIndex: number,
  salt?: string,
): RoundMatchups {
  const { pairs, bye } = pairingsForRound(participants, roundIndex, salt);
  const matchups = pairs.map(([a, b], i) => ({ matchupId: matchupId(roundId, i), a, b }));
  return bye === undefined ? { matchups } : { matchups, bye };
}

// ---- internals -------------------------------------------------------------

/** 0-based position within the cycle for a 1-based round index (wraps). */
function cyclePosition(roundIndex: number, cycle: number): number {
  const k = Number.isFinite(roundIndex) ? Math.trunc(roundIndex) : 1;
  return (((k - 1) % cycle) + cycle) % cycle;
}

/** `<roundId>~M<n>` split back into its parts, or null when it doesn't parse. */
function parseMatchupId(id: string): { roundId: string; pairIndex: number } | null {
  const at = id.lastIndexOf("~M");
  const index = id.slice(at + 2);
  if (at < 0 || !/^(0|[1-9]\d*)$/.test(index)) return null;
  return { roundId: id.slice(0, at), pairIndex: Number(index) };
}

/**
 * Salted path only: which circle rotation each cycle position plays. A
 * permutation of 0..cycle-1, so a full cycle still covers every pair once,
 * but knowing earlier rounds' pair sets no longer pins down which rotation
 * comes next.
 */
function rotationOrder(participants: readonly string[], cycle: number, salt: string): number[] {
  const order = Array.from({ length: cycle }, (_, i) => i);
  shuffle(order, mulberry32(keyedSeed(salt, "rotations", participants)));
  return order;
}

/**
 * Shuffle pair order, then flip a/b sides, in place. Seeded per rotation (see
 * `pairingsForRound`), so the same round always presents identically and a
 * wrapped round presents exactly like the round it wraps onto.
 */
function scramble(pairs: [string, string][], rand: () => number): void {
  shuffle(pairs, rand);
  for (let i = 0; i < pairs.length; i++) {
    const [a, b] = pairs[i]!;
    if (rand() < 0.5) pairs[i] = [b, a];
  }
}

/** Fisher–Yates, in place, driven by `rand`. */
function shuffle<T>(xs: T[], rand: () => number): void {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = xs[i]!;
    xs[i] = xs[j]!;
    xs[j] = tmp;
  }
}

/**
 * 32-bit PRNG seed from SHA-256 over a label, the frozen order and the secret
 * salt. Each label (`rotations`, `round:<r>`) gets an independent seed, so
 * recovering one round's seed by brute force says nothing about another's,
 * and recovering the salt itself is a preimage search on SHA-256.
 */
function keyedSeed(salt: string, label: string, participants: readonly string[]): number {
  return sha256(`dxml-h2h\u0000${label}\u0000${participants.join("\u0001")}\u0000${salt}`)[0];
}

/** 32-bit FNV-1a over UTF-16 code units — identical in Node and browsers. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32: tiny seeded PRNG returning floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Words8 = [number, number, number, number, number, number, number, number];

/** SHA-256 round constants (FIPS 180-4 §4.2.2). */
const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/**
 * SHA-256 (FIPS 180-4) of a string's UTF-8 bytes, as eight unsigned 32-bit
 * words. Hand-rolled because this module must stay synchronous and isomorphic:
 * Node's `crypto` doesn't exist in the browser and Web Crypto's digest is
 * async. Inputs are at most a few hundred bytes, so speed is a non-issue.
 */
function sha256(message: string): Words8 {
  const bytes = new TextEncoder().encode(message);
  const blocks = Math.ceil((bytes.length + 9) / 64); // + 0x80 marker + 64-bit length
  const view = new DataView(new ArrayBuffer(blocks * 64));
  bytes.forEach((byte, i) => view.setUint8(i, byte));
  view.setUint8(bytes.length, 0x80);
  view.setUint32(blocks * 64 - 8, Math.floor(bytes.length / 0x20000000)); // bit length, high word
  view.setUint32(blocks * 64 - 4, (bytes.length * 8) >>> 0); // bit length, low word

  let state: Words8 = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Array<number>(64).fill(0);
  for (let block = 0; block < blocks; block++) {
    for (let t = 0; t < 64; t++) {
      if (t < 16) {
        w[t] = view.getUint32(block * 64 + t * 4);
      } else {
        const x = w[t - 15]!;
        const y = w[t - 2]!;
        const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
        const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
        w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) | 0;
      }
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[t]! + w[t]!) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    state = [
      (state[0] + a) | 0, (state[1] + b) | 0, (state[2] + c) | 0, (state[3] + d) | 0,
      (state[4] + e) | 0, (state[5] + f) | 0, (state[6] + g) | 0, (state[7] + h) | 0,
    ];
  }
  return state.map((word) => word >>> 0) as Words8;
}

/** 32-bit rotate right. */
function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}
