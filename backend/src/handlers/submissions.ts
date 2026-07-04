// Submission handlers — submit one song per player per round, and read the
// anonymized list voters choose from. Same shape as the other handlers:
// (deps, caller, ...) over the Repository port, throwing ApiError.
//
// One submission per player is enforced by the storage key (SUB#<userId>), so a
// re-submit overwrites; we keep the original submission id stable so it stays
// opaque and doesn't change underneath a ballot once voting starts.

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
  const existing = await deps.repo.getSubmission(roundId, caller); // stable id across re-submits

  // Reject duplicate songs/artists across the round (ignoring the caller's own pick).
  const others = (await deps.repo.getSubmissionsForRound(roundId)).filter((s) => s.userId !== caller);
  assertNoDuplicate(track, others);

  const submission: Submission = {
    id: existing?.id ?? `sub-${randomUUID()}`,
    roundId,
    userId: caller,
    track,
    comment: optStr(input?.comment?.trim()),
  };
  await deps.repo.putSubmission(submission);
  // Timed leagues: if that was the last member to submit, close submissions now.
  await autoAdvanceRound(deps, league, round);
  return submission;
}

/** The caller's own submission for a round (or null if they haven't picked yet),
 *  so they can see what they chose while waiting for everyone else. Available in
 *  any round status; only requires league membership. */
export async function getMySubmission(
  deps: Deps,
  caller: string,
  roundId: string,
): Promise<Submission | null> {
  await roundForMember(deps, caller, roundId);
  return (await deps.repo.getSubmission(roundId, caller)) ?? null;
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
