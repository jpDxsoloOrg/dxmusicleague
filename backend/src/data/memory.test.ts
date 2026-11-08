// Seed tests (BUG-08) — the fixture leagues the in-memory backend loads, as
// the local dev server serves them (`new MemoryRepository()` at startup).
// Every seeded deadline is laid out from one clock — an injectable `now`,
// defaulting to the moment the repo is built — so the seeded standard rounds
// can be played on whatever date the server starts (they used to hang off a
// fixed 2026-06-28 base, and every one had expired three days later). These
// also pin what makes those rounds playable end to end: Vaporwave's voting
// round has a song from every member, so each of them can spend a valid
// 12-point ballot; every seeded member has a standings row, as create / join /
// claim write one (Indie Anthems' board was empty); and the head-to-head
// fixture is the shared module's, unchanged, on the same clock.
//
// The play-through tests set the clock the handlers read their deadlines
// against (Date) to the same instant the seed is laid out from — a server
// started on that date, with a request arriving right away.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository, MemoryUserDirectory } from "./memory.ts";
import { H2H_SEED_LEAGUE_ID, headToHeadSeed } from "./seedHeadToHead.ts";
import { ApiError } from "../domain/errors.ts";
import type { Deps } from "../handlers/leagues.ts";
import { getLeagueDetail } from "../handlers/leagues.ts";
import { getMySubmissions, listVotableSubmissions, submitSong } from "../handlers/submissions.ts";
import { castBallot, getMyBallot } from "../handlers/voting.ts";
import type { Ballot, Submission, Track } from "../domain/types.ts";

/** Far from the date the seed was written: "whenever the server starts". */
const NOW = new Date("2030-01-01T09:00:00.000Z");
const DAY = 24 * 60 * 60_000;
const inDays = (from: Date, days: number): string => new Date(from.getTime() + days * DAY).toISOString();

/** The seeded backend as a local server started at `now` serves it. */
function serverStartedAt(t: TestContext, now = NOW): Deps {
  t.mock.timers.enable({ apis: ["Date"], now });
  return { repo: new MemoryRepository(true, { now }), users: new MemoryUserDirectory() };
}

const mockTrack = (pid: string, title: string, artist: string): Track => ({
  id: `mock:${pid}`,
  provider: "mock",
  providerTrackId: pid,
  title,
  artists: [artist],
});

const isStatus = (code: number, message?: string) => (e: unknown) =>
  e instanceof ApiError && e.statusCode === code && (message === undefined || e.message === message);

const byId = (a: Submission, b: Submission) => a.id.localeCompare(b.id);
const byVoter = (a: Ballot, b: Ballot) => a.voterId.localeCompare(b.voterId);

test("seed: every live round's deadline is laid out from the injected now", async () => {
  const repo = new MemoryRepository(true, { now: NOW });
  const deadlines: Record<string, string | undefined> = {};
  for (const lg of await repo.getAllLeagues()) {
    for (const r of await repo.getRoundsForLeague(lg.id)) {
      if (r.status !== "submitting" && r.status !== "voting") continue;
      const deadline = r.status === "submitting" ? r.submissionDeadline : r.voteDeadline;
      if (deadline) assert.ok(new Date(deadline).getTime() > NOW.getTime(), `${r.id}: ${deadline} is after now`);
      deadlines[r.id] = deadline;
    }
  }
  assert.deepEqual(deadlines, {
    "r-sw-3": inDays(NOW, 2),
    "r-vw-1": inDays(NOW, 1),
    "r-in-2": inDays(NOW, 3),
    "r-ff-2": undefined, // the head-to-head league is manual: no deadlines
  });
});

test("seed: by default the clock is the moment the repo is built — the local server's start", async (t) => {
  const start = new Date("2031-05-05T05:05:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const repo = new MemoryRepository();
  assert.equal((await repo.getRound("r-sw-3"))?.submissionDeadline, inDays(start, 2));
  assert.equal((await repo.getRound("r-vw-1"))?.voteDeadline, inDays(start, 1));
  // The head-to-head fixture's activity timestamps run on the same clock.
  assert.deepEqual(
    (await repo.getSubmissionsForRound("r-ff-2")).sort(byId),
    headToHeadSeed(start).submissions.filter((s) => s.roundId === "r-ff-2").sort(byId),
  );
});

test("seed: on any date, the seeded submitting rounds take a song — Max in r-sw-3, Luna in r-in-2", async (t) => {
  const deps = serverStartedAt(t);
  const mine = await submitSong(deps, "u-me", "r-sw-3", { track: mockTrack("m2", "Nightcall", "Kavinsky"), comment: "Windows down." });
  assert.deepEqual((await getMySubmissions(deps, "u-me", "r-sw-3")).map((s) => s.id), [mine.id]);
  await submitSong(deps, "u-luna", "r-in-2", { track: mockTrack("m3", "Resonance", "HOME") });
  assert.equal((await deps.repo.getSubmissionsForUser("r-in-2", "u-luna")).length, 1);
  // The deadline is still real: once it lapses (two days on), picks are refused again.
  t.mock.timers.setTime(NOW.getTime() + 2 * DAY + 60_000);
  await assert.rejects(
    submitSong(deps, "u-sarah", "r-sw-3", { track: mockTrack("m9", "Starlight", "Muse") }),
    isStatus(400, "The submission deadline has passed."),
  );
});

test("seed: Vaporwave's r-vw-1 has a song from every member — each of them can spend a valid 12-point ballot", async (t) => {
  const deps = serverStartedAt(t);
  const league = (await deps.repo.getLeague("lg-vaporwave"))!;
  const subs = await deps.repo.getSubmissionsForRound("r-vw-1");
  assert.deepEqual(subs.map((s) => s.userId).sort(), [...league.memberIds].sort());
  // Max's own pick is the mock's canonical one, and his list is everyone else's.
  assert.deepEqual((await getMySubmissions(deps, "u-me", "r-vw-1")).map((s) => [s.id, s.track.title]), [["sub-5", "Midnight City"]]);
  assert.deepEqual(
    (await listVotableSubmissions(deps, "u-me", "r-vw-1")).map((s) => [s.id, s.track.title]),
    [["sub-1", "Levitating"], ["sub-2", "Blinding Lights"], ["sub-4", "Heat Waves"]],
  );

  for (const voter of league.memberIds) {
    const songs = await listVotableSubmissions(deps, voter, "r-vw-1");
    assert.equal(songs.length, 3, `${voter} has three songs on offer`);
    // The whole 12-point pool under the 5-point cap: 5 + 5 + 2.
    const allocations = Object.fromEntries(songs.map((s, i) => [s.id, [5, 5, 2][i]!]));
    await castBallot(deps, voter, "r-vw-1", { allocations });
    assert.deepEqual((await getMyBallot(deps, voter, "r-vw-1"))?.allocations, allocations, voter);
  }
  const detail = await getLeagueDetail(deps, "u-sarah", "lg-vaporwave");
  assert.deepEqual(
    { done: detail.votingProgress?.doneCount, total: detail.votingProgress?.totalCount },
    { done: 4, total: 4 },
  );
});

test("seed: every member of every seeded league has a standings row — Indie Anthems' board is no longer empty", async () => {
  const deps: Deps = { repo: new MemoryRepository(true, { now: NOW }), users: new MemoryUserDirectory() };
  for (const lg of await deps.repo.getAllLeagues()) {
    const rows = new Set((await deps.repo.getStandings(lg.id)).map((r) => r.userId));
    for (const member of lg.memberIds) assert.ok(rows.has(member), `${lg.id}: ${member} has a row`);
  }
  const board = async (leagueId: string) =>
    (await getLeagueDetail(deps, "u-me", leagueId)).standings.map((s) => `${s.user.id} ${s.points}`);
  // Seeds without a score start everyone at 0, as create / join / claim write a row.
  assert.deepEqual(await board("lg-indie"), ["u-luna 0", "u-mia 0", "u-jpop 0"]); // spectated
  assert.deepEqual(await board("lg-midnight"), ["u-sarah 0", "u-james 0", "u-luna 0"]);
  // The scored seeds are untouched.
  assert.deepEqual(await board("lg-synthwave"), ["u-james 450", "u-sarah 420", "u-mia 390", "u-me 360", "u-luna 300"]);
});

test("seed: the head-to-head league is the shared fixture, unchanged, on the injected clock", async () => {
  const repo = new MemoryRepository(true, { now: NOW });
  const h2h = headToHeadSeed(NOW);
  assert.deepEqual(await repo.getLeague(H2H_SEED_LEAGUE_ID), h2h.league);
  assert.deepEqual((await repo.getRoundsForLeague(H2H_SEED_LEAGUE_ID)).sort((a, b) => a.index - b.index), h2h.rounds);
  for (const r of h2h.rounds) {
    assert.deepEqual((await repo.getSubmissionsForRound(r.id)).sort(byId), h2h.submissions.filter((s) => s.roundId === r.id).sort(byId));
    assert.deepEqual((await repo.getBallotsForRound(r.id)).sort(byVoter), h2h.ballots.filter((b) => b.roundId === r.id).sort(byVoter));
  }
  assert.deepEqual(await repo.getStandings(H2H_SEED_LEAGUE_ID), h2h.standings);
});
