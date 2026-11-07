// Voting-phase handler tests. HTH-05: the head-to-head matchups read API
// (GET /rounds/:roundId/matchups) — pairs derived from the frozen schedule,
// songs anonymized, the caller's own matchup flagged, the bye's exhibition
// song, walkover / no-contest sides as null, departures (withdrawn while the
// round is in play, never re-judged once it's revealed; the anonymous song
// list agrees), the phase + membership gates, and that nothing in the payload
// (or the league) gives away who submitted what or the frozen order. Every league is driven through the real flow
// (open round 1 → freeze, submit, close, open voting) over MemoryRepository,
// with the freeze RNG seeded through deps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository, MemoryUserDirectory } from "../data/memory.ts";
import type { Deps } from "./leagues.ts";
import { leaveLeague } from "./leagues.ts";
import { updateRound } from "./rounds.ts";
import { listVotableSubmissions, submitSong } from "./submissions.ts";
import { listMatchups } from "./matchups.ts";
import { ApiError } from "../domain/errors.ts";
import type { RandomInt } from "../domain/freeze.ts";
import type { RoundMatchupsView } from "../domain/matchups.ts";
import { matchupsForRound } from "../domain/schedule.ts";
import type { RoundMatchups } from "../domain/schedule.ts";
import { DEFAULT_LEAGUE_SETTINGS, H2H_FORCED_SETTINGS } from "../domain/types.ts";
import type { League, Round, RoundStatus, Submission } from "../domain/types.ts";
import { buildRoutes, matchRoute } from "../http/routes.ts";

const LEAGUE = "duel";
const ROUND = `${LEAGUE}~0001`;
const OWNER = "u-ana";
const FOUR = [OWNER, "u-ben", "u-cyd", "u-dot"];
const FIVE = [...FOUR, "u-eli"];
const SPECTATOR = "u-zed";
const NOTE = "submitter note: keep me hidden";

const SONGS = [
  { title: "Midnight City", artists: ["M83"] },
  { title: "Dreams", artists: ["Fleetwood Mac"] },
  { title: "Heroes", artists: ["David Bowie"] },
  { title: "Hounds of Love", artists: ["Kate Bush"] },
  { title: "Archangel", artists: ["Burial"] },
];

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

interface Setup {
  deps: Deps;
  repo: MemoryRepository;
  /** The stored league (with the frozen order + salt — server-side truth). */
  league: League;
  /** Each submitter's stored submission. */
  subs: Map<string, Submission>;
  /** The round's pairing, derived independently from the stored order + salt. */
  schedule: RoundMatchups;
}

/**
 * An H2H league of `members` (owner first) with round 1 opened — which
 * freezes the season — songs submitted by `submitters`, then moved on to
 * `status` (default voting), all through the real handlers.
 */
async function h2hRound(
  members: string[],
  { submitters = members, status = "voting" as RoundStatus } = {},
): Promise<Setup> {
  const repo = new MemoryRepository(false);
  await repo.createLeague({
    id: LEAGUE, name: "Duel League", ownerId: OWNER, musicProvider: "mock", format: "headToHead",
    settings: { ...DEFAULT_LEAGUE_SETTINGS, ...H2H_FORCED_SETTINGS }, memberIds: [...members],
    inviteCode: "DUEL-1", visibility: "private", roundCount: 3, progression: "manual",
  });
  for (const id of members) await repo.addStandingPoints(LEAGUE, id, 0);
  await repo.createRound({ id: ROUND, leagueId: LEAGUE, index: 1, theme: "Openers", status: "draft" });
  const deps: Deps = { repo, users: new MemoryUserDirectory(), randomInt: seeded(20261107) };

  await updateRound(deps, OWNER, LEAGUE, ROUND, { status: "submitting" }); // freezes the season
  for (const id of submitters) {
    const song = SONGS[members.indexOf(id)]!;
    await submitSong(deps, id, ROUND, {
      track: { id: `mock-${song.title}`, provider: "mock", providerTrackId: `mock-${song.title}`, ...song },
      comment: NOTE,
    });
  }
  for (const next of ["previewing", "voting"] as const) {
    if (status === "submitting" || (status === "previewing" && next === "voting")) break;
    await updateRound(deps, OWNER, LEAGUE, ROUND, { status: next });
  }
  if (status === "revealed" || status === "complete") await setStatus(repo, status);

  const league = (await repo.getLeague(LEAGUE))!;
  assert.equal(league.h2hParticipants?.length, members.length, "round 1 froze the season");
  const subs = new Map((await repo.getSubmissionsForRound(ROUND)).map((s) => [s.userId, s]));
  return { deps, repo, league, subs, schedule: matchupsForRound(league.h2hParticipants!, ROUND, 1, league.h2hSalt) };
}

/** Jump the round's status directly (reveal itself is HTH-07's business). */
async function setStatus(repo: MemoryRepository, status: RoundStatus): Promise<void> {
  const round = (await repo.getRound(ROUND)) as Round;
  await repo.updateRound({ ...round, status });
}

const isStatus = (code: number, message?: RegExp) => (e: unknown) =>
  e instanceof ApiError && e.statusCode === code && (message === undefined || message.test(e.message));

/** The anonymized song a submission should appear as. */
const anon = (s: Submission | undefined) => (s ? { id: s.id, track: s.track } : null);

/** The payload `viewer` should get, built from the independent derivation. */
function expectedView({ schedule, subs }: Setup, viewer: string): RoundMatchupsView {
  return {
    matchups: schedule.matchups.map((m) => ({
      matchupId: m.matchupId,
      a: anon(subs.get(m.a)),
      b: anon(subs.get(m.b)),
      isMine: m.a === viewer || m.b === viewer,
    })),
    bye: schedule.bye ? anon(subs.get(schedule.bye)) : null,
  };
}

/** Assert no submitter identity, no submitter note, no frozen order / salt. */
function assertAnonymous(view: unknown, league: League): void {
  const json = JSON.stringify(view);
  for (const id of league.memberIds) assert.ok(!json.includes(`"${id}"`), `payload leaks user id ${id}`);
  assert.ok(!json.includes(NOTE), "payload leaks a submitter note");
  assert.ok(!json.includes(league.h2hSalt!), "payload leaks the schedule salt");
  assert.ok(!/h2hParticipants|h2hSalt|userId|submitter/.test(json), "payload carries identity fields");
}

test("4 players, round 1, all submitted → 2 matchups, every song anonymized, the caller's matchup flagged isMine", async () => {
  const setup = await h2hRound(FOUR);
  const { deps, league, subs } = setup;

  for (const caller of FOUR) {
    const view = await listMatchups(deps, caller, ROUND);
    assert.deepEqual(view, expectedView(setup, caller));

    assert.equal(view.matchups.length, 2);
    assert.equal(view.bye, null); // even field: no bye
    assert.deepEqual(view.matchups.map((m) => m.matchupId), [`${ROUND}~M0`, `${ROUND}~M1`]); // sorted by id
    // Every song exactly once, as { id, track } and nothing else.
    const songs = view.matchups.flatMap((m) => [m.a, m.b]);
    assert.deepEqual(songs.map((s) => s?.id).sort(), [...subs.values()].map((s) => s.id).sort());
    for (const s of songs) assert.deepEqual(Object.keys(s!).sort(), ["id", "track"]);
    assertAnonymous(view, league);

    // Exactly one matchup is the caller's, and it holds the caller's own song.
    const mine = view.matchups.filter((m) => m.isMine);
    assert.equal(mine.length, 1, `${caller} plays exactly once`);
    assert.ok([mine[0]!.a?.id, mine[0]!.b?.id].includes(subs.get(caller)!.id));
  }
  // Stable across reads (ballots key picks by matchupId).
  assert.deepEqual(await listMatchups(deps, OWNER, ROUND), await listMatchups(deps, OWNER, ROUND));
});

test("5 players → 2 matchups + the bye player's exhibition song", async () => {
  const setup = await h2hRound(FIVE);
  const { deps, league, subs, schedule } = setup;
  assert.ok(schedule.bye);

  for (const caller of FIVE) {
    const view = await listMatchups(deps, caller, ROUND);
    assert.deepEqual(view, expectedView(setup, caller));
    assert.equal(view.matchups.length, 2);
    assert.deepEqual(view.bye, anon(subs.get(schedule.bye))); // the bye's song, anonymized
    assert.notEqual(view.bye, null);
    // All five songs appear exactly once (four in pairs + the bye).
    const ids = [...view.matchups.flatMap((m) => [m.a?.id, m.b?.id]), view.bye?.id];
    assert.deepEqual(ids.sort(), [...subs.values()].map((s) => s.id).sort());
    // The bye player sits out: no matchup of theirs. Everyone else plays once.
    assert.equal(view.matchups.filter((m) => m.isMine).length, caller === schedule.bye ? 0 : 1);
    assertAnonymous(view, league);
  }
});

test("one player didn't submit → their slot is null (walkover); the rest of the round is unaffected", async () => {
  // Pick the non-submitter from the derived schedule so it's a pair slot.
  const probe = await h2hRound(FOUR, { status: "submitting" });
  const absent = probe.schedule.matchups[1]!.b;
  const setup = await h2hRound(FOUR, { submitters: FOUR.filter((id) => id !== absent) });
  const { deps, subs, schedule } = setup;
  assert.deepEqual(schedule, probe.schedule); // same seed → same frozen season

  const view = await listMatchups(deps, OWNER, ROUND);
  assert.deepEqual(view, expectedView(setup, OWNER));
  const walkover = view.matchups[1]!;
  assert.equal(walkover.b, null);
  assert.deepEqual(walkover.a, anon(subs.get(schedule.matchups[1]!.a)));
  assert.ok(view.matchups[0]!.a && view.matchups[0]!.b, "the other matchup keeps both songs");
  // The non-submitter still sees their (walkover) matchup as theirs.
  const theirs = await listMatchups(deps, absent, ROUND);
  assert.equal(theirs.matchups[1]!.isMine, true);
  assert.equal(theirs.matchups[0]!.isMine, false);

  // Odd field, bye player didn't submit → no exhibition song.
  const probe5 = await h2hRound(FIVE, { status: "submitting" });
  const bye = probe5.schedule.bye!;
  const noBye = await h2hRound(FIVE, { submitters: FIVE.filter((id) => id !== bye) });
  assert.equal((await listMatchups(noBye.deps, OWNER, ROUND)).bye, null);
});

test("neither player submitted → the no-contest matchup is still listed during voting, both sides null", async () => {
  const probe = await h2hRound(FOUR, { status: "submitting" });
  const [x, y] = [probe.schedule.matchups[0]!.a, probe.schedule.matchups[0]!.b];
  const setup = await h2hRound(FOUR, { submitters: FOUR.filter((id) => id !== x && id !== y) });

  const view = await listMatchups(setup.deps, OWNER, ROUND);
  assert.equal(view.matchups.length, 2);
  assert.deepEqual(view.matchups[0], { matchupId: `${ROUND}~M0`, a: null, b: null, isMine: x === OWNER || y === OWNER });
  assert.ok(view.matchups[1]!.a && view.matchups[1]!.b);
});

test("a participant who left mid-season: their song is withdrawn, so their pair shows as a walkover", async () => {
  const setup = await h2hRound(FOUR);
  const { deps, subs, schedule } = setup;
  // Kick someone whose pair isn't the owner's (the owner can't be removed).
  const pair = schedule.matchups.findIndex((m) => m.a !== OWNER && m.b !== OWNER);
  const leaver = schedule.matchups[pair]!.a;
  await leaveLeague(deps, OWNER, LEAGUE, leaver);
  assert.ok(subs.has(leaver), "their submission is still stored");

  const view = await listMatchups(deps, OWNER, ROUND);
  assert.equal(view.matchups[pair]!.a, null);
  assert.deepEqual(view.matchups[pair]!.b, anon(subs.get(schedule.matchups[pair]!.b)));
  assert.ok(!JSON.stringify(view).includes(subs.get(leaver)!.id));
});

test("a revealed round is history: a later leave/kick doesn't rewrite it, for spectators, members or the departed player", async () => {
  const setup = await h2hRound(FIVE);
  const { deps, repo, subs, schedule } = setup;
  await setStatus(repo, "revealed");
  const before = await listMatchups(deps, SPECTATOR, ROUND);
  assert.deepEqual(before, expectedView(setup, SPECTATOR));

  // Kick a pair player and (if it isn't the owner) the bye player afterwards.
  const pair = schedule.matchups.findIndex((m) => m.a !== OWNER && m.b !== OWNER);
  const leaver = schedule.matchups[pair]!.a;
  await leaveLeague(deps, OWNER, LEAGUE, leaver);
  if (schedule.bye && schedule.bye !== OWNER) await leaveLeague(deps, OWNER, LEAGUE, schedule.bye);

  for (const status of ["revealed", "complete"] as const) {
    await setStatus(repo, status);
    assert.deepEqual(await listMatchups(deps, SPECTATOR, ROUND), before, `${status}: a played contest stays a contest`);
    assert.deepEqual(await listMatchups(deps, OWNER, ROUND), expectedView(setup, OWNER));
    // The departed player now reads as a non-member, and still sees the round
    // as it was played: their song in place, their own matchup flagged.
    const theirs = await listMatchups(deps, leaver, ROUND);
    assert.deepEqual(theirs, expectedView(setup, leaver));
    assert.equal(theirs.matchups[pair]!.isMine, true);
    assert.deepEqual(theirs.matchups[pair]!.a, anon(subs.get(leaver)));
  }
});

test("the anonymous song list agrees with the matchups: an H2H departed player's song is withdrawn there too; standard leagues keep it", async () => {
  const setup = await h2hRound(FOUR);
  const { deps, subs, schedule } = setup;
  const pair = schedule.matchups.findIndex((m) => m.a !== OWNER && m.b !== OWNER);
  const leaver = schedule.matchups[pair]!.b;
  await leaveLeague(deps, OWNER, LEAGUE, leaver);

  const ids = (songs: Array<{ id: string } | null>) => songs.flatMap((x) => (x ? [x.id] : [])).sort();
  const list = await listVotableSubmissions(deps, OWNER, ROUND);
  assert.deepEqual(ids(list), ids([...subs.values()].filter((x) => x.userId !== OWNER && x.userId !== leaver)));
  // Exactly the matchups' songs, minus the caller's own.
  const view = await listMatchups(deps, OWNER, ROUND);
  assert.deepEqual(ids(list), ids(view.matchups.flatMap((m) => [m.a, m.b]).filter((x) => x?.id !== subs.get(OWNER)!.id)));

  // Standard league: a departed player's song stays votable, exactly as before.
  const repo = new MemoryRepository(false);
  await repo.createLeague({
    id: "pts", name: "Points League", ownerId: OWNER, musicProvider: "mock", format: "standard",
    settings: { ...DEFAULT_LEAGUE_SETTINGS, submissionsPerPlayer: 1 }, memberIds: [...FOUR], inviteCode: "PTS-1",
    visibility: "private", roundCount: 3, progression: "manual",
  });
  await repo.createRound({ id: "pts~0001", leagueId: "pts", index: 1, theme: "Openers", status: "submitting" });
  const std: Deps = { repo, users: new MemoryUserDirectory() };
  for (const [i, id] of FOUR.entries()) {
    const song = SONGS[i]!;
    await submitSong(std, id, "pts~0001", {
      track: { id: `mock-${song.title}`, provider: "mock", providerTrackId: `mock-${song.title}`, ...song },
    });
  }
  await repo.updateRound({ ...((await repo.getRound("pts~0001")) as Round), status: "voting" });
  await leaveLeague(std, OWNER, "pts", "u-ben");
  const stdList = await listVotableSubmissions(std, OWNER, "pts~0001");
  assert.equal(stdList.length, 3);
  assert.ok(stdList.some((x) => x.track.title === SONGS[1]!.title), "the departed player's song is still listed");
});

test("standard-format round → 400; before voting a member gets 403 (no peeking), unknown round → 404", async () => {
  // A standard league in voting, songs in.
  const repo = new MemoryRepository(false);
  await repo.createLeague({
    id: "pts", name: "Points League", ownerId: OWNER, musicProvider: "mock", format: "standard",
    settings: DEFAULT_LEAGUE_SETTINGS, memberIds: [...FOUR], inviteCode: "PTS-1", visibility: "private",
    roundCount: 3, progression: "manual",
  });
  await repo.createRound({ id: "pts~0001", leagueId: "pts", index: 1, theme: "Openers", status: "voting" });
  const std: Deps = { repo, users: new MemoryUserDirectory() };
  await assert.rejects(listMatchups(std, OWNER, "pts~0001"), isStatus(400, /points/));
  await assert.rejects(listMatchups(std, SPECTATOR, "pts~0001"), isStatus(400));

  // H2H: every pre-voting phase is closed, to members and the owner alike.
  for (const status of ["submitting", "previewing"] as const) {
    const { deps } = await h2hRound(FOUR, { status });
    for (const caller of [OWNER, "u-ben"]) {
      await assert.rejects(listMatchups(deps, caller, ROUND), isStatus(403, /voting opens/), `${status} / ${caller}`);
    }
  }
  const { deps, repo: h2hRepo } = await h2hRound(FOUR);
  await setStatus(h2hRepo, "draft"); // hand-edited back to draft: still closed
  await assert.rejects(listMatchups(deps, "u-ben", ROUND), isStatus(403));

  await assert.rejects(listMatchups(deps, OWNER, "duel~0042"), isStatus(404));
});

test("spectators: 403 while voting (ballot internals are members-only); readable once revealed, never flagged isMine", async () => {
  const setup = await h2hRound(FIVE);
  const { deps, repo, league } = setup;
  await assert.rejects(listMatchups(deps, SPECTATOR, ROUND), isStatus(403, /members/));

  for (const status of ["revealed", "complete"] as const) {
    await setStatus(repo, status);
    const asSpectator = await listMatchups(deps, SPECTATOR, ROUND);
    assert.deepEqual(asSpectator, expectedView(setup, SPECTATOR));
    assert.ok(asSpectator.matchups.every((m) => !m.isMine));
    assertAnonymous(asSpectator, league);
    // Members keep reading it after the reveal too.
    assert.deepEqual(await listMatchups(deps, "u-ben", ROUND), expectedView(setup, "u-ben"));
  }
});

test("GET /rounds/:roundId/matchups through the real route table; no league payload echoes the frozen order", async () => {
  const setup = await h2hRound(FIVE);
  const { deps, league } = setup;
  const routes = buildRoutes(deps);
  const call = (method: string, path: string, caller: string) => {
    const match = matchRoute(routes, method, path);
    assert.ok(match, `no route for ${method} ${path}`);
    return match.route.handler({ caller, params: match.params, query: {}, body: undefined });
  };

  assert.deepEqual(await call("GET", `/rounds/${encodeURIComponent(ROUND)}/matchups`, "u-cyd"), expectedView(setup, "u-cyd"));
  await assert.rejects(call("GET", `/rounds/${ROUND}/matchups`, SPECTATOR), isStatus(403));

  // The frozen order and salt never leave the server — owner, member or spectator.
  for (const caller of [OWNER, "u-cyd", SPECTATOR]) {
    const json = JSON.stringify(await call("GET", `/leagues/${LEAGUE}`, caller));
    assert.ok(!json.includes("h2hParticipants") && !json.includes("h2hSalt"), caller);
    assert.ok(!json.includes(league.h2hSalt!), caller);
  }
});
