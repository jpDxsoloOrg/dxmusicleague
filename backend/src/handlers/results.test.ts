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

test("getMyBallot returns the cast ballot (points + comments), null before voting", async () => {
  const { getMyBallot, castBallot } = await import("./voting.ts");
  const d = await deps();
  await d.repo.putSubmission({
    id: "sub-a", roundId: ROUND, userId: "u-sarah",
    track: { id: "t1", provider: "spotify", providerTrackId: "sp1", title: "Song A", artists: ["A"] },
  });
  await d.repo.putSubmission({
    id: "sub-b", roundId: ROUND, userId: "u-owner",
    track: { id: "t2", provider: "spotify", providerTrackId: "sp2", title: "Song B", artists: ["B"] },
  });

  assert.equal(await getMyBallot(d, "u-james", ROUND), null);
  // Full 10-point pool, respecting the 5-per-song cap.
  await castBallot(d, "u-james", ROUND, {
    allocations: { "sub-a": 5, "sub-b": 5 },
    comments: { "sub-a": "Banger." },
  });
  const mine = await getMyBallot(d, "u-james", ROUND);
  assert.deepEqual(mine, { allocations: { "sub-a": 5, "sub-b": 5 }, downvotes: {}, comments: { "sub-a": "Banger." } });
});

test("anti-votes subtract at tally (can go negative) and bank to standings", async () => {
  const { castBallot } = await import("./voting.ts");
  const { finalizeReveal } = await import("./results.ts");
  const d = await deps();
  // Give the league anti-votes (pool of 2 per voter).
  const lg = (await d.repo.getLeague("lg-test"))!;
  await d.repo.updateLeagueSettings("lg-test", { ...lg.settings, downvotePoolSize: 2 });

  await d.repo.putSubmission({
    id: "sub-a", roundId: ROUND, userId: "u-sarah",
    track: { id: "t1", provider: "spotify", providerTrackId: "sp1", title: "Song A", artists: ["A"] },
  });
  await d.repo.putSubmission({
    id: "sub-b", roundId: ROUND, userId: "u-james",
    track: { id: "t2", provider: "spotify", providerTrackId: "sp2", title: "Song B", artists: ["B"] },
  });
  await d.repo.putSubmission({
    id: "sub-c", roundId: ROUND, userId: "u-3",
    track: { id: "t3", provider: "spotify", providerTrackId: "sp3", title: "Song C", artists: ["C"] },
  });

  // James: full pool on the others' songs, plus both anti-votes on Song A.
  await castBallot(d, "u-james", ROUND, {
    allocations: { "sub-a": 5, "sub-c": 5 },
    downvotes: { "sub-a": 2 },
  });
  await castBallot(d, "u-sarah", ROUND, { allocations: { "sub-b": 5, "sub-c": 5 } });

  const round = (await d.repo.getRound(ROUND))!;
  const results = await finalizeReveal(d, round);
  const a = results.find((r) => r.track.title === "Song A")!;
  assert.equal(a.points, 3); // 5 - 2
  assert.equal(a.pointsFor, 5);
  assert.equal(a.pointsAgainst, 2);

  const standings = await d.repo.getStandings("lg-test");
  assert.equal(standings.find((s) => s.userId === "u-sarah")?.points, 3);
});

test("anti-votes beyond the pool, on own song, or in a league without them are rejected", async () => {
  const { castBallot } = await import("./voting.ts");
  const d = await deps();
  const lg = (await d.repo.getLeague("lg-test"))!;
  await d.repo.putSubmission({
    id: "sub-a", roundId: ROUND, userId: "u-sarah",
    track: { id: "t1", provider: "spotify", providerTrackId: "sp1", title: "Song A", artists: ["A"] },
  });
  await d.repo.putSubmission({
    id: "sub-b", roundId: ROUND, userId: "u-james",
    track: { id: "t2", provider: "spotify", providerTrackId: "sp2", title: "Song B", artists: ["B"] },
  });

  await d.repo.putSubmission({
    id: "sub-c", roundId: ROUND, userId: "u-3",
    track: { id: "t3", provider: "spotify", providerTrackId: "sp3", title: "Song C", artists: ["C"] },
  });

  // Pool of 0 (default): any anti-vote is rejected.
  await assert.rejects(
    castBallot(d, "u-james", ROUND, { allocations: { "sub-a": 5, "sub-c": 5 }, downvotes: { "sub-a": 1 } }),
    /doesn't use anti-votes/,
  );

  await d.repo.updateLeagueSettings("lg-test", { ...lg.settings, downvotePoolSize: 2 });
  // Over the pool.
  await assert.rejects(
    castBallot(d, "u-james", ROUND, { allocations: { "sub-a": 5, "sub-c": 5 }, downvotes: { "sub-a": 3 } }),
    /at most 2 anti-votes/,
  );
  // Own song.
  await assert.rejects(
    castBallot(d, "u-james", ROUND, { allocations: { "sub-a": 5, "sub-c": 5 }, downvotes: { "sub-b": 1 } }),
    /anti-vote your own/,
  );
});
