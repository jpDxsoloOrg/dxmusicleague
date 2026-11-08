// Timed auto-advance tests — a round whose phase deadlines are in the past
// advances (cascading), and a manual league never does; concurrent reads of
// a standard league reveal (and bank) a due round once, and a stale advance
// can't write over a reveal (BUG-04). Head-to-head leagues (HTH-08) at the
// bottom.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository, MemoryUserDirectory } from "../data/memory.ts";
import { DEFAULT_LEAGUE_SETTINGS } from "../domain/types.ts";
import type { League, Round } from "../domain/types.ts";
import type { RandomInt } from "../domain/freeze.ts";
import { votableMatchups } from "../domain/matchups.ts";
import type { RoundMatchup, RoundMatchupSet } from "../domain/matchups.ts";
import type { Deps } from "./leagues.ts";
import { createLeague, getLeagueDetail, joinLeague, leaveLeague } from "./leagues.ts";
import { createRound, updateRound } from "./rounds.ts";
import { submitSong } from "./submissions.ts";
import { castBallot } from "./voting.ts";
import { loadRoundMatchups } from "./matchups.ts";
import { autoAdvanceRound } from "./progression.ts";

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

function timedLeague(over: Partial<League> = {}): League {
  return {
    id: "lg", name: "Timed", ownerId: "u-owner", musicProvider: "spotify", format: "standard",
    settings: DEFAULT_LEAGUE_SETTINGS, memberIds: ["u-owner", "u-2"], inviteCode: "C",
    visibility: "private", roundCount: 3, progression: "timed", phaseDays: 1, ...over,
  };
}

async function deps(league: League, round: Round): Promise<Deps> {
  const repo = new MemoryRepository(false);
  await repo.createLeague(league);
  await repo.createRound(round);
  return { repo, users: new MemoryUserDirectory() };
}

const round = (over: Partial<Round>): Round => ({
  id: "lg~0001", leagueId: "lg", index: 1, theme: "T", status: "submitting", ...over,
});

test("submitting → previewing once the submission deadline passes", async () => {
  const lg = timedLeague();
  const r = round({ status: "submitting", submissionDeadline: ago(HOUR), previewDeadline: ahead(HOUR), voteDeadline: ahead(2 * HOUR) });
  const d = await deps(lg, r);
  const out = await autoAdvanceRound(d, lg, r);
  assert.equal(out?.status, "previewing");
  assert.equal((await d.repo.getRound("lg~0001"))?.status, "previewing"); // persisted
});

test("cascades submitting → voting when both deadlines have passed", async () => {
  const lg = timedLeague();
  const r = round({ status: "submitting", submissionDeadline: ago(2 * HOUR), previewDeadline: ago(HOUR), voteDeadline: ahead(HOUR) });
  const d = await deps(lg, r);
  const out = await autoAdvanceRound(d, lg, r);
  assert.equal(out?.status, "voting");
});

test("voting → revealed once the vote deadline passes (points banked)", async () => {
  const lg = timedLeague();
  const r = round({ status: "voting", voteDeadline: ago(HOUR) });
  const d = await deps(lg, r);
  const out = await autoAdvanceRound(d, lg, r);
  assert.equal(out?.status, "revealed");
});

test("advances early when every member has submitted (deadline not passed)", async () => {
  const lg = timedLeague({ memberIds: ["u-owner", "u-2"] });
  const r = round({ status: "submitting", submissionDeadline: ahead(24 * HOUR) });
  const d = await deps(lg, r);
  // both members submit → phase is finished before the deadline
  for (const [u, t] of [["u-owner", "yt-a"], ["u-2", "yt-b"]] as const) {
    await d.repo.putSubmission({ id: `s-${u}`, roundId: r.id, userId: u, track: { id: t, provider: "spotify", providerTrackId: t, title: t, artists: [u] } });
  }
  const out = await autoAdvanceRound(d, lg, r);
  assert.equal(out?.status, "previewing");
  // early advance re-bases the preview deadline into the future (not the old one)
  assert.ok(new Date(out!.previewDeadline!).getTime() > Date.now());
});

test("reveals early when every member has voted", async () => {
  const lg = timedLeague({ memberIds: ["u-owner", "u-2"] });
  const r = round({ status: "voting", voteDeadline: ahead(24 * HOUR) });
  const d = await deps(lg, r);
  await d.repo.putSubmission({ id: "s1", roundId: r.id, userId: "u-owner", track: { id: "t", provider: "spotify", providerTrackId: "t", title: "T", artists: ["A"] } });
  await d.repo.putBallot({ roundId: r.id, voterId: "u-owner", allocations: { s1: 10 }, castAt: "x" });
  await d.repo.putBallot({ roundId: r.id, voterId: "u-2", allocations: { s1: 10 }, castAt: "x" });
  const out = await autoAdvanceRound(d, lg, r);
  assert.equal(out?.status, "revealed");
});

test("does nothing before the deadline, or for a manual league", async () => {
  const lg = timedLeague();
  const r = round({ status: "submitting", submissionDeadline: ahead(HOUR) });
  const d = await deps(lg, r);
  assert.equal((await autoAdvanceRound(d, lg, r))?.status, "submitting");

  const manual = timedLeague({ progression: "manual" });
  const r2 = round({ status: "submitting", submissionDeadline: ago(HOUR) });
  const d2 = await deps(manual, r2);
  assert.equal((await autoAdvanceRound(d2, manual, r2))?.status, "submitting");
});

// ---- standard reveal races (BUG-04) ------------------------------------------
// Every read of a timed league may reveal its due round, so two at once both
// try to; the reveal's one claim-and-bank write lets exactly one bank. And a
// read holding a copy from before the round was advanced and revealed can't
// write it back over the reveal (which would let it be revealed — and
// banked — again).

const STD_OWNER = "u-me";
const STD_PLAYERS = ["u-me", "u-sarah", "u-james"];

interface PointsLeague {
  deps: Deps;
  repo: MemoryRepository;
  leagueId: string;
  roundId: string;
  /** Each player's one song. */
  song: Map<string, string>;
}

/** A timed (1-day phases) standard league of STD_PLAYERS, through the
 *  handlers: round 1 opened and every song in — which closes submissions on
 *  its own (everyone submitted) — so the round is previewing. */
async function pointsTimed(): Promise<PointsLeague> {
  const repo = new MemoryRepository(false);
  const d: Deps = { repo, users: new MemoryUserDirectory() };
  const lg = await createLeague(d, STD_OWNER, { name: "Timed Points", musicProvider: "mock", roundCount: 3, progression: "timed", phaseDays: 1 });
  for (const p of STD_PLAYERS.slice(1)) await joinLeague(d, p, lg.inviteCode);
  const r = await createRound(d, STD_OWNER, lg.id, { theme: "Openers" });
  await updateRound(d, STD_OWNER, lg.id, r.id, { status: "submitting" });
  const song = new Map<string, string>();
  for (const p of STD_PLAYERS) {
    const sub = await submitSong(d, p, r.id, {
      track: { id: `t-${p}`, provider: "mock", providerTrackId: `t-${p}`, title: `${p} anthem`, artists: [`Artist ${p}`] },
    });
    song.set(p, sub.id);
  }
  assert.equal((await repo.getRound(r.id))!.status, "previewing", "everyone submitted: the timed league advanced");
  return { deps: d, repo, leagueId: lg.id, roundId: r.id, song };
}

/** `voter`'s ballot: 5 + 5 on the other two players' songs. */
const fiveAndFive = (f: PointsLeague, voter: string) => ({
  allocations: Object.fromEntries(STD_PLAYERS.filter((p) => p !== voter).map((p) => [f.song.get(p)!, 5])),
});

async function pointsOf(f: PointsLeague): Promise<Record<string, number>> {
  return Object.fromEntries((await f.repo.getStandings(f.leagueId)).map((r) => [r.userId, r.points]));
}

test("standard timed: two league reads at once after the vote deadline reveal the round once — every player's points banked once, and both boards show them", async () => {
  const f = await pointsTimed();
  await updateRound(f.deps, STD_OWNER, f.leagueId, f.roundId, { status: "voting" });
  await castBallot(f.deps, "u-me", f.roundId, fiveAndFive(f, "u-me"));
  // The vote deadline passes with one ballot in: the next read reveals.
  const r = (await f.repo.getRound(f.roundId))!;
  await f.repo.updateRound({ ...r, voteDeadline: ago(HOUR) });

  const [sarah, james] = await Promise.all([
    getLeagueDetail(f.deps, "u-sarah", f.leagueId),
    getLeagueDetail(f.deps, "u-james", f.leagueId),
  ]);
  assert.deepEqual(await pointsOf(f), { "u-me": 0, "u-sarah": 5, "u-james": 5 });
  for (const detail of [sarah, james]) {
    assert.equal(detail.currentRound?.status, "revealed");
    assert.deepEqual(
      Object.fromEntries(detail.standings.map((s) => [s.user.id, s.points])),
      { "u-me": 0, "u-sarah": 5, "u-james": 5 },
    );
  }
});

test("standard timed: an auto-advance holding a copy read before the round was advanced and revealed doesn't write it back over the reveal, so no second reveal can bank it", async () => {
  const { revealRound } = await import("./voting.ts");
  const f = await pointsTimed();
  // A slow reader's copy, its preview deadline already passed: it will advance to voting.
  const stale: Round = { ...(await f.repo.getRound(f.roundId))!, previewDeadline: ago(HOUR) };

  // Meanwhile the owner opens voting, two of three vote, and the owner reveals.
  await updateRound(f.deps, STD_OWNER, f.leagueId, f.roundId, { status: "voting" });
  await castBallot(f.deps, "u-me", f.roundId, fiveAndFive(f, "u-me"));
  await castBallot(f.deps, "u-sarah", f.roundId, fiveAndFive(f, "u-sarah"));
  await revealRound(f.deps, STD_OWNER, f.roundId);
  const banked = await pointsOf(f);
  assert.deepEqual(banked, { "u-me": 5, "u-sarah": 5, "u-james": 10 });
  const settled = (await f.repo.getRound(f.roundId))!;

  const league = (await f.repo.getLeague(f.leagueId))!;
  const after = await autoAdvanceRound(f.deps, league, stale);
  assert.equal(after?.status, "revealed", "the stale copy is brought up to date, not written");
  assert.deepEqual(await f.repo.getRound(f.roundId), settled);
  await assert.rejects(revealRound(f.deps, STD_OWNER, f.roundId), (e: unknown) => e instanceof Error && /in voting/.test(e.message));
  assert.deepEqual(await pointsOf(f), banked);
});

// ---- head-to-head (HTH-08) --------------------------------------------------
// The same machinery for H2H leagues, driven through the real handlers
// (create → join → open round 1 = freeze → submit → vote) over
// MemoryRepository with a seeded freeze RNG. What differs is only who
// "everyone" is (domain/matchups.ts "turnout"): current members with a song,
// and members with a matchup to pick in. A round nobody can vote in never
// sits in voting — the acceptance case for two-player and all-walkover
// rounds.

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

const OWNER = "u-me";
const PLAYERS = ["u-me", "u-sarah", "u-james", "u-mia", "u-jpop"];
const DAY = 24 * HOUR;

interface H2H {
  deps: Deps;
  repo: MemoryRepository;
  leagueId: string;
}

/** A timed (1-day phases) head-to-head league of `players`, owner first. */
async function h2hTimed(players: readonly string[]): Promise<H2H> {
  const repo = new MemoryRepository(false);
  const d: Deps = { repo, users: new MemoryUserDirectory(), randomInt: seeded(20261107) };
  const lg = await createLeague(d, players[0]!, {
    name: "Timed Duel", musicProvider: "mock", format: "headToHead", roundCount: 3, progression: "timed", phaseDays: 1,
  });
  for (const p of players.slice(1)) await joinLeague(d, p, lg.inviteCode);
  return { deps: d, repo, leagueId: lg.id };
}

/** Create and open the league's next round (round 1 freezes the season). */
async function openNextRound(f: H2H): Promise<Round> {
  const r = await createRound(f.deps, OWNER, f.leagueId, { theme: "Openers" });
  return updateRound(f.deps, OWNER, f.leagueId, r.id, { status: "submitting" });
}

const submit = (f: H2H, roundId: string, userId: string) =>
  submitSong(f.deps, userId, roundId, {
    track: { id: `t-${userId}`, provider: "mock", providerTrackId: `t-${userId}`, title: `${userId} anthem`, artists: [`Artist ${userId}`] },
  });

/** The round's server-side matchups (user ids + songs). */
async function matchupSet(f: H2H, roundId: string): Promise<RoundMatchupSet> {
  return loadRoundMatchups(f.deps, (await f.repo.getLeague(f.leagueId))!, (await f.repo.getRound(roundId))!);
}

/** `voter`'s complete picks, side a of every matchup they can vote in. */
const picksFor = (set: RoundMatchupSet, voter: string) =>
  Object.fromEntries(votableMatchups(set, voter).map((m) => [m.matchupId, m.a.submission!.id]));

/** Rewrite the stored round's status / deadlines (time passing, as the other tests stage it). */
async function stage(f: H2H, roundId: string, over: Partial<Round>): Promise<Round> {
  const r = { ...(await f.repo.getRound(roundId))!, ...over };
  await f.repo.updateRound(r);
  return r;
}

/** Each player's stored W-L-D. */
async function records(f: H2H): Promise<Map<string, string>> {
  const rows = await f.repo.getStandings(f.leagueId);
  return new Map(rows.map((r) => [r.userId, `${r.wins}-${r.losses}-${r.draws}`]));
}

const read = async (f: H2H) => (await getLeagueDetail(f.deps, OWNER, f.leagueId)).currentRound!;

test("H2H timed: everyone-submitted closes the phase early — one song per member (allowance forced to 1) — and re-bases the later deadlines", async () => {
  const four = PLAYERS.slice(0, 4);
  const f = await h2hTimed(four);
  assert.equal((await f.repo.getLeague(f.leagueId))!.settings.submissionsPerPlayer, 1);
  const opened = await openNextRound(f);
  const scheduledPreview = new Date(opened.previewDeadline!).getTime();
  assert.ok(scheduledPreview > Date.now() + 1.5 * DAY, "opening lays out a 1-day phase each");

  for (const p of four.slice(0, 3)) await submit(f, opened.id, p);
  assert.equal((await f.repo.getRound(opened.id))!.status, "submitting", "3 of 4 songs in");
  await submit(f, opened.id, four[3]!);
  const advanced = (await f.repo.getRound(opened.id))!;
  assert.equal(advanced.status, "previewing", "the last song closed submissions");
  const preview = new Date(advanced.previewDeadline!).getTime();
  assert.ok(preview > Date.now() && preview < scheduledPreview, "the preview deadline is re-based to a day from now");
  assert.ok(new Date(advanced.voteDeadline!).getTime() - preview > 0.9 * DAY);
});

test("H2H timed: a departed player's song doesn't count toward everyone-submitted — the phase waits for the member who stayed", async () => {
  const four = PLAYERS.slice(0, 4);
  const f = await h2hTimed(four);
  const round = await openNextRound(f);
  const [leaver, ...stayers] = four.slice(1) as [string, ...string[]];
  await submit(f, round.id, leaver);
  await leaveLeague(f.deps, leaver, f.leagueId, leaver);
  await submit(f, round.id, OWNER);
  await submit(f, round.id, stayers[0]!);
  // Three songs for three members — a row count would close the phase here,
  // and the member still picking a song would lose by walkover.
  assert.equal((await f.repo.getSubmissionsForRound(round.id)).length, 3);
  assert.equal((await read(f)).status, "submitting");
  await submit(f, round.id, stayers[1]!);
  assert.equal((await read(f)).status, "previewing");
});

test("H2H timed cascade: a dormant round runs submitting → previewing → voting → revealed on one read once every deadline passed, banking W/L/D as any reveal does", async () => {
  const four = PLAYERS.slice(0, 4);
  const f = await h2hTimed(four);
  const round = await openNextRound(f);
  const plan = await matchupSet(f, round.id);
  const [contest, walk] = plan.matchups as [RoundMatchup, RoundMatchup];
  for (const p of [contest.a.userId, contest.b.userId, walk.a.userId]) await submit(f, round.id, p);
  await stage(f, round.id, { submissionDeadline: ago(3 * HOUR), previewDeadline: ago(2 * HOUR), voteDeadline: ago(HOUR) });

  const out = await read(f);
  assert.equal(out.status, "revealed");
  const board = await records(f);
  assert.equal(board.get(walk.a.userId), "1-0-0", "walkover W");
  assert.equal(board.get(walk.b.userId), "0-1-0", "no song: walkover L");
  assert.equal(board.get(contest.a.userId), "0-0-1", "nobody voted: a 0–0 draw");
  assert.equal(board.get(contest.b.userId), "0-0-1");
});

test("H2H timed: a round reaching voting with nothing to vote on (all walkovers / no contests) reveals on the same read, days before its vote deadline", async () => {
  const four = PLAYERS.slice(0, 4);
  const f = await h2hTimed(four);
  const round = await openNextRound(f);
  const [walk, none] = (await matchupSet(f, round.id)).matchups as [RoundMatchup, RoundMatchup];
  await submit(f, round.id, walk.a.userId);
  await stage(f, round.id, { status: "previewing", previewDeadline: ago(HOUR), voteDeadline: ahead(3 * DAY) });

  const out = await autoAdvanceRound(f.deps, (await f.repo.getLeague(f.leagueId))!, (await f.repo.getRound(round.id))!);
  assert.equal(out?.status, "revealed", "not left in voting until the deadline");
  assert.equal((await f.repo.getRound(round.id))!.status, "revealed");
  const board = await records(f);
  assert.equal(board.get(walk.a.userId), "1-0-0");
  assert.equal(board.get(walk.b.userId), "0-1-0");
  for (const idle of [none.a.userId, none.b.userId]) assert.equal(board.get(idle), "0-0-0", "no contest banks nothing");
});

test("H2H timed two-player league can't hang in voting: both submit → previewing early → the preview deadline passes → revealed at once (nobody can vote: a 0–0 draw), league finished", async () => {
  const duo = PLAYERS.slice(0, 2);
  const f = await h2hTimed(duo);
  const round = await openNextRound(f);
  assert.equal((await f.repo.getLeague(f.leagueId))!.roundCount, 1, "two players: a one-round season");
  for (const p of duo) await submit(f, round.id, p);
  assert.equal((await f.repo.getRound(round.id))!.status, "previewing");
  await stage(f, round.id, { previewDeadline: ago(HOUR) });

  const detail = await getLeagueDetail(f.deps, OWNER, f.leagueId);
  assert.equal(detail.currentRound?.status, "revealed");
  assert.equal(detail.finished, true);
  assert.deepEqual([...(await records(f)).values()], ["0-0-1", "0-0-1"]);
});

test("H2H timed two-player league with a no-show: the walkover W/L is banked the moment voting would open", async () => {
  const duo = PLAYERS.slice(0, 2);
  const f = await h2hTimed(duo);
  const round = await openNextRound(f);
  await submit(f, round.id, "u-sarah");
  // The owner never submits: submissions close on the deadline, then the
  // preview deadline passes too — one read carries it all the way to the reveal.
  await stage(f, round.id, { submissionDeadline: ago(2 * HOUR), previewDeadline: ago(HOUR), voteDeadline: ahead(DAY) });
  assert.equal((await read(f)).status, "revealed");
  const board = await records(f);
  assert.equal(board.get("u-sarah"), "1-0-0");
  assert.equal(board.get(OWNER), "0-1-0");
});

test("H2H timed everyone-voted: reveals once every member who can vote has picked in all their matchups — the contest's own pair isn't waited for, and their comments-only ballot isn't a vote", async () => {
  const four = PLAYERS.slice(0, 4);
  const f = await h2hTimed(four);
  const round = await openNextRound(f);
  const [contest, walk] = (await matchupSet(f, round.id)).matchups as [RoundMatchup, RoundMatchup];
  for (const p of [contest.a.userId, contest.b.userId, walk.a.userId]) await submit(f, round.id, p);
  // The owner may still advance a timed league by hand.
  await updateRound(f.deps, OWNER, f.leagueId, round.id, { status: "previewing" });
  await updateRound(f.deps, OWNER, f.leagueId, round.id, { status: "voting" });
  assert.equal((await f.repo.getRound(round.id))!.status, "voting", "the walkover pair can vote in the contest");
  const set = await matchupSet(f, round.id);

  // One of the contest's own players leaves a comment: a ballot row, not a vote.
  const theirSong = set.matchups.find((m) => m.matchupId === contest.matchupId)!.b.submission!.id;
  await castBallot(f.deps, contest.a.userId, round.id, { comments: { [theirSong]: "good luck" } });
  assert.equal((await read(f)).status, "voting");
  await castBallot(f.deps, walk.a.userId, round.id, { picks: picksFor(set, walk.a.userId) });
  assert.equal((await f.repo.getRound(round.id))!.status, "voting", "one of two eligible voters");
  // Four ballot rows would satisfy a standard league's count already; H2H waits for the last eligible voter.
  await castBallot(f.deps, walk.b.userId, round.id, { picks: picksFor(set, walk.b.userId) });
  assert.equal((await f.repo.getRound(round.id))!.status, "revealed", "every member who can vote has");
  assert.equal((await records(f)).get(contest.a.userId), "1-0-0", "both votes went to side a");
});

test("H2H timed: departures mid-voting that leave nobody able to vote reveal the round on the next read — the kicked player's pair resolves as a walkover", async () => {
  const three = PLAYERS.slice(0, 3);
  const f = await h2hTimed(three);
  const round = await openNextRound(f);
  for (const p of three) await submit(f, round.id, p);
  await updateRound(f.deps, OWNER, f.leagueId, round.id, { status: "voting" });
  const set = await matchupSet(f, round.id);
  const [only] = set.matchups as [RoundMatchup];
  assert.equal((await f.repo.getRound(round.id))!.status, "voting", "the bye player can vote");
  // Kick the non-owner of the contest (or, if the owner is the bye, either player).
  const kicked = only.a.userId === OWNER ? only.b.userId : only.a.userId;
  const stayer = kicked === only.a.userId ? only.b.userId : only.a.userId;
  await leaveLeague(f.deps, OWNER, f.leagueId, kicked);

  // The contest is now a walkover, so the bye player has nothing to vote on.
  assert.equal((await read(f)).status, "revealed");
  const board = await records(f);
  assert.equal(board.get(stayer), "1-0-0", "the stayer wins by walkover");
  assert.equal(board.get(kicked), "0-0-0", "the departed player takes no L");
  assert.deepEqual((await f.repo.getRound(round.id))!.h2hDeparted, [kicked]);
});
