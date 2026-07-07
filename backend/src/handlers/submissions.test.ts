// Submission handler tests — duplicate song/artist guard within a round.
// Uses the seeded MemoryRepository (lg-synthwave, round r-sw-3 is "submitting").

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository, MemoryUserDirectory } from "../data/memory.ts";
import { DEFAULT_LEAGUE_SETTINGS } from "../domain/types.ts";
import { getMySubmissions, removeSubmission, submitSong } from "./submissions.ts";
import type { Deps } from "./leagues.ts";

const ROUND = "r-test"; // an open round with no deadline (created fresh per test)

/** Fresh deps with a league (members u-sarah & u-james) and an open round. */
async function deps(submissionsPerPlayer = 1): Promise<Deps> {
  const repo = new MemoryRepository(false); // no seed — fully isolated
  await repo.createLeague({
    id: "lg-test", name: "Test", ownerId: "u-sarah", musicProvider: "youtube-music",
    settings: { ...DEFAULT_LEAGUE_SETTINGS, submissionsPerPlayer }, memberIds: ["u-sarah", "u-james"], inviteCode: "TEST-1",
    visibility: "private", roundCount: 5, progression: "manual",
  });
  await repo.createRound({ id: ROUND, leagueId: "lg-test", index: 1, theme: "Theme", status: "submitting" });
  return { repo, users: new MemoryUserDirectory() };
}

const track = (over: Partial<{ id: string; providerTrackId: string; title: string; artists: string[] }> = {}) => ({
  id: over.id ?? "t1",
  provider: "youtube-music",
  providerTrackId: over.providerTrackId ?? "yt1",
  title: over.title ?? "Midnight City",
  artists: over.artists ?? ["M83"],
});

test("blocks a second player submitting the same song", async () => {
  const d = await deps();
  await submitSong(d, "u-sarah", ROUND, { track: track() });
  await assert.rejects(
    () => submitSong(d, "u-james", ROUND, { track: track() }),
    /already been submitted/,
  );
});

test("getMySubmissions returns the caller's own picks, empty before submitting", async () => {
  const d = await deps();
  assert.deepEqual(await getMySubmissions(d, "u-sarah", ROUND), []);
  await submitSong(d, "u-sarah", ROUND, { track: track({ title: "Outro" }) });
  const mine = await getMySubmissions(d, "u-sarah", ROUND);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]?.track.title, "Outro");
  // Another member who hasn't submitted still sees nothing (only their own).
  assert.deepEqual(await getMySubmissions(d, "u-james", ROUND), []);
});

test("blocks a second player submitting a different song by the same artist", async () => {
  const d = await deps();
  await submitSong(d, "u-sarah", ROUND, { track: track() });
  await assert.rejects(
    () => submitSong(d, "u-james", ROUND, { track: track({ providerTrackId: "yt2", title: "Reunion" }) }),
    /each artist can only appear once/,
  );
});

test("allows a different song by a different artist", async () => {
  const d = await deps();
  await submitSong(d, "u-sarah", ROUND, { track: track() });
  const sub = await submitSong(d, "u-james", ROUND, {
    track: track({ providerTrackId: "yt9", title: "Resonance", artists: ["HOME"] }),
  });
  assert.equal(sub.track.title, "Resonance");
});

test("allowance 1: re-submitting replaces the pick and keeps its id stable", async () => {
  const d = await deps();
  const first = await submitSong(d, "u-sarah", ROUND, { track: track() });
  const again = await submitSong(d, "u-sarah", ROUND, { track: track({ title: "Midnight City (edit)" }) });
  assert.equal(again.id, first.id); // stable so ballots can't be pulled out from under
  const mine = await getMySubmissions(d, "u-sarah", ROUND);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]?.track.title, "Midnight City (edit)");
});

test("allowance 2: a player can add two picks; the third is rejected", async () => {
  const d = await deps(2);
  await submitSong(d, "u-sarah", ROUND, { track: track() });
  await submitSong(d, "u-sarah", ROUND, { track: track({ providerTrackId: "yt2", title: "Resonance", artists: ["HOME"] }) });
  await assert.rejects(
    () => submitSong(d, "u-sarah", ROUND, { track: track({ providerTrackId: "yt3", title: "Solar", artists: ["Betamaxx"] }) }),
    /remove one/,
  );
  assert.equal((await getMySubmissions(d, "u-sarah", ROUND)).length, 2);
});

test("allowance 2: a player can't submit two songs by the same artist", async () => {
  const d = await deps(2);
  await submitSong(d, "u-sarah", ROUND, { track: track() });
  await assert.rejects(
    () => submitSong(d, "u-sarah", ROUND, { track: track({ providerTrackId: "yt2", title: "Reunion" }) }),
    /each artist can only appear once/,
  );
});

test("removeSubmission frees a slot and rejects removing someone else's pick", async () => {
  const d = await deps(2);
  const sub = await submitSong(d, "u-sarah", ROUND, { track: track() });
  await assert.rejects(() => removeSubmission(d, "u-james", ROUND, sub.id), /isn't yours/);
  await removeSubmission(d, "u-sarah", ROUND, sub.id);
  assert.deepEqual(await getMySubmissions(d, "u-sarah", ROUND), []);
  // The slot (and the artist) are free again.
  await submitSong(d, "u-sarah", ROUND, { track: track({ providerTrackId: "yt5", title: "Reunion" }) });
});
