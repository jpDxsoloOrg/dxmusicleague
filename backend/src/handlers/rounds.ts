// Round lifecycle handlers — create a round and advance its status. Owner-only,
// plain CRUD over the Repository port (no rules engine). Same shape as the
// league handlers: (deps, caller, ...input) -> result, throwing ApiError.
//
// Lifecycle this slice covers: draft -> submitting -> voting. `revealed` is
// reached only via the (future) reveal endpoint, never a raw status change —
// with one head-to-head exception (HTH-08): opening voting on a round nobody
// can vote in reveals it on the spot (progression.ts `revealIfNobodyCanVote`).
//
// Head-to-head leagues (HTH-03): opening round 1 (draft -> submitting) freezes
// the season — see `freezeSeasonIfNeeded`. This PATCH is the ONLY place any
// round leaves draft (createRound only makes drafts; the timed auto-advance in
// progression.ts starts from submitting — the owner opens every round, timed
// or manual), so the one hook catches every league.

import { randomInt } from "node:crypto";
import type { League, Round, RoundStatus } from "../domain/types.ts";
import { leagueFormat } from "../domain/types.ts";
import { badRequest, conflict, forbidden, notFound } from "../domain/errors.ts";
import { roundSettled } from "../domain/matchups.ts";
import {
  H2H_MIN_PLAYERS_MESSAGE,
  H2H_ROUND_ONE_FIRST_MESSAGE,
  MIN_H2H_PLAYERS,
  membersOutsideOrder,
  planSeasonFreeze,
  seasonLocked,
} from "../domain/freeze.ts";
import type { RandomInt } from "../domain/freeze.ts";
import { createPlaylistForRound } from "./providers.ts";
import { revealIfNobodyCanVote } from "./progression.ts";
import { phaseDeadline } from "./timing.ts";
import type { Deps } from "./leagues.ts";

/** Round ids encode their league + 1-based index as `<leagueId>~<index4>`,
 *  matching DynamoRepository's key layout so both stores agree. */
function makeRoundId(leagueId: string, index: number): string {
  return `${leagueId}~${String(index).padStart(4, "0")}`;
}

/** Load the league and assert the caller owns it. */
async function requireOwnedLeague(deps: Deps, caller: string, leagueId: string) {
  const league = await deps.repo.getLeague(leagueId);
  if (!league) throw notFound("That league doesn't exist.");
  if (league.ownerId !== caller) throw forbidden("Only the league owner can manage rounds.");
  return league;
}

export interface CreateRoundInput {
  theme: string;
  description?: string;
  submissionDeadline?: string;
  voteDeadline?: string;
}

export async function createRound(
  deps: Deps,
  caller: string,
  leagueId: string,
  input: CreateRoundInput,
): Promise<Round> {
  const league = await requireOwnedLeague(deps, caller, leagueId);

  const theme = (input?.theme ?? "").trim();
  if (!theme) throw badRequest("Give the round a theme.");

  const existing = await deps.repo.getRoundsForLeague(leagueId);
  const index = existing.reduce((max, r) => Math.max(max, r.index), 0) + 1;

  // Head-to-head: the season's length isn't known until round 1 opens and
  // freezes the field (roundCount = schedule length), so no later round may
  // exist before then — otherwise a pre-made round could sit beyond the
  // schedule. After the freeze the roundCount cap below does the job.
  if (leagueFormat(league) === "headToHead" && index > 1 && !seasonLocked(league)) {
    throw badRequest(H2H_ROUND_ONE_FIRST_MESSAGE);
  }

  // The league closes after its planned rounds — no round N+1. Once the last
  // round reveals, the league is finished and the owner starts a rematch instead.
  if (league.roundCount && index > league.roundCount) {
    throw badRequest(
      `This league was set to ${league.roundCount} round${league.roundCount === 1 ? "" : "s"} and they've all been created — start a rematch to keep playing.`,
    );
  }

  const round: Round = {
    id: makeRoundId(leagueId, index),
    leagueId,
    index,
    theme,
    description: input.description?.trim() || undefined,
    status: "draft",
    submissionDeadline: input.submissionDeadline,
    voteDeadline: input.voteDeadline,
  };
  await deps.repo.createRound(round);
  return round;
}

// The only status moves a PATCH may make. `revealed`/`complete` are off-limits
// here (reveal endpoint owns them); nothing moves backwards or skips a step.
// submitting → previewing is where the playlist gets created (later slice).
const ALLOWED_NEXT: Record<RoundStatus, RoundStatus[]> = {
  draft: ["submitting"],
  submitting: ["previewing"],
  previewing: ["voting"],
  voting: [],
  revealed: [],
  complete: [],
};

export interface UpdateRoundInput {
  status?: RoundStatus;
  theme?: string;
  description?: string;
  submissionDeadline?: string;
  voteDeadline?: string;
}

export async function updateRound(
  deps: Deps,
  caller: string,
  leagueId: string,
  roundId: string,
  input: UpdateRoundInput,
): Promise<Round> {
  const league = await requireOwnedLeague(deps, caller, leagueId);

  const round = await deps.repo.getRound(roundId);
  if (!round || round.leagueId !== leagueId) throw notFound("That round doesn't exist.");
  const opening = input.status === "submitting" && round.status === "draft";
  const openingVoting = input.status === "voting" && round.status === "previewing";
  const settledWhenRead = roundSettled(round);

  if (input.status && input.status !== round.status) {
    if (input.status === "revealed" || input.status === "complete") {
      throw badRequest("Reveal a round with the reveal endpoint, not a status change.");
    }
    if (!ALLOWED_NEXT[round.status].includes(input.status)) {
      throw badRequest(`Can't move a ${round.status} round to ${input.status}.`);
    }
    round.status = input.status;

    // Submissions close → build the round's public playlist from its songs.
    // Best-effort: a Spotify hiccup shouldn't block the round from advancing.
    if (input.status === "previewing" && !round.playlistUrl) {
      try {
        const subs = await deps.repo.getSubmissionsForRound(round.id);
        const url = await createPlaylistForRound(league, round, subs);
        if (url) round.playlistUrl = url;
      } catch (err) {
        console.error(`Playlist creation failed for round ${round.id}:`, err);
      }
    }

    // Timed mode: stamp the ENTERING phase's deadline (phaseDays from when it
    // begins). Each phase's clock is set as it starts, so advancing early — by
    // the owner here, or by auto-advance — re-bases the next deadline instead of
    // keeping stale fixed times. Round 1 is anchored no earlier than startAt.
    if (league.progression === "timed" && league.phaseDays) {
      const p = league.phaseDays;
      if (input.status === "submitting") {
        // Opening a round lays down the full schedule for all three phases.
        const startFloor = league.startAt ? new Date(league.startAt).getTime() : 0;
        const anchor = Math.max(Date.now(), Number.isNaN(startFloor) ? 0 : startFloor);
        round.submissionDeadline = phaseDeadline(p, anchor);
        round.previewDeadline = phaseDeadline(2 * p, anchor);
        round.voteDeadline = phaseDeadline(3 * p, anchor);
      } else if (input.status === "previewing") {
        // Owner closed submissions early → shift the rest of the schedule to now.
        round.previewDeadline = phaseDeadline(p);
        round.voteDeadline = phaseDeadline(2 * p);
      } else if (input.status === "voting") {
        round.voteDeadline = phaseDeadline(p);
      }
    }
  }

  if (input.theme !== undefined) {
    const theme = input.theme.trim();
    if (!theme) throw badRequest("Theme can't be empty.");
    round.theme = theme;
  }
  if (input.description !== undefined) round.description = input.description.trim() || undefined;
  if (input.submissionDeadline !== undefined) round.submissionDeadline = input.submissionDeadline;
  if (input.voteDeadline !== undefined) round.voteDeadline = input.voteDeadline;

  // Head-to-head: a round leaving draft freezes the season (round 1) or must
  // find it already frozen (any later round). Last of all the checks, so a
  // PATCH refused for any other reason freezes nothing; and before the round
  // write, so a refused open leaves the round in draft.
  if (opening && leagueFormat(league) === "headToHead") await freezeSeasonIfNeeded(deps, league, round);

  // Head-to-head (HTH-08): opening voting on a round nobody can vote in (all
  // walkovers / no contests, or a two-player league's one matchup) reveals it
  // on the spot instead — its one conditional write stores the round
  // revealed, this PATCH's edits included, and banks the W/L/D. Otherwise no
  // ballot could ever arrive and the round would sit in voting. If another
  // reveal got there first, the edits didn't land: 409, as below.
  if (openingVoting && leagueFormat(league) === "headToHead" && (await revealIfNobodyCanVote(deps, league, round))) {
    return round;
  }

  // An edit built from a round read before its reveal must not be written
  // back over the reveal — it would put the round back in voting (and drop
  // the reveal's pins: h2hDeparted / h2hTally head to head, pointsTally on a
  // standard round), letting a second reveal bank its W/L/D (HTH-07) or
  // points (BUG-04) twice: say, an owner extending the vote deadline just as
  // it expires while a member's page load reveals the round. So such a write
  // lands only while the round is still unsettled; if a reveal got there
  // first, the edit is refused. (The write is refused too if the league was
  // deleted under this PATCH — it never recreates a deleted round — so a
  // refusal checks which: 404 if the round is gone.) An edit of a round read
  // already settled (a theme fix after the reveal) is an ordinary write, as
  // before, and keeps the pins.
  if (!settledWhenRead) {
    if (!(await deps.repo.updateRoundUnlessSettled(round))) {
      if (!(await deps.repo.getRound(round.id, { consistent: true }))) throw notFound("That round doesn't exist.");
      throw conflict("That round was just revealed. Reload to see the results.");
    }
    return round;
  }
  await deps.repo.updateRound(round);
  return round;
}

/**
 * The head-to-head season freeze, run as a round leaves draft. On round 1 of
 * an un-frozen H2H league: shuffle the current members into the frozen
 * participant order, draw the schedule salt, and set roundCount to the
 * round-robin length — overriding whatever the owner typed at creation, since
 * "everyone faces everyone once" is the format's contract (createRound's cap
 * then ends the season on schedule). From then on every round's pairings are
 * pure derivation (domain/schedule.ts) and joining is closed (leagues.ts).
 *
 * Freeze is once: an already-frozen league is left untouched, so re-opening
 * or advancing later rounds never re-shuffles, and the repo's conditional
 * write makes a concurrent double-open settle on one shuffle (the first).
 * The one exception is settleRoundOneOrder's re-plan to take in a late
 * joiner — still inside the opening request, before round 1 is written.
 */
async function freezeSeasonIfNeeded(deps: Deps, league: League, round: Round): Promise<void> {
  if (round.index !== 1) {
    // A later round of a frozen season: the order stands. Of an un-frozen
    // one: unreachable through createRound's guard (no round 2 exists before
    // the freeze) — a defensive check against hand-edited data.
    if (!seasonLocked(league)) throw badRequest(H2H_ROUND_ONE_FIRST_MESSAGE);
    return;
  }
  // The feature's single source of randomness (crypto-quality in production:
  // the salt must be unguessable); tests seed it through deps.
  const rng = deps.randomInt ?? randomInt;
  if (!seasonLocked(league)) {
    if (league.memberIds.length < MIN_H2H_PLAYERS) throw badRequest(H2H_MIN_PLAYERS_MESSAGE);
    // Won or lost (a concurrent open froze first, or the league is gone), the
    // check below settles what's stored.
    await deps.repo.freezeH2HSeason(league.id, planSeasonFreeze(league.memberIds, rng));
  }
  await settleRoundOneOrder(deps, league.id, rng);
}

/** Bound on the re-plan loop below; two passes always suffice (see there). */
const MAX_ORDER_SETTLES = 3;

/**
 * Round 1 is opening and the season should now be frozen — by this request, a
 * concurrent open, or an earlier attempt whose round write never landed.
 * Confirm it from a strongly consistent read, and make sure the frozen order
 * holds every member.
 *
 * The order was planned from the member list read at the start of the PATCH.
 * A newcomer's join can commit after that read but before the freeze write
 * (its own "season open?" check passed against the un-frozen league); every
 * later join is refused atomically by the repo's season-gated join. So the
 * only members the order can lack are those few, and the set is final once
 * the freeze has landed. Round 1 isn't written yet, so no pairing has been
 * derived from the order: take them in by re-planning the whole order (fresh
 * shuffle and salt, roundCount for the bigger field), conditional on the salt
 * just read. A concurrent opener doing the same may win that write; the next
 * pass then finds nobody missing — joins are already closed.
 */
async function settleRoundOneOrder(deps: Deps, leagueId: string, rng: RandomInt): Promise<void> {
  for (let pass = 0; pass < MAX_ORDER_SETTLES; pass++) {
    const stored = await deps.repo.getLeague(leagueId, { consistent: true });
    // Deleted mid-open: don't write a round for it.
    if (!stored) throw notFound("That league doesn't exist.");
    // A freeze attempt (ours or a racer's) always leaves a frozen season —
    // the repos' write conditions and seasonLocked share one definition. If
    // not, something is badly off: fail loudly rather than open round 1 on
    // an un-frozen league, which could never freeze afterwards.
    if (!seasonLocked(stored)) throw new Error(`Head-to-head league ${leagueId}: opening round 1 didn't freeze the season.`);
    const late = membersOutsideOrder(stored);
    if (late.length === 0) return;
    if (!stored.h2hSalt) throw new Error(`Head-to-head league ${leagueId}: frozen without a schedule salt.`);
    const replan = planSeasonFreeze([...stored.h2hParticipants!, ...late], rng);
    if (await deps.repo.freezeH2HSeason(leagueId, replan, stored.h2hSalt)) return;
  }
  throw new Error(`Head-to-head league ${leagueId}: the round-1 order didn't settle.`);
}
