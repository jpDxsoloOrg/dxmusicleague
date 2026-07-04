// Round lifecycle handlers — create a round and advance its status. Owner-only,
// plain CRUD over the Repository port (no rules engine). Same shape as the
// league handlers: (deps, caller, ...input) -> result, throwing ApiError.
//
// Lifecycle this slice covers: draft -> submitting -> voting. `revealed` is
// reached only via the (future) reveal endpoint, never a raw status change.

import type { Round, RoundStatus } from "../domain/types.ts";
import { badRequest, forbidden, notFound } from "../domain/errors.ts";
import { createPlaylistForRound } from "./providers.ts";
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
  await requireOwnedLeague(deps, caller, leagueId);

  const theme = (input?.theme ?? "").trim();
  if (!theme) throw badRequest("Give the round a theme.");

  const existing = await deps.repo.getRoundsForLeague(leagueId);
  const index = existing.reduce((max, r) => Math.max(max, r.index), 0) + 1;

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

  await deps.repo.updateRound(round);
  return round;
}
