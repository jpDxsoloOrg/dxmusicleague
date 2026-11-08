// Standings rules — pure, format-aware, no I/O. One player's running season
// record lives on a single standing row (`STANDING#<userId>`): `points` drive a
// standard league's table, `wins`/`losses`/`draws` drive a head-to-head one.
// Both live on the same row so leave/kick/rejoin durability, the rematch
// reseed and the league cascade delete cover W/L/D with no extra entity.
//
// Kept here (not in the handler) so every reader orders a board the same way:
// the league-detail view model today, the frontend mock (HTH-09) and playoff
// seeding (HTH-13) later.

import type { LeagueFormat } from "./types.ts";

/** One standing row as the repository returns it. Every counter is always a
 *  number: rows written before W/L/D existed (every standard league, and any
 *  live-beta row) read back with zeros, never undefined. */
export interface StandingTotals {
  userId: string;
  points: number;
  wins: number;
  losses: number;
  draws: number;
}

/** An increment to a player's W/L/D record. Omitted fields add nothing, so a
 *  reveal banks a draw as `{ draws: 1 }` and a walkover as `{ wins: 1 }` with
 *  one call per player (HTH-07). */
export interface StandingRecordDelta {
  wins?: number;
  losses?: number;
  draws?: number;
}

/** A W/L/D delta with every field present — what the repository writes.
 *  Rejects a non-integer increment, so a bad caller can never poison a stored
 *  record with NaN/Infinity/fractions (the board must always read clean). */
export function recordIncrements(delta: StandingRecordDelta): { wins: number; losses: number; draws: number } {
  const out = { wins: delta.wins ?? 0, losses: delta.losses ?? 0, draws: delta.draws ?? 0 };
  for (const [field, value] of Object.entries(out)) {
    if (!Number.isInteger(value)) throw new Error(`Standing ${field} increment must be an integer, got ${value}`);
  }
  return out;
}

/** One player's increment to their standing `points` — what a standard
 *  (points) round's reveal banks (BUG-04). */
export interface StandingPointsDelta {
  userId: string;
  delta: number;
}

/**
 * Points increments as one validated entry per player: repeats summed, in the
 * order each player first appears. A transaction can't touch the same
 * standing row twice, and a standard league with submissionsPerPlayer > 1
 * gives one submitter several results. Every player given is kept, even when
 * their entries sum to 0: that write still creates their row if it's absent,
 * exactly as the one-write-per-result banking this replaced did. Rejects a
 * non-integer increment (as recordIncrements does), so a bad caller can never
 * poison a stored total with NaN/Infinity/fractions.
 */
export function mergePointDeltas(entries: ReadonlyArray<StandingPointsDelta>): StandingPointsDelta[] {
  const byUser = new Map<string, number>();
  for (const { userId, delta } of entries) {
    if (!Number.isInteger(delta)) throw new Error(`Standing points increment must be an integer, got ${delta}`);
    byUser.set(userId, (byUser.get(userId) ?? 0) + delta);
  }
  return [...byUser].map(([userId, delta]) => ({ userId, delta }));
}

/**
 * What a standard round's reveal banks, from its ranked results: each
 * submitter's points summed over their songs (`mergePointDeltas`), in
 * ranked order of first appearance. A zero-point result banks nothing, as
 * the reveal always skipped those; a negative one (anti-votes) banks too —
 * the leaderboard can go below 0. A round where every result scored 0 banks
 * nothing at all (an empty list).
 */
export function revealPointDeltas(results: ReadonlyArray<{ userId: string; points: number }>): StandingPointsDelta[] {
  return mergePointDeltas(results.filter((r) => r.points !== 0).map((r) => ({ userId: r.userId, delta: r.points })));
}

/** The board's name collation, pinned to English (see compareStandings). */
const NAME_COLLATOR = new Intl.Collator("en");

/** What the comparator needs: the totals plus the name the board shows. */
export type RankableStanding = StandingTotals & { displayName: string };

/** Board order for a league's format.
 *  - standard: points desc. Equal points keep the order they arrived in (the
 *    sort is stable) — exactly the pre-format behavior, byte for byte.
 *  - headToHead: wins desc → losses asc → display name A→Z (→ user id, so two
 *    players sharing a name still order deterministically). Draws don't break
 *    ties: with wins and losses equal they only differ by games played. A
 *    win-% or head-to-head tiebreak is playoff-seeding territory (HTH-13).
 *    Names collate with a pinned English collator, never the host's default
 *    locale, so the server, a browser running the frontend mock (HTH-09) and
 *    playoff seeding (HTH-13) rank tied players with non-ASCII names
 *    identically (a Swedish host would otherwise put "Örjan" after "Zed"). */
export function compareStandings(format: LeagueFormat): (a: RankableStanding, b: RankableStanding) => number {
  if (format === "headToHead") {
    return (a, b) =>
      b.wins - a.wins ||
      a.losses - b.losses ||
      NAME_COLLATOR.compare(a.displayName, b.displayName) ||
      (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);
  }
  return (a, b) => b.points - a.points;
}

/** A sorted copy of `rows` in the league's board order (input untouched). Rank
 *  numbers are assigned by the caller from the resulting positions. */
export function sortStandings<T extends RankableStanding>(format: LeagueFormat, rows: readonly T[]): T[] {
  return [...rows].sort(compareStandings(format));
}
