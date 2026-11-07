// Head-to-head matchups read API (HTH-05) — the voting-phase view of an H2H
// round: its matchups with each pair's two songs (still anonymous), which one
// the caller plays in, and the bye player's exhibition song. Everything is
// derived on read from the frozen schedule + the round's submissions
// (domain/matchups.ts); nothing here is stored.
//
// Its own module (not voting.ts) because `loadRoundMatchups` is shared: the
// H2H ballot path in voting.ts (HTH-06), the tally in results.ts (HTH-07)
// and the progress counts in progression.ts / leagues.ts (HTH-08,
// `loadVotingTurnout`) load matchups through it too, and results.ts can't
// import voting.ts (that is the cycle results.ts was extracted to break).
// This file imports only domain modules and the Deps type, so anything may
// import it.
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
// it (domain/matchups.ts header): it withdraws exactly the songs of the
// players the reveal pinned as departed (`Round.h2hDeparted`, HTH-07), so this
// payload and GET results agree about a revealed round's walkovers.

import type { Ballot, League, Round, Submission } from "../domain/types.ts";
import { leagueFormat } from "../domain/types.ts";
import { badRequest, forbidden, notFound } from "../domain/errors.ts";
import { deriveRoundMatchups, matchupsView, roundSettled, votingTurnout } from "../domain/matchups.ts";
import type { DeriveOptions, RoundMatchupSet, RoundMatchupsView, VotingTurnout } from "../domain/matchups.ts";
import type { Deps } from "./leagues.ts";

/**
 * The round's derived matchups with every player's song attached. Carries
 * submitter ids — server-side only; respond through `matchupsView`. The one
 * loader for every H2H reader (this API, ballot validation, the tally), so
 * they all agree on who faces whom and which sides have songs.
 *
 * Departures are judged by `round.status` (domain `departedParticipants`):
 * against the member list as it is NOW while the round is in play — right for
 * casting ballots — and, once the round is revealed, as the reveal pinned them
 * (`round.h2hDeparted`), so GET results re-derives exactly what was banked.
 * The reveal itself (`finalizeReveal`, handlers/results.ts) passes the
 * current set explicitly, then pins it.
 */
export async function loadRoundMatchups(
  deps: Deps,
  league: League,
  round: Round,
  options?: DeriveOptions,
): Promise<RoundMatchupSet> {
  return deriveRoundMatchups(league, round, await deps.repo.getSubmissionsForRound(round.id), options);
}

/**
 * A head-to-head voting round's turnout (HTH-08): the members who have a
 * matchup to pick in, and which of them have voted — domain `votingTurnout`
 * over the round as it stands (departed players' songs withdrawn, exactly as
 * ballots are refereed: the derivation's default, as in `loadRoundMatchups`)
 * and the league's current members. What the timed everyone-voted advance,
 * the completion % and the voting panel count. Pass the round's submissions
 * and ballots when they're already read, to skip reading them again.
 */
export async function loadVotingTurnout(
  deps: Deps,
  league: League,
  round: Round,
  read: { submissions?: readonly Submission[]; ballots?: readonly Ballot[] } = {},
): Promise<VotingTurnout> {
  const [submissions, ballots] = await Promise.all([
    read.submissions ?? deps.repo.getSubmissionsForRound(round.id),
    read.ballots ?? deps.repo.getBallotsForRound(round.id),
  ]);
  return votingTurnout(deriveRoundMatchups(league, round, submissions), league.memberIds, ballots);
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
