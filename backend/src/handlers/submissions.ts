// Submission handlers — submit songs (up to the league's submissionsPerPlayer,
// default 1), remove a pick, and read the anonymized list voters choose from.
// Same shape as the other handlers: (deps, caller, ...) over the Repository
// port, throwing ApiError.
//
// With an allowance of 1 a re-submit REPLACES the existing pick (the original
// UX), keeping the submission id stable so it stays opaque and doesn't change
// underneath a ballot. With a larger allowance each submit ADDS a pick until
// the allowance is full; players remove a pick to change their mind.

import { randomUUID } from "node:crypto";
import type { MusicProviderId, Submission, Track } from "../domain/types.ts";
import { badRequest, forbidden, notFound } from "../domain/errors.ts";
import { autoAdvanceRound } from "./progression.ts";
import type { Deps } from "./leagues.ts";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const optStr = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const deadlinePassed = (iso?: string): boolean => (iso ? Date.now() > new Date(iso).getTime() : false);

/** Keep only the known, normalized Track fields — never store arbitrary input. */
function normalizeTrack(raw: unknown): Track {
  if (!raw || typeof raw !== "object") throw badRequest("Pick a song to submit.");
  const t = raw as Record<string, unknown>;
  if (!str(t.title).trim()) throw badRequest("That track is missing a title.");
  return {
    id: str(t.id),
    provider: str(t.provider) as MusicProviderId,
    providerTrackId: str(t.providerTrackId),
    title: str(t.title),
    artists: Array.isArray(t.artists) ? t.artists.map(str).filter(Boolean) : [],
    album: optStr(t.album),
    artworkUrl: optStr(t.artworkUrl),
    durationMs: typeof t.durationMs === "number" ? t.durationMs : undefined,
    previewUrl: optStr(t.previewUrl),
    externalUrl: optStr(t.externalUrl),
  };
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Block two players from submitting the same song, or two songs by the same
 *  artist, within one round. Compares against everyone else's picks (the caller's
 *  own existing pick is excluded so re-submitting/editing stays allowed). */
function assertNoDuplicate(track: Track, others: Submission[]): void {
  for (const sub of others) {
    const same =
      track.providerTrackId && sub.track.providerTrackId
        ? track.provider === sub.track.provider && track.providerTrackId === sub.track.providerTrackId
        : norm(track.title) === norm(sub.track.title) &&
          track.artists.map(norm).join(",") === sub.track.artists.map(norm).join(",");
    if (same) {
      throw badRequest("That song has already been submitted for this round — pick a different one.");
    }
  }

  const taken = new Set(others.flatMap((s) => s.track.artists.map(norm)));
  const clash = track.artists.find((a) => taken.has(norm(a)));
  if (clash) {
    throw badRequest(`A song by ${clash} is already in this round — each artist can only appear once.`);
  }
}

/** Load a round + its league, asserting the caller is a member of the league. */
async function roundForMember(deps: Deps, caller: string, roundId: string) {
  const round = await deps.repo.getRound(roundId);
  if (!round) throw notFound("That round doesn't exist.");
  const league = await deps.repo.getLeague(round.leagueId);
  if (!league || !league.memberIds.includes(caller)) {
    throw forbidden("You're not a member of this league.");
  }
  return { round, league };
}

export interface SubmitInput {
  track: unknown;
  comment?: string;
}

export async function submitSong(
  deps: Deps,
  caller: string,
  roundId: string,
  input: SubmitInput,
): Promise<Submission> {
  const { round, league } = await roundForMember(deps, caller, roundId);
  if (round.status !== "submitting") throw badRequest("This round isn't accepting submissions right now.");
  if (deadlinePassed(round.submissionDeadline)) throw badRequest("The submission deadline has passed.");

  const track = normalizeTrack(input?.track);
  const allowance = league.settings.submissionsPerPlayer || 1;
  const mine = await deps.repo.getSubmissionsForUser(roundId, caller);

  // Allowance of 1 → a re-submit replaces the pick (stable id). Larger
  // allowance → each submit adds a pick; at the cap, ask them to remove one.
  const replacing = allowance === 1 ? mine[0] : undefined;
  if (!replacing && mine.length >= allowance) {
    throw badRequest(
      `You've already submitted ${allowance} songs for this round — remove one to change your picks.`,
    );
  }

  // Reject duplicate songs/artists across the round. The caller's other picks
  // count too (no self-duplicates); only the pick being replaced is exempt.
  const all = await deps.repo.getSubmissionsForRound(roundId);
  assertNoDuplicate(track, all.filter((s) => s.id !== replacing?.id));

  const submission: Submission = {
    id: replacing?.id ?? `sub-${randomUUID()}`,
    roundId,
    userId: caller,
    track,
    comment: optStr(input?.comment?.trim()),
  };
  await deps.repo.putSubmission(submission);
  // Timed leagues: if that filled the last open slot, close submissions now.
  await autoAdvanceRound(deps, league, round);
  return submission;
}

/** Remove one of the caller's own picks while the round is still submitting. */
export async function removeSubmission(
  deps: Deps,
  caller: string,
  roundId: string,
  submissionId: string,
): Promise<{ ok: true }> {
  const { round } = await roundForMember(deps, caller, roundId);
  if (round.status !== "submitting") throw badRequest("Picks are locked once submissions close.");
  if (deadlinePassed(round.submissionDeadline)) throw badRequest("The submission deadline has passed.");

  const mine = await deps.repo.getSubmissionsForUser(roundId, caller);
  if (!mine.some((s) => s.id === submissionId)) throw notFound("That submission isn't yours to remove.");
  await deps.repo.deleteSubmission(roundId, caller, submissionId);
  return { ok: true };
}

/** The caller's own submissions for a round (empty if they haven't picked yet),
 *  so they can see what they chose while waiting for everyone else. Available in
 *  any round status; only requires league membership. */
export async function getMySubmissions(
  deps: Deps,
  caller: string,
  roundId: string,
): Promise<Submission[]> {
  await roundForMember(deps, caller, roundId);
  return deps.repo.getSubmissionsForUser(roundId, caller);
}

/** The anonymized song list — every submission except the caller's own, with no
 *  submitter identity. Available once submissions close: during `previewing`
 *  (listen to the playlist) and `voting`. */
export async function listVotableSubmissions(
  deps: Deps,
  caller: string,
  roundId: string,
): Promise<Array<{ id: string; track: Track }>> {
  const { round } = await roundForMember(deps, caller, roundId);
  if (round.status !== "previewing" && round.status !== "voting") {
    throw badRequest("The songs aren't revealed yet for this round.");
  }

  const subs = await deps.repo.getSubmissionsForRound(roundId);
  return subs
    .filter((s) => s.userId !== caller)
    .map((s) => ({ id: s.id, track: s.track }));
}
