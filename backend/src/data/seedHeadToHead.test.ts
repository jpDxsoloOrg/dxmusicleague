// Seed fixture tests (HTH-09) — the head-to-head league seeded into the
// in-memory backend (data/memory.ts) and the frontend mock (src/data/mock.ts)
// from one module (data/seedHeadToHead.ts). These pin what the downstream UI
// tickets rely on: a frozen, mid-season 5-player league whose revealed round 1
// has a draw, a walkover and a bye, whose W/L/D board agrees with its ballots,
// and whose round 2 is open for voting with one bye — and that the real
// handlers play it on from there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository, MemoryUserDirectory } from "./memory.ts";
import { H2H_SEED_LEAGUE_ID, headToHeadSeed } from "./seedHeadToHead.ts";
import { ApiError } from "../domain/errors.ts";
import { SEASON_LEFT_MESSAGE, SEASON_LOCKED_MESSAGE } from "../domain/freeze.ts";
import { deriveRoundMatchups, votableMatchups } from "../domain/matchups.ts";
import { matchupRecords, settleMatchups } from "../domain/rules.ts";
import { matchupsForRound, scheduleLength } from "../domain/schedule.ts";
import type { Deps } from "../handlers/leagues.ts";
import { getLeagueDetail, joinLeague, leaveLeague, listMyLeagues } from "../handlers/leagues.ts";
import { listMatchups } from "../handlers/matchups.ts";
import { castBallot, getMyBallot, getResults, revealRound } from "../handlers/voting.ts";
import type { HeadToHeadResults } from "../handlers/results.ts";

const LG = H2H_SEED_LEAGUE_ID;
const R1 = "r-ff-1";
const R2 = "r-ff-2";

/** The seeded local-dev backend, as `npm run dev` serves it. */
function seeded(): Deps {
  return { repo: new MemoryRepository(), users: new MemoryUserDirectory() };
}

const isStatus = (code: number, message?: string) => (e: unknown) =>
  e instanceof ApiError && e.statusCode === code && (message === undefined || e.message === message);

/** Board rows as `name W-L-D`, in board order. */
async function board(deps: Deps): Promise<string[]> {
  const detail = await getLeagueDetail(deps, "u-me", LG);
  return detail.standings.map((s) => `${s.user.id} ${s.wins}-${s.losses}-${s.draws}`);
}

test("seed: the H2H league is frozen mid-season — 5 players, 5 rounds, round 2 voting, secrets stripped", async () => {
  const deps = seeded();
  const detail = await getLeagueDetail(deps, "u-me", LG);
  assert.equal(detail.league.format, "headToHead");
  assert.equal(detail.league.ownerId, "u-me");
  assert.equal(detail.league.memberIds.length, 5);
  assert.equal(detail.league.roundCount, scheduleLength(5)); // what the freeze sets
  assert.deepEqual(detail.league.settings, { votePoolSize: 10, maxPointsPerSong: 5, allowSelfVote: false, submissionsPerPlayer: 1, downvotePoolSize: 0 });
  assert.deepEqual(detail.rounds.map((r) => [r.id, r.status]), [[R1, "revealed"], [R2, "voting"]]);
  assert.equal(detail.currentRound?.id, R2);
  assert.equal(detail.finished, false);
  // The frozen order and salt stay server-side, owner included.
  assert.equal("h2hParticipants" in detail.league, false);
  assert.equal("h2hSalt" in detail.league, false);
  const stored = await deps.repo.getLeague(LG);
  assert.equal(stored?.h2hParticipants?.length, 5);
  assert.match(stored?.h2hSalt ?? "", /^[0-9a-f]{32}$/);
  // It's in u-me's league list, with a real completion % (2 of 5 voted).
  const mine = await listMyLeagues(deps, "u-me");
  assert.equal(mine.find((s) => s.league.id === LG)?.completionPct, 40);
});

test("seed: the documented pairings — R1 Sarah v Max, Mia v J-Pop, James bye; R2 Max v Mia, Sarah v James, J-Pop bye", () => {
  const { league } = headToHeadSeed();
  const pairs = (roundId: string, index: number) => {
    const { matchups, bye } = matchupsForRound(league.h2hParticipants!, roundId, index, league.h2hSalt);
    return { matchups: matchups.map((m) => [m.matchupId, [m.a, m.b].sort().join(" v ")]), bye };
  };
  assert.deepEqual(pairs(R1, 1), {
    matchups: [[`${R1}~M0`, "u-me v u-sarah"], [`${R1}~M1`, "u-jpop v u-mia"]],
    bye: "u-james",
  });
  assert.deepEqual(pairs(R2, 2), {
    matchups: [[`${R2}~M0`, "u-me v u-mia"], [`${R2}~M1`, "u-james v u-sarah"]],
    bye: "u-jpop",
  });
});

test("seed: revealed round 1 reads back as a 1–1 draw, a walkover to Mia, and James's exhibition bye", async () => {
  const deps = seeded();
  const results = (await getResults(deps, "u-stranger", R1)) as HeadToHeadResults; // spectators can read it
  assert.equal(results.format, "headToHead");
  const [draw, walkover] = results.matchups;
  assert.equal(draw?.outcome, "draw");
  assert.deepEqual([draw?.a.votes, draw?.b.votes], [1, 1]);
  assert.equal(draw?.winnerUserId, undefined);
  assert.deepEqual(new Set([draw?.a.player.id, draw?.b.player.id]), new Set(["u-me", "u-sarah"]));
  assert.ok(draw?.a.song?.comments.length && draw.b.song?.comments.length, "voter comments ride along");
  assert.equal(walkover?.outcome, "walkover");
  assert.equal(walkover?.winnerUserId, "u-mia");
  const noShow = walkover?.a.player.id === "u-jpop" ? walkover.a : walkover?.b;
  assert.equal(noShow?.player.id, "u-jpop");
  assert.equal(noShow?.song, null);
  assert.equal(results.bye?.player.id, "u-james");
  assert.equal(results.bye?.song.track.title, "Digital Love");
});

test("seed: the W/L/D board is exactly what round 1's ballots bank", async () => {
  const deps = seeded();
  assert.deepEqual(await board(deps), [
    "u-mia 1-0-0", // walkover W
    "u-me 0-0-1", // draw — ties on record break by name: Curator Max, James, Sarah
    "u-james 0-0-0", // bye: no result
    "u-sarah 0-0-1",
    "u-jpop 0-1-0", // walkover L
  ]);
  // Independently: settle round 1 from the stored songs + ballots and bank it.
  const league = (await deps.repo.getLeague(LG))!;
  const round = (await deps.repo.getRound(R1))!;
  const set = deriveRoundMatchups(league, round, await deps.repo.getSubmissionsForRound(R1));
  const banked = new Map<string, string>();
  for (const { userId, delta } of matchupRecords(settleMatchups(set, await deps.repo.getBallotsForRound(R1)).matchups)) {
    banked.set(userId, `${delta.wins ?? 0}-${delta.losses ?? 0}-${delta.draws ?? 0}`);
  }
  const rows = await deps.repo.getStandings(LG);
  for (const row of rows) {
    assert.equal(`${row.wins}-${row.losses}-${row.draws}`, banked.get(row.userId) ?? "0-0-0", row.userId);
    assert.equal(row.points, 0);
  }
  assert.equal(rows.length, 5);
});

test("seed: round 2 is open for voting — Max's own matchup locked, one pick to make, J-Pop's exhibition bye", async () => {
  const deps = seeded();
  const view = await listMatchups(deps, "u-me", R2);
  assert.equal(view.matchups.length, 2);
  assert.deepEqual(view.matchups.map((m) => m.isMine), [true, false]);
  assert.ok(view.matchups.every((m) => m.a && m.b), "everyone submitted in round 2");
  assert.equal(view.bye?.track.title, "Starlight");
  const json = JSON.stringify(view);
  assert.doesNotMatch(json, /u-(me|sarah|james|mia|jpop)/, "no submitter identity before the reveal");
  // Who still has to vote: everyone can vote in round 2 (two contests); J-Pop and Sarah have.
  const detail = await getLeagueDetail(deps, "u-me", LG);
  assert.deepEqual(
    { done: detail.votingProgress?.doneCount, total: detail.votingProgress?.totalCount },
    { done: 2, total: 5 },
  );
  assert.equal(await getMyBallot(deps, "u-me", R2), null);
  // Max's votable set is exactly the other matchup.
  const league = (await deps.repo.getLeague(LG))!;
  const set = deriveRoundMatchups(league, (await deps.repo.getRound(R2))!, await deps.repo.getSubmissionsForRound(R2));
  assert.deepEqual(votableMatchups(set, "u-me").map((m) => m.matchupId), [`${R2}~M1`]);
});

test("seed: the season is locked — a newcomer's invite-code join is refused with the season-locked message, and a player who leaves can't rejoin (HTH-14)", async () => {
  const deps = seeded();
  await assert.rejects(joinLeague(deps, "u-luna", "FACE-5"), isStatus(409, SEASON_LOCKED_MESSAGE));
  await leaveLeague(deps, "u-sarah", LG, "u-sarah");
  await assert.rejects(joinLeague(deps, "u-sarah", "FACE-5"), isStatus(409, SEASON_LEFT_MESSAGE));
  assert.equal((await deps.repo.getLeague(LG))!.memberIds.includes("u-sarah"), false);
});

test("seed: round 2 plays on through the real handlers — vote, reveal, and the board banks it", async () => {
  const deps = seeded();
  const view = await listMatchups(deps, "u-me", R2);
  const other = view.matchups.find((m) => !m.isMine)!;
  // Max picks side b of Sarah v James; Mia and James vote too.
  await castBallot(deps, "u-me", R2, { picks: { [other.matchupId]: other.b!.id }, comments: { [other.a!.id]: "Close call." } });
  assert.deepEqual((await getMyBallot(deps, "u-me", R2))?.picks, { [other.matchupId]: other.b!.id });
  const mine = view.matchups.find((m) => m.isMine)!;
  await castBallot(deps, "u-mia", R2, { picks: { [other.matchupId]: other.b!.id } });
  await castBallot(deps, "u-james", R2, { picks: { [mine.matchupId]: mine.a!.id } });

  const results = (await revealRound(deps, "u-me", R2)) as HeadToHeadResults;
  assert.equal(results.matchups.length, 2);
  assert.equal(results.bye?.player.id, "u-jpop");
  // Every matchup of round 2 is a contest, so each banks exactly two results.
  const rows = await deps.repo.getStandings(LG);
  const total = rows.reduce((n, r) => n + r.wins + r.losses + r.draws, 0);
  assert.equal(total, 4 /* round 1: D, D, W, L */ + 4);
  assert.equal(rows.reduce((n, r) => n + r.wins, 0), rows.reduce((n, r) => n + r.losses, 0));
  // Revealing again is refused (exactly-once banking).
  await assert.rejects(revealRound(deps, "u-me", R2), isStatus(400));
});

test("seed: the fixture is deterministic apart from its activity timestamps", () => {
  const at = new Date("2026-11-07T12:00:00.000Z");
  assert.deepEqual(headToHeadSeed(at), headToHeadSeed(at));
  const later = headToHeadSeed(new Date(at.getTime() + 60_000));
  const strip = (seed: ReturnType<typeof headToHeadSeed>) =>
    JSON.stringify(seed, (key, value) => (key === "submittedAt" || key === "castAt" ? undefined : value));
  assert.equal(strip(later), strip(headToHeadSeed(at)));
});
