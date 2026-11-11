// Submission handler tests — duplicate song/artist guard within a round, and
// (BUG-01) that the anonymous song list's order says nothing about who
// submitted what. Uses unseeded MemoryRepository fixtures.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository, MemoryUserDirectory } from "../data/memory.ts";
import { DEFAULT_LEAGUE_SETTINGS, H2H_FORCED_SETTINGS } from "../domain/types.ts";
import type { League, Submission } from "../domain/types.ts";
import { getMySubmissions, listVotableSubmissions, removeSubmission, submitSong } from "./submissions.ts";
import type { Deps } from "./leagues.ts";

const ROUND = "r-test"; // an open round with no deadline (created fresh per test)

/** Fresh deps with a league (members u-sarah & u-james) and an open round. */
async function deps(submissionsPerPlayer = 1): Promise<Deps> {
  const repo = new MemoryRepository(false); // no seed — fully isolated
  await repo.createLeague({
    id: "lg-test", name: "Test", ownerId: "u-sarah", musicProvider: "youtube-music", format: "standard",
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

// ---- BUG-01: the anonymous list's order names nobody -----------------------
// Repository order follows the submitter: MemoryRepository reads in insertion
// (= submission) order, DynamoDB in sort-key order, SK = SUB#<userId>#<subId>
// — i.e. by user id, the same every round. Either one, laid next to the
// activity feed or a revealed round, says whose song sits where (and in a
// head-to-head round, next to GET /matchups, who plays whom). The list must
// come out in submission-id order instead: random per round, stable within it.

const VIEWER = "u-ana";
const PLAYERS = [VIEWER, "u-ben", "u-cyd", "u-dot", "u-eli"];
/** Written in this order, with these ids. The others' id order (cyd, eli,
 *  ben, dot) differs at every position from both their write order (dot, ben,
 *  eli, cyd) and their user-id order (ben, cyd, dot, eli). */
const WRITES: Array<[userId: string, id: string]> = [
  ["u-dot", "sub-c41f"], ["u-ben", "sub-9a6e"], [VIEWER, "sub-e07a"], ["u-eli", "sub-3f8a"], ["u-cyd", "sub-0d93"],
];

/** DynamoDB's read order (ascending SK) over the in-memory store. */
class SortKeyOrderRepository extends MemoryRepository {
  override async getSubmissionsForRound(roundId: string): Promise<Submission[]> {
    const sk = (s: Submission) => `SUB#${s.userId}#${s.id}`;
    return (await super.getSubmissionsForRound(roundId)).sort((a, b) => (sk(a) < sk(b) ? -1 : sk(a) > sk(b) ? 1 : 0));
  }
}

/** A league of PLAYERS (standard, or head-to-head with its season frozen),
 *  `memberIds` defaulting to everyone, with every WRITES row stored as-is in
 *  a round at `status`. */
async function orderFixture(
  repo: MemoryRepository,
  format: "standard" | "headToHead",
  status: "previewing" | "voting",
  memberIds = PLAYERS,
): Promise<{ deps: Deps; subs: Map<string, Submission> }> {
  const league: League = {
    id: "lg-order", name: "Order", ownerId: VIEWER, musicProvider: "mock", format,
    settings: format === "headToHead" ? { ...DEFAULT_LEAGUE_SETTINGS, ...H2H_FORCED_SETTINGS } : { ...DEFAULT_LEAGUE_SETTINGS },
    memberIds: [...memberIds], inviteCode: "ORDER-1", visibility: "private", roundCount: 3, progression: "manual",
    ...(format === "headToHead" ? { h2hParticipants: [...PLAYERS], h2hSalt: "0123456789abcdef0123456789abcdef" } : {}),
  };
  await repo.createLeague(league);
  await repo.createRound({ id: ROUND, leagueId: league.id, index: 1, theme: "Theme", status });
  const subs = new Map<string, Submission>();
  for (const [i, [userId, id]] of WRITES.entries()) {
    const sub: Submission = {
      id, roundId: ROUND, userId, comment: `note from ${userId}`, submittedAt: new Date(Date.UTC(2026, 10, 1, 12, i)).toISOString(),
      track: { id: `mock:t${i}`, provider: "mock", providerTrackId: `t${i}`, title: `Song ${i}`, artists: [`Artist ${i}`] },
    };
    await repo.putSubmission(sub);
    subs.set(id, sub);
  }
  return { deps: { repo, users: new MemoryUserDirectory() }, subs };
}

/** The two repository read orders the list must not follow. */
const READ_ORDERS = [
  { name: "insertion order (MemoryRepository)", make: () => new MemoryRepository(false) },
  { name: "user-id sort-key order (DynamoDB)", make: () => new SortKeyOrderRepository(false) },
];

/** The ids `viewer` must be shown (everyone else's, minus `withdrawn`), id-sorted. */
const expectedIds = (viewer: string, withdrawn: string[] = []) =>
  WRITES.filter(([userId]) => userId !== viewer && !withdrawn.includes(userId)).map(([, id]) => id).sort();
/** That list as the endpoint sends it: anonymized songs. */
const expectedList = (subs: Map<string, Submission>, ids: string[]) => ids.map((id) => ({ id, track: subs.get(id)!.track }));

for (const format of ["standard", "headToHead"] as const) {
  for (const order of READ_ORDERS) {
    test(`${format}, ${order.name}: the anonymous list comes out in submission-id order`, async () => {
      for (const status of ["previewing", "voting"] as const) {
        const repo = order.make();
        const { deps, subs } = await orderFixture(repo, format, status);
        // The fixture really is out of id order as the repository reads it.
        assert.notDeepEqual((await repo.getSubmissionsForRound(ROUND)).map((s) => s.id), WRITES.map(([, id]) => id).sort(), status);

        const list = await listVotableSubmissions(deps, VIEWER, ROUND);
        assert.deepEqual(list.map((s) => s.id), expectedIds(VIEWER), status);
        // Same payload shape and the same set of songs as before: only the order moved.
        assert.deepEqual(list, expectedList(subs, expectedIds(VIEWER)), status);
        // Another member gets the same order, their own song left out.
        assert.deepEqual(await listVotableSubmissions(deps, "u-ben", ROUND), expectedList(subs, expectedIds("u-ben")), status);
      }
    });
  }
}

test("headToHead: a departed player's song is withdrawn first, the rest still in submission-id order", async () => {
  for (const order of READ_ORDERS) {
    // u-ben left mid-season: still a frozen participant, no longer a member.
    const { deps, subs } = await orderFixture(order.make(), "headToHead", "voting", PLAYERS.filter((id) => id !== "u-ben"));
    const list = await listVotableSubmissions(deps, VIEWER, ROUND);
    assert.deepEqual(list.map((s) => s.id), expectedIds(VIEWER, ["u-ben"]), order.name);
    assert.deepEqual(list, expectedList(subs, expectedIds(VIEWER, ["u-ben"])), order.name);
  }
});
