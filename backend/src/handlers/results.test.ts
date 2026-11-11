// Results tests — both comment kinds ride along: the submitter's own note
// (written at submit time) and voters' per-song ballot comments.
// HTH-07 (below the standard tests): head-to-head reveals — matchup outcomes
// (wins, draws, walkovers, no contests, the exhibition bye), W/L/D banked
// exactly once (double reveals, reveal-vs-auto-advance races, stale round
// writes and failed writes included), the pinned tally vs late ballots,
// departures, the results payload, and that a standard round's results stay
// the bare array. Head-to-head leagues are driven through the real handlers
// (create → join → open round 1 = freeze → submit → vote → reveal) over
// MemoryRepository, with the freeze RNG seeded through deps.
// BUG-04: a standard round's points are banked exactly once too — racing
// reveals, stale reveals, failed writes, a submitter's several results summed
// into one increment — with the payload unchanged.
// BUG-18: a standard reveal pins the per-song tally it banked on the round,
// so a ballot landing after the reveal read the ballots can't make GET
// results (or a lost claim's answer) disagree with the standings; a revealed
// round without a pin re-tallies; a theme edit keeps the pin.
// BUG-05 (at the bottom): both reveals tally from a strongly consistent ballot
// read (GET results keeps the default read), so the ballot that completed a
// timed round's turnout is counted even when a lagging replica would have
// served the reveal's read without it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository, MemoryUserDirectory } from "../data/memory.ts";
import { DEFAULT_LEAGUE_SETTINGS } from "../domain/types.ts";
import type { Round } from "../domain/types.ts";
import type { Repository } from "../data/repository.ts";
import { ApiError } from "../domain/errors.ts";
import type { RandomInt } from "../domain/freeze.ts";
import { votableMatchups } from "../domain/matchups.ts";
import type { RoundMatchup, RoundMatchupSet } from "../domain/matchups.ts";
import { computeResults, finalizeReveal } from "./results.ts";
import type { HeadToHeadResults, MatchupResult, RoundResult, RoundResultsPayload } from "./results.ts";
import type { Deps } from "./leagues.ts";
import { createLeague, getLeagueDetail, joinLeague, leaveLeague } from "./leagues.ts";
import { createRound, updateRound } from "./rounds.ts";
import { submitSong } from "./submissions.ts";
import { listMatchups, loadRoundMatchups } from "./matchups.ts";
import { autoAdvanceRound } from "./progression.ts";
import { buildRoutes, matchRoute } from "../http/routes.ts";

const ROUND = "r-test";

async function deps(): Promise<Deps> {
  const repo = new MemoryRepository(false);
  await repo.createLeague({
    id: "lg-test", name: "Test", ownerId: "u-sarah", musicProvider: "spotify", format: "standard",
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
  assert.ok(Array.isArray(results), "a standard round still reveals the bare RoundResult[]");
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

// ---- Head-to-head results (HTH-07) ------------------------------------------

/** Seeded RandomInt (mulberry32) for the season freeze's shuffle + salt. */
function seeded(seed: number): RandomInt {
  let a = seed >>> 0;
  return (max: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max);
  };
}

// Seed users, so the directory resolves real display names (u-me = "Curator Max").
const OWNER = "u-me";
const PLAYERS = ["u-me", "u-sarah", "u-james", "u-mia", "u-jpop", "u-luna"];
const SPECTATOR = "u-nobody";

interface H2H {
  deps: Deps;
  repo: MemoryRepository;
  leagueId: string;
  inviteCode: string;
}

/** A head-to-head league of `players` (owner first), created and joined
 *  through the handlers. Timed leagues run 1-day phases. */
async function h2hLeague(players: readonly string[], { timed = false } = {}): Promise<H2H> {
  const repo = new MemoryRepository(false);
  const deps: Deps = { repo, users: new MemoryUserDirectory(), randomInt: seeded(20261107) };
  const lg = await createLeague(deps, players[0]!, {
    name: "Duel League", musicProvider: "mock", format: "headToHead", roundCount: 3,
    ...(timed ? { progression: "timed" as const, phaseDays: 1 } : {}),
  });
  for (const p of players.slice(1)) await joinLeague(deps, p, lg.inviteCode);
  return { deps, repo, leagueId: lg.id, inviteCode: lg.inviteCode };
}

/** Open the league's next round (round 1 freezes the season), take a song
 *  (with a submitter note) from each of `submitters`, and open voting. */
async function roundInVoting(f: H2H, submitters: readonly string[]): Promise<Round> {
  const round = await createRound(f.deps, OWNER, f.leagueId, { theme: "Openers" });
  await updateRound(f.deps, OWNER, f.leagueId, round.id, { status: "submitting" });
  for (const p of submitters) {
    await submitSong(f.deps, p, round.id, {
      track: { id: `t-${p}-${round.index}`, provider: "mock", providerTrackId: `t-${p}-${round.index}`, title: `${p} anthem ${round.index}`, artists: [`Artist ${p}`] },
      comment: `${p}'s note`,
    });
  }
  await updateRound(f.deps, OWNER, f.leagueId, round.id, { status: "previewing" });
  await updateRound(f.deps, OWNER, f.leagueId, round.id, { status: "voting" });
  return (await f.repo.getRound(round.id))!;
}

/** The round's server-side matchups (user ids + songs) — the tests' ground truth. */
async function serverSet(f: H2H, roundId: string): Promise<RoundMatchupSet> {
  return loadRoundMatchups(f.deps, (await f.repo.getLeague(f.leagueId))!, (await f.repo.getRound(roundId))!);
}

/** `voter`'s complete picks, choosing a side per matchup with `choose`. */
function picksFor(set: RoundMatchupSet, voter: string, choose: (m: RoundMatchup) => "a" | "b") {
  return Object.fromEntries(votableMatchups(set, voter).map((m) => [m.matchupId, m[choose(m)].submission!.id]));
}

/** Cast every eligible player's ballot so matchup i is decided by
 *  `patterns[i]` — one letter per eligible voter (sorted by id), the side
 *  that voter picks. The pattern's length must match the eligible voters. */
async function voteByPattern(f: H2H, roundId: string, voters: readonly string[], patterns: readonly string[]) {
  const { castBallot } = await import("./voting.ts");
  const set = await serverSet(f, roundId);
  const eligible = set.matchups.map((m) => [...voters].filter((v) => votableMatchups(set, v).includes(m)).sort());
  eligible.forEach((ids, i) => assert.equal(ids.length, patterns[i]!.length, `pattern for matchup ${i}`));
  for (const voter of voters) {
    const picks = picksFor(set, voter, (m) => {
      const i = set.matchups.indexOf(m);
      return patterns[i]![eligible[i]!.indexOf(voter)] as "a" | "b";
    });
    if (Object.keys(picks).length > 0) await castBallot(f.deps, voter, roundId, { picks });
  }
  return set;
}

/** Each player's stored W/L/D (and points) — standing rows of ex-members included. */
async function records(f: H2H): Promise<Map<string, string>> {
  const rows = await f.repo.getStandings(f.leagueId);
  return new Map(rows.map((r) => [r.userId, `${r.wins}-${r.losses}-${r.draws}${r.points ? ` ${r.points}pts` : ""}`]));
}

function h2h(payload: RoundResultsPayload): HeadToHeadResults {
  assert.ok(!Array.isArray(payload), "a head-to-head round answers with the matchup payload");
  assert.equal(payload.format, "headToHead");
  return payload;
}

const byId = (payload: HeadToHeadResults, matchupId: string): MatchupResult =>
  payload.matchups.find((m) => m.matchupId === matchupId)!;

const isStatus = (code: number, message?: RegExp) => (e: unknown) =>
  e instanceof ApiError && e.statusCode === code && (message === undefined || message.test(e.message));

/** `f.deps` over the same store with some repository methods replaced — to
 *  stage a race: hand one request a stale read, or act inside another's
 *  write. Every other method runs on the real MemoryRepository. */
function withRepo(f: { deps: Deps; repo: MemoryRepository }, overrides: Partial<Repository>): Deps {
  const repo = new Proxy(f.repo, {
    get: (target, prop) => {
      if (Object.hasOwn(overrides, prop)) return Reflect.get(overrides, prop);
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...f.deps, repo };
}

test("H2H reveal: 3v1 → W/L banked; 2v2 → both draw; 4v0 → the 0-vote loser still banks the L (six players: four voters per matchup)", async () => {
  const { revealRound } = await import("./voting.ts");
  const f = await h2hLeague(PLAYERS);
  const round = await roundInVoting(f, PLAYERS);
  // M0: 3–1 to side a; M1: 2–2; M2: 4–0 to side b.
  const set = await voteByPattern(f, round.id, PLAYERS, ["aaab", "abab", "bbbb"]);
  const [m0, m1, m2] = set.matchups as [RoundMatchup, RoundMatchup, RoundMatchup];

  const payload = h2h(await revealRound(f.deps, OWNER, round.id));
  assert.deepEqual(
    payload.matchups.map((m) => [m.matchupId, m.outcome, m.winnerUserId ?? null, m.a.votes, m.b.votes]),
    [
      [m0.matchupId, "win", m0.a.userId, 3, 1],
      [m1.matchupId, "draw", null, 2, 2],
      [m2.matchupId, "win", m2.b.userId, 0, 4],
    ],
  );

  const board = await records(f);
  assert.equal(board.get(m0.a.userId), "1-0-0");
  assert.equal(board.get(m0.b.userId), "0-1-0");
  assert.equal(board.get(m1.a.userId), "0-0-1");
  assert.equal(board.get(m1.b.userId), "0-0-1");
  assert.equal(board.get(m2.b.userId), "1-0-0");
  assert.equal(board.get(m2.a.userId), "0-1-0", "zero votes, still an L");
  assert.equal((await f.repo.getRound(round.id))!.status, "revealed");

  // The league board shows the records, best first.
  const detail = await getLeagueDetail(f.deps, OWNER, f.leagueId);
  assert.deepEqual(
    detail.standings.slice(0, 2).map((s) => [s.wins, s.losses, s.draws]),
    [[1, 0, 0], [1, 0, 0]],
  );
});

test("H2H reveal: the L79-guard regression — a 2–0 loss banks the L and a 0–0 draw banks a D for both, every row written though no points move", async () => {
  const { revealRound } = await import("./voting.ts");
  const four = PLAYERS.slice(0, 4);
  const f = await h2hLeague(four);
  const round = await roundInVoting(f, four);
  const set = await serverSet(f, round.id);
  const [decided, idle] = set.matchups as [RoundMatchup, RoundMatchup];
  // Only `idle`'s two players vote (both for `decided`'s side a); `decided`'s
  // players never cast, so `idle` stays 0–0.
  const { castBallot } = await import("./voting.ts");
  for (const voter of [idle.a.userId, idle.b.userId]) {
    await castBallot(f.deps, voter, round.id, { picks: picksFor(set, voter, () => "a") });
  }
  await revealRound(f.deps, OWNER, round.id);
  const board = await records(f);
  assert.equal(board.get(decided.a.userId), "1-0-0");
  assert.equal(board.get(decided.b.userId), "0-1-0");
  assert.equal(board.get(idle.a.userId), "0-0-1");
  assert.equal(board.get(idle.b.userId), "0-0-1");
  // Points never move in a head-to-head league.
  assert.ok((await f.repo.getStandings(f.leagueId)).every((r) => r.points === 0));
});

test("H2H reveal: a walkover banks W and L; a no contest banks nothing; the bye banks nothing", async () => {
  const { getResults } = await import("./voting.ts");
  const five = PLAYERS.slice(0, 5);
  const f = await h2hLeague(five);
  // Find the schedule first (it's frozen when round 1 opens), then choose who submits.
  const round = await createRound(f.deps, OWNER, f.leagueId, { theme: "Openers" });
  await updateRound(f.deps, OWNER, f.leagueId, round.id, { status: "submitting" });
  const plan = await serverSet(f, round.id);
  const [walk, none] = plan.matchups as [RoundMatchup, RoundMatchup];
  const bye = plan.bye!.userId;
  for (const p of [walk.a.userId, bye]) {
    await submitSong(f.deps, p, round.id, {
      track: { id: `t-${p}`, provider: "mock", providerTrackId: `t-${p}`, title: `${p} anthem`, artists: [`Artist ${p}`] },
      comment: `${p}'s note`,
    });
  }
  await updateRound(f.deps, OWNER, f.leagueId, round.id, { status: "previewing" });
  // Nothing is votable, so opening voting reveals the round on the spot
  // (HTH-08) — banking exactly what an owner's reveal would.
  const opened = await updateRound(f.deps, OWNER, f.leagueId, round.id, { status: "voting" });
  assert.equal(opened.status, "revealed");
  const byeSong = (await f.repo.getSubmissionsForUser(round.id, bye))[0]!;

  const payload = h2h(await getResults(f.deps, SPECTATOR, round.id));
  const w = byId(payload, walk.matchupId);
  assert.equal(w.outcome, "walkover");
  assert.equal(w.winnerUserId, walk.a.userId);
  assert.equal(w.a.song?.track.title, `${walk.a.userId} anthem`);
  assert.equal(w.b.song, null);
  assert.deepEqual([w.a.votes, w.b.votes, w.a.departed, w.b.departed], [0, 0, false, false]);
  const n = byId(payload, none.matchupId);
  assert.equal(n.outcome, "noContest");
  assert.equal("winnerUserId" in n, false);
  assert.deepEqual([n.a.song, n.b.song], [null, null]);
  // The bye: the exhibition song, revealed with its submitter, note and comments.
  assert.equal(payload.bye?.player.id, bye);
  assert.equal(payload.bye?.song.id, byeSong.id);
  assert.equal(payload.bye?.song.submitterComment, `${bye}'s note`);
  // (Voter comments on the bye's song: see the results-payload test below.)
  assert.deepEqual(payload.bye?.song.comments, []);

  const board = await records(f);
  assert.equal(board.get(walk.a.userId), "1-0-0");
  assert.equal(board.get(walk.b.userId), "0-1-0", "no submission = the walkover's L");
  for (const idle of [none.a.userId, none.b.userId, bye]) {
    assert.equal(board.get(idle) ?? "0-0-0", "0-0-0", `${idle} banks nothing`);
  }
});

test("H2H reveal → reveal again: the second is refused and nothing is banked twice; finalizeReveal on a stale round object banks nothing and answers with the settled results", async () => {
  const { revealRound } = await import("./voting.ts");
  const four = PLAYERS.slice(0, 4);
  const f = await h2hLeague(four);
  const round = await roundInVoting(f, four);
  const stale = structuredClone(round); // read while voting, like a racing request's copy
  await voteByPattern(f, round.id, four, ["aa", "ab"]);
  const first = h2h(await revealRound(f.deps, OWNER, round.id));
  const banked = await records(f);

  await assert.rejects(revealRound(f.deps, OWNER, round.id), isStatus(400, /in voting/));
  assert.deepEqual(await records(f), banked);

  // A reveal that read the round before it was settled (still "voting") gets
  // past every status guard — the conditional claim stops it banking.
  const reads: unknown[] = [];
  const spy = withRepo(f, {
    getRound: async (id, opts) => {
      reads.push(opts);
      return f.repo.getRound(id, opts);
    },
  });
  const again = await finalizeReveal(spy, stale);
  assert.deepEqual(reads, [{ consistent: true }], "the loser re-reads the settled round strongly consistently");
  assert.deepEqual(await records(f), banked, "no double-bank");
  assert.deepEqual(again, first, "answers with the round as it was settled");
  assert.equal(stale.status, "revealed", "the caller's copy is brought up to date");
  // Auto-advance on a timed league is a no-op once the round is settled.
  const league = (await f.repo.getLeague(f.leagueId))!;
  await autoAdvanceRound(f.deps, { ...league, progression: "timed", phaseDays: 1 }, (await f.repo.getRound(round.id))!);
  assert.deepEqual(await records(f), banked);
});

test("H2H reveal racing a timed auto-advance (and a league read) banks the round exactly once", async () => {
  const { revealRound } = await import("./voting.ts");
  const four = PLAYERS.slice(0, 4);
  const f = await h2hLeague(four, { timed: true });
  const round = await roundInVoting(f, four);
  // Three of four ballots, then the vote deadline passes: every reader may now reveal.
  const set = await serverSet(f, round.id);
  const { castBallot } = await import("./voting.ts");
  for (const voter of four.slice(1)) await castBallot(f.deps, voter, round.id, { picks: picksFor(set, voter, () => "a") });
  const due = { ...(await f.repo.getRound(round.id))!, voteDeadline: new Date(Date.now() - 60_000).toISOString() };
  await f.repo.updateRound(due);
  const league = (await f.repo.getLeague(f.leagueId))!;

  // All three hold a "voting" copy of the round when they start.
  const [ownerReveal, autoRound] = await Promise.all([
    revealRound(f.deps, OWNER, round.id),
    autoAdvanceRound(f.deps, league, structuredClone(due)),
    getLeagueDetail(f.deps, "u-sarah", f.leagueId),
  ]);
  assert.equal(autoRound?.status, "revealed");
  const rows = await f.repo.getStandings(f.leagueId);
  const games = rows.reduce((sum, r) => sum + r.wins + r.losses + r.draws, 0);
  assert.equal(games, 4, "two matchups, two results each — banked once");
  for (const r of rows) assert.equal(r.wins + r.losses + r.draws, 1, `${r.userId} has exactly one result`);
  // Whoever won the race, the owner's answer is the settled round.
  assert.deepEqual(ownerReveal, await (await import("./voting.ts")).getResults(f.deps, SPECTATOR, round.id));
});

test("H2H reveal pins its tally: a ballot written between the reveal's ballot read and its write, or one that passed castBallot's voting check just before the reveal and lands after it, changes neither the banked W/L/D nor GET results", async () => {
  const { castBallot, revealRound, getResults } = await import("./voting.ts");
  const four = PLAYERS.slice(0, 4);
  const f = await h2hLeague(four);
  const round = await roundInVoting(f, four);
  const stale = structuredClone(round); // a voter's copy, read while voting
  const set = await serverSet(f, round.id);
  const [m0, m1] = set.matchups as [RoundMatchup, RoundMatchup];
  // In a 4-player league each pair votes in the other's matchup only.
  await castBallot(f.deps, m1.a.userId, round.id, { picks: { [m0.matchupId]: m0.a.submission!.id } });

  // A ballot lands while the reveal is under way: after it read the ballots, before its write.
  const racing = withRepo(f, {
    revealRoundOnce: async (r, recs) => {
      await f.repo.putBallot({
        roundId: round.id, voterId: m1.b.userId, allocations: {},
        picks: { [m0.matchupId]: m0.b.submission!.id }, castAt: new Date().toISOString(),
      });
      return f.repo.revealRoundOnce(r, recs);
    },
  });
  const revealed = h2h(await revealRound(racing, OWNER, round.id));
  assert.deepEqual(
    revealed.matchups.map((m) => [m.matchupId, m.a.votes, m.b.votes, m.outcome]),
    [[m0.matchupId, 1, 0, "win"], [m1.matchupId, 0, 0, "draw"]],
  );
  const banked = await records(f);
  assert.deepEqual(
    [m0.a, m0.b, m1.a, m1.b].map((p) => banked.get(p.userId)),
    ["1-0-0", "0-1-0", "0-0-1", "0-0-1"],
  );
  assert.deepEqual((await f.repo.getRound(round.id))!.h2hTally, [
    { matchupId: m0.matchupId, votesA: 1, votesB: 0 },
    { matchupId: m1.matchupId, votesA: 0, votesB: 0 },
  ]);

  // A voter whose castBallot read the round before the reveal: its check
  // passes and the ballot row is written after the reveal.
  const late = withRepo(f, { getRound: async () => structuredClone(stale) });
  await castBallot(late, m0.a.userId, round.id, { picks: { [m1.matchupId]: m1.a.submission!.id } });
  assert.equal((await f.repo.getBallotsForRound(round.id)).length, 3, "both late ballots are stored");

  // Re-tallying the rows now would read 1–1 and 1–0; the pinned tally keeps the banked result.
  assert.deepEqual(await getResults(f.deps, SPECTATOR, round.id), revealed);
  assert.deepEqual(await records(f), banked);
});

test("H2H: an owner's edit built from a round read before the reveal can't un-reveal it (409), so no second reveal can bank it again; an edit that reads the revealed round lands and keeps the pins", async () => {
  const { revealRound } = await import("./voting.ts");
  const four = PLAYERS.slice(0, 4);
  const f = await h2hLeague(four);
  const round = await roundInVoting(f, four);
  await voteByPattern(f, round.id, four, ["aa", "ab"]);
  const stale = structuredClone(round); // the PATCH read the round while it was voting…
  await revealRound(f.deps, OWNER, round.id);
  const banked = await records(f);
  const settled = (await f.repo.getRound(round.id))!;
  assert.ok(settled.h2hTally && settled.h2hDeparted);

  // …and its write arrives after the reveal.
  const late = withRepo(f, { getRound: async () => structuredClone(stale) });
  await assert.rejects(
    updateRound(late, OWNER, f.leagueId, round.id, { theme: "Renamed", voteDeadline: "2030-01-01T00:00:00.000Z" }),
    isStatus(409, /revealed/),
  );
  assert.deepEqual(await f.repo.getRound(round.id), settled, "still revealed, pins intact");
  await assert.rejects(revealRound(f.deps, OWNER, round.id), isStatus(400, /in voting/));
  assert.deepEqual(await records(f), banked);

  // An edit made from a fresh read of the revealed round is an ordinary write.
  await updateRound(f.deps, OWNER, f.leagueId, round.id, { theme: "Renamed" });
  assert.deepEqual(await f.repo.getRound(round.id), { ...settled, theme: "Renamed" });
});

test("H2H: a timed auto-advance holding a copy read before the round was advanced and revealed doesn't write it back over the reveal", async () => {
  const { castBallot, revealRound } = await import("./voting.ts");
  const four = PLAYERS.slice(0, 4);
  const f = await h2hLeague(four, { timed: true });
  const round = await createRound(f.deps, OWNER, f.leagueId, { theme: "Openers" });
  await updateRound(f.deps, OWNER, f.leagueId, round.id, { status: "submitting" });
  for (const p of four) {
    await submitSong(f.deps, p, round.id, {
      track: { id: `t-${p}`, provider: "mock", providerTrackId: `t-${p}`, title: `${p} anthem`, artists: [`Artist ${p}`] },
    });
  }
  const previewing = (await f.repo.getRound(round.id))!;
  assert.equal(previewing.status, "previewing", "everyone submitted: the timed league advanced");
  // A slow reader's copy, its preview deadline already passed: it will advance to voting.
  const stale: Round = { ...structuredClone(previewing), previewDeadline: new Date(Date.now() - 60_000).toISOString() };

  // Meanwhile the owner opens voting, two players vote, and the owner reveals.
  await updateRound(f.deps, OWNER, f.leagueId, round.id, { status: "voting" });
  const set = await serverSet(f, round.id);
  for (const voter of [set.matchups[0]!.a.userId, set.matchups[1]!.a.userId]) {
    await castBallot(f.deps, voter, round.id, { picks: picksFor(set, voter, () => "a") });
  }
  await revealRound(f.deps, OWNER, round.id);
  const banked = await records(f);
  const settled = (await f.repo.getRound(round.id))!;

  const league = (await f.repo.getLeague(f.leagueId))!;
  const after = await autoAdvanceRound(f.deps, league, stale);
  assert.equal(after?.status, "revealed", "the stale copy is brought up to date, not written");
  assert.deepEqual(await f.repo.getRound(round.id), settled);
  await assert.rejects(revealRound(f.deps, OWNER, round.id), isStatus(400, /in voting/));
  assert.deepEqual(await records(f), banked);
});

test("H2H: a reveal whose write fails banks nothing and leaves the round in voting — retrying banks it exactly once", async () => {
  const { revealRound, getResults } = await import("./voting.ts");
  const four = PLAYERS.slice(0, 4);
  const f = await h2hLeague(four);
  const round = await roundInVoting(f, four);
  await voteByPattern(f, round.id, four, ["aa", "bb"]);
  const failing = withRepo(f, {
    revealRoundOnce: async () => {
      throw Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" });
    },
  });
  await assert.rejects(revealRound(failing, OWNER, round.id), /throttled/);
  const after = (await f.repo.getRound(round.id))!;
  assert.equal(after.status, "voting");
  assert.equal("h2hTally" in after, false);
  assert.ok((await f.repo.getStandings(f.leagueId)).every((r) => r.wins + r.losses + r.draws === 0), "nothing banked");

  const payload = h2h(await revealRound(f.deps, OWNER, round.id));
  const rows = await f.repo.getStandings(f.leagueId);
  assert.equal(rows.length, 4);
  for (const r of rows) assert.equal(r.wins + r.losses + r.draws, 1, `${r.userId} banked once`);
  assert.deepEqual(await getResults(f.deps, SPECTATOR, round.id), payload);
});

test("MemoryRepository.revealRoundOnce: claims an unsettled round and banks its records together; refused — writing and banking nothing — on a revealed, complete or missing round; a bad increment writes nothing", async () => {
  const repo = new MemoryRepository(false);
  const base: Round = { id: "lg-x~0001", leagueId: "lg-x", index: 1, theme: "T", status: "voting" };
  const recs = [{ userId: "u-a", delta: { wins: 1 } }, { userId: "u-b", delta: { losses: 1 } }];
  const rows = async () => (await repo.getStandings("lg-x")).map((r) => `${r.userId} ${r.wins}-${r.losses}-${r.draws}`);

  await repo.createRound(base);
  await assert.rejects(repo.revealRoundOnce({ ...base, status: "revealed" }, [{ userId: "u-a", delta: { wins: 0.5 } }]), /integer/);
  assert.equal((await repo.getRound(base.id))!.status, "voting", "a bad increment claims nothing");
  assert.deepEqual(await rows(), []);

  assert.equal(await repo.revealRoundOnce({ ...base, status: "revealed", h2hDeparted: [] }, recs), true);
  assert.deepEqual(await rows(), ["u-a 1-0-0", "u-b 0-1-0"]);
  assert.equal(await repo.revealRoundOnce({ ...base, status: "revealed", h2hDeparted: ["u-z"] }, recs), false);
  assert.deepEqual((await repo.getRound(base.id))!.h2hDeparted, []);
  assert.deepEqual(await rows(), ["u-a 1-0-0", "u-b 0-1-0"]);

  const complete: Round = { ...base, id: "lg-x~0002", index: 2, status: "complete" };
  await repo.createRound(complete);
  assert.equal(await repo.revealRoundOnce({ ...complete, status: "revealed", h2hDeparted: ["u-z"] }, recs), false);
  assert.deepEqual(await repo.getRound(complete.id), complete, "a complete round is settled: nothing written");
  assert.equal(await repo.revealRoundOnce({ ...base, id: "lg-x~0009", index: 9, status: "revealed" }, recs), false);
  assert.equal(await repo.getRound("lg-x~0009"), undefined, "no phantom round");
  assert.deepEqual(await rows(), ["u-a 1-0-0", "u-b 0-1-0"]);

  // updateRoundUnlessSettled: the same guard without the banking.
  assert.equal(await repo.updateRoundUnlessSettled({ ...complete, theme: "Edited" }), false);
  assert.equal((await repo.getRound(complete.id))!.theme, "T");
  const open: Round = { ...base, id: "lg-x~0003", index: 3, status: "previewing" };
  await repo.createRound(open);
  assert.equal(await repo.updateRoundUnlessSettled({ ...open, status: "voting" }), true);
  assert.equal((await repo.getRound(open.id))!.status, "voting");
});

test("H2H full round-trip: reveal all 3 rounds of a 4-player league → W and L totals = rounds × matchups, everyone played 3, league finished", async () => {
  const { revealRound } = await import("./voting.ts");
  const four = PLAYERS.slice(0, 4);
  const f = await h2hLeague(four);
  for (let i = 0; i < 3; i++) {
    const round = await roundInVoting(f, four);
    await voteByPattern(f, round.id, four, i === 1 ? ["bb", "aa"] : ["aa", "bb"]);
    const payload = h2h(await revealRound(f.deps, OWNER, round.id));
    assert.deepEqual(payload.matchups.map((m) => m.outcome), ["win", "win"]);
  }
  assert.equal((await f.repo.getLeague(f.leagueId))!.roundCount, 3, "schedule length for 4 players");
  await assert.rejects(createRound(f.deps, OWNER, f.leagueId, { theme: "Extra" }), isStatus(400));

  const rows = await f.repo.getStandings(f.leagueId);
  const total = (k: "wins" | "losses" | "draws") => rows.reduce((sum, r) => sum + r[k], 0);
  assert.deepEqual([total("wins"), total("losses"), total("draws")], [3 * 2, 3 * 2, 0]);
  for (const r of rows) assert.equal(r.wins + r.losses + r.draws, 3, `${r.userId} played every round`);

  const detail = await getLeagueDetail(f.deps, OWNER, f.leagueId);
  assert.equal(detail.finished, true);
  const sorted = [...detail.standings].sort((x, y) => y.wins - x.wins || x.losses - y.losses);
  assert.deepEqual(detail.standings.map((s) => [s.wins, s.losses]), sorted.map((s) => [s.wins, s.losses]), "board sorted by record");
});

test("H2H departures: a player kicked mid-round loses nothing — their pair is a walkover the stayer wins; they can't rejoin (HTH-14), the revealed round still reads as banked (their own matchup too), and a leave after the reveal rewrites nothing", async () => {
  const { revealRound, getResults } = await import("./voting.ts");
  const four = PLAYERS.slice(0, 4);
  const f = await h2hLeague(four);
  const round = await roundInVoting(f, four);
  const set = await serverSet(f, round.id);
  const theirs = set.matchups.find((m) => m.a.userId !== OWNER && m.b.userId !== OWNER)!;
  const ownersPair = set.matchups.find((m) => m !== theirs)!;
  const [leaver, stayer] = [theirs.a.userId, theirs.b.userId];
  // The owner's pair votes in the leaver's matchup (for the leaver), then the leaver is kicked.
  const { castBallot } = await import("./voting.ts");
  for (const voter of [ownersPair.a.userId, ownersPair.b.userId]) {
    await castBallot(f.deps, voter, round.id, { picks: { [theirs.matchupId]: theirs.a.submission!.id } });
  }
  await leaveLeague(f.deps, OWNER, f.leagueId, leaver);

  const payload = h2h(await revealRound(f.deps, OWNER, round.id));
  const m = byId(payload, theirs.matchupId);
  assert.equal(m.outcome, "walkover");
  assert.equal(m.winnerUserId, stayer);
  assert.equal(m.a.player.id, leaver);
  assert.deepEqual([m.a.departed, m.a.song, m.a.votes], [true, null, 0], "withdrawn song, its pre-departure picks inert");
  assert.equal(byId(payload, ownersPair.matchupId).outcome, "draw", "its only voters (the leaver and the stayer) never voted: 0–0");
  assert.deepEqual((await f.repo.getRound(round.id))!.h2hDeparted, [leaver], "the departed set is pinned on the round");

  const board = await records(f);
  assert.equal(board.get(stayer), "1-0-0");
  assert.equal(board.get(leaver) ?? "0-0-0", "0-0-0", "the departed player's row takes no L");

  // The kicked player can't rejoin: leaving a locked season is permanent
  // (HTH-14). The revealed round still reads as it was banked — here and in
  // the matchups read, where their own matchup is still theirs.
  await assert.rejects(joinLeague(f.deps, leaver, f.inviteCode), isStatus(409, /^You can't rejoin this head-to-head season/));
  assert.equal((await f.repo.getLeague(f.leagueId))!.memberIds.includes(leaver), false);
  assert.deepEqual(await getResults(f.deps, SPECTATOR, round.id), payload);
  const view = await listMatchups(f.deps, leaver, round.id);
  const mine = view.matchups.find((v) => v.matchupId === theirs.matchupId)!;
  assert.deepEqual([mine.a === null || mine.b === null, mine.isMine], [true, true], "still a walkover in GET /matchups");
  // And a leave AFTER the reveal rewrites nothing either.
  await leaveLeague(f.deps, OWNER, f.leagueId, stayer);
  assert.deepEqual(await getResults(f.deps, SPECTATOR, round.id), payload);
  assert.equal((await records(f)).get(stayer), "1-0-0");
});

test("H2H results payload: players + songs revealed with votes, outcome, winner, submitter notes and voter comments; the reveal answer = GET results (spectators too); 400 before the reveal", async () => {
  const { castBallot, getResults } = await import("./voting.ts");
  const five = PLAYERS.slice(0, 5);
  const f = await h2hLeague(five);
  const round = await roundInVoting(f, five);
  const set = await serverSet(f, round.id);
  const [m0] = set.matchups as [RoundMatchup];
  const bye = set.bye!;
  const comment = { [m0.a.submission!.id]: "this one slaps", [bye.submission!.id]: "fun exhibition" };
  await castBallot(f.deps, bye.userId, round.id, { picks: picksFor(set, bye.userId, () => "a"), comments: comment });

  await assert.rejects(getResults(f.deps, OWNER, round.id), isStatus(400, /until the round is revealed/));

  const routes = buildRoutes(f.deps);
  const call = (method: string, path: string, caller: string) => {
    const match = matchRoute(routes, method, path);
    assert.ok(match, `no route for ${method} ${path}`);
    return match.route.handler({ caller, params: match.params, query: {}, body: undefined });
  };
  const revealed = h2h((await call("POST", `/rounds/${encodeURIComponent(round.id)}/reveal`, OWNER)) as RoundResultsPayload);
  const read = await call("GET", `/rounds/${encodeURIComponent(round.id)}/results`, SPECTATOR);
  assert.deepEqual(read, revealed, "GET results (any signed-in user) = the reveal response");

  // Matchups sorted by id, every song revealed with its submitter.
  assert.deepEqual(revealed.matchups.map((m) => m.matchupId), set.matchups.map((m) => m.matchupId));
  const r0 = byId(revealed, m0.matchupId);
  assert.deepEqual(r0, {
    matchupId: m0.matchupId,
    a: {
      player: { id: m0.a.userId, displayName: await f.deps.users.getDisplayName(m0.a.userId) },
      song: {
        id: m0.a.submission!.id,
        track: m0.a.submission!.track,
        submitterComment: `${m0.a.userId}'s note`,
        comments: [{ voter: { id: bye.userId, displayName: await f.deps.users.getDisplayName(bye.userId) }, text: "this one slaps" }],
      },
      votes: 1,
      departed: false,
    },
    b: {
      player: { id: m0.b.userId, displayName: await f.deps.users.getDisplayName(m0.b.userId) },
      song: { id: m0.b.submission!.id, track: m0.b.submission!.track, submitterComment: `${m0.b.userId}'s note`, comments: [] },
      votes: 0,
      departed: false,
    },
    outcome: "win",
    winnerUserId: m0.a.userId,
  });
  assert.equal(r0.a.player.displayName === m0.a.userId, false, "real display names, not ids");
  assert.deepEqual(revealed.bye, {
    player: { id: bye.userId, displayName: await f.deps.users.getDisplayName(bye.userId) },
    song: {
      id: bye.submission!.id, track: bye.submission!.track, submitterComment: `${bye.userId}'s note`,
      comments: [{ voter: { id: bye.userId, displayName: await f.deps.users.getDisplayName(bye.userId) }, text: "fun exhibition" }],
    },
  });
  // Server-only league fields never ride along.
  const league = (await f.repo.getLeague(f.leagueId))!;
  const json = JSON.stringify(revealed);
  assert.ok(!json.includes(league.h2hSalt!) && !/h2hParticipants|h2hSalt/.test(json));
});

test("a standard round's reveal and results stay the bare RoundResult[] array through the route table — no format key, same bytes as computeResults", async () => {
  const d = await deps();
  await d.repo.putSubmission({
    id: "sub-a", roundId: ROUND, userId: "u-sarah",
    track: { id: "t1", provider: "spotify", providerTrackId: "sp1", title: "Song A", artists: ["A"] },
  });
  await d.repo.putSubmission({
    id: "sub-b", roundId: ROUND, userId: "u-james",
    track: { id: "t2", provider: "spotify", providerTrackId: "sp2", title: "Song B", artists: ["B"] },
  });
  await d.repo.putBallot({ roundId: ROUND, voterId: "u-james", allocations: { "sub-a": 10 }, castAt: "2026-07-08T00:00:00.000Z" });
  const expected = JSON.stringify(await computeResults(d, ROUND));

  const routes = buildRoutes(d);
  const call = (method: string, path: string, caller: string) => {
    const match = matchRoute(routes, method, path)!;
    return match.route.handler({ caller, params: match.params, query: {}, body: undefined });
  };
  const revealed = await call("POST", `/rounds/${ROUND}/reveal`, "u-sarah");
  assert.ok(Array.isArray(revealed));
  assert.equal(JSON.stringify(revealed), expected);
  assert.equal(JSON.stringify(await call("GET", `/rounds/${ROUND}/results`, "u-me")), expected);
  // Points banked as ever; no W/L/D written, no head-to-head pins — only the
  // per-song tally the list was ranked from (BUG-18).
  const sarah = (await d.repo.getStandings("lg-test")).find((s) => s.userId === "u-sarah")!;
  assert.deepEqual([sarah.points, sarah.wins, sarah.losses, sarah.draws], [10, 0, 0, 0]);
  assert.equal("h2hDeparted" in (await d.repo.getRound(ROUND))!, false);
  assert.equal("h2hTally" in (await d.repo.getRound(ROUND))!, false);
  assert.deepEqual((await d.repo.getRound(ROUND))!.pointsTally, [
    { submissionId: "sub-a", pointsFor: 10, pointsAgainst: 0, distinctVoters: 1 },
    { submissionId: "sub-b", pointsFor: 0, pointsAgainst: 0, distinctVoters: 0 },
  ]);
});

// ---- Standard reveal: points banked exactly once (BUG-04) ----------------------
// A standard round claims itself and banks its points in ONE repository write
// (`revealPointsRoundOnce`), as a head-to-head round banks its W/L/D, so two
// reveals — the owner's, a timed auto-advance from a league read, a ballot or
// a submission — can race any way and every player's points still land
// exactly once. The answer stays the bare ranked list, byte for byte.
// (Timed races: progression.test.ts and voting.test.ts; stale PATCHes:
// rounds.test.ts.)

const POINTS_PLAYERS = ["u-me", "u-sarah", "u-james"];

interface PointsRound {
  deps: Deps;
  repo: MemoryRepository;
  leagueId: string;
  roundId: string;
  /** Each player's submission ids, in submission order. */
  songs: Map<string, string[]>;
}

/** A standard league of POINTS_PLAYERS (u-me owns it), created and joined
 *  through the handlers, round 1 opened, `songsEach` songs from every player
 *  (the league's submissionsPerPlayer), `antiVotes` anti-votes per voter, and
 *  voting open. Timed leagues run 1-day phases. */
async function pointsRoundInVoting({ songsEach = 1, antiVotes = 0, timed = false } = {}): Promise<PointsRound> {
  const repo = new MemoryRepository(false);
  const deps: Deps = { repo, users: new MemoryUserDirectory() };
  const lg = await createLeague(deps, OWNER, {
    name: "Points League", musicProvider: "mock", roundCount: 3,
    ...(timed ? { progression: "timed" as const, phaseDays: 1 } : {}),
  });
  for (const p of POINTS_PLAYERS.slice(1)) await joinLeague(deps, p, lg.inviteCode);
  await repo.updateLeagueSettings(lg.id, { ...lg.settings, submissionsPerPlayer: songsEach, downvotePoolSize: antiVotes });
  const round = await createRound(deps, OWNER, lg.id, { theme: "Openers" });
  await updateRound(deps, OWNER, lg.id, round.id, { status: "submitting" });
  const songs = new Map<string, string[]>();
  for (const p of POINTS_PLAYERS) {
    for (let i = 1; i <= songsEach; i++) {
      const sub = await submitSong(deps, p, round.id, {
        track: { id: `t-${p}-${i}`, provider: "mock", providerTrackId: `t-${p}-${i}`, title: `${p} song ${i}`, artists: [`Artist ${p} ${i}`] },
      });
      songs.set(p, [...(songs.get(p) ?? []), sub.id]);
    }
  }
  await updateRound(deps, OWNER, lg.id, round.id, { status: "previewing" });
  await updateRound(deps, OWNER, lg.id, round.id, { status: "voting" });
  return { deps, repo, leagueId: lg.id, roundId: round.id, songs };
}

/** Every player's banked points, by user. */
async function pointsOf(f: PointsRound): Promise<Record<string, number>> {
  return Object.fromEntries((await f.repo.getStandings(f.leagueId)).map((r) => [r.userId, r.points]));
}

/** Two ballots: u-me 5 + 5 on Sarah's and James's songs, u-sarah 5 + 5 on
 *  u-me's and James's → u-me 5, u-sarah 5, u-james 10. */
async function twoBallots(f: PointsRound): Promise<void> {
  const { castBallot } = await import("./voting.ts");
  const song = (p: string) => f.songs.get(p)![0]!;
  await castBallot(f.deps, "u-me", f.roundId, { allocations: { [song("u-sarah")]: 5, [song("u-james")]: 5 } });
  await castBallot(f.deps, "u-sarah", f.roundId, { allocations: { [song("u-me")]: 5, [song("u-james")]: 5 } });
}

test("standard reveal racing another reveal (the owner's, or one through the route table) banks every player's points exactly once; both answer the bare ranked list, byte for byte what it was before, and GET results agrees", async () => {
  const { revealRound, getResults } = await import("./voting.ts");
  const f = await pointsRoundInVoting();
  await twoBallots(f);
  const expected = JSON.stringify(await computeResults(f.deps, f.roundId));
  const banked = { "u-me": 5, "u-sarah": 5, "u-james": 10 };

  const routes = buildRoutes(f.deps);
  const match = matchRoute(routes, "POST", `/rounds/${f.roundId}/reveal`)!;
  const answers = await Promise.all([
    revealRound(f.deps, OWNER, f.roundId),
    match.route.handler({ caller: OWNER, params: match.params, query: {}, body: undefined }),
  ]);
  assert.deepEqual(await pointsOf(f), banked, "banked once, not twice");
  for (const answer of answers) assert.equal(JSON.stringify(answer), expected);
  assert.equal(JSON.stringify(await getResults(f.deps, SPECTATOR, f.roundId)), expected);
  const stored = (await f.repo.getRound(f.roundId))!;
  assert.equal(stored.status, "revealed");
  assert.equal("h2hTally" in stored, false, "no head-to-head pins on a standard round");
  assert.equal(stored.pointsTally?.length, 3, "the winning claim pinned its per-song tally (BUG-18)");

  // Settled: a later reveal is refused and banks nothing.
  await assert.rejects(revealRound(f.deps, OWNER, f.roundId), isStatus(400, /in voting/));
  assert.deepEqual(await pointsOf(f), banked);
});

test("standard: a reveal holding a round read while it was still voting banks nothing once another reveal settled it — it re-reads the round strongly consistently, answers the same list and brings the caller's copy up to date", async () => {
  const { revealRound } = await import("./voting.ts");
  const f = await pointsRoundInVoting();
  const stale = (await f.repo.getRound(f.roundId))!; // a racing request's copy
  await twoBallots(f);
  const first = await revealRound(f.deps, OWNER, f.roundId);
  const banked = await pointsOf(f);
  assert.deepEqual(banked, { "u-me": 5, "u-sarah": 5, "u-james": 10 });

  const reads: unknown[] = [];
  const spy = withRepo(f, {
    getRound: async (id, opts) => {
      reads.push(opts);
      return f.repo.getRound(id, opts);
    },
  });
  const again = await finalizeReveal(spy, stale);
  assert.deepEqual(await pointsOf(f), banked, "no double-bank");
  assert.deepEqual(reads, [{ consistent: true }], "the loser re-reads the settled round strongly consistently");
  assert.equal(JSON.stringify(again), JSON.stringify(first), "answers with the same ranked list");
  assert.equal(stale.status, "revealed", "the caller's copy is brought up to date");
});

test("standard, submissionsPerPlayer 2 + anti-votes: each player's results bank as ONE increment (their sum) in the claim's write — negative totals included, zero results skipped — and the standings match per-result banking; the round is written as before, just revealed, with every song's tally pinned", async () => {
  const { castBallot, revealRound } = await import("./voting.ts");
  const f = await pointsRoundInVoting({ songsEach: 2, antiVotes: 2 });
  const [me1, me2] = f.songs.get("u-me")!;
  const [, sarah2] = f.songs.get("u-sarah")!;
  const [james1, james2] = f.songs.get("u-james")!;
  // → u-me 10 + 5, u-james 10 + 5, u-sarah 0 (no points) and −3 (anti-votes only).
  await castBallot(f.deps, "u-me", f.roundId, { allocations: { [james1!]: 5, [james2!]: 5 }, downvotes: { [sarah2!]: 2 } });
  await castBallot(f.deps, "u-sarah", f.roundId, { allocations: { [me1!]: 5, [james1!]: 5 } });
  await castBallot(f.deps, "u-james", f.roundId, { allocations: { [me1!]: 5, [me2!]: 5 }, downvotes: { [sarah2!]: 1 } });
  const before = (await f.repo.getRound(f.roundId))!;
  const ranked = await computeResults(f.deps, f.roundId);
  assert.deepEqual(
    ranked.map((r) => [r.track.title, r.points]).sort(),
    [["u-james song 1", 10], ["u-james song 2", 5], ["u-me song 1", 10], ["u-me song 2", 5], ["u-sarah song 1", 0], ["u-sarah song 2", -3]],
  );

  const calls: unknown[] = [];
  const spy = withRepo(f, {
    revealPointsRoundOnce: async (round, points) => {
      calls.push(structuredClone(points));
      return f.repo.revealPointsRoundOnce(round, points);
    },
    addStandingPoints: async () => assert.fail("a reveal banks only through its claim"),
    updateRound: async () => assert.fail("a reveal writes the round only through its claim"),
  });
  const answer = await revealRound(spy, OWNER, f.roundId);
  assert.equal(JSON.stringify(answer), JSON.stringify(ranked), "the bare ranked list, unchanged");

  // One call; one entry per player, in ranked order of first appearance.
  const firstSeen = [...new Set(ranked.filter((r) => r.points !== 0).map((r) => r.submitter.id))];
  assert.equal(calls.length, 1);
  const sent = calls[0] as Array<{ userId: string; delta: number }>;
  assert.deepEqual(sent.map((p) => p.userId), firstSeen);
  assert.deepEqual(Object.fromEntries(sent.map((p) => [p.userId, p.delta])), { "u-me": 15, "u-james": 15, "u-sarah": -3 });

  // The totals the old per-result banking reached: 0 at join + every non-zero result.
  const perResult: Record<string, number> = { "u-me": 0, "u-sarah": 0, "u-james": 0 };
  for (const r of ranked) if (r.points !== 0) perResult[r.submitter.id]! += r.points;
  assert.deepEqual(await pointsOf(f), perResult);
  assert.deepEqual(await pointsOf(f), { "u-me": 15, "u-sarah": -3, "u-james": 15 });
  // The claim pinned every song's tally (BUG-18), in submission order —
  // anti-votes and zero rows included — and changed nothing else.
  const [sarah1] = f.songs.get("u-sarah")!;
  const tally = (submissionId: string, pointsFor: number, pointsAgainst: number, distinctVoters: number) =>
    ({ submissionId, pointsFor, pointsAgainst, distinctVoters });
  assert.deepEqual(await f.repo.getRound(f.roundId), {
    ...before,
    status: "revealed",
    pointsTally: [
      tally(me1!, 10, 0, 2), tally(me2!, 5, 0, 1),
      tally(sarah1!, 0, 0, 0), tally(sarah2!, 0, 3, 0),
      tally(james1!, 10, 0, 2), tally(james2!, 5, 0, 1),
    ],
  });
});

test("standard: a round where nobody scored claims the round and banks nothing; a reveal whose write fails banks nothing and leaves the round in voting — retrying banks it exactly once", async () => {
  const { revealRound, getResults } = await import("./voting.ts");
  const quiet = await pointsRoundInVoting();
  const sent: unknown[] = [];
  const spy = withRepo(quiet, {
    revealPointsRoundOnce: async (round, points) => {
      sent.push(points);
      return quiet.repo.revealPointsRoundOnce(round, points);
    },
  });
  await revealRound(spy, OWNER, quiet.roundId);
  assert.deepEqual(sent, [[]], "no ballots: every result is 0, nothing to bank");
  assert.equal((await quiet.repo.getRound(quiet.roundId))!.status, "revealed");
  assert.deepEqual(await pointsOf(quiet), { "u-me": 0, "u-sarah": 0, "u-james": 0 });

  const f = await pointsRoundInVoting();
  await twoBallots(f);
  const failing = withRepo(f, {
    revealPointsRoundOnce: async () => {
      throw Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" });
    },
  });
  await assert.rejects(revealRound(failing, OWNER, f.roundId), /throttled/);
  assert.equal((await f.repo.getRound(f.roundId))!.status, "voting");
  assert.deepEqual(await pointsOf(f), { "u-me": 0, "u-sarah": 0, "u-james": 0 }, "nothing banked");

  const payload = await revealRound(f.deps, OWNER, f.roundId);
  assert.deepEqual(await pointsOf(f), { "u-me": 5, "u-sarah": 5, "u-james": 10 }, "banked once");
  assert.deepEqual(await getResults(f.deps, SPECTATOR, f.roundId), payload);
});

test("MemoryRepository.revealPointsRoundOnce: claims an unsettled round and banks its points together (repeats summed, rows created in the order given); refused — writing and banking nothing — on a revealed, complete or missing round; a bad increment writes nothing", async () => {
  const repo = new MemoryRepository(false);
  const base: Round = { id: "lg-x~0001", leagueId: "lg-x", index: 1, theme: "T", status: "voting" };
  const rows = async () => (await repo.getStandings("lg-x")).map((r) => `${r.userId} ${r.points}`);
  await repo.addStandingPoints("lg-x", "u-a", 2); // an existing row (joined earlier)
  await repo.createRound(base);

  await assert.rejects(repo.revealPointsRoundOnce({ ...base, status: "revealed" }, [{ userId: "u-a", delta: 1.5 }]), /integer/);
  assert.equal((await repo.getRound(base.id))!.status, "voting", "a bad increment claims nothing");
  assert.deepEqual(await rows(), ["u-a 2"]);

  const points = [
    { userId: "u-c", delta: 4 },
    { userId: "u-a", delta: -3 },
    { userId: "u-b", delta: 6 },
    { userId: "u-c", delta: 1 },
  ];
  assert.equal(await repo.revealPointsRoundOnce({ ...base, status: "revealed" }, points), true);
  assert.equal((await repo.getRound(base.id))!.status, "revealed");
  assert.deepEqual(await rows(), ["u-a -1", "u-c 5", "u-b 6"], "new rows in first-write order, like the old per-result writes");
  assert.equal(await repo.revealPointsRoundOnce({ ...base, status: "revealed", theme: "Again" }, points), false);
  assert.equal((await repo.getRound(base.id))!.theme, "T");
  assert.deepEqual(await rows(), ["u-a -1", "u-c 5", "u-b 6"], "the loser banks nothing");

  const complete: Round = { ...base, id: "lg-x~0002", index: 2, status: "complete" };
  await repo.createRound(complete);
  assert.equal(await repo.revealPointsRoundOnce({ ...complete, status: "revealed" }, points), false);
  assert.deepEqual(await repo.getRound(complete.id), complete, "a complete round is settled: nothing written");
  assert.equal(await repo.revealPointsRoundOnce({ ...base, id: "lg-x~0009", index: 9, status: "revealed" }, points), false);
  assert.equal(await repo.getRound("lg-x~0009"), undefined, "no phantom round");
  assert.deepEqual(await rows(), ["u-a -1", "u-c 5", "u-b 6"]);

  // Nothing to bank: just the claim.
  const open: Round = { ...base, id: "lg-x~0003", index: 3 };
  await repo.createRound(open);
  assert.equal(await repo.revealPointsRoundOnce({ ...open, status: "revealed" }), true);
  assert.equal((await repo.getRound(open.id))!.status, "revealed");
  assert.deepEqual(await rows(), ["u-a -1", "u-c 5", "u-b 6"]);
});

// ---- Standard reveal pins its tally (BUG-18) ----------------------------------
// A standard reveal banks the points it tallied, so it pins those per-song
// numbers on the round in the same conditional write (`pointsTally`), as a
// head-to-head reveal pins `h2hTally`. GET results, the reveal page on reload
// and a lost claim's answer rank from the pin, so a ballot row written after
// the reveal read the ballots — racing its write, or one that passed
// castBallot's voting check just before it — is stored but can never make
// the results disagree with the standings. A revealed round without a pin
// (seeded, or revealed before the pin existed) re-tallies its rows as before.

/** A standard round's results payload: the bare ranked list. */
function ranked(payload: RoundResultsPayload): RoundResult[] {
  assert.ok(Array.isArray(payload), "a standard round answers the bare array");
  return payload;
}
/** `[rank, title, points]` per result, in ranked order. */
const ranking = (results: RoundResult[]) => results.map((r) => [r.rank, r.track.title, r.points]);

test("standard reveal pins its tally (BUG-18): a ballot written between the reveal's ballot read and its write, or one that passed castBallot's voting check just before the reveal and lands after it, changes neither the banked points nor GET results nor a lost claim's answer", async () => {
  const { castBallot, revealRound, getResults } = await import("./voting.ts");
  const f = await pointsRoundInVoting();
  const stale = (await f.repo.getRound(f.roundId))!; // a voter's copy, read while voting
  const song = (p: string) => f.songs.get(p)![0]!;
  await castBallot(f.deps, "u-me", f.roundId, { allocations: { [song("u-sarah")]: 5, [song("u-james")]: 5 } });

  // A ballot lands while the reveal is under way: after it read the ballots, before its write.
  const racing = withRepo(f, {
    revealPointsRoundOnce: async (round, points) => {
      await f.repo.putBallot({
        roundId: f.roundId, voterId: "u-sarah", allocations: { [song("u-me")]: 5, [song("u-james")]: 5 },
        castAt: new Date().toISOString(),
      });
      return f.repo.revealPointsRoundOnce(round, points);
    },
  });
  const revealed = ranked(await revealRound(racing, OWNER, f.roundId));
  assert.deepEqual(ranking(revealed), [[1, "u-james song 1", 5], [2, "u-sarah song 1", 5], [3, "u-me song 1", 0]]);
  const banked = await pointsOf(f);
  assert.deepEqual(banked, { "u-me": 0, "u-sarah": 5, "u-james": 5 });
  // One entry per song of the round, in the order the reveal read them, zeros included.
  assert.deepEqual((await f.repo.getRound(f.roundId))!.pointsTally, [
    { submissionId: song("u-me"), pointsFor: 0, pointsAgainst: 0, distinctVoters: 0 },
    { submissionId: song("u-sarah"), pointsFor: 5, pointsAgainst: 0, distinctVoters: 1 },
    { submissionId: song("u-james"), pointsFor: 5, pointsAgainst: 0, distinctVoters: 1 },
  ]);
  // Sarah's racing row alone already changes a re-tally; GET results keeps the reveal's answer.
  assert.deepEqual(
    ranking(await computeResults(f.deps, f.roundId)),
    [[1, "u-james song 1", 10], [2, "u-me song 1", 5], [3, "u-sarah song 1", 5]],
    "re-tallying the rows after the racing ballot would rank the round differently",
  );
  assert.equal(JSON.stringify(await getResults(f.deps, SPECTATOR, f.roundId)), JSON.stringify(revealed));

  // A voter whose castBallot read the round before the reveal: its check
  // passes and the ballot row is written after the reveal.
  const late = withRepo(f, { getRound: async () => structuredClone(stale) });
  assert.deepEqual(
    await castBallot(late, "u-james", f.roundId, { allocations: { [song("u-me")]: 5, [song("u-sarah")]: 5 } }),
    { ok: true },
  );
  assert.equal((await f.repo.getBallotsForRound(f.roundId)).length, 3, "both late ballots are stored");
  assert.deepEqual(
    ranking(await computeResults(f.deps, f.roundId)),
    [[1, "u-james song 1", 10], [2, "u-me song 1", 10], [3, "u-sarah song 1", 10]],
    "re-tallying the rows now would rank the round differently",
  );

  // The pinned tally keeps the banked ranking: GET results (the reveal page
  // on reload, through the route table too) and a reveal that loses its
  // claim answer exactly what the reveal answered.
  assert.equal(JSON.stringify(await getResults(f.deps, SPECTATOR, f.roundId)), JSON.stringify(revealed));
  const match = matchRoute(buildRoutes(f.deps), "GET", `/rounds/${f.roundId}/results`)!;
  assert.equal(
    JSON.stringify(await match.route.handler({ caller: "u-james", params: match.params, query: {}, body: undefined })),
    JSON.stringify(revealed),
  );
  const loser = structuredClone(stale);
  assert.equal(JSON.stringify(await finalizeReveal(f.deps, loser)), JSON.stringify(revealed));
  assert.equal(loser.status, "revealed");
  assert.deepEqual(await pointsOf(f), banked, "the standings are unchanged");
  assert.deepEqual(
    Object.fromEntries(ranked(await getResults(f.deps, SPECTATOR, f.roundId)).map((r) => [r.submitter.id, r.points])),
    banked,
    "the standings and the results agree",
  );
});

test("standard: a revealed round without a pinned tally (seeded, or revealed before BUG-18) still re-tallies its ballot rows, exactly as before", async () => {
  const { getResults } = await import("./voting.ts");
  const f = await pointsRoundInVoting();
  const song = (p: string) => f.songs.get(p)![0]!;
  await twoBallots(f);
  const round = (await f.repo.getRound(f.roundId))!;
  await f.repo.updateRound({ ...round, status: "revealed" }); // nothing pinned
  assert.equal("pointsTally" in (await f.repo.getRound(f.roundId))!, false);
  assert.equal(JSON.stringify(await getResults(f.deps, SPECTATOR, f.roundId)), JSON.stringify(await computeResults(f.deps, f.roundId)));
  assert.deepEqual(ranking(ranked(await getResults(f.deps, SPECTATOR, f.roundId))), [
    [1, "u-james song 1", 10], [2, "u-me song 1", 5], [3, "u-sarah song 1", 5],
  ]);

  // A ballot row written afterwards counts, as it always did there.
  await f.repo.putBallot({
    roundId: f.roundId, voterId: "u-james", allocations: { [song("u-me")]: 5, [song("u-sarah")]: 5 },
    castAt: new Date().toISOString(),
  });
  assert.deepEqual(ranking(ranked(await getResults(f.deps, SPECTATOR, f.roundId))), [
    [1, "u-james song 1", 10], [2, "u-me song 1", 10], [3, "u-sarah song 1", 10],
  ]);
});

test("standard: editing a revealed round (a theme fix) keeps its pinned tally, so its results still read back as banked", async () => {
  const { revealRound, getResults } = await import("./voting.ts");
  const f = await pointsRoundInVoting();
  const song = (p: string) => f.songs.get(p)![0]!;
  await twoBallots(f);
  const revealed = await revealRound(f.deps, OWNER, f.roundId);
  const settled = (await f.repo.getRound(f.roundId))!;
  assert.equal(settled.pointsTally?.length, 3);

  const edited = await updateRound(f.deps, OWNER, f.leagueId, f.roundId, { theme: "Renamed" });
  assert.deepEqual(edited, { ...settled, theme: "Renamed" });
  assert.deepEqual(await f.repo.getRound(f.roundId), { ...settled, theme: "Renamed" }, "the pin survives the edit");

  // A ballot row that raced the reveal still doesn't count.
  await f.repo.putBallot({
    roundId: f.roundId, voterId: "u-james", allocations: { [song("u-me")]: 5, [song("u-sarah")]: 5 },
    castAt: new Date().toISOString(),
  });
  assert.equal(JSON.stringify(await getResults(f.deps, SPECTATOR, f.roundId)), JSON.stringify(revealed));
});

// ---- Both reveals tally from a strongly consistent ballot read (BUG-05) -------
// DynamoDB's default Query is eventually consistent: a replica that hasn't
// applied a ballot write yet can serve it. In a timed league the last voter's
// castBallot writes their ballot, the everyone-voted check reads the ballots
// (and may see it), and the reveal reads them again — and, read the default
// way, may not. Both reveals pin or bank what they tally (the H2H `h2hTally`
// and its W/L/D; a standard round's points), so they read the ballots strongly
// consistently. GET results, turnout and progress reads keep the default.

/** `f.deps` with the ballot Query modelled as DynamoDB's eventual consistency
 *  (MemoryRepository is always consistent): once `voterId`'s ballot is
 *  written, the first default read of the round's ballots is served fresh
 *  (the timed advance's turnout check sees the vote), every later default
 *  read by a replica that hasn't applied that write yet; a strongly
 *  consistent read always sees it. */
function laggingReplica(f: { deps: Deps; repo: MemoryRepository }, voterId: string): Deps {
  let readsSinceWrite = -1; // -1: not written yet
  return withRepo(f, {
    putBallot: async (ballot) => {
      await f.repo.putBallot(ballot);
      if (ballot.voterId === voterId) readsSinceWrite = 0;
    },
    getBallotsForRound: async (roundId, opts) => {
      const all = await f.repo.getBallotsForRound(roundId, opts);
      if (readsSinceWrite < 0 || opts?.consistent) return all;
      readsSinceWrite += 1;
      return readsSinceWrite === 1 ? all : all.filter((b) => b.voterId !== voterId);
    },
  });
}

/** `f.deps` recording the options of every ballot Query into `reads`. */
function spyBallotReads(f: { deps: Deps; repo: MemoryRepository }, reads: unknown[]): Deps {
  return withRepo(f, {
    getBallotsForRound: async (roundId, opts) => {
      reads.push(opts);
      return f.repo.getBallotsForRound(roundId, opts);
    },
  });
}

test("H2H, timed: the ballot that completes the turnout is counted though a lagging replica would serve the reveal's ballot read without it — the pinned tally, GET results and the banked W/L/D all include it", async () => {
  const { castBallot, getResults } = await import("./voting.ts");
  const four = PLAYERS.slice(0, 4);
  const f = await h2hLeague(four, { timed: true });
  const round = await roundInVoting(f, four);
  const set = await serverSet(f, round.id);
  const [m0, m1] = set.matchups as [RoundMatchup, RoundMatchup];
  // In a 4-player league each pair votes in the other's matchup only: M1's
  // pair splits M0 (1–1, a draw), M0's pair both pick M1's side a (2–0).
  const last = m1.b.userId;
  const deps = laggingReplica(f, last);
  for (const voter of [m0.a.userId, m0.b.userId]) {
    await castBallot(deps, voter, round.id, { picks: { [m1.matchupId]: m1.a.submission!.id } });
  }
  await castBallot(deps, m1.a.userId, round.id, { picks: { [m0.matchupId]: m0.a.submission!.id } });
  assert.equal((await f.repo.getRound(round.id))!.status, "voting", "one vote still outstanding");

  assert.deepEqual(await castBallot(deps, last, round.id, { picks: { [m0.matchupId]: m0.b.submission!.id } }), { ok: true });
  const stored = (await f.repo.getRound(round.id))!;
  assert.equal(stored.status, "revealed", "the last ballot completed the turnout: the timed round revealed");
  assert.deepEqual(stored.h2hTally, [
    { matchupId: m0.matchupId, votesA: 1, votesB: 1 },
    { matchupId: m1.matchupId, votesA: 2, votesB: 0 },
  ], "the pinned tally counts the last voter's pick");
  const payload = h2h(await getResults(f.deps, SPECTATOR, round.id));
  assert.deepEqual(
    payload.matchups.map((m) => [m.matchupId, m.a.votes, m.b.votes, m.outcome]),
    [[m0.matchupId, 1, 1, "draw"], [m1.matchupId, 2, 0, "win"]],
  );
  const banked = await records(f);
  assert.deepEqual(
    [m0.a, m0.b, m1.a, m1.b].map((p) => banked.get(p.userId)),
    ["0-0-1", "0-0-1", "1-0-0", "0-1-0"],
  );
});

test("standard, timed: the ballot that completes the turnout is counted though a lagging replica would serve the reveal's ballot read without it — the banked points match GET results", async () => {
  const { castBallot, getResults } = await import("./voting.ts");
  const f = await pointsRoundInVoting({ timed: true });
  const song = (p: string) => f.songs.get(p)![0]!;
  const deps = laggingReplica(f, "u-james");
  await castBallot(deps, "u-me", f.roundId, { allocations: { [song("u-sarah")]: 5, [song("u-james")]: 5 } });
  await castBallot(deps, "u-sarah", f.roundId, { allocations: { [song("u-me")]: 5, [song("u-james")]: 5 } });
  assert.equal((await f.repo.getRound(f.roundId))!.status, "voting", "one vote still outstanding");

  assert.deepEqual(await castBallot(deps, "u-james", f.roundId, { allocations: { [song("u-me")]: 5, [song("u-sarah")]: 5 } }), { ok: true });
  assert.equal((await f.repo.getRound(f.roundId))!.status, "revealed", "the last ballot completed the turnout: the timed round revealed");
  assert.deepEqual(await pointsOf(f), { "u-me": 10, "u-sarah": 10, "u-james": 10 }, "the banked points count the last voter's ballot");
  const live = await getResults(f.deps, SPECTATOR, f.roundId);
  assert.ok(Array.isArray(live));
  assert.deepEqual(
    Object.fromEntries(live.map((r) => [r.submitter.id, r.points])),
    await pointsOf(f),
    "the standings and the results agree",
  );
});

test("both reveals read the round's ballots strongly consistently — the owner's reveal, a timed auto-reveal and opening voting on a round nobody can vote in; GET results, the turnout check and a lost claim's answer keep the default read; payloads unchanged", async () => {
  const { castBallot, revealRound, getResults } = await import("./voting.ts");
  const strong = { consistent: true };

  // Head-to-head, the owner's reveal: one ballot read, the tally's.
  const four = PLAYERS.slice(0, 4);
  const f = await h2hLeague(four);
  const round = await roundInVoting(f, four);
  const stale = structuredClone(round);
  await voteByPattern(f, round.id, four, ["aa", "ab"]);
  let reads: unknown[] = [];
  const revealed = h2h(await revealRound(spyBallotReads(f, reads), OWNER, round.id));
  assert.deepEqual(reads, [strong], "the H2H reveal tallies (and takes its comments) from one consistent read");
  reads = [];
  assert.deepEqual(await getResults(spyBallotReads(f, reads), SPECTATOR, round.id), revealed);
  assert.deepEqual(reads, [undefined], "GET results keeps the default read");
  reads = [];
  assert.deepEqual(await finalizeReveal(spyBallotReads(f, reads), stale), revealed);
  assert.deepEqual(reads, [strong, undefined], "a lost claim tallied consistently, then answers as GET results does");

  // Head-to-head, timed: the turnout check reads the default way, the reveal consistently.
  const timed = await h2hLeague(four, { timed: true });
  const timedRound = await roundInVoting(timed, four);
  const set = await serverSet(timed, timedRound.id);
  const voters = [...four].sort();
  for (const voter of voters.slice(0, 3)) {
    await castBallot(timed.deps, voter, timedRound.id, { picks: picksFor(set, voter, () => "a") });
  }
  reads = [];
  await castBallot(spyBallotReads(timed, reads), voters[3]!, timedRound.id, { picks: picksFor(set, voters[3]!, () => "a") });
  assert.equal((await timed.repo.getRound(timedRound.id))!.status, "revealed");
  assert.deepEqual(reads, [undefined, strong], "turnout: default; the reveal's tally: consistent");

  // Head-to-head, opening voting on a round nobody can vote in (every pair a walkover).
  const w = await h2hLeague(four);
  const walkovers = await createRound(w.deps, OWNER, w.leagueId, { theme: "Openers" });
  await updateRound(w.deps, OWNER, w.leagueId, walkovers.id, { status: "submitting" });
  const plan = await serverSet(w, walkovers.id);
  for (const m of plan.matchups) {
    await submitSong(w.deps, m.a.userId, walkovers.id, {
      track: { id: `t-${m.a.userId}`, provider: "mock", providerTrackId: `t-${m.a.userId}`, title: `${m.a.userId} anthem`, artists: [`Artist ${m.a.userId}`] },
    });
  }
  await updateRound(w.deps, OWNER, w.leagueId, walkovers.id, { status: "previewing" });
  reads = [];
  const opened = await updateRound(spyBallotReads(w, reads), OWNER, w.leagueId, walkovers.id, { status: "voting" });
  assert.equal(opened.status, "revealed");
  assert.deepEqual(reads.at(-1), strong, "the reveal's tally is the last ballot read, and consistent");
  assert.ok(reads.slice(0, -1).every((opts) => opts === undefined), "every read before it (turnout) keeps the default");

  // Standard, the owner's reveal: the tally's read is consistent; the payload is unchanged.
  const p = await pointsRoundInVoting();
  const pStale = (await p.repo.getRound(p.roundId))!;
  await twoBallots(p);
  const expected = JSON.stringify(await computeResults(p.deps, p.roundId));
  reads = [];
  const answer = await revealRound(spyBallotReads(p, reads), OWNER, p.roundId);
  assert.deepEqual(reads, [strong], "the standard reveal tallies from one consistent read");
  assert.equal(JSON.stringify(answer), expected, "byte-identical ranked list");
  reads = [];
  assert.equal(JSON.stringify(await getResults(spyBallotReads(p, reads), SPECTATOR, p.roundId)), expected);
  assert.deepEqual(reads, [undefined], "GET results keeps the default read");
  reads = [];
  assert.equal(JSON.stringify(await finalizeReveal(spyBallotReads(p, reads), pStale)), expected);
  assert.deepEqual(reads, [strong, undefined], "a lost claim tallied consistently, then answers as GET results does");

  // Standard, timed: the turnout check reads the default way, the reveal consistently.
  const pt = await pointsRoundInVoting({ timed: true });
  const song = (who: string) => pt.songs.get(who)![0]!;
  await castBallot(pt.deps, "u-me", pt.roundId, { allocations: { [song("u-sarah")]: 5, [song("u-james")]: 5 } });
  await castBallot(pt.deps, "u-sarah", pt.roundId, { allocations: { [song("u-me")]: 5, [song("u-james")]: 5 } });
  reads = [];
  await castBallot(spyBallotReads(pt, reads), "u-james", pt.roundId, { allocations: { [song("u-me")]: 5, [song("u-sarah")]: 5 } });
  assert.equal((await pt.repo.getRound(pt.roundId))!.status, "revealed");
  assert.deepEqual(reads, [undefined, strong], "turnout: default; the reveal's tally: consistent");
});
