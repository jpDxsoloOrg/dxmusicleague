// Submission handler tests — duplicate song/artist guard within a round.
// Uses the seeded MemoryRepository (lg-synthwave, round r-sw-3 is "submitting").

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository, MemoryUserDirectory } from "../data/memory.ts";
import { DEFAULT_LEAGUE_SETTINGS } from "../domain/types.ts";
import { submitSong } from "./submissions.ts";
import type { Deps } from "./leagues.ts";

const ROUND = "r-test"; // an open round with no deadline (created fresh per test)

/** Fresh deps with a league (members u-sarah & u-james) and an open round. */
async function deps(): Promise<Deps> {
  const repo = new MemoryRepository(false); // no seed — fully isolated
  await repo.createLeague({
    id: "lg-test", name: "Test", ownerId: "u-sarah", musicProvider: "youtube-music",
    settings: DEFAULT_LEAGUE_SETTINGS, memberIds: ["u-sarah", "u-james"], inviteCode: "TEST-1",
    visibility: "private", roundCount: 5,
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

test("lets the same player re-submit (edit) their own pick", async () => {
  const d = await deps();
  await submitSong(d, "u-sarah", ROUND, { track: track() });
  const again = await submitSong(d, "u-sarah", ROUND, { track: track({ title: "Midnight City (edit)" }) });
  assert.equal(again.userId, "u-sarah");
});
