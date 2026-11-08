// Voting-phase handler tests. HTH-05: the head-to-head matchups read API
// (GET /rounds/:roundId/matchups) — pairs derived from the frozen schedule,
// songs anonymized, the caller's own matchup flagged, the bye's exhibition
// song, walkover / no-contest sides as null, departures (withdrawn while the
// round is in play, never re-judged once it's revealed; the anonymous song
// list agrees), the phase + membership gates, and that nothing in the payload
// (or the league) gives away who submitted what or the frozen order.
// HTH-06: casting a head-to-head ballot (POST /rounds/:roundId/ballot with
// `picks`) — stored on the voter's one Ballot row, refereed by
// validateH2HBallot over the same derived matchups, re-cast + my-ballot
// pre-fill, comments, format cross-checks, and the timed auto-reveal.
// BUG-02: a standard (points) ballot when the songs on offer can't take the
// whole pool (a two-player league, players who didn't submit, a low cap) —
// the voter spends exactly what those songs can take, end to end through the
// reveal and the timed everyone-voted reveal.
// BUG-04: in a timed standard league, the last two ballots cast at once
// reveal — and bank — the round once.
// BUG-11: with more than one song per player, points and anti-votes on ANY
// of the voter's songs are refused. BUG-17 (last): in every league — a
// legacy row that still says `allowSelfVote: true` included, and a settings
// PATCH that sends it stores false.
// Every league is driven through the real flow (open round 1 → freeze,
// submit, close, open voting) over MemoryRepository, with the freeze RNG
// seeded through deps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository, MemoryUserDirectory } from "../data/memory.ts";
import type { Deps } from "./leagues.ts";
import { createLeague, joinLeague, leaveLeague, updateLeagueSettings } from "./leagues.ts";
import { createRound, updateRound } from "./rounds.ts";
import { listVotableSubmissions, submitSong } from "./submissions.ts";
import { listMatchups } from "./matchups.ts";
import { castBallot, getMyBallot, revealRound } from "./voting.ts";
import { ApiError } from "../domain/errors.ts";
import type { RandomInt } from "../domain/freeze.ts";
import type { RoundMatchupsView } from "../domain/matchups.ts";
import { matchupsForRound } from "../domain/schedule.ts";
import type { RoundMatchups } from "../domain/schedule.ts";
import { DEFAULT_LEAGUE_SETTINGS, H2H_FORCED_SETTINGS } from "../domain/types.ts";
import type { League, LeagueSettings, Round, RoundStatus, Submission } from "../domain/types.ts";
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
  { submitters = members, status = "voting" as RoundStatus, timed = false } = {},
): Promise<Setup> {
  const repo = new MemoryRepository(false);
  await repo.createLeague({
    id: LEAGUE, name: "Duel League", ownerId: OWNER, musicProvider: "mock", format: "headToHead",
    settings: { ...DEFAULT_LEAGUE_SETTINGS, ...H2H_FORCED_SETTINGS }, memberIds: [...members],
    inviteCode: "DUEL-1", visibility: "private", roundCount: 3,
    ...(timed ? { progression: "timed" as const, phaseDays: 3 } : { progression: "manual" as const }),
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

/** The self-vote rule's two messages (domain/rules.ts `validateBallot`). */
const OWN_POINTS = /^You can't vote for your own submission\.$/;
const OWN_ANTI = /^You can't anti-vote your own submission\.$/;

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

// ---- HTH-06: casting head-to-head ballots ----------------------------------

/** The contests `voter` gets a pick in, from the independent derivation: both
 *  players submitted and the voter isn't one of them. */
function contestsFor({ schedule, subs }: Setup, voter: string) {
  return schedule.matchups.filter((m) => subs.has(m.a) && subs.has(m.b) && m.a !== voter && m.b !== voter);
}

/** A complete pick set for `voter`: side `pick` of every contest they vote in. */
function fullPicks(setup: Setup, voter: string, pick: "a" | "b" = "a"): Record<string, string> {
  return Object.fromEntries(contestsFor(setup, voter).map((m) => [m.matchupId, setup.subs.get(m[pick])!.id]));
}

/** The voter's own matchup in the derived schedule (undefined for the bye). */
const ownMatchup = ({ schedule }: Setup, voter: string) => schedule.matchups.find((m) => m.a === voter || m.b === voter);

/** A standard (points) league in voting with all four songs in. */
async function pointsRound() {
  const repo = new MemoryRepository(false);
  await repo.createLeague({
    id: "pts", name: "Points League", ownerId: OWNER, musicProvider: "mock", format: "standard",
    settings: DEFAULT_LEAGUE_SETTINGS, memberIds: [...FOUR], inviteCode: "PTS-1", visibility: "private",
    roundCount: 3, progression: "manual",
  });
  await repo.createRound({ id: "pts~0001", leagueId: "pts", index: 1, theme: "Openers", status: "submitting" });
  const deps: Deps = { repo, users: new MemoryUserDirectory() };
  for (const [i, id] of FOUR.entries()) {
    const song = SONGS[i]!;
    await submitSong(deps, id, "pts~0001", {
      track: { id: `mock-${song.title}`, provider: "mock", providerTrackId: `mock-${song.title}`, ...song },
    });
  }
  await repo.updateRound({ ...((await repo.getRound("pts~0001")) as Round), status: "voting" });
  const subs = new Map((await repo.getSubmissionsForRound("pts~0001")).map((x) => [x.userId, x]));
  return { deps, repo, subs };
}

test("H2H cast happy path: complete picks land on the voter's one Ballot row as allocations {} + picks; my-ballot returns them", async () => {
  const setup = await h2hRound(FIVE);
  const { deps, repo, schedule } = setup;

  for (const voter of FIVE) {
    const picks = fullPicks(setup, voter, voter === OWNER ? "b" : "a");
    // The bye player picks in both matchups; a paired player in the other one only.
    assert.equal(Object.keys(picks).length, voter === schedule.bye ? 2 : 1, voter);
    assert.deepEqual(await castBallot(deps, voter, ROUND, { picks }), { ok: true });

    const { castAt, ...stored } = (await repo.getBallot(ROUND, voter))!;
    assert.deepEqual(stored, { roundId: ROUND, voterId: voter, allocations: {}, picks, comments: {} });
    assert.ok(!Number.isNaN(Date.parse(castAt)));
    assert.deepEqual(await getMyBallot(deps, voter, ROUND), { allocations: {}, downvotes: {}, comments: {}, picks });
  }
  // One ballot row per voter — what completion % and everyone-voted count.
  assert.deepEqual((await repo.getBallotsForRound(ROUND)).map((b) => b.voterId).sort(), [...FIVE].sort());
  // The picks are keyed exactly by the matchups payload's ids.
  const ids = new Set((await listMatchups(deps, OWNER, ROUND)).matchups.map((m) => m.matchupId));
  for (const b of await repo.getBallotsForRound(ROUND)) {
    for (const id of Object.keys(b.picks!)) assert.ok(ids.has(id), id);
  }
});

test("H2H comments: any song in the round's matchups takes one — both songs of a matchup, their own matchup, the bye's song; unknown ids dropped", async () => {
  const setup = await h2hRound(FIVE);
  const { deps, repo, subs, schedule } = setup;
  const voter = schedule.matchups[0]!.a; // a paired player
  const own = ownMatchup(setup, voter)!;
  const [other] = contestsFor(setup, voter);
  const song = (userId: string) => subs.get(userId)!.id;

  await castBallot(deps, voter, ROUND, {
    picks: fullPicks(setup, voter),
    comments: {
      [song(other!.a)]: "  great opener ",
      [song(other!.b)]: "solid",
      [song(own.a)]: "mine — comments aren't votes",
      [song(own.b)]: "my opponent's",
      [song(schedule.bye!)]: "the exhibition song",
      "s-nope": "not a song in this round",
      [song(other!.a) + "x"]: "near miss",
    },
  });
  assert.deepEqual((await repo.getBallot(ROUND, voter))!.comments, {
    [song(other!.a)]: "great opener",
    [song(other!.b)]: "solid",
    [song(own.a)]: "mine — comments aren't votes",
    [song(own.b)]: "my opponent's",
    [song(schedule.bye!)]: "the exhibition song",
  });
  // Blank comments are dropped, as for standard ballots.
  await castBallot(deps, voter, ROUND, { picks: fullPicks(setup, voter), comments: { [song(other!.a)]: "   " } });
  assert.deepEqual((await repo.getBallot(ROUND, voter))!.comments, {});
});

test("H2H recast overwrites the picks and keeps the comments — my-ballot pre-fills exactly what was cast", async () => {
  const setup = await h2hRound(FOUR);
  const { deps, repo, subs } = setup;
  const voter = "u-ben";
  const own = ownMatchup(setup, voter)!;
  const [contest] = contestsFor(setup, voter);
  const comments = {
    [subs.get(contest!.a)!.id]: "loved this one",
    [subs.get(contest!.b)!.id]: "close call",
    [subs.get(voter)!.id]: "my pick, for the record",
    [subs.get(own.a === voter ? own.b : own.a)!.id]: "tough opponent",
  };
  const first = fullPicks(setup, voter, "a");
  await castBallot(deps, voter, ROUND, { picks: first, comments });
  const castAt1 = (await repo.getBallot(ROUND, voter))!.castAt;

  // The vote page pre-fills from my-ballot: exactly what was cast.
  const prefill = (await getMyBallot(deps, voter, ROUND))!;
  assert.deepEqual(prefill, { allocations: {}, downvotes: {}, comments, picks: first });

  // Change the pick, re-submit with the pre-filled comments.
  const second = fullPicks(setup, voter, "b");
  assert.notDeepEqual(second, first);
  await castBallot(deps, voter, ROUND, { picks: second, comments: prefill.comments });

  const ballots = await repo.getBallotsForRound(ROUND);
  assert.equal(ballots.length, 1, "the re-cast overwrote the row, no second ballot");
  assert.deepEqual(ballots[0]!.picks, second);
  assert.deepEqual(ballots[0]!.comments, comments, "comments survive the re-cast");
  assert.ok(ballots[0]!.castAt >= castAt1);
  assert.deepEqual(await getMyBallot(deps, voter, ROUND), { allocations: {}, downvotes: {}, comments, picks: second });
});

test("a standard league ballot carrying picks → rejected, nothing stored; an empty picks map is tolerated and my-ballot's shape is unchanged", async () => {
  const { deps, repo, subs } = await pointsRound();
  const allocations = { [subs.get("u-ben")!.id]: 5, [subs.get("u-cyd")!.id]: 5 };

  await assert.rejects(
    castBallot(deps, OWNER, "pts~0001", { allocations, picks: { "pts~0001~M0": subs.get("u-ben")!.id } }),
    isStatus(400, /scores by points/),
  );
  await assert.rejects(castBallot(deps, OWNER, "pts~0001", { allocations, picks: "u-ben" as never }), isStatus(400, /scores by points/));
  assert.equal(await repo.getBallot("pts~0001", OWNER), undefined, "nothing stored");

  // No picks / an empty map: the points ballot goes through exactly as before.
  await castBallot(deps, OWNER, "pts~0001", { allocations, picks: {} });
  await castBallot(deps, "u-ben", "pts~0001", { allocations: { [subs.get(OWNER)!.id]: 5, [subs.get("u-cyd")!.id]: 5 } });
  for (const voter of [OWNER, "u-ben"]) {
    const stored = (await repo.getBallot("pts~0001", voter))!;
    assert.deepEqual(Object.keys(stored).sort(), ["allocations", "castAt", "comments", "downvotes", "roundId", "voterId"]);
    const mine = (await getMyBallot(deps, voter, "pts~0001"))!;
    assert.deepEqual(Object.keys(mine).sort(), ["allocations", "comments", "downvotes"], "no picks key on a standard my-ballot");
  }
  // And the points rules still referee it.
  await assert.rejects(castBallot(deps, "u-cyd", "pts~0001", { allocations: { [subs.get(OWNER)!.id]: 3 } }), isStatus(400, /exactly 10/));
});

test("an H2H ballot with non-empty allocations → rejected (and anti-votes); an empty allocations map is tolerated", async () => {
  const setup = await h2hRound(FOUR);
  const { deps, repo, subs } = setup;
  const voter = "u-cyd";
  const picks = fullPicks(setup, voter);
  const otherSong = Object.values(picks)[0]!;

  // A points ballot posted to an H2H league (e.g. an old cached vote page) …
  await assert.rejects(castBallot(deps, voter, ROUND, { allocations: { [otherSong]: 10 } }), isStatus(400, /head-to-head/));
  // … or points alongside otherwise-valid picks.
  await assert.rejects(castBallot(deps, voter, ROUND, { allocations: { [otherSong]: 10 }, picks }), isStatus(400, /head-to-head/));
  await assert.rejects(castBallot(deps, voter, ROUND, { allocations: { [otherSong]: 0 }, picks }), isStatus(400, /head-to-head/));
  await assert.rejects(castBallot(deps, voter, ROUND, { downvotes: { [subs.get(OWNER)!.id]: 1 }, picks }), isStatus(400, /anti-votes/));
  assert.equal(await repo.getBallot(ROUND, voter), undefined, "nothing stored");

  await castBallot(deps, voter, ROUND, { allocations: {}, downvotes: {}, picks });
  const stored = (await repo.getBallot(ROUND, voter))!;
  assert.deepEqual(stored.allocations, {});
  assert.deepEqual(stored.picks, picks);
  assert.equal(stored.downvotes, undefined);
});

test("the referee through the handler: missing, own-matchup, foreign-song and unknown-matchup picks → 400 and the earlier ballot stands; phase, deadline and membership guards unchanged", async () => {
  const setup = await h2hRound(FIVE);
  const { deps, repo, subs, schedule } = setup;
  const voter = schedule.bye!; // votes in both matchups
  const picks = fullPicks(setup, voter);
  const [m0, m1] = schedule.matchups;

  await assert.rejects(castBallot(deps, voter, ROUND, {}), isStatus(400, /every matchup.*you picked 0/));
  await assert.rejects(castBallot(deps, voter, ROUND, { picks: { [m0!.matchupId]: picks[m0!.matchupId]! } }), isStatus(400, /you picked 1/));
  await assert.rejects(
    castBallot(deps, voter, ROUND, { picks: { ...picks, [m0!.matchupId]: subs.get(m1!.a)!.id } }),
    isStatus(400, /isn't in matchup/),
  );
  await assert.rejects(
    castBallot(deps, voter, ROUND, { picks: { ...picks, [m0!.matchupId]: subs.get(voter)!.id } }), // the bye's own song
    isStatus(400, /isn't in matchup/),
  );
  await assert.rejects(castBallot(deps, voter, ROUND, { picks: { ...picks, [`${ROUND}~M7`]: subs.get(m0!.a)!.id } }), isStatus(400, /Unknown matchup/));
  // A paired player picking in their own matchup.
  const paired = m0!.a;
  await assert.rejects(
    castBallot(deps, paired, ROUND, { picks: { ...fullPicks(setup, paired), [m0!.matchupId]: subs.get(m0!.b)!.id } }),
    isStatus(400, /your own matchup/),
  );
  assert.equal((await repo.getBallotsForRound(ROUND)).length, 0, "no rejected ballot was stored");

  // A rejected re-cast leaves the earlier valid ballot in place.
  await castBallot(deps, voter, ROUND, { picks, comments: { [subs.get(m0!.a)!.id]: "keep me" } });
  await assert.rejects(castBallot(deps, voter, ROUND, { picks: {} }), isStatus(400));
  assert.deepEqual((await repo.getBallot(ROUND, voter))!.picks, picks);
  assert.deepEqual((await repo.getBallot(ROUND, voter))!.comments, { [subs.get(m0!.a)!.id]: "keep me" });

  // Guards shared with standard ballots: membership, phase, deadline.
  await assert.rejects(castBallot(deps, SPECTATOR, ROUND, { picks }), isStatus(403));
  const round = (await repo.getRound(ROUND))!;
  await repo.updateRound({ ...round, voteDeadline: new Date(Date.now() - 60_000).toISOString() });
  await assert.rejects(castBallot(deps, voter, ROUND, { picks }), isStatus(400, /deadline/));
  for (const status of ["submitting", "previewing", "revealed"] as const) {
    await repo.updateRound({ ...round, status });
    await assert.rejects(castBallot(deps, voter, ROUND, { picks }), isStatus(400, /isn't open for voting/), status);
  }
});

test("a departure mid-voting: the pre-filled re-cast goes through and keeps the now-walkover pick and its comments, so a rejoin restores them", async () => {
  const setup = await h2hRound(FIVE);
  const { deps, repo, subs, schedule } = setup;
  // The bye player (who votes in every matchup) picks the leaver's song and
  // comments on it; that player is then kicked.
  const voter = schedule.bye!;
  const [contest, other] = contestsFor(setup, voter).sort((x, y) => Number(y.a === OWNER || y.b === OWNER) - Number(x.a === OWNER || x.b === OWNER));
  assert.ok(contest && other);
  const leaver = [other.a, other.b].find((u) => u !== OWNER)!; // the owner can't be removed
  const stayer = other.a === leaver ? other.b : other.a;
  const picks = { [contest.matchupId]: subs.get(contest.a)!.id, [other.matchupId]: subs.get(leaver)!.id };
  const comments = { [subs.get(leaver)!.id]: "on the departed song", [subs.get(stayer)!.id]: "on the stayer's song" };
  await castBallot(deps, voter, ROUND, { picks, comments });

  await leaveLeague(deps, OWNER, LEAGUE, leaver);
  const view = await listMatchups(deps, voter, ROUND);
  assert.equal(view.matchups.filter((m) => m.a && m.b).length, 1, "the leaver's pair is a walkover now");
  // my-ballot still returns exactly what was cast …
  const prefill = (await getMyBallot(deps, voter, ROUND))!;
  assert.deepEqual(prefill, { allocations: {}, downvotes: {}, comments, picks });
  // … and re-casting it goes through unchanged: the now-walkover pick (naming
  // the withdrawn song) is kept, inert, and its song keeps its comment.
  await castBallot(deps, voter, ROUND, { picks: prefill.picks, comments: prefill.comments });
  assert.deepEqual((await repo.getBallot(ROUND, voter))!.picks, picks);
  assert.deepEqual((await repo.getBallot(ROUND, voter))!.comments, comments);
  // The walkover pick isn't required any more — the other contest completes the ballot …
  await castBallot(deps, voter, ROUND, { picks: { [contest.matchupId]: picks[contest.matchupId]! }, comments });
  assert.deepEqual((await repo.getBallot(ROUND, voter))!.picks, { [contest.matchupId]: picks[contest.matchupId] });
  // … and a walkover pick that can't predate the departure is dropped, not kept or rejected.
  await castBallot(deps, voter, ROUND, { picks: { ...picks, [other.matchupId]: "garbage" }, comments });
  assert.deepEqual((await repo.getBallot(ROUND, voter))!.picks, { [contest.matchupId]: picks[contest.matchupId] });
  await castBallot(deps, voter, ROUND, { picks, comments }); // back to the pre-filled ballot

  // The leaver can't vote; the stayer's own matchup is still off-limits.
  await assert.rejects(castBallot(deps, leaver, ROUND, { picks: {} }), isStatus(403));
  await assert.rejects(
    castBallot(deps, stayer, ROUND, { picks: { ...fullPicks(setup, stayer), [other.matchupId]: subs.get(stayer)!.id } }),
    isStatus(400, /your own matchup/),
  );

  // The leaver rejoins: their pair is a contest again and the ballot still holds the pick + comments.
  await repo.putInvite("DUEL-1", LEAGUE); // h2hRound creates the league row only
  await joinLeague(deps, leaver, "DUEL-1");
  assert.equal((await listMatchups(deps, voter, ROUND)).matchups.filter((m) => m.a && m.b).length, 2);
  assert.deepEqual(await getMyBallot(deps, voter, ROUND), { allocations: {}, downvotes: {}, comments, picks });
  await castBallot(deps, voter, ROUND, { picks, comments });
  assert.deepEqual((await repo.getBallot(ROUND, voter))!.picks, picks);
});

test("nothing to vote on (a two-player league's only matchup is the voter's own): a ballot with no picks is accepted and still carries comments", async () => {
  const duo = [OWNER, "u-ben"];
  // Staged straight into voting: since HTH-08, opening voting through the
  // handlers reveals a round nobody can vote in on the spot. Such a round can
  // still be found in voting (one already there, or a smaller league after
  // departures mid-voting) — and a voter with nothing to vote on, in any
  // round, is refereed the same way.
  const { deps, repo, subs } = await h2hRound(duo, { status: "previewing" });
  await setStatus(repo, "voting");
  await castBallot(deps, OWNER, ROUND, { comments: { [subs.get("u-ben")!.id]: "good luck" } });
  const stored = (await repo.getBallot(ROUND, OWNER))!;
  assert.deepEqual(stored.picks, {});
  assert.deepEqual(stored.comments, { [subs.get("u-ben")!.id]: "good luck" });
  assert.deepEqual((await getMyBallot(deps, OWNER, ROUND))!.picks, {});
  // Picking in it is still the self-vote rule.
  const [only] = (await listMatchups(deps, "u-ben", ROUND)).matchups;
  await assert.rejects(castBallot(deps, "u-ben", ROUND, { picks: { [only!.matchupId]: subs.get(OWNER)!.id } }), isStatus(400, /your own matchup/));
});

test("timed H2H league: the last outstanding ballot still triggers the auto-reveal (autoAdvanceRound runs after an H2H cast)", async () => {
  const setup = await h2hRound(FOUR, { timed: true });
  const { deps, repo } = setup;
  assert.equal((await repo.getRound(ROUND))!.status, "voting");
  for (const [i, voter] of FOUR.entries()) {
    await castBallot(deps, voter, ROUND, { picks: fullPicks(setup, voter) });
    const status = (await repo.getRound(ROUND))!.status;
    assert.equal(status, i < FOUR.length - 1 ? "voting" : "revealed", `after ${i + 1} ballots`);
  }
  await assert.rejects(castBallot(deps, OWNER, ROUND, { picks: fullPicks(setup, OWNER) }), isStatus(400, /isn't open for voting/));
});

test("POST /rounds/:roundId/ballot forwards `picks` through the route table's field list; GET my-ballot returns them", async () => {
  const setup = await h2hRound(FOUR);
  const { deps, repo, subs } = setup;
  const routes = buildRoutes(deps);
  const call = (method: string, path: string, caller: string, body?: unknown) => {
    const match = matchRoute(routes, method, path);
    assert.ok(match, `no route for ${method} ${path}`);
    return match.route.handler({ caller, params: match.params, query: {}, body });
  };
  const picks = fullPicks(setup, "u-dot");
  const comments = { [Object.values(picks)[0]!]: "via the route" };
  assert.deepEqual(await call("POST", `/rounds/${encodeURIComponent(ROUND)}/ballot`, "u-dot", { picks, comments }), { ok: true });
  assert.deepEqual((await repo.getBallot(ROUND, "u-dot"))!.picks, picks);
  assert.deepEqual(await call("GET", `/rounds/${encodeURIComponent(ROUND)}/my-ballot`, "u-dot"), {
    allocations: {}, downvotes: {}, comments, picks,
  });
  // An H2H points body through the route is still refused.
  await assert.rejects(
    call("POST", `/rounds/${ROUND}/ballot`, "u-ben", { allocations: { [subs.get(OWNER)!.id]: 10 } }),
    isStatus(400, /head-to-head/),
  );
});

// ---- Standard ballots: the effective pool (BUG-02) --------------------------
//
// A voter can always cast a valid points ballot: when the songs on offer (the
// vote page's list — every song but the voter's own) times the per-song cap
// fall short of the pool, the ballot spends exactly what they can take.

const TINY = "tiny";
const TINY_ROUND = `${TINY}~0001`;

/** A small standard league driven through the real flow: `members` (owner
 *  first), songs from `submitters`, then the owner moves the round on to
 *  previewing and voting (a timed league may already be past submitting). */
async function smallPointsRound(
  members: string[],
  { submitters = members, settings = {}, timed = false }: { submitters?: string[]; settings?: Partial<LeagueSettings>; timed?: boolean } = {},
) {
  const repo = new MemoryRepository(false);
  await repo.createLeague({
    id: TINY, name: "Tiny League", ownerId: OWNER, musicProvider: "mock", format: "standard",
    settings: { ...DEFAULT_LEAGUE_SETTINGS, ...settings }, memberIds: [...members], inviteCode: "TINY-1",
    visibility: "private", roundCount: 3,
    ...(timed ? { progression: "timed" as const, phaseDays: 3 } : { progression: "manual" as const }),
  });
  for (const id of members) await repo.addStandingPoints(TINY, id, 0);
  await repo.createRound({ id: TINY_ROUND, leagueId: TINY, index: 1, theme: "Openers", status: "submitting" });
  const deps: Deps = { repo, users: new MemoryUserDirectory() };
  for (const id of submitters) {
    const song = SONGS[members.indexOf(id)]!;
    await submitSong(deps, id, TINY_ROUND, {
      track: { id: `mock-${song.title}`, provider: "mock", providerTrackId: `mock-${song.title}`, ...song },
    });
  }
  const order: RoundStatus[] = ["submitting", "previewing", "voting"];
  for (const next of ["previewing", "voting"] as const) {
    const { status } = (await repo.getRound(TINY_ROUND))!;
    if (order.indexOf(status) < order.indexOf(next)) await updateRound(deps, OWNER, TINY, TINY_ROUND, { status: next });
  }
  assert.equal((await repo.getRound(TINY_ROUND))!.status, "voting");
  const subs = new Map((await repo.getSubmissionsForRound(TINY_ROUND)).map((x) => [x.userId, x]));
  return { deps, repo, subs };
}

/** Each song's points in a standard round's results, by submitter. */
const pointsBySubmitter = (results: unknown) =>
  Object.fromEntries((results as Array<{ submitter: { id: string }; points: number }>).map((r) => [r.submitter.id, r.points]));

test("a two-player standard league (pool 10, cap 5): each voter has one song on offer, so 5 points is the full ballot — both are accepted and the reveal tallies them", async () => {
  const { deps, repo, subs } = await smallPointsRound([OWNER, "u-ben"]);
  const [offered] = await listVotableSubmissions(deps, OWNER, TINY_ROUND);
  assert.equal((await listVotableSubmissions(deps, OWNER, TINY_ROUND)).length, 1, "the vote page shows one song");
  assert.equal(offered!.id, subs.get("u-ben")!.id);

  // Short of what the song can take, or over the cap → still refused.
  await assert.rejects(
    castBallot(deps, OWNER, TINY_ROUND, { allocations: { [offered!.id]: 4 } }),
    isStatus(400, /^You must spend exactly 5 points \(you spent 4\)/),
  );
  await assert.rejects(castBallot(deps, OWNER, TINY_ROUND, { allocations: { [offered!.id]: 6 } }), isStatus(400, /more than 5/));
  assert.equal(await repo.getBallot(TINY_ROUND, OWNER), undefined, "nothing stored");

  await castBallot(deps, OWNER, TINY_ROUND, { allocations: { [offered!.id]: 5 }, comments: { [offered!.id]: "great" } });
  await castBallot(deps, "u-ben", TINY_ROUND, { allocations: { [subs.get(OWNER)!.id]: 5 } });
  assert.deepEqual((await getMyBallot(deps, OWNER, TINY_ROUND))!.allocations, { [offered!.id]: 5 });

  const results = await revealRound(deps, OWNER, TINY_ROUND);
  assert.deepEqual(pointsBySubmitter(results), { [OWNER]: 5, "u-ben": 5 });
  const standings = Object.fromEntries((await repo.getStandings(TINY)).map((s) => [s.userId, s.points]));
  assert.deepEqual(standings, { [OWNER]: 5, "u-ben": 5 });
});

test("a legacy row with allowSelfVote: true: the voter's own song isn't added back, and a ballot that self-votes is refused (BUG-17)", async () => {
  // The league row is written straight to the repository, as one stored
  // before the option was removed would be.
  const { deps, repo, subs } = await smallPointsRound([OWNER, "u-ben"], { settings: { allowSelfVote: true } });
  assert.equal((await listVotableSubmissions(deps, OWNER, TINY_ROUND)).length, 1);
  const own = subs.get(OWNER)!.id;
  const other = subs.get("u-ben")!.id;
  // Points on the voter's own song: the self-vote rule, whatever the row says.
  await assert.rejects(castBallot(deps, OWNER, TINY_ROUND, { allocations: { [own]: 5, [other]: 5 } }), isStatus(400, OWN_POINTS));
  await assert.rejects(
    castBallot(deps, "u-ben", TINY_ROUND, { allocations: { [subs.get("u-ben")!.id]: 2, [own]: 3 } }),
    isStatus(400, OWN_POINTS),
  );
  assert.equal(await repo.getBallot(TINY_ROUND, OWNER), undefined, "nothing stored");
  assert.equal(await repo.getBallot(TINY_ROUND, "u-ben"), undefined, "nothing stored");
  // The page can only place 5 (one song); the server wants exactly that.
  await castBallot(deps, OWNER, TINY_ROUND, { allocations: { [other]: 5 } });
  await castBallot(deps, "u-ben", TINY_ROUND, { allocations: { [own]: 5 } });
  assert.deepEqual(pointsBySubmitter(await revealRound(deps, OWNER, TINY_ROUND)), { [OWNER]: 5, "u-ben": 5 });
});

test("BUG-17 repro over the routes: a settings PATCH with allowSelfVote: true is accepted but stores false, and a ballot with points on the caller's own song is refused", async () => {
  // u-me's standard league; u-sarah, u-james, u-mia and u-luna join.
  const repo = new MemoryRepository(false);
  const deps: Deps = { repo, users: new MemoryUserDirectory() };
  const routes = buildRoutes(deps);
  const call = (caller: string, method: string, path: string, body?: unknown) => {
    const match = matchRoute(routes, method, path);
    assert.ok(match, `no route for ${method} ${path}`);
    return match.route.handler({ caller, params: match.params, query: {}, body });
  };
  const lg = (await call("u-me", "POST", "/leagues", { name: "Self Vote Repro", musicProvider: "mock", roundCount: 3 })) as League;
  for (const p of ["u-sarah", "u-james", "u-mia", "u-luna"]) await call(p, "POST", "/leagues/join", { code: lg.inviteCode });

  // Step 1: an older frontend still sends the field — the save goes through,
  // but self-voting stays off, in the response and in the stored row.
  const saved = (await call("u-me", "PATCH", `/leagues/${lg.id}/settings`, {
    votePoolSize: 10, maxPointsPerSong: 5, allowSelfVote: true, submissionsPerPlayer: 1, downvotePoolSize: 1,
  })) as League;
  assert.equal(saved.settings.allowSelfVote, false);
  assert.equal(saved.settings.downvotePoolSize, 1, "the rest of the PATCH is saved");
  assert.equal((await repo.getLeague(lg.id))!.settings.allowSelfVote, false);

  // Step 2: run a round to voting; the vote list never holds u-me's song.
  const players = ["u-me", "u-sarah", "u-james", "u-mia", "u-luna"];
  const round = (await call("u-me", "POST", `/leagues/${lg.id}/rounds`, { theme: "Openers" })) as Round;
  await call("u-me", "PATCH", `/leagues/${lg.id}/rounds/${round.id}`, { status: "submitting" });
  const song = new Map<string, string>();
  for (const [i, p] of players.entries()) {
    const { title, artists } = SONGS[i]!;
    const sub = (await call(p, "POST", `/rounds/${round.id}/submission`, {
      track: { id: `mock-${title}`, provider: "mock", providerTrackId: `mock-${title}`, title, artists },
    })) as Submission;
    song.set(p, sub.id);
  }
  for (const status of ["previewing", "voting"]) await call("u-me", "PATCH", `/leagues/${lg.id}/rounds/${round.id}`, { status });
  const offered = ((await call("u-me", "GET", `/rounds/${round.id}/submissions`)) as Array<{ id: string }>).map((s) => s.id);
  assert.equal(offered.includes(song.get("u-me")!), false);
  assert.equal(offered.length, 4);

  // Step 3: a hand-written ballot with points (or an anti-vote) on u-me's own song.
  const others = players.slice(1).map((p) => song.get(p)!);
  await assert.rejects(
    call("u-me", "POST", `/rounds/${round.id}/ballot`, { allocations: { [song.get("u-me")!]: 5, [others[0]!]: 5 } }),
    isStatus(400, OWN_POINTS),
  );
  await assert.rejects(
    call("u-me", "POST", `/rounds/${round.id}/ballot`, {
      allocations: { [others[0]!]: 5, [others[1]!]: 5 },
      downvotes: { [song.get("u-me")!]: 1 },
    }),
    isStatus(400, OWN_ANTI),
  );
  assert.equal(await repo.getBallot(round.id, "u-me"), undefined, "no refused ballot was stored");
  // A ballot that leaves the caller's own song alone is unchanged.
  assert.deepEqual(
    await call("u-me", "POST", `/rounds/${round.id}/ballot`, { allocations: { [others[0]!]: 5, [others[1]!]: 5 }, downvotes: { [others[2]!]: 1 } }),
    { ok: true },
  );
});

test("players who didn't submit: a non-submitter has every song on offer (the full pool), a submitter only the others' (pool 12, cap 4)", async () => {
  const members = [OWNER, "u-ben", "u-cyd", "u-dot"];
  const { deps, subs } = await smallPointsRound(members, {
    submitters: [OWNER, "u-ben", "u-cyd"],
    settings: { votePoolSize: 12, maxPointsPerSong: 4 },
  });
  const [ana, ben, cyd] = [OWNER, "u-ben", "u-cyd"].map((u) => subs.get(u)!.id);
  // u-dot didn't submit: three songs × 4 = 12, the whole pool, message unchanged.
  await assert.rejects(
    castBallot(deps, "u-dot", TINY_ROUND, { allocations: { [ana!]: 4, [ben!]: 4 } }),
    (e: unknown) => e instanceof ApiError && e.message === "You must spend exactly 12 points (you spent 8).",
  );
  await castBallot(deps, "u-dot", TINY_ROUND, { allocations: { [ana!]: 4, [ben!]: 4, [cyd!]: 4 } });
  // A submitter has two songs on offer: 2 × 4 = 8.
  await assert.rejects(castBallot(deps, OWNER, TINY_ROUND, { allocations: { [ben!]: 4, [cyd!]: 3 } }), isStatus(400, /exactly 8 points/));
  await castBallot(deps, OWNER, TINY_ROUND, { allocations: { [ben!]: 4, [cyd!]: 4 } });
  const results = await revealRound(deps, OWNER, TINY_ROUND);
  assert.deepEqual(pointsBySubmitter(results), { [OWNER]: 4, "u-ben": 8, "u-cyd": 8 });
});

test("timed: the lone submitter has no songs on offer — their empty ballot is accepted and counts, so the everyone-voted reveal fires", async () => {
  const { deps, repo, subs } = await smallPointsRound([OWNER, "u-ben"], { submitters: [OWNER], timed: true });
  assert.deepEqual(await listVotableSubmissions(deps, OWNER, TINY_ROUND), []);
  await assert.rejects(castBallot(deps, OWNER, TINY_ROUND, { allocations: { [subs.get(OWNER)!.id]: 1 } }), isStatus(400, /your own/));
  await castBallot(deps, OWNER, TINY_ROUND, { allocations: {} });
  assert.equal((await repo.getRound(TINY_ROUND))!.status, "voting", "u-ben hasn't voted yet");
  await castBallot(deps, "u-ben", TINY_ROUND, { allocations: { [subs.get(OWNER)!.id]: 5 } });
  assert.equal((await repo.getRound(TINY_ROUND))!.status, "revealed", "both ballots in → the timed reveal");
});

test("timed two-player league: both 5-point ballots trigger the everyone-voted reveal", async () => {
  const { deps, repo, subs } = await smallPointsRound([OWNER, "u-ben"], { timed: true });
  await castBallot(deps, OWNER, TINY_ROUND, { allocations: { [subs.get("u-ben")!.id]: 5 } });
  assert.equal((await repo.getRound(TINY_ROUND))!.status, "voting");
  await castBallot(deps, "u-ben", TINY_ROUND, { allocations: { [subs.get(OWNER)!.id]: 5 } });
  assert.equal((await repo.getRound(TINY_ROUND))!.status, "revealed");
});

test("timed standard league: the last two ballots cast at the same moment reveal the round once — every player's points banked once (BUG-04)", async () => {
  // Each cast runs the timed auto-advance, and both see every member voted:
  // both reveal, and the reveal's one claim-and-bank write lets one bank.
  const players = ["u-me", "u-sarah", "u-james"];
  const repo = new MemoryRepository(false);
  const deps: Deps = { repo, users: new MemoryUserDirectory() };
  const lg = await createLeague(deps, "u-me", { name: "Timed Points", musicProvider: "mock", roundCount: 3, progression: "timed", phaseDays: 1 });
  for (const p of players.slice(1)) await joinLeague(deps, p, lg.inviteCode);
  const round = await createRound(deps, "u-me", lg.id, { theme: "Openers" });
  await updateRound(deps, "u-me", lg.id, round.id, { status: "submitting" });
  const song = new Map<string, string>();
  for (const [i, p] of players.entries()) {
    const { title, artists } = SONGS[i]!;
    const sub = await submitSong(deps, p, round.id, {
      track: { id: `mock-${title}`, provider: "mock", providerTrackId: `mock-${title}`, title, artists },
    });
    song.set(p, sub.id);
  }
  await updateRound(deps, "u-me", lg.id, round.id, { status: "voting" }); // everyone submitted: previewing already
  const ballot = (voter: string) => ({
    allocations: Object.fromEntries(players.filter((p) => p !== voter).map((p) => [song.get(p)!, 5])),
  });

  await castBallot(deps, "u-me", round.id, ballot("u-me"));
  assert.equal((await repo.getRound(round.id))!.status, "voting");
  await Promise.all([castBallot(deps, "u-sarah", round.id, ballot("u-sarah")), castBallot(deps, "u-james", round.id, ballot("u-james"))]);
  assert.equal((await repo.getRound(round.id))!.status, "revealed");
  const points = Object.fromEntries((await repo.getStandings(lg.id)).map((s) => [s.userId, s.points]));
  assert.deepEqual(points, { "u-me": 10, "u-sarah": 10, "u-james": 10 }, "three ballots of 5 + 5: 10 each, banked once");
});

// ---- Standard ballots: every one of the voter's songs is their own (BUG-11) -
//
// With more than one song per player, the self-vote rule must guard ALL of
// the voter's songs in the round, not just the first one the repository
// happens to return (insertion order here, SK order in DynamoDB).

/** The ticket's repro through the real handlers: Sarah's standard league
 *  (pool 10, cap 5, 2 songs per player, 1 anti-vote), James and Mia join,
 *  Sarah submits two songs in `sarahOrder`, the others one each, and the
 *  round moves on to voting. */
async function twoSongsEachRound({
  legacySelfVote = false,
  sarahOrder = ["Midnight City", "Nightcall"],
}: { legacySelfVote?: boolean; sarahOrder?: string[] } = {}) {
  const tracks: Record<string, string> = {
    "Midnight City": "M83",
    Nightcall: "Kavinsky",
    Resonance: "HOME",
    "The Sound of Silence": "Simon & Garfunkel",
  };
  const repo = new MemoryRepository(false);
  const deps: Deps = { repo, users: new MemoryUserDirectory() };
  const lg = await createLeague(deps, "u-sarah", { name: "Two Songs Each", musicProvider: "mock", roundCount: 3 });
  const saved = await updateLeagueSettings(deps, "u-sarah", lg.id, {
    votePoolSize: 10, maxPointsPerSong: 5, submissionsPerPlayer: 2, downvotePoolSize: 1,
  });
  // A league stored before the self-vote option was removed (BUG-17): no
  // route can write `allowSelfVote: true` any more, so write the row directly.
  if (legacySelfVote) await repo.updateLeagueSettings(lg.id, { ...saved.settings, allowSelfVote: true });
  for (const p of ["u-james", "u-mia"]) await joinLeague(deps, p, lg.inviteCode);
  const round = await createRound(deps, "u-sarah", lg.id, { theme: "Night drives" });
  await updateRound(deps, "u-sarah", lg.id, round.id, { status: "submitting" });
  const song: Record<string, string> = {};
  const submit = async (user: string, title: string) => {
    const track = { id: `mock-${title}`, provider: "mock" as const, providerTrackId: `mock-${title}`, title, artists: [tracks[title]!] };
    song[title] = (await submitSong(deps, user, round.id, { track })).id;
  };
  for (const title of sarahOrder) await submit("u-sarah", title);
  await submit("u-james", "Resonance");
  await submit("u-mia", "The Sound of Silence");
  for (const status of ["previewing", "voting"] as const) await updateRound(deps, "u-sarah", lg.id, round.id, { status });
  return { deps, repo, roundId: round.id, song };
}

for (const sarahOrder of [["Midnight City", "Nightcall"], ["Nightcall", "Midnight City"]]) {
  test(`2 songs per player (submitted ${sarahOrder.join(" then ")}): points and anti-votes on EITHER own song → 400, nothing stored; the reveal credits no self-vote`, async () => {
    const { deps, repo, roundId, song } = await twoSongsEachRound({ sarahOrder });
    const [midnight, nightcall, resonance, silence] = ["Midnight City", "Nightcall", "Resonance", "The Sound of Silence"].map((t) => song[t]!);

    // The vote page offers neither of Sarah's songs.
    const offered = (await listVotableSubmissions(deps, "u-sarah", roundId)).map((s) => s.id).sort();
    assert.deepEqual(offered, [resonance, silence].sort());

    // Points on either own song (repro steps 2 and 3).
    for (const own of [midnight, nightcall]) {
      await assert.rejects(castBallot(deps, "u-sarah", roundId, { allocations: { [own!]: 5, [resonance!]: 5 } }), isStatus(400, OWN_POINTS));
    }
    // Anti-votes on either own song, on an otherwise valid ballot (step 4).
    for (const own of [midnight, nightcall]) {
      await assert.rejects(
        castBallot(deps, "u-sarah", roundId, { allocations: { [silence!]: 5, [resonance!]: 5 }, downvotes: { [own!]: 1 } }),
        isStatus(400, OWN_ANTI),
      );
    }
    assert.equal(await repo.getBallot(roundId, "u-sarah"), undefined, "no refused ballot was stored");

    // Zero on an own song is no vote: still accepted, and cleaned away.
    await castBallot(deps, "u-sarah", roundId, {
      allocations: { [silence!]: 5, [resonance!]: 5, [nightcall!]: 0 },
      downvotes: { [midnight!]: 0 },
    });
    assert.deepEqual((await getMyBallot(deps, "u-sarah", roundId))!.allocations, { [silence!]: 5, [resonance!]: 5 });

    // Repro step 5: the reveal credits Sarah's songs only with others' points.
    await castBallot(deps, "u-james", roundId, { allocations: { [nightcall!]: 5, [silence!]: 5 } });
    await castBallot(deps, "u-mia", roundId, { allocations: { [midnight!]: 5, [resonance!]: 5 } });
    const results = (await revealRound(deps, "u-sarah", roundId)) as Array<{ track: { title: string }; points: number }>;
    const points = Object.fromEntries(results.map((r) => [r.track.title, r.points]));
    assert.deepEqual(points, { "Midnight City": 5, Nightcall: 5, Resonance: 10, "The Sound of Silence": 10 });
  });
}

test("a legacy row with allowSelfVote: true, 2 songs per player: points and anti-votes on EITHER own song are still refused, nothing stored (BUG-17)", async () => {
  const { deps, repo, roundId, song } = await twoSongsEachRound({ legacySelfVote: true });
  assert.equal((await repo.getLeague((await repo.getRound(roundId))!.leagueId))!.settings.allowSelfVote, true, "the legacy row");
  const [midnight, nightcall, resonance, silence] = ["Midnight City", "Nightcall", "Resonance", "The Sound of Silence"].map((t) => song[t]!);
  for (const [up, down] of [[midnight, nightcall], [nightcall, midnight]]) {
    await assert.rejects(
      castBallot(deps, "u-sarah", roundId, { allocations: { [up!]: 5, [resonance!]: 5 }, downvotes: { [down!]: 1 } }),
      isStatus(400, OWN_POINTS),
    );
    await assert.rejects(
      castBallot(deps, "u-sarah", roundId, { allocations: { [silence!]: 5, [resonance!]: 5 }, downvotes: { [down!]: 1 } }),
      isStatus(400, OWN_ANTI),
    );
  }
  assert.equal(await repo.getBallot(roundId, "u-sarah"), undefined, "no refused ballot was stored");
  // Leaving her own songs alone, Sarah votes exactly as before.
  await castBallot(deps, "u-sarah", roundId, { allocations: { [silence!]: 5, [resonance!]: 5 }, downvotes: { [resonance!]: 1 } });
  const stored = (await repo.getBallot(roundId, "u-sarah"))!;
  assert.deepEqual(stored.allocations, { [silence!]: 5, [resonance!]: 5 });
  assert.deepEqual(stored.downvotes, { [resonance!]: 1 });
});
