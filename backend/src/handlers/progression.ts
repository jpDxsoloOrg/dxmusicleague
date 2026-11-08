// Lazy round auto-advance for timed leagues. There's no scheduler: whenever the
// league or its round is read (and right after a submission/ballot), we check
// whether the current phase should end and advance it — cascading through any
// phases that all elapsed while nobody was looking. Manual leagues are a no-op.
//
// A phase ends when EITHER its deadline passes OR everyone has finished it
// (all members submitted / all members voted). Advancing re-bases the next
// phase's deadline to `phaseDays` from now, so finishing early shortens the
// round instead of leaving dead time. "Everyone" counts only CURRENT members,
// in either format (domain/matchups.ts, "turnout"; in head-to-head voting,
// only those with a matchup to pick in — see below): a departed player's
// songs and ballot stay in the round but never stand in for a member who
// stayed — the phase would close on that member, and a round never moves
// backwards, so they'd be locked out of it (BUG-09 for standard leagues).
//
// The owner can still advance manually in timed mode (rounds.updateRound /
// revealRound) — this just automates it. See memory: round-automation.
//
// Head-to-head (HTH-08): the machinery is format-agnostic — one song and one
// ballot row per member — except for who "everyone" is (domain/matchups.ts,
// "turnout"): a round is done submitting when every CURRENT member has a song
// (a departed player's withdrawn song doesn't stand in for a missing one), and
// done voting when every member who has a matchup to pick in has picked in
// all of them. A round in which nobody can vote (every pair a walkover / no
// contest, or a two-player league whose one matchup is both players' own)
// has nothing to wait for and reveals straight away — in rounds.updateRound
// when the owner opens voting (`revealIfNobodyCanVote`, manual and timed
// leagues alike), and here when a timed round reaches voting by deadline (or
// departures mid-voting leave nobody who can vote) — so it never sits dead
// in voting. Deadlines, cascades and early-advance re-basing need no format
// awareness.

import type { League, Round, Submission } from "../domain/types.ts";
import { leagueFormat } from "../domain/types.ts";
import { everyoneEligibleVoted, membersWithAllSongs, membersWithBallot, membersWithSong } from "../domain/matchups.ts";
import { createPlaylistForRound } from "./providers.ts";
import { finalizeReveal } from "./results.ts";
import { loadVotingTurnout } from "./matchups.ts";
import { phaseDeadline } from "./timing.ts";
import type { Deps } from "./leagues.ts";

const past = (iso?: string): boolean => (iso ? Date.now() > new Date(iso).getTime() : false);

/** Advance a timed league's current round through every phase that's ready
 *  (deadline passed OR everyone finished), persisting as it goes. Returns the
 *  (possibly mutated) round. No-op for manual leagues or when nothing is due. */
export async function autoAdvanceRound(
  deps: Deps,
  league: League,
  round: Round | undefined,
): Promise<Round | undefined> {
  if (!round || league.progression !== "timed" || !league.phaseDays) return round;
  const phaseDays = league.phaseDays;
  let advanced = false;

  // submitting → previewing: deadline passed OR every member has used every
  // submission slot (submissionsPerPlayer picks each).
  if (round.status === "submitting") {
    const subs = await deps.repo.getSubmissionsForRound(round.id);
    const everyoneSubmitted =
      leagueFormat(league) === "headToHead"
        ? everyMemberHasSong(league, subs)
        : everySlotFilled(league, subs);
    const deadlineHit = past(round.submissionDeadline);
    if (deadlineHit || everyoneSubmitted) {
      round.status = "previewing";
      // Everyone finished before the deadline → pull the rest of the schedule
      // forward. Deadline-triggered → keep the schedule so a long-dormant round
      // can cascade through every elapsed phase on a single read.
      if (!deadlineHit) {
        round.previewDeadline = phaseDeadline(phaseDays);
        round.voteDeadline = phaseDeadline(2 * phaseDays);
      }
      if (!round.playlistUrl) {
        try {
          const url = await createPlaylistForRound(league, round, subs);
          if (url) round.playlistUrl = url;
        } catch (err) {
          console.error(`Auto-advance playlist creation failed for round ${round.id}:`, err);
        }
      }
      advanced = true;
    }
  }

  // previewing → voting: only the deadline (listening has no "finished" signal).
  if (round.status === "previewing" && past(round.previewDeadline)) {
    round.status = "voting";
    advanced = true;
  }

  // voting → revealed: deadline passed OR every member voted (with songs to
  // rank). Head-to-head: every member who CAN vote has — vacuously true when
  // nobody can, so a round that just reached voting with nothing to vote on
  // reveals in this same pass instead of hanging until its deadline.
  if (round.status === "voting") {
    const everyoneVoted =
      leagueFormat(league) === "headToHead"
        ? everyoneEligibleVoted(await loadVotingTurnout(deps, league, round))
        : await everyMemberVoted(deps, league, round);
    if (past(round.voteDeadline) || everyoneVoted) {
      await finalizeReveal(deps, round); // tallies, banks points, persists
      return round;
    }
  }

  if (advanced) await persistAdvance(deps, round);
  return round;
}

/** Standard everyone-submitted: every current member has used every one of
 *  their submission slots (BUG-09). Counted by member, not by row, so a
 *  departed player's songs — which still rank — can't fill the slots of a
 *  member who stayed and hasn't submitted yet. */
function everySlotFilled(league: League, subs: Submission[]): boolean {
  const allowance = league.settings.submissionsPerPlayer || 1;
  const members = league.memberIds;
  return members.length > 0 && membersWithAllSongs(members, subs, allowance).length === members.length;
}

/** Head-to-head everyone-submitted: every current member has their one song
 *  (allowance is forced to 1). Counted by member, not by row, so a departed
 *  player's song — withdrawn from their pair — can't close the phase while
 *  a member who stayed hasn't submitted (they'd lose by walkover). */
function everyMemberHasSong(league: League, subs: Submission[]): boolean {
  return league.memberIds.length > 0 && membersWithSong(league.memberIds, subs).length === league.memberIds.length;
}

/** Standard everyone-voted: every current member has a ballot, and there are
 *  songs to rank (BUG-09). A departed player's ballot still scores at the
 *  reveal but doesn't stand in for a member who stayed and hasn't voted. */
async function everyMemberVoted(deps: Deps, league: League, round: Round): Promise<boolean> {
  const [subs, ballots] = await Promise.all([
    deps.repo.getSubmissionsForRound(round.id),
    deps.repo.getBallotsForRound(round.id),
  ]);
  const members = league.memberIds;
  return members.length > 0 && subs.length > 0 && membersWithBallot(members, ballots).length === members.length;
}

/**
 * Head-to-head (HTH-08): reveal a round that has just entered voting if
 * nobody can vote in it — no member has a matchup to pick in (every pair a
 * walkover / no contest, or a two-player league whose one matchup is both
 * players' own). No ballot could ever arrive, so the round goes straight to
 * the reveal, which banks its walkovers (and a two-player league's 0–0 draw)
 * exactly as any reveal does (HTH-07). Used by rounds.updateRound when the
 * owner opens voting; the timed advance above gets the same effect from its
 * everyone-voted check. `round` is the round about to enter voting (status
 * already `voting`, not yet written): `finalizeReveal`'s one conditional
 * write stores it revealed, edits included. Returns whether it revealed (then
 * `round` is the revealed round); a round someone can vote in is untouched.
 * If another reveal settled the round first (a racing PATCH or a timed
 * advance), this request's edits never landed, so it throws the same 409 the
 * H2H round write answers in that race rather than return someone else's
 * round as if the edits had been kept.
 */
export async function revealIfNobodyCanVote(deps: Deps, league: League, round: Round): Promise<boolean> {
  const turnout = await loadVotingTurnout(deps, league, round);
  if (turnout.eligible.length > 0) return false;
  await finalizeReveal(deps, round, { conflictIfSettled: true });
  return true;
}

/** Write an advanced round. The write lands only while the stored round is
 *  unsettled, in either format (HTH-07 head-to-head; BUG-04 standard): this
 *  copy may have been read before another request advanced AND revealed the
 *  round, and writing it back would put the round back in voting — dropping
 *  the reveal's pins (h2hTally / h2hDeparted, or a standard round's
 *  pointsTally) — and let a second reveal bank it twice. If a reveal
 *  won, `round` is brought up to date with the stored, settled round
 *  instead. */
async function persistAdvance(deps: Deps, round: Round): Promise<void> {
  if (await deps.repo.updateRoundUnlessSettled(round)) return;
  const stored = await deps.repo.getRound(round.id, { consistent: true });
  if (stored) Object.assign(round, stored);
}
