// Results tests — both comment kinds ride along: the submitter's own note
// (written at submit time) and voters' per-song ballot comments.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository, MemoryUserDirectory } from "../data/memory.ts";
import { DEFAULT_LEAGUE_SETTINGS } from "../domain/types.ts";
import { computeResults } from "./results.ts";
import type { Deps } from "./leagues.ts";

const ROUND = "r-test";

async function deps(): Promise<Deps> {
  const repo = new MemoryRepository(false);
  await repo.createLeague({
    id: "lg-test", name: "Test", ownerId: "u-sarah", musicProvider: "spotify",
    settings: DEFAULT_LEAGUE_SETTINGS, memberIds: ["u-sarah", "u-james"], inviteCode: "TEST-1",
    visibility: "private", roundCount: 3, progression: "manual",
  });
  await repo.createRound({ id: ROUND, leagueId: "lg-test", index: 1, theme: "Theme", status: "voting" });
  return { repo, users: new MemoryUserDirectory() };
}

test("results include the submitter's note and voter comments", async () => {
  const d = await deps();
  await d.repo.putSubmission({
    id: "sub-a", roundId: ROUND, userId: "u-sarah",
    track: { id: "t1", provider: "spotify", providerTrackId: "sp1", title: "Song A", artists: ["A"] },
    comment: "This one got me through finals week.",
  });
  await d.repo.putSubmission({
    id: "sub-b", roundId: ROUND, userId: "u-james",
    track: { id: "t2", provider: "spotify", providerTrackId: "sp2", title: "Song B", artists: ["B"] },
    // no submitter note on this one
  });
  await d.repo.putBallot({
    roundId: ROUND, voterId: "u-james",
    allocations: { "sub-a": 10 },
    comments: { "sub-a": "Great pick!" },
    castAt: "2026-07-08T00:00:00.000Z",
  });

  const results = await computeResults(d, ROUND);
  const a = results.find((r) => r.track.title === "Song A")!;
  const b = results.find((r) => r.track.title === "Song B")!;
  assert.equal(a.submitterComment, "This one got me through finals week.");
  assert.deepEqual(a.comments.map((c) => c.text), ["Great pick!"]);
  assert.equal(b.submitterComment, undefined);
  assert.deepEqual(b.comments, []);
});
