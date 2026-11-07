// Head-to-head matchups read API (HTH-05) — the voting-phase view of an H2H
// round: its matchups with each pair's two songs (still anonymous), which one
// the caller plays in, and the bye player's exhibition song. Everything is
// derived on read from the frozen schedule + the round's submissions
// (domain/matchups.ts); nothing here is stored.
//
// Its own module (not voting.ts) because `loadRoundMatchups` is shared: the
// H2H ballot path in voting.ts (HTH-06) and the tally in results.ts (HTH-07)
// load matchups through it too, and results.ts can't import voting.ts (that
// is the cycle results.ts was extracted to break). This file imports only
// domain modules and the Deps type, so anything may import it.
//
// Who can read (mirrors the existing reads): before the reveal the matchups
// are a members-only voting aid, exactly like the anonymous song list —
// members see them from the moment voting opens, never earlier (no peeking
// at who-faces-whom while songs are still being picked). Once the round is
// revealed they're readable by any signed-in user, spectators included, like
// GET results. The payload is anonymous in every phase; identities come with
// the results (HTH-07).
//
// Departures: while the round is in play a departed player's song is
// withdrawn (their pair reads as a walkover); a revealed round is never
// re-judged against today's member list, so a later leave/kick can't rewrite
// it (domain/matchups.ts header). Until HTH-07 pins the departed set at the
// reveal, a revealed round's payload shows every submitted song — so for the
// rare round where someone departed mid-round it is NOT authoritative about
// walkovers; GET results (HTH-07) is.

import type { League, Round } from "../domain/types.ts";
import { leagueFormat } from "../domain/types.ts";
import { badRequest, forbidden, notFound } from "../domain/errors.ts";
import { deriveRoundMatchups, matchupsView, roundSettled } from "../domain/matchups.ts";
import type { DeriveOptions, RoundMatchupSet, RoundMatchupsView } from "../domain/matchups.ts";
import type { Deps } from "./leagues.ts";

/**
 * The round's derived matchups with every player's song attached. Carries
 * submitter ids — server-side only; respond through `matchupsView`. The one
 * loader for every H2H reader (this API, ballot validation, the tally), so
 * they all agree on who faces whom and which sides have songs.
 *
 * Departures are judged by `round.status` (domain `departedParticipants`):
 * against the member list as it is NOW while the round is in play — right for
 * casting ballots and for the tally inside `finalizeReveal` (it runs before
 * the status flips) — and not at all once the round is revealed. HTH-07:
 * `computeResults` re-runs on every GET results, so a revealed round must not
 * lean on that default — pin the departed set when `finalizeReveal` banks and
 * pass it as `options.departed` on every later read, or a mid-round departure
 * (walkover banked at reveal) reads back as a contest afterwards.
 */
export async function loadRoundMatchups(
  deps: Deps,
  league: League,
  round: Round,
  options?: DeriveOptions,
): Promise<RoundMatchupSet> {
  return deriveRoundMatchups(league, round, await deps.repo.getSubmissionsForRound(round.id), options);
}

/** GET /rounds/:roundId/matchups. 400 for a standard league's round (no
 *  matchups there), 403 before voting opens or for a non-member before the
 *  reveal. */
export async function listMatchups(deps: Deps, caller: string, roundId: string): Promise<RoundMatchupsView> {
  const round = await deps.repo.getRound(roundId);
  if (!round) throw notFound("That round doesn't exist.");
  const league = await deps.repo.getLeague(round.leagueId);
  if (!league) throw notFound("That league doesn't exist.");
  if (leagueFormat(league) !== "headToHead") {
    throw badRequest("This league scores by points, so its rounds don't have matchups.");
  }

  if (!roundSettled(round)) {
    if (!league.memberIds.includes(caller)) {
      throw forbidden("Only league members can see the matchups before the round is revealed.");
    }
    if (round.status !== "voting") throw forbidden("The matchups aren't out yet — they're revealed when voting opens.");
  }

  return matchupsView(await loadRoundMatchups(deps, league, round), caller);
}
