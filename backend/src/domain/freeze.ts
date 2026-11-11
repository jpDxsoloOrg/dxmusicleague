// Head-to-head season freeze — pure, no I/O, no Node APIs (isomorphic like
// domain/schedule.ts, so the frontend mock can reuse it in HTH-09).
//
// When an H2H league's round 1 opens (draft → submitting, the freeze hook in
// handlers/rounds.ts), the season is frozen exactly once:
//   - every current member is shuffled into the frozen participant order
//     (`League.h2hParticipants`) that all pairings derive from;
//   - a secret salt (`League.h2hSalt`) is drawn to key the schedule's
//     per-round presentation order (see schedule.ts's anonymity notes);
//   - `roundCount` becomes the round-robin length for that many players
//     ("everyone faces everyone once, season over"), whatever the owner typed
//     at creation.
//
// This is the ONLY randomness in the whole head-to-head feature. It is drawn
// through one injected seam, `RandomInt`: production passes node:crypto's
// `randomInt` (a crypto-quality source — the salt must be unguessable), tests
// pass a seeded generator so the shuffle is reproducible.

import { scheduleLength } from "./schedule.ts";
import type { League } from "./types.ts";
import { leagueFormat } from "./types.ts";

/** A uniform random integer in [0, maxExclusive). node:crypto's `randomInt`
 *  has exactly this shape. */
export type RandomInt = (maxExclusive: number) => number;

/** The smallest field a round robin can schedule (one matchup). */
export const MIN_H2H_PLAYERS = 2;

/** Salt size: 16 random bytes = 128 bits, rendered as 32 lowercase hex chars. */
const SALT_BYTES = 16;

// User-facing errors for the freeze + join gating, exported so the HTH-09
// mock can throw byte-identical messages.

/** A join refused because the H2H season froze (round 1 opened): what a
 *  newcomer (never in the schedule) is told. */
export const SEASON_LOCKED_MESSAGE =
  "Season locked — this head-to-head league set its schedule when round 1 opened, so it can't take new players.";
/** A join refused to a former participant of a frozen season — one who left
 *  or was removed after round 1 opened (HTH-14: that's permanent). Worded for
 *  both, since a leave and a kick look the same once they're gone. */
export const SEASON_LEFT_MESSAGE =
  "You can't rejoin this head-to-head season — once round 1 opens, a player who leaves or is removed is out for the rest of the season.";
/** Opening round 1 of an H2H league with a lone member. */
export const H2H_MIN_PLAYERS_MESSAGE =
  `A head-to-head league needs at least ${MIN_H2H_PLAYERS} players before round 1 can open — share the invite code first.`;
/** Creating / opening a later round before round 1 has frozen the season. */
export const H2H_ROUND_ONE_FIRST_MESSAGE =
  "Open round 1 first — it sets the head-to-head schedule and how many rounds the season runs.";

/** Everything the freeze writes onto the league, in one go. */
export interface SeasonFreeze {
  /** The frozen participant order (a permutation of the members). */
  participants: string[];
  /** Secret schedule salt, 32 hex chars. */
  salt: string;
  /** Round-robin length for `participants.length` players. */
  roundCount: number;
}

/** A shuffled copy of `ids` (unbiased Fisher–Yates). Never mutates `ids`. */
export function shuffled<T>(ids: readonly T[], randomInt: RandomInt): T[] {
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/** A fresh schedule salt: 128 bits from `randomInt`, as 32 lowercase hex chars. */
export function newScheduleSalt(randomInt: RandomInt): string {
  let salt = "";
  for (let i = 0; i < SALT_BYTES; i++) salt += randomInt(256).toString(16).padStart(2, "0");
  return salt;
}

/** Plan the freeze for the league's current members: shuffled order, fresh
 *  salt, schedule-derived round count. The caller enforces the
 *  `MIN_H2H_PLAYERS` floor and persists the result exactly once. */
export function planSeasonFreeze(memberIds: readonly string[], randomInt: RandomInt): SeasonFreeze {
  const participants = shuffled(memberIds, randomInt);
  return {
    participants,
    salt: newScheduleSalt(randomInt),
    roundCount: scheduleLength(participants.length),
  };
}

type FreezeFields = Pick<League, "format" | "h2hParticipants">;

/** Has this league's head-to-head season frozen (round 1 opened)? From then
 *  on its membership is locked: nobody joins, and a player who leaves or is
 *  removed can't come back (`seasonJoinRefusal`, HTH-14). Always false for
 *  standard leagues, whatever else the record holds.
 *
 *  "Frozen" means a NON-EMPTY `h2hParticipants`: an absent or empty list is
 *  un-frozen. Both repositories' conditional writes (the freeze and the
 *  season-gated join) use exactly this definition, so a stray `[]` in
 *  hand-written data reads as a lobby everywhere and round 1 freezes it
 *  properly instead of being half-frozen. */
export function seasonLocked(league: FreezeFields): boolean {
  return leagueFormat(league) === "headToHead" && (league.h2hParticipants?.length ?? 0) > 0;
}

/** Members of a frozen season who aren't in its frozen order. Empty in a
 *  healthy league: joins are refused atomically once the season freezes, and
 *  the round-1 open takes in anyone whose join landed between its member
 *  snapshot and its freeze write (handlers/rounds.ts). Empty for un-frozen
 *  and standard leagues. */
export function membersOutsideOrder(league: Pick<League, "format" | "h2hParticipants" | "memberIds">): string[] {
  if (!seasonLocked(league)) return [];
  const order = new Set(league.h2hParticipants);
  return league.memberIds.filter((id) => !order.has(id));
}

/** Why the season lock refuses `userId` a place in this league, or
 *  `undefined` when it doesn't apply (an un-frozen lobby, or a standard
 *  league). The one join gate both join paths (invite code and public claim)
 *  and the frontend mock share. Once a head-to-head season is frozen NOBODY
 *  joins (HTH-14): a newcomer can't be scheduled into a round robin that's
 *  already drawn (`SEASON_LOCKED_MESSAGE`), and a former participant — in
 *  the frozen order but no longer a member: they left or were kicked — is
 *  out for good (`SEASON_LEFT_MESSAGE`), so nobody can dodge a loss by
 *  leaving before a reveal and coming back after it. Their remaining
 *  matchups play as walkovers for their opponents. Callers answer a current
 *  member ("already a member") before asking. */
export function seasonJoinRefusal(league: FreezeFields, userId: string): string | undefined {
  if (!seasonLocked(league)) return undefined;
  return (league.h2hParticipants ?? []).includes(userId) ? SEASON_LEFT_MESSAGE : SEASON_LOCKED_MESSAGE;
}
