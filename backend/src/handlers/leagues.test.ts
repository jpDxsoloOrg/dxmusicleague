// Discovery service tests — listOpenPublicLeagues filtering + ranking.
// Pure logic over MemoryRepository (no AWS).

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository, MemoryUserDirectory } from "../data/memory.ts";
import type { Deps } from "./leagues.ts";
import { claimPublicSpot, createLeague, deleteLeague, getLeagueDetail, getPublicLeaguePreview, joinLeague, leaveLeague, listBrowseLeagues, listMyLeagues, listOpenPublicLeagues, rematchLeague, toLeagueView, updateLeagueSettings } from "./leagues.ts";
import { createRound, updateRound } from "./rounds.ts";
import { ApiError, errorBody } from "../domain/errors.ts";
import { SEASON_LOCKED_MESSAGE } from "../domain/freeze.ts";
import type { RandomInt } from "../domain/freeze.ts";
import { DEFAULT_LEAGUE_SETTINGS, H2H_FORCED_SETTINGS, applyFormatSettings, leagueFormat } from "../domain/types.ts";
import type { League, Round } from "../domain/types.ts";
import { buildRoutes, matchRoute } from "../http/routes.ts";
import { votableMatchups } from "../domain/matchups.ts";
import type { RoundMatchup, RoundMatchupSet } from "../domain/matchups.ts";
import { submitSong } from "./submissions.ts";
import { castBallot, getResults, revealRound } from "./voting.ts";
import { listMatchups, loadRoundMatchups } from "./matchups.ts";

function league(over: Partial<League> & Pick<League, "id" | "name" | "visibility">): League {
  return {
    ownerId: "u-owner",
    musicProvider: "spotify",
    format: "standard",
    settings: DEFAULT_LEAGUE_SETTINGS,
    memberIds: ["u-owner"],
    inviteCode: `C-${over.id}`,
    maxMembers: 8,
    roundCount: 8,
    progression: "manual",
    ...over,
  };
}

async function depsWith(leagues: League[], rounds: Round[] = []): Promise<Deps> {
  const repo = new MemoryRepository(false); // no seed
  for (const lg of leagues) await repo.createLeague(lg);
  for (const r of rounds) await repo.createRound(r);
  return { repo, users: new MemoryUserDirectory() };
}

test("returns open public leagues, ranked fullest-first, with open slots + theme", async () => {
  const deps = await depsWith(
    [
      league({ id: "a", name: "Alpha", visibility: "public", memberIds: ["u-owner", "u-2"], maxMembers: 5 }),
      league({ id: "b", name: "Bravo", visibility: "public", memberIds: ["u-owner", "u-2", "u-3", "u-4"], maxMembers: 6 }),
    ],
    [{ id: "a~1", leagueId: "a", index: 1, theme: "Road trip", status: "draft" }],
  );
  const out = await listOpenPublicLeagues(deps, "u-me");
  assert.deepEqual(out.map((l) => l.id), ["b", "a"]); // fullest (4 members) first
  const alpha = out.find((l) => l.id === "a")!;
  assert.equal(alpha.openSlots, 3); // 5 cap − 2 members
  assert.equal(alpha.firstRoundTheme, "Road trip");
});

test("excludes private, full, past-submitting, and already-joined leagues", async () => {
  const deps = await depsWith(
    [
      league({ id: "priv", name: "Priv", visibility: "private" }),
      league({ id: "full", name: "Full", visibility: "public", memberIds: ["u-owner", "u-2"], maxMembers: 2 }),
      league({ id: "closed", name: "Closed", visibility: "public", maxMembers: 8 }),
      league({ id: "mine", name: "Mine", visibility: "public", memberIds: ["u-owner", "u-me"], maxMembers: 8 }),
      league({ id: "ok", name: "Ok", visibility: "public", maxMembers: 8 }),
      // Round 1 still submitting → the join window is open, so it's listed.
      league({ id: "sub", name: "Sub", visibility: "public", maxMembers: 8 }),
    ],
    [
      { id: "closed~1", leagueId: "closed", index: 1, theme: "Go", status: "voting" },
      { id: "sub~1", leagueId: "sub", index: 1, theme: "Go", status: "submitting" },
    ],
  );
  const out = await listOpenPublicLeagues(deps, "u-me");
  assert.deepEqual(out.map((l) => l.id).sort(), ["ok", "sub"]);
});

test("respects the limit", async () => {
  const deps = await depsWith([
    league({ id: "a", name: "A", visibility: "public", maxMembers: 8 }),
    league({ id: "b", name: "B", visibility: "public", maxMembers: 8 }),
    league({ id: "c", name: "C", visibility: "public", maxMembers: 8 }),
  ]);
  const out = await listOpenPublicLeagues(deps, "u-me", 2);
  assert.equal(out.length, 2);
});

test("preview returns theme, members, slots + flags for a public league", async () => {
  const deps = await depsWith(
    [league({ id: "p", name: "Preview", visibility: "public", memberIds: ["u-owner", "u-2"], maxMembers: 4 })],
    [{ id: "p~1", leagueId: "p", index: 1, theme: "Opening night", status: "draft" }],
  );
  const preview = await getPublicLeaguePreview(deps, "u-me", "p");
  assert.equal(preview.name, "Preview");
  assert.equal(preview.firstRoundTheme, "Opening night");
  assert.equal(preview.openSlots, 2);
  assert.equal(preview.members.length, 2);
  assert.equal(preview.hasStarted, false);
  assert.equal(preview.isFull, false);
  assert.equal(preview.alreadyMember, false);
});

test("preview flags alreadyMember for a caller who's in the league", async () => {
  const deps = await depsWith([
    league({ id: "p", name: "P", visibility: "public", memberIds: ["u-owner", "u-me"], maxMembers: 4 }),
  ]);
  const preview = await getPublicLeaguePreview(deps, "u-me", "p");
  assert.equal(preview.alreadyMember, true);
});

test("preview 404s for a private or missing league", async () => {
  const deps = await depsWith([league({ id: "priv", name: "Priv", visibility: "private" })]);
  await assert.rejects(getPublicLeaguePreview(deps, "u-me", "priv"), (e) => e instanceof ApiError && e.statusCode === 404);
  await assert.rejects(getPublicLeaguePreview(deps, "u-me", "nope"), (e) => e instanceof ApiError && e.statusCode === 404);
});

test("claim adds the caller to an open public league", async () => {
  const deps = await depsWith([
    league({ id: "p", name: "P", visibility: "public", memberIds: ["u-owner"], maxMembers: 4 }),
  ]);
  const { league: updated } = await claimPublicSpot(deps, "u-me", "p");
  assert.ok(updated.memberIds.includes("u-me"));
  assert.equal(updated.memberIds.length, 2);
  // standing seeded so the new member shows up on the board
  const standings = await deps.repo.getStandings("p");
  assert.ok(standings.some((s) => s.userId === "u-me" && s.points === 0));
});

test("leave removes the caller's membership; owner can't leave; only self", async () => {
  const deps = await depsWith([
    league({ id: "lg", name: "L", visibility: "public", ownerId: "u-owner", memberIds: ["u-owner", "u-me"], maxMembers: 8 }),
  ]);
  const is = (code: number) => (e: unknown) => e instanceof ApiError && e.statusCode === code;
  // owner can't leave their own league
  await assert.rejects(leaveLeague(deps, "u-owner", "lg", "u-owner"), is(400));
  // can only remove yourself
  await assert.rejects(leaveLeague(deps, "u-me", "lg", "u-owner"), is(403));
  // a member leaves successfully
  await leaveLeague(deps, "u-me", "lg", "u-me");
  const after = await deps.repo.getLeague("lg");
  assert.deepEqual(after?.memberIds, ["u-owner"]);
  // leaving again (not a member) is a 400
  await assert.rejects(leaveLeague(deps, "u-me", "lg", "u-me"), is(400));
});

test("claim rejects full / past-submitting / already-member / private-or-missing", async () => {
  const deps = await depsWith(
    [
      league({ id: "full", name: "Full", visibility: "public", memberIds: ["u-owner", "u-2"], maxMembers: 2 }),
      league({ id: "closed", name: "Closed", visibility: "public", memberIds: ["u-owner"], maxMembers: 4 }),
      league({ id: "mine", name: "Mine", visibility: "public", memberIds: ["u-owner", "u-me"], maxMembers: 4 }),
      league({ id: "priv", name: "Priv", visibility: "private", maxMembers: 4 }),
    ],
    [{ id: "closed~1", leagueId: "closed", index: 1, theme: "Go", status: "previewing" }],
  );
  const is = (code: number) => (e: unknown) => e instanceof ApiError && e.statusCode === code;
  await assert.rejects(claimPublicSpot(deps, "u-me", "full"), is(409));
  await assert.rejects(claimPublicSpot(deps, "u-me", "closed"), is(409));
  await assert.rejects(claimPublicSpot(deps, "u-me", "mine"), is(409));
  await assert.rejects(claimPublicSpot(deps, "u-me", "priv"), is(404));
  await assert.rejects(claimPublicSpot(deps, "u-me", "nope"), is(404));
});

test("claim succeeds while round 1 is still submitting (late join window)", async () => {
  const deps = await depsWith(
    [league({ id: "sub", name: "Sub", visibility: "public", memberIds: ["u-owner"], maxMembers: 4 })],
    [{ id: "sub~1", leagueId: "sub", index: 1, theme: "Go", status: "submitting" }],
  );
  const { league: joined } = await claimPublicSpot(deps, "u-me", "sub");
  assert.ok(joined.memberIds.includes("u-me"));
});

test("detail exposes who submitted vs waiting during submitting — names only, no tracks", async () => {
  const deps = await depsWith(
    [league({ id: "lg", name: "League", visibility: "private", memberIds: ["u-owner", "u-2", "u-3"] })],
    [{ id: "lg~1", leagueId: "lg", index: 1, theme: "Go", status: "submitting" }],
  );
  await deps.repo.putSubmission({
    id: "s1",
    roundId: "lg~1",
    userId: "u-2",
    track: { id: "t1", provider: "spotify", providerTrackId: "sp1", title: "Song", artists: ["Artist"] },
  });

  const detail = await getLeagueDetail(deps, "u-owner", "lg");
  assert.deepEqual(detail.submissionProgress?.submitted.map((u) => u.id), ["u-2"]);
  assert.deepEqual(detail.submissionProgress?.waiting.map((u) => u.id), ["u-owner", "u-3"]);
  // Identities only — make sure no track data rides along.
  assert.equal(JSON.stringify(detail.submissionProgress).includes("Song"), false);
});

test("detail omits submission progress outside the submitting phase", async () => {
  const deps = await depsWith(
    [league({ id: "lg", name: "League", visibility: "private" })],
    [{ id: "lg~1", leagueId: "lg", index: 1, theme: "Go", status: "voting" }],
  );
  const detail = await getLeagueDetail(deps, "u-owner", "lg");
  assert.equal(detail.submissionProgress, undefined);
});

test("detail exposes who voted vs waiting during voting — no allocations leaked", async () => {
  const deps = await depsWith(
    [league({ id: "lg", name: "League", visibility: "private", memberIds: ["u-owner", "u-2", "u-3"] })],
    [{ id: "lg~1", leagueId: "lg", index: 1, theme: "Go", status: "voting" }],
  );
  await deps.repo.putBallot({
    roundId: "lg~1",
    voterId: "u-3",
    allocations: { "sub-1": 10 },
    castAt: "2026-07-06T00:00:00.000Z",
  });

  const detail = await getLeagueDetail(deps, "u-owner", "lg");
  assert.deepEqual(detail.votingProgress?.submitted.map((u) => u.id), ["u-3"]);
  assert.deepEqual(detail.votingProgress?.waiting.map((u) => u.id), ["u-owner", "u-2"]);
  assert.equal(detail.submissionProgress, undefined);
  // Identities only — the ballot's allocations must not ride along.
  assert.equal(JSON.stringify(detail.votingProgress).includes("sub-1"), false);
});

test("owner can kick a member; non-owners can't; the owner can't be kicked", async () => {
  const deps = await depsWith([
    league({ id: "lg", name: "L", visibility: "private", ownerId: "u-owner", memberIds: ["u-owner", "u-me", "u-2"] }),
  ]);
  const is = (code: number) => (e: unknown) => e instanceof ApiError && e.statusCode === code;
  // a regular member can't kick someone else
  await assert.rejects(leaveLeague(deps, "u-me", "lg", "u-2"), is(403));
  // the owner can't be removed
  await assert.rejects(leaveLeague(deps, "u-2", "lg", "u-owner"), is(403));
  await assert.rejects(leaveLeague(deps, "u-owner", "lg", "u-owner"), is(400));
  // the owner kicks u-2
  await leaveLeague(deps, "u-owner", "lg", "u-2");
  const after = await deps.repo.getLeague("lg");
  assert.deepEqual(after?.memberIds, ["u-owner", "u-me"]);
});

test("regenerateInvite mints a new code, retires the old, and is owner-only", async () => {
  const { regenerateInvite } = await import("./leagues.ts");
  const deps = await depsWith([
    league({ id: "lg", name: "L", visibility: "private", ownerId: "u-owner", memberIds: ["u-owner", "u-me"] }),
  ]);
  await deps.repo.putInvite("C-lg", "lg"); // the seed helper's code, registered

  const is = (code: number) => (e: unknown) => e instanceof ApiError && e.statusCode === code;
  await assert.rejects(regenerateInvite(deps, "u-me", "lg"), is(403));

  const { league: updated } = await regenerateInvite(deps, "u-owner", "lg");
  assert.notEqual(updated.inviteCode, "C-lg");
  assert.match(updated.inviteCode, /^DXL-/);
  assert.equal(await deps.repo.getLeagueIdForInvite("C-lg"), undefined); // old retired
  assert.equal(await deps.repo.getLeagueIdForInvite(updated.inviteCode), "lg"); // new works
  const stored = await deps.repo.getLeague("lg");
  assert.equal(stored?.inviteCode, updated.inviteCode);
});

test("browse lists running leagues (any visibility) the caller isn't in", async () => {
  const { listBrowseLeagues } = await import("./leagues.ts");
  const deps = await depsWith(
    [
      league({ id: "priv-run", name: "Private Running", visibility: "private", memberIds: ["u-owner", "u-2"] }),
      league({ id: "pub-run", name: "Public Running", visibility: "public" }),
      league({ id: "not-started", name: "Fresh", visibility: "private" }),
      league({ id: "mine", name: "Mine", visibility: "private", memberIds: ["u-owner", "u-me"] }),
    ],
    [
      { id: "pr~1", leagueId: "priv-run", index: 1, theme: "Go", status: "voting" },
      { id: "pu~1", leagueId: "pub-run", index: 1, theme: "Go", status: "submitting" },
      { id: "ns~1", leagueId: "not-started", index: 1, theme: "Soon", status: "draft" },
      { id: "mi~1", leagueId: "mine", index: 1, theme: "Go", status: "voting" },
    ],
  );
  const out = await listBrowseLeagues(deps, "u-me");
  assert.deepEqual(out.map((l) => l.id).sort(), ["priv-run", "pub-run"]);
  const priv = out.find((l) => l.id === "priv-run")!;
  assert.equal(priv.currentRound?.status, "voting");
  // The browse summary never carries an invite code.
  assert.equal("inviteCode" in priv, false);
});

test("spectators get league detail without the invite code; members keep it", async () => {
  const deps = await depsWith(
    [league({ id: "lg", name: "L", visibility: "private", memberIds: ["u-owner"] })],
    [{ id: "lg~1", leagueId: "lg", index: 1, theme: "Go", status: "voting" }],
  );
  const spectator = await getLeagueDetail(deps, "u-me", "lg");
  assert.equal(spectator.league.inviteCode, "");
  const member = await getLeagueDetail(deps, "u-owner", "lg");
  assert.equal(member.league.inviteCode, "C-lg");
});

test("revealed results are readable by non-members", async () => {
  const { getResults } = await import("./voting.ts");
  const deps = await depsWith(
    [league({ id: "lg", name: "L", visibility: "private", memberIds: ["u-owner"] })],
    [{ id: "lg~1", leagueId: "lg", index: 1, theme: "Go", status: "revealed" }],
  );
  await deps.repo.putSubmission({
    id: "sub-a", roundId: "lg~1", userId: "u-owner",
    track: { id: "t1", provider: "spotify", providerTrackId: "sp1", title: "Song A", artists: ["A"] },
  });
  const results = await getResults(deps, "u-me", "lg~1"); // u-me is not a member
  assert.ok(Array.isArray(results), "a standard round's results are still the bare RoundResult[]");
  assert.equal(results.length, 1);
});

test("points survive a leave/kick and reappear on rejoin", async () => {
  const { joinLeague } = await import("./leagues.ts");
  const deps = await depsWith([
    league({ id: "lg", name: "L", visibility: "private", memberIds: ["u-owner", "u-me"] }),
  ]);
  await deps.repo.putInvite("C-lg", "lg");
  await deps.repo.addStandingPoints("lg", "u-me", 9);

  await leaveLeague(deps, "u-me", "lg", "u-me");
  // Hidden from the board while gone…
  const gone = await getLeagueDetail(deps, "u-owner", "lg");
  assert.equal(gone.standings.some((s) => s.user.id === "u-me"), false);

  // …and intact on return (rejoin seeds 0 with create-if-absent semantics).
  await joinLeague(deps, "u-me", "C-lg");
  const back = await getLeagueDetail(deps, "u-me", "lg");
  assert.equal(back.standings.find((s) => s.user.id === "u-me")?.points, 9);
});

test("activity feed derives from submissions + ballots, newest first, no track data", async () => {
  const deps = await depsWith(
    [league({ id: "lg", name: "L", visibility: "private", memberIds: ["u-owner", "u-me"] })],
    [{ id: "lg~1", leagueId: "lg", index: 1, theme: "Go", status: "voting" }],
  );
  await deps.repo.putSubmission({
    id: "sub-a", roundId: "lg~1", userId: "u-me", submittedAt: "2026-07-09T10:00:00.000Z",
    track: { id: "t1", provider: "spotify", providerTrackId: "sp1", title: "Secret Song", artists: ["A"] },
  });
  await deps.repo.putBallot({
    roundId: "lg~1", voterId: "u-owner",
    allocations: { "sub-a": 10 }, castAt: "2026-07-09T11:00:00.000Z",
  });

  const detail = await getLeagueDetail(deps, "u-owner", "lg");
  assert.deepEqual(
    detail.activity.map((a) => `${a.user.id}: ${a.text}`),
    ["u-owner: cast their votes", "u-me: submitted a song"], // ballot is newer
  );
  assert.equal(JSON.stringify(detail.activity).includes("Secret Song"), false);
});

// ---- standard progress after a departure (BUG-09) ----
// The who-submitted / who-voted counts and the completion % count CURRENT
// members, so they agree with the names beside them and never pass 100: a
// departed player's songs and ballot stay in the round (they still rank and
// score) but no longer count toward "X of N in".

/** A manual standard league of `players` (owner first), round 1 open for
 *  submissions; the owner's view of its progress panels and completion %. */
async function pointsRound(players: readonly string[], songsPerPlayer = 1) {
  const deps: Deps = { repo: new MemoryRepository(false), users: new MemoryUserDirectory() };
  const owner = players[0]!;
  const lg = await createLeague(deps, owner, { name: "Departures", musicProvider: "mock", roundCount: 3 });
  await updateLeagueSettings(deps, owner, lg.id, { ...DEFAULT_LEAGUE_SETTINGS, submissionsPerPlayer: songsPerPlayer });
  for (const p of players.slice(1)) await joinLeague(deps, p, lg.inviteCode);
  const r = await createRound(deps, owner, lg.id, { theme: "Openers" });
  await updateRound(deps, owner, lg.id, r.id, { status: "submitting" });
  const song = (userId: string, n = 1) =>
    submitSong(deps, userId, r.id, {
      track: { id: `t-${userId}-${n}`, provider: "mock", providerTrackId: `t-${userId}-${n}`, title: `${userId} ${n}`, artists: [`Artist ${userId} ${n}`] },
    });
  const progress = async () => {
    const detail = await getLeagueDetail(deps, owner, lg.id);
    const panel = detail.submissionProgress ?? detail.votingProgress;
    assert.ok(panel, "a live phase has a progress panel");
    const pct = (await listMyLeagues(deps, owner)).find((s) => s.league.id === lg.id)!.completionPct;
    return { done: panel.submitted.map((u) => u.id), waiting: panel.waiting.map((u) => u.id), counts: [panel.doneCount, panel.totalCount], pct };
  };
  return { deps, leagueId: lg.id, roundId: r.id, song, progress };
}

test("standard submitting progress (BUG-09): a departed player's songs leave the 'X of N songs in' count and the completion % — each member's songs count up to their allowance", async () => {
  const f = await pointsRound(["u-me", "u-sarah", "u-james"], 2);
  for (const n of [1, 2]) await f.song("u-sarah", n);
  // Nobody has left: exactly as before — 2 of 3 × 2 slots.
  assert.deepEqual(await f.progress(), { done: ["u-sarah"], waiting: ["u-me", "u-james"], counts: [2, 6], pct: 33 });

  await leaveLeague(f.deps, "u-sarah", f.leagueId, "u-sarah");
  assert.deepEqual(await f.progress(), { done: [], waiting: ["u-me", "u-james"], counts: [0, 4], pct: 0 });
  await f.song("u-me", 1);
  assert.deepEqual(await f.progress(), { done: [], waiting: ["u-me", "u-james"], counts: [1, 4], pct: 25 }, "one of u-me's two slots");
  await f.song("u-me", 2);
  // A row count read 4 of 4, 100%, with u-james still waiting.
  assert.deepEqual(await f.progress(), { done: ["u-me"], waiting: ["u-james"], counts: [2, 4], pct: 50 });
});

test("standard voting progress (BUG-09): a departed voter's ballot leaves the 'X of N ballots in' count and the completion %, which stops at 100 — and still scores at the reveal", async () => {
  const f = await pointsRound(["u-me", "u-sarah", "u-james", "u-mia"]);
  const song = new Map<string, string>();
  for (const p of ["u-me", "u-sarah", "u-james", "u-mia"]) song.set(p, (await f.song(p)).id);
  await updateRound(f.deps, "u-me", f.leagueId, f.roundId, { status: "previewing" });
  await updateRound(f.deps, "u-me", f.leagueId, f.roundId, { status: "voting" });
  const vote = (voter: string, a: string, b: string) =>
    castBallot(f.deps, voter, f.roundId, { allocations: { [song.get(a)!]: 5, [song.get(b)!]: 5 } });

  await vote("u-sarah", "u-me", "u-james");
  // Nobody has left: exactly as before.
  assert.deepEqual(await f.progress(), { done: ["u-sarah"], waiting: ["u-me", "u-james", "u-mia"], counts: [1, 4], pct: 25 });

  await leaveLeague(f.deps, "u-sarah", f.leagueId, "u-sarah");
  assert.deepEqual(await f.progress(), { done: [], waiting: ["u-me", "u-james", "u-mia"], counts: [0, 3], pct: 0 });
  await vote("u-me", "u-james", "u-mia");
  await vote("u-james", "u-me", "u-mia");
  // A row count read 3 of 3, 100%, with u-mia still listed as waiting.
  assert.deepEqual(await f.progress(), { done: ["u-me", "u-james"], waiting: ["u-mia"], counts: [2, 3], pct: 67 });
  await vote("u-mia", "u-me", "u-james");
  // …and 4 of 3, 133%, once she had voted.
  assert.deepEqual(await f.progress(), { done: ["u-me", "u-james", "u-mia"], waiting: [], counts: [3, 3], pct: 100 });

  await revealRound(f.deps, "u-me", f.roundId);
  const results = await getResults(f.deps, "u-me", f.roundId);
  assert.ok(Array.isArray(results), "the standard results payload is unchanged: a bare RoundResult[]");
  const pointsBy = Object.fromEntries(results.map((r) => [r.submitter.id, r.points]));
  assert.equal(pointsBy["u-me"], 15, "u-sarah's ballot still scores (5 of u-me's 15)");
});

// ---- league finish + rematch ----

test("a league finishes once its final round is revealed, and leaves the browse list", async () => {
  const deps = await depsWith(
    [league({ id: "done", name: "Done", visibility: "private", roundCount: 2, memberIds: ["u-owner", "u-2"] })],
    [
      { id: "done~1", leagueId: "done", index: 1, theme: "One", status: "revealed" },
      { id: "done~2", leagueId: "done", index: 2, theme: "Two", status: "revealed" },
    ],
  );
  const detail = await getLeagueDetail(deps, "u-owner", "done");
  assert.equal(detail.finished, true);
  assert.deepEqual(await listBrowseLeagues(deps, "u-stranger"), []); // closed → not spectatable
});

test("a league with rounds left to play is not finished and still browsable", async () => {
  const deps = await depsWith(
    [league({ id: "mid", name: "Mid", visibility: "private", roundCount: 3 })],
    [{ id: "mid~1", leagueId: "mid", index: 1, theme: "One", status: "revealed" }],
  );
  const detail = await getLeagueDetail(deps, "u-owner", "mid");
  assert.equal(detail.finished, false);
  assert.deepEqual((await listBrowseLeagues(deps, "u-stranger")).map((b) => b.id), ["mid"]);
});

test("rematch clones a finished league: same players + settings, fresh standings at 0", async () => {
  const deps = await depsWith(
    [league({ id: "s1", name: "Szn Group 1", visibility: "private", roundCount: 1, memberIds: ["u-owner", "u-2", "u-3"] })],
    [{ id: "s1~1", leagueId: "s1", index: 1, theme: "One", status: "revealed" }],
  );
  await deps.repo.addStandingPoints("s1", "u-2", 42); // old points must not carry over

  const next = await rematchLeague(deps, "u-owner", "s1");
  assert.equal(next.name, "Szn Group 2"); // trailing number increments
  assert.notEqual(next.id, "s1");
  assert.deepEqual(next.memberIds, ["u-owner", "u-2", "u-3"]);
  assert.equal(next.roundCount, 1);
  assert.ok(next.inviteCode && next.inviteCode !== "C-s1");

  const standings = await deps.repo.getStandings(next.id);
  assert.equal(standings.length, 3);
  assert.ok(standings.every((s) => s.points === 0));
  // The new invite code resolves to the new league.
  assert.equal(await deps.repo.getLeagueIdForInvite(next.inviteCode), next.id);
});

test("rematch is owner-only and only after the league has finished", async () => {
  const deps = await depsWith(
    [league({ id: "live", name: "Live", visibility: "private", roundCount: 2, memberIds: ["u-owner", "u-2"] })],
    [{ id: "live~1", leagueId: "live", index: 1, theme: "One", status: "voting" }],
  );
  const is = (code: number) => (e: unknown) => e instanceof ApiError && e.statusCode === code;
  await assert.rejects(rematchLeague(deps, "u-2", "live"), is(403));
  await assert.rejects(rematchLeague(deps, "u-owner", "live"), is(409));
});

test("no round can be created beyond the league's planned roundCount", async () => {
  const deps = await depsWith(
    [league({ id: "cap", name: "Cap", visibility: "private", roundCount: 1 })],
    [{ id: "cap~1", leagueId: "cap", index: 1, theme: "One", status: "revealed" }],
  );
  await assert.rejects(
    createRound(deps, "u-owner", "cap", { theme: "Two" }),
    (e: unknown) => e instanceof ApiError && e.statusCode === 400,
  );
});

// ---- league format (HTH-01): creation-time, immutable, back-compat ----

const isStatus = (code: number) => (e: unknown) => e instanceof ApiError && e.statusCode === code;

/** Drive a request through the real route table (the same one the Lambda and
 *  the local server use), so route-level field lists are under test too. */
async function callRoute(deps: Deps, method: string, path: string, caller: string, body?: unknown): Promise<unknown> {
  const match = matchRoute(buildRoutes(deps), method, path);
  assert.ok(match, `no route for ${method} ${path}`);
  return match.route.handler({ caller, params: match.params, query: {}, body });
}

const baseCreate = { name: "Format Test", musicProvider: "mock" as const, roundCount: 3 };

test("leagueFormat() defaults a missing / null / unknown field to standard", () => {
  assert.equal(leagueFormat({}), "standard");
  assert.equal(leagueFormat({ format: undefined }), "standard");
  assert.equal(leagueFormat({ format: null }), "standard");
  assert.equal(leagueFormat({ format: "foo" as never }), "standard");
  assert.equal(leagueFormat({ format: "standard" }), "standard");
  assert.equal(leagueFormat({ format: "headToHead" }), "headToHead");
});

test("create with format headToHead → detail returns it; create without → standard", async () => {
  const deps = await depsWith([]);
  const h2h = await createLeague(deps, "u-owner", { ...baseCreate, format: "headToHead" });
  assert.equal(h2h.format, "headToHead");
  assert.equal((await getLeagueDetail(deps, "u-owner", h2h.id)).league.format, "headToHead");

  const plain = await createLeague(deps, "u-owner", { ...baseCreate });
  assert.equal(plain.format, "standard");
  const detail = await getLeagueDetail(deps, "u-owner", plain.id);
  assert.equal(detail.league.format, "standard");
  // Explicit "standard" is accepted too.
  assert.equal((await createLeague(deps, "u-owner", { ...baseCreate, format: "standard" })).format, "standard");

  // Same through the HTTP route table (POST /leagues forwards `format`).
  const viaRoute = (await callRoute(deps, "POST", "/leagues", "u-owner", { ...baseCreate, format: "headToHead" })) as League;
  assert.equal(viaRoute.format, "headToHead");
  const viaRouteDefault = (await callRoute(deps, "POST", "/leagues", "u-owner", { ...baseCreate })) as League;
  assert.equal(viaRouteDefault.format, "standard");
});

test("invalid format 'foo' → 400 (handler and route); nothing is created", async () => {
  const deps = await depsWith([]);
  await assert.rejects(createLeague(deps, "u-owner", { ...baseCreate, format: "foo" as never }), isStatus(400));
  await assert.rejects(callRoute(deps, "POST", "/leagues", "u-owner", { ...baseCreate, format: "foo" }), isStatus(400));
  await assert.rejects(callRoute(deps, "POST", "/leagues", "u-owner", { ...baseCreate, format: 7 }), isStatus(400));
  await assert.rejects(callRoute(deps, "POST", "/leagues", "u-owner", { ...baseCreate, format: "HeadToHead" }), isStatus(400));
  assert.equal((await deps.repo.getAllLeagues()).length, 0);
});

test("applyFormatSettings clamps head-to-head to 1 song / 0 anti-votes; standard untouched", () => {
  const loose = { ...DEFAULT_LEAGUE_SETTINGS, submissionsPerPlayer: 3, downvotePoolSize: 2, votePoolSize: 12 };
  assert.deepEqual(applyFormatSettings("headToHead", loose), {
    ...loose,
    submissionsPerPlayer: 1,
    downvotePoolSize: 0,
  });
  assert.deepEqual(applyFormatSettings("standard", loose), loose);
  assert.notEqual(applyFormatSettings("standard", loose), loose); // a copy, never the caller's object
});

test("create H2H with submissionsPerPlayer: 3 → forced to 1 song / 0 anti-votes", async () => {
  const deps = await depsWith([]);
  // A hand-crafted create body trying to smuggle settings in, both flat and
  // nested: the route drops them and the handler clamps H2H to its forced values.
  const created = (await callRoute(deps, "POST", "/leagues", "u-owner", {
    ...baseCreate,
    format: "headToHead",
    submissionsPerPlayer: 3,
    downvotePoolSize: 2,
    settings: { ...DEFAULT_LEAGUE_SETTINGS, submissionsPerPlayer: 3, downvotePoolSize: 2 },
  })) as League;
  assert.equal(created.settings.submissionsPerPlayer, 1);
  assert.equal(created.settings.downvotePoolSize, 0);
  const stored = await deps.repo.getLeague(created.id);
  assert.equal(stored?.settings.submissionsPerPlayer, 1);
  assert.equal(stored?.settings.downvotePoolSize, 0);
  // Standard creation still gets the plain defaults, unchanged.
  const plain = await createLeague(deps, "u-owner", { ...baseCreate });
  assert.deepEqual(plain.settings, DEFAULT_LEAGUE_SETTINGS);
});

test("create H2H still clamps if DEFAULT_LEAGUE_SETTINGS drifts from the forced values", async () => {
  // Today the defaults already equal H2H_FORCED_SETTINGS (1 song, 0 anti-votes),
  // so the create-path clamp is defensive and the test above can't tell it
  // apart from the coincidence. Drift the shared defaults for the duration of
  // this test only (a file's top-level tests run one at a time; restored in
  // `finally`) so a create handler that skips the clamp fails here.
  const original = { ...DEFAULT_LEAGUE_SETTINGS };
  Object.assign(DEFAULT_LEAGUE_SETTINGS, { submissionsPerPlayer: 3, downvotePoolSize: 2 });
  try {
    const deps = await depsWith([]);
    const h2h = await createLeague(deps, "u-owner", { ...baseCreate, format: "headToHead" });
    assert.equal(h2h.settings.submissionsPerPlayer, 1);
    assert.equal(h2h.settings.downvotePoolSize, 0);
    assert.equal((await deps.repo.getLeague(h2h.id))?.settings.downvotePoolSize, 0);
    // Standard takes the (drifted) defaults as-is: the clamp is H2H-only.
    const plain = await createLeague(deps, "u-owner", { ...baseCreate });
    assert.equal(plain.settings.submissionsPerPlayer, 3);
    assert.equal(plain.settings.downvotePoolSize, 2);
  } finally {
    Object.assign(DEFAULT_LEAGUE_SETTINGS, original);
  }
  assert.equal(DEFAULT_LEAGUE_SETTINGS.submissionsPerPlayer, 1);
  assert.equal(DEFAULT_LEAGUE_SETTINGS.downvotePoolSize, 0);
});

test("PATCH settings to downvotePoolSize: 1 (or 2 songs) on an H2H league → 400", async () => {
  const deps = await depsWith([
    league({ id: "h2h", name: "H2H", visibility: "private", format: "headToHead" }),
  ]);
  const path = "/leagues/h2h/settings";
  const ok = { votePoolSize: 10, maxPointsPerSong: 5, allowSelfVote: false, submissionsPerPlayer: 1, downvotePoolSize: 0 };

  await assert.rejects(callRoute(deps, "PATCH", path, "u-owner", { ...ok, downvotePoolSize: 1 }), isStatus(400));
  await assert.rejects(
    updateLeagueSettings(deps, "u-owner", "h2h", { ...ok, downvotePoolSize: 1 }),
    (e: unknown) => isStatus(400)(e) && /anti-votes/.test((e as Error).message),
  );
  await assert.rejects(
    updateLeagueSettings(deps, "u-owner", "h2h", { ...ok, submissionsPerPlayer: 2 }),
    (e: unknown) => isStatus(400)(e) && /1 song per player/.test((e as Error).message),
  );
  // Nothing was written by the rejected edits.
  assert.equal((await deps.repo.getLeague("h2h"))?.settings.downvotePoolSize, 0);
  assert.equal((await deps.repo.getLeague("h2h"))?.settings.submissionsPerPlayer, 1);

  // The forced values (explicit or omitted) still save, so the other knobs stay editable.
  const saved = (await callRoute(deps, "PATCH", path, "u-owner", { ...ok, votePoolSize: 12 })) as League;
  assert.equal(saved.settings.votePoolSize, 12);
  const omitted = await updateLeagueSettings(deps, "u-owner", "h2h", { votePoolSize: 8, maxPointsPerSong: 4, allowSelfVote: true });
  assert.equal(omitted.settings.submissionsPerPlayer, 1);
  assert.equal(omitted.settings.downvotePoolSize, 0);
});

test("standard leagues keep their settings freedom (anti-votes + multi-song still allowed)", async () => {
  const deps = await depsWith([league({ id: "std", name: "Std", visibility: "private" })]);
  const saved = await updateLeagueSettings(deps, "u-owner", "std", {
    votePoolSize: 10, maxPointsPerSong: 5, allowSelfVote: false, submissionsPerPlayer: 3, downvotePoolSize: 2,
  });
  assert.equal(saved.settings.submissionsPerPlayer, 3);
  assert.equal(saved.settings.downvotePoolSize, 2);
  assert.equal(saved.format, "standard");
});

test("format is immutable: a settings PATCH carrying `format` changes nothing", async () => {
  const deps = await depsWith([
    league({ id: "std", name: "Std", visibility: "private" }),
    league({ id: "h2h", name: "H2H", visibility: "private", format: "headToHead" }),
  ]);
  const body = { votePoolSize: 10, maxPointsPerSong: 5, allowSelfVote: false, submissionsPerPlayer: 1, downvotePoolSize: 0 };
  const std = (await callRoute(deps, "PATCH", "/leagues/std/settings", "u-owner", { ...body, format: "headToHead" })) as League;
  assert.equal(std.format, "standard");
  assert.equal((await deps.repo.getLeague("std"))?.format, "standard");
  const h2h = (await callRoute(deps, "PATCH", "/leagues/h2h/settings", "u-owner", { ...body, format: "standard" })) as League;
  assert.equal(h2h.format, "headToHead");
  assert.equal((await deps.repo.getLeague("h2h"))?.format, "headToHead");
});

test("rematch of an H2H league keeps format headToHead (and its forced settings)", async () => {
  // The source row carries non-forced settings (a hand-edited or legacy row),
  // so the rematch clamp is what turns them back into 1 song / 0 anti-votes.
  const deps = await depsWith(
    [
      league({
        id: "h1", name: "Duel 1", visibility: "private", format: "headToHead", roundCount: 1, memberIds: ["u-owner", "u-2"],
        settings: { ...DEFAULT_LEAGUE_SETTINGS, submissionsPerPlayer: 3, downvotePoolSize: 2, votePoolSize: 12 },
      }),
    ],
    [{ id: "h1~1", leagueId: "h1", index: 1, theme: "One", status: "revealed" }],
  );
  const next = await rematchLeague(deps, "u-owner", "h1");
  assert.equal(next.format, "headToHead");
  assert.equal(next.settings.submissionsPerPlayer, 1);
  assert.equal(next.settings.downvotePoolSize, 0);
  assert.equal(next.settings.votePoolSize, 12); // the other knobs carry over
  assert.equal((await deps.repo.getLeague(next.id))?.settings.downvotePoolSize, 0);
  assert.equal((await deps.repo.getLeague(next.id))?.format, "headToHead");
  assert.equal((await getLeagueDetail(deps, "u-owner", next.id)).league.format, "headToHead");
});

test("rematch of a standard league stays standard", async () => {
  const deps = await depsWith(
    [league({ id: "s1", name: "Szn 1", visibility: "private", roundCount: 1 })],
    [{ id: "s1~1", leagueId: "s1", index: 1, theme: "One", status: "revealed" }],
  );
  assert.equal((await rematchLeague(deps, "u-owner", "s1")).format, "standard");
});

test("a legacy league stored without `format` reads as standard everywhere (no undefined leaks)", async () => {
  const legacy = league({ id: "old", name: "Old Szn 1", visibility: "public", roundCount: 1, memberIds: ["u-owner", "u-me"] });
  delete (legacy as Partial<League>).format; // a pre-format record, as an old Dynamo row would be
  const deps = await depsWith([legacy], [{ id: "old~1", leagueId: "old", index: 1, theme: "One", status: "revealed" }]);

  assert.equal((await deps.repo.getLeague("old"))?.format, "standard");
  assert.equal((await getLeagueDetail(deps, "u-me", "old")).league.format, "standard");
  assert.equal((await getLeagueDetail(deps, "u-stranger", "old")).league.format, "standard"); // spectator copy
  const mine = await listMyLeagues(deps, "u-me");
  assert.equal(mine.find((s) => s.league.id === "old")?.league.format, "standard");
  assert.ok((await deps.repo.getAllLeagues()).every((lg) => lg.format === "standard"));
  assert.ok((await deps.repo.getPublicLeagues()).every((lg) => lg.format === "standard"));
  // The rematch of a legacy league is written with an explicit standard format.
  const next = await rematchLeague(deps, "u-owner", "old");
  assert.equal(next.format, "standard");
  // Settings edits on a legacy league behave exactly as before (no H2H rules).
  const saved = await updateLeagueSettings(deps, "u-owner", "old", {
    votePoolSize: 10, maxPointsPerSong: 5, allowSelfVote: false, downvotePoolSize: 2,
  });
  assert.equal(saved.settings.downvotePoolSize, 2);
  assert.equal(saved.format, "standard");
});

// ---- W/L/D standings (HTH-04): storage, view model, format-aware order ----

test("addStandingRecord accumulates on one standing row (memory impl); points untouched", async () => {
  const repo = new MemoryRepository(false);
  await repo.addStandingPoints("lg", "u-me", 7);
  await repo.addStandingRecord("lg", "u-me", { wins: 1 });
  await repo.addStandingRecord("lg", "u-me", { wins: 1, losses: 1 });
  await repo.addStandingRecord("lg", "u-me", { draws: 1 });
  assert.deepEqual(await repo.getStandings("lg"), [{ userId: "u-me", points: 7, wins: 2, losses: 1, draws: 1 }]);

  // …and the points side doesn't disturb the record either.
  await repo.addStandingPoints("lg", "u-me", 3);
  assert.deepEqual(await repo.getStandings("lg"), [{ userId: "u-me", points: 10, wins: 2, losses: 1, draws: 1 }]);

  // A record written before any points (no join seed) still reads complete.
  await repo.addStandingRecord("lg", "u-2", { losses: 1 });
  assert.deepEqual(
    (await repo.getStandings("lg")).find((s) => s.userId === "u-2"),
    { userId: "u-2", points: 0, wins: 0, losses: 1, draws: 0 },
  );

  // A bad increment is refused before it can poison the row with NaN.
  await assert.rejects(repo.addStandingRecord("lg", "u-me", { wins: Number.NaN }));
  await assert.rejects(repo.addStandingRecord("lg", "u-me", { draws: 0.5 }));
  assert.deepEqual(
    (await repo.getStandings("lg")).find((s) => s.userId === "u-me"),
    { userId: "u-me", points: 10, wins: 2, losses: 1, draws: 1 },
  );
});

test("H2H standings sort: 3W-1L above 3W-2L above 2W-0L; record ties by name; ranks 1..n", async () => {
  const members = ["u-me", "u-sarah", "u-james", "u-mia", "u-luna", "u-jpop"];
  const deps = await depsWith([
    league({ id: "h2h", name: "Duel", visibility: "private", format: "headToHead", ownerId: "u-me", memberIds: members }),
  ]);
  const bank = async (userId: string, wins: number, losses: number, draws: number, points = 0) => {
    await deps.repo.addStandingPoints("h2h", userId, points);
    await deps.repo.addStandingRecord("h2h", userId, { wins, losses, draws });
  };
  // Written in an order that matches neither the expected board nor the ids,
  // and with points that would rank them differently — H2H must ignore both.
  await bank("u-mia", 2, 0, 0, 99);
  await bank("u-sarah", 3, 2, 0);
  // Three players tied at 1W-1L. Their draws (1, 0, 1 in name order) are
  // neither ascending nor descending, so a draws tiebreak in either direction
  // would reorder them; only the name rule yields Curator Max, J-Pop, Luna.
  await bank("u-luna", 1, 1, 1, 50);
  await bank("u-jpop", 1, 1, 0, 20);
  await bank("u-me", 1, 1, 1);
  await bank("u-james", 3, 1, 0);
  await bank("u-gone", 9, 0, 0); // ex-member's row: kept in storage, off the board

  const { standings } = await getLeagueDetail(deps, "u-me", "h2h");
  assert.deepEqual(
    standings.map((s) => `${s.rank}. ${s.user.displayName} ${s.wins}-${s.losses}-${s.draws}`),
    [
      "1. James 3-1-0",
      "2. Sarah 3-2-0",
      "3. Mia 2-0-0",
      // Tie on W and L → display name A→Z, regardless of draws, points, ids
      // (u-jpop < u-luna < u-me) or write order (Luna's row came first).
      "4. Curator Max 1-1-1",
      "5. J-Pop 1-1-0",
      "6. Luna 1-1-1",
    ],
  );
  assert.deepEqual(standings.map((s) => s.rank), [1, 2, 3, 4, 5, 6]);
  assert.equal(standings.find((s) => s.user.id === "u-mia")?.points, 99); // points still carried, just not ranked on
});

test("the W/L/D record survives a leave or a kick and reappears on rejoin", async () => {
  const { joinLeague } = await import("./leagues.ts");
  const deps = await depsWith([
    league({ id: "lg", name: "L", visibility: "private", format: "headToHead", memberIds: ["u-owner", "u-me", "u-2"] }),
  ]);
  await deps.repo.putInvite("C-lg", "lg");
  await deps.repo.addStandingPoints("lg", "u-owner", 0); // the owner's creation seed
  await deps.repo.addStandingRecord("lg", "u-me", { wins: 2, losses: 1, draws: 1 });
  await deps.repo.addStandingRecord("lg", "u-2", { wins: 1, losses: 3 });

  await leaveLeague(deps, "u-me", "lg", "u-me"); // leave
  await leaveLeague(deps, "u-owner", "lg", "u-2"); // kick
  // Hidden from the board while gone…
  const gone = await getLeagueDetail(deps, "u-owner", "lg");
  assert.deepEqual(gone.standings.map((s) => s.user.id), ["u-owner"]);

  // …and intact on return (the rejoin seed is create-if-absent, adding 0).
  await joinLeague(deps, "u-me", "C-lg");
  await joinLeague(deps, "u-2", "C-lg");
  const back = await getLeagueDetail(deps, "u-owner", "lg");
  const record = (id: string) => {
    const s = back.standings.find((row) => row.user.id === id);
    return s && [s.wins, s.losses, s.draws];
  };
  assert.deepEqual(record("u-me"), [2, 1, 1]);
  assert.deepEqual(record("u-2"), [1, 3, 0]);
  assert.deepEqual(back.standings.map((s) => s.user.id), ["u-me", "u-2", "u-owner"]); // re-ranked on record
});

test("standard league standings: same rows, order and ranks as before — plus three zeroed fields", async () => {
  const deps = await depsWith([
    league({ id: "std", name: "Std", visibility: "private", memberIds: ["u-owner", "u-sarah", "u-james", "u-mia"] }),
  ]);
  // A points tie (sarah/james) must keep its stored order, exactly as the old
  // `b.points - a.points` sort did — it is not re-broken by name (James < Sarah).
  await deps.repo.addStandingPoints("std", "u-owner", 5);
  await deps.repo.addStandingPoints("std", "u-sarah", 12);
  await deps.repo.addStandingPoints("std", "u-james", 12);
  await deps.repo.addStandingPoints("std", "u-mia", 20);

  const { standings } = await getLeagueDetail(deps, "u-owner", "std");
  assert.deepEqual(standings, [
    { rank: 1, user: { id: "u-mia", displayName: "Mia" }, points: 20, wins: 0, losses: 0, draws: 0 },
    { rank: 2, user: { id: "u-sarah", displayName: "Sarah" }, points: 12, wins: 0, losses: 0, draws: 0 },
    { rank: 3, user: { id: "u-james", displayName: "James" }, points: 12, wins: 0, losses: 0, draws: 0 },
    { rank: 4, user: { id: "u-owner", displayName: "u-owner" }, points: 5, wins: 0, losses: 0, draws: 0 },
  ]);
  // Shape: the pre-HTH-04 keys first, in the same order, then the new ones.
  for (const row of standings) assert.deepEqual(Object.keys(row), ["rank", "user", "points", "wins", "losses", "draws"]);

  // A standard board ranks on points only, even if a record ever landed on it.
  await deps.repo.addStandingRecord("std", "u-owner", { wins: 9 });
  const again = await getLeagueDetail(deps, "u-owner", "std");
  assert.deepEqual(again.standings.map((s) => s.user.id), ["u-mia", "u-sarah", "u-james", "u-owner"]);
});

test("legacy standing rows (points only) read back as a 0–0–0 record — no NaN/undefined in the response", async () => {
  const deps = await depsWith([
    league({ id: "h2h", name: "Duel", visibility: "public", format: "headToHead", memberIds: ["u-owner", "u-sarah"] }),
  ]);
  // Exactly what a row looks like before any W/L/D write: the join/create seed.
  await deps.repo.addStandingPoints("h2h", "u-owner", 0);
  await claimPublicSpot(deps, "u-james", "h2h");
  await deps.repo.addStandingPoints("h2h", "u-sarah", 4);

  const detail = await getLeagueDetail(deps, "u-owner", "h2h");
  for (const s of detail.standings) {
    for (const n of [s.points, s.wins, s.losses, s.draws]) assert.ok(Number.isFinite(n), `non-number in ${JSON.stringify(s)}`);
    assert.deepEqual([s.wins, s.losses, s.draws], [0, 0, 0]);
  }
  // All 0–0 → name order (James, Sarah, then the id-named owner), ranks 1..n.
  assert.deepEqual(detail.standings.map((s) => `${s.rank}:${s.user.id}`), ["1:u-james", "2:u-sarah", "3:u-owner"]);
  // What goes on the wire is identical after a JSON round-trip (nothing undefined dropped).
  assert.deepEqual(JSON.parse(JSON.stringify(detail.standings)), detail.standings);
});

/** A MemoryRepository that records every addStandingRecord call. */
class RecordSpyRepository extends MemoryRepository {
  recordCalls: Array<[string, string, object]> = [];
  override async addStandingRecord(...args: Parameters<MemoryRepository["addStandingRecord"]>): Promise<void> {
    this.recordCalls.push([args[0], args[1], { ...args[2] }]);
    return super.addStandingRecord(...args);
  }
}

test("rematch reseeds a 0–0–0 record for every H2H player (old record dropped); standard rematch writes none", async () => {
  const repo = new RecordSpyRepository(false);
  const deps: Deps = { repo, users: new MemoryUserDirectory() };
  await repo.createLeague(league({ id: "h1", name: "Duel 1", visibility: "private", format: "headToHead", roundCount: 1, memberIds: ["u-owner", "u-2", "u-3"] }));
  await repo.createRound({ id: "h1~1", leagueId: "h1", index: 1, theme: "One", status: "revealed" });
  await repo.addStandingRecord("h1", "u-2", { wins: 1 }); // old record must not carry over
  await repo.addStandingRecord("h1", "u-3", { losses: 1 });
  repo.recordCalls = [];

  const next = await rematchLeague(deps, "u-owner", "h1");
  assert.deepEqual(repo.recordCalls, [
    [next.id, "u-owner", { wins: 0, losses: 0, draws: 0 }],
    [next.id, "u-2", { wins: 0, losses: 0, draws: 0 }],
    [next.id, "u-3", { wins: 0, losses: 0, draws: 0 }],
  ]);
  assert.deepEqual(
    await repo.getStandings(next.id),
    ["u-owner", "u-2", "u-3"].map((userId) => ({ userId, points: 0, wins: 0, losses: 0, draws: 0 })),
  );
  // The finished league keeps its history.
  assert.equal((await repo.getStandings("h1")).find((s) => s.userId === "u-2")?.wins, 1);

  // Standard rematch: the same writes as before HTH-04 — no record calls.
  await repo.createLeague(league({ id: "s1", name: "Szn 1", visibility: "private", roundCount: 1, memberIds: ["u-owner", "u-2"] }));
  await repo.createRound({ id: "s1~1", leagueId: "s1", index: 1, theme: "One", status: "revealed" });
  repo.recordCalls = [];
  const std = await rematchLeague(deps, "u-owner", "s1");
  assert.deepEqual(repo.recordCalls, []);
  assert.ok((await repo.getStandings(std.id)).every((s) => s.points === 0 && s.wins === 0 && s.losses === 0 && s.draws === 0));
});

test("finished H2H league: the wrap-up winner (standings[0]) is the best record, not the most points", async () => {
  const deps = await depsWith(
    [league({ id: "h2h", name: "Duel", visibility: "private", format: "headToHead", roundCount: 2, memberIds: ["u-owner", "u-sarah", "u-james"] })],
    [
      { id: "h2h~1", leagueId: "h2h", index: 1, theme: "One", status: "revealed" },
      { id: "h2h~2", leagueId: "h2h", index: 2, theme: "Two", status: "revealed" },
    ],
  );
  await deps.repo.addStandingPoints("h2h", "u-sarah", 40);
  await deps.repo.addStandingRecord("h2h", "u-sarah", { wins: 1, losses: 1 });
  await deps.repo.addStandingRecord("h2h", "u-james", { wins: 2 });
  await deps.repo.addStandingRecord("h2h", "u-owner", { losses: 1, draws: 1 });

  const detail = await getLeagueDetail(deps, "u-owner", "h2h");
  assert.equal(detail.finished, true); // phase-derived, format-agnostic
  assert.equal(detail.standings[0]?.user.displayName, "James"); // what the wrap-up hero renders
  assert.deepEqual(detail.standings.map((s) => s.user.id), ["u-james", "u-sarah", "u-owner"]);
});

// ---- head-to-head season freeze (HTH-03): join gating, rematch, secrecy ----

/** Seeded RandomInt (mulberry32) for the freeze's shuffle + salt. */
function seededRng(seed: number): RandomInt {
  let a = seed >>> 0;
  return (max) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max);
  };
}

const H2H_MEMBERS = ["u-owner", "u-2", "u-3", "u-4", "u-5"];

/** An H2H league (5 players, owner u-owner) with a draft round 1, invite
 *  code wired, standings seeded, and a seeded freeze RNG. */
async function h2hDeps(over: Partial<League> = {}, seed = 7): Promise<Deps> {
  const lg = league({
    id: "h2h", name: "Duel 1", visibility: "private", format: "headToHead", inviteCode: "DUEL-1",
    settings: { ...DEFAULT_LEAGUE_SETTINGS, ...H2H_FORCED_SETTINGS }, memberIds: [...H2H_MEMBERS], roundCount: 3,
    maxMembers: undefined, ...over,
  });
  const deps = await depsWith([lg], [{ id: "h2h~0001", leagueId: "h2h", index: 1, theme: "One", status: "draft" }]);
  await deps.repo.putInvite(lg.inviteCode, lg.id);
  for (const id of lg.memberIds) await deps.repo.addStandingPoints(lg.id, id, 0);
  return { ...deps, randomInt: seededRng(seed) };
}

const openRound1 = (deps: Deps, leagueId = "h2h") =>
  updateRound(deps, "u-owner", leagueId, `${leagueId}~0001`, { status: "submitting" });
const seasonLockedError = (e: unknown) => isStatus(409)(e) && (e as Error).message === SEASON_LOCKED_MESSAGE;

test("H2H invite-code join: allowed before the freeze, refused with 'season locked' after", async () => {
  const deps = await h2hDeps();
  // Before round 1 opens the league is a lobby: the invite path works as ever.
  const { league: joined } = await joinLeague(deps, "u-early", "DUEL-1");
  assert.ok(joined.memberIds.includes("u-early"));

  await openRound1(deps);
  const frozen = (await deps.repo.getLeague("h2h"))!;
  assert.ok(frozen.h2hParticipants?.includes("u-early")); // frozen in with everyone else
  assert.equal(frozen.h2hParticipants?.length, 6);
  assert.equal(frozen.roundCount, 5); // 6 players (even) → 5 rounds

  // After: refused — even though round 1 is still submitting (a standard
  // league's invite path would let them in) — with the distinct message.
  assert.match(SEASON_LOCKED_MESSAGE, /season locked/i);
  await assert.rejects(joinLeague(deps, "u-late", "DUEL-1"), seasonLockedError);
  await assert.rejects(callRoute(deps, "POST", "/leagues/join", "u-late", { code: "duel-1" }), seasonLockedError);
  const after = (await deps.repo.getLeague("h2h"))!;
  assert.equal(after.memberIds.includes("u-late"), false);
  assert.deepEqual(after.h2hParticipants, frozen.h2hParticipants);
  assert.equal((await deps.repo.getStandings("h2h")).some((s) => s.userId === "u-late"), false);
  // An existing member still gets the usual "already a member" answer.
  await assert.rejects(joinLeague(deps, "u-2", "DUEL-1"), (e: unknown) => isStatus(409)(e) && /already a member/.test((e as Error).message));
});

test("H2H public league: claim, discovery and preview close the moment round 1 opens", async () => {
  const deps = await h2hDeps({ visibility: "public", maxMembers: 10 });
  // Lobby: listed, previewable as open, claimable.
  assert.deepEqual((await listOpenPublicLeagues(deps, "u-me")).map((l) => l.id), ["h2h"]);
  assert.equal((await getPublicLeaguePreview(deps, "u-me", "h2h")).hasStarted, false);
  await claimPublicSpot(deps, "u-early", "h2h");

  await openRound1(deps);
  assert.equal((await deps.repo.getRound("h2h~0001"))?.status, "submitting");
  // A standard league stays joinable while round 1 submits; a frozen H2H one doesn't.
  assert.deepEqual(await listOpenPublicLeagues(deps, "u-me"), []);
  assert.equal((await getPublicLeaguePreview(deps, "u-me", "h2h")).hasStarted, true);
  await assert.rejects(claimPublicSpot(deps, "u-me", "h2h"), seasonLockedError);
  await assert.rejects(callRoute(deps, "POST", "/leagues/h2h/members", "u-me"), seasonLockedError);
  assert.equal((await deps.repo.getLeague("h2h"))?.memberIds.includes("u-me"), false);
});

test("H2H: a join whose lock check read the lobby but whose write lands after the freeze is refused atomically (invite and claim)", async () => {
  for (const via of ["invite", "claim"] as const) {
    const deps = await h2hDeps({ visibility: "public", maxMembers: 10 });
    // The joiner's handler has already read the league (un-frozen, check
    // passed) when round 1 opens — then its membership write arrives.
    const write = deps.repo.addMemberUnlessSeasonLocked.bind(deps.repo);
    deps.repo.addMemberUnlessSeasonLocked = async (leagueId, userId) => {
      await openRound1(deps);
      return write(leagueId, userId);
    };
    const attempt = via === "invite" ? joinLeague(deps, "u-late", "DUEL-1") : claimPublicSpot(deps, "u-late", "h2h");
    await assert.rejects(attempt, seasonLockedError, via);
    const stored = (await deps.repo.getLeague("h2h"))!;
    assert.equal(stored.memberIds.includes("u-late"), false, via);
    assert.equal(stored.h2hParticipants?.includes("u-late"), false, via);
    assert.equal((await deps.repo.getStandings("h2h")).some((s) => s.userId === "u-late"), false, via);
  }
});

test("H2H: a frozen participant who left (or was kicked) may rejoin by invite; newcomers can't", async () => {
  const deps = await h2hDeps();
  await openRound1(deps);
  const order = (await deps.repo.getLeague("h2h"))!.h2hParticipants;

  await leaveLeague(deps, "u-3", "h2h", "u-3"); // leaves mid-season
  await leaveLeague(deps, "u-owner", "h2h", "u-4"); // kicked
  await joinLeague(deps, "u-3", "DUEL-1"); // back: already in the schedule
  await joinLeague(deps, "u-4", "DUEL-1");
  const back = (await deps.repo.getLeague("h2h"))!;
  assert.ok(back.memberIds.includes("u-3") && back.memberIds.includes("u-4"));
  assert.deepEqual(back.h2hParticipants, order); // the schedule never moved
  assert.equal(back.roundCount, 5);
  await assert.rejects(joinLeague(deps, "u-new", "DUEL-1"), seasonLockedError);
});

test("H2H rematch: the clone has no frozen order or salt, takes players again, and re-freezes on its own", async () => {
  // A 3-player season (3 rounds), frozen and played out.
  const deps = await h2hDeps({ memberIds: ["u-owner", "u-2", "u-3"] }, 11);
  await openRound1(deps);
  const original = (await deps.repo.getLeague("h2h"))!;
  assert.equal(original.roundCount, 3);
  for (let index = 2; index <= 3; index++) await createRound(deps, "u-owner", "h2h", { theme: `R${index}` });
  for (const r of await deps.repo.getRoundsForLeague("h2h")) await deps.repo.updateRound({ ...r, status: "revealed" });

  const clone = await rematchLeague(deps, "u-owner", "h2h");
  assert.equal(clone.format, "headToHead");
  const stored = (await deps.repo.getLeague(clone.id))!;
  assert.equal(stored.h2hParticipants, undefined); // starts un-frozen
  assert.equal(stored.h2hSalt, undefined);
  assert.equal("h2hParticipants" in clone, false);

  // Un-frozen → it takes a new player by invite, unlike the original.
  await assert.rejects(joinLeague(deps, "u-new", "DUEL-1"), seasonLockedError);
  await joinLeague(deps, "u-new", clone.inviteCode);
  await createRound(deps, "u-owner", clone.id, { theme: "Rematch R1" });
  await updateRound({ ...deps, randomInt: seededRng(99) }, "u-owner", clone.id, `${clone.id}~0001`, { status: "submitting" });

  const refrozen = (await deps.repo.getLeague(clone.id))!;
  assert.deepEqual([...refrozen.h2hParticipants!].sort(), ["u-2", "u-3", "u-new", "u-owner"]);
  assert.equal(refrozen.roundCount, 3); // re-derived from the clone's 4 players
  assert.match(refrozen.h2hSalt ?? "", /^[0-9a-f]{32}$/);
  assert.notEqual(refrozen.h2hSalt, original.h2hSalt); // its own salt, not a copy
  // The original season is untouched by the clone's freeze.
  const again = (await deps.repo.getLeague("h2h"))!;
  assert.deepEqual(again.h2hParticipants, original.h2hParticipants);
  assert.equal(again.h2hSalt, original.h2hSalt);
});

test("h2hParticipants / h2hSalt never leave the server: every League-returning route strips them", async () => {
  const deps = await h2hDeps({ visibility: "public", maxMembers: 10, roundCount: 1, memberIds: ["u-owner", "u-2"] });
  await openRound1(deps);
  const frozen = (await deps.repo.getLeague("h2h"))!;
  assert.ok(frozen.h2hParticipants && frozen.h2hSalt);
  await deps.repo.updateRound({ ...(await deps.repo.getRound("h2h~0001"))!, status: "revealed" }); // finished
  await leaveLeague(deps, "u-2", "h2h", "u-2"); // so the rejoin below returns a League

  const settings = { votePoolSize: 10, maxPointsPerSong: 5, allowSelfVote: false, submissionsPerPlayer: 1, downvotePoolSize: 0 };
  const payloads: Array<[string, unknown]> = [
    ["GET /leagues (owner)", await callRoute(deps, "GET", "/leagues", "u-owner")],
    ["GET /leagues/:id (owner)", await callRoute(deps, "GET", "/leagues/h2h", "u-owner")],
    ["GET /leagues/:id (spectator)", await callRoute(deps, "GET", "/leagues/h2h", "u-stranger")],
    ["POST /leagues/join (participant rejoin)", await callRoute(deps, "POST", "/leagues/join", "u-2", { code: "DUEL-1" })],
    ["GET /leagues/:id (member)", await callRoute(deps, "GET", "/leagues/h2h", "u-2")],
    ["GET /leagues/:id/public", await callRoute(deps, "GET", "/leagues/h2h/public", "u-stranger")],
    ["POST /leagues/:id/invite", await callRoute(deps, "POST", "/leagues/h2h/invite", "u-owner")],
    ["PATCH /leagues/:id/settings", await callRoute(deps, "PATCH", "/leagues/h2h/settings", "u-owner", settings)],
    ["POST /leagues/:id/rematch", await callRoute(deps, "POST", "/leagues/h2h/rematch", "u-owner")],
  ];
  for (const [label, payload] of payloads) {
    const json = JSON.stringify(payload);
    assert.equal(json.includes("h2hParticipants"), false, `${label} leaks the frozen order`);
    assert.equal(json.includes("h2hSalt"), false, `${label} leaks the salt key`);
    assert.equal(json.includes(frozen.h2hSalt!), false, `${label} leaks the salt value`);
  }
  // The stored league is unaffected by the stripping (copies, not mutation).
  const stored = (await deps.repo.getLeague("h2h"))!;
  assert.deepEqual(stored.h2hParticipants, frozen.h2hParticipants);
  assert.equal(stored.h2hSalt, frozen.h2hSalt);
  // The view helper itself: drops exactly those two fields.
  const view = toLeagueView(stored);
  assert.deepEqual(view, (({ h2hParticipants: _p, h2hSalt: _s, ...rest }) => rest)(stored));
  assert.equal(stored.h2hSalt, frozen.h2hSalt);
});

test("standard league: HTH-03 leaves the join window exactly as it was", async () => {
  const deps = await depsWith(
    [
      league({ id: "pub", name: "Pub", visibility: "public", memberIds: ["u-owner", "u-2", "u-3"], maxMembers: 8 }),
      league({ id: "priv", name: "Priv", visibility: "private", inviteCode: "PRIV-1", memberIds: ["u-owner", "u-2"] }),
    ],
    [
      { id: "pub~0001", leagueId: "pub", index: 1, theme: "One", status: "draft" },
      { id: "priv~0001", leagueId: "priv", index: 1, theme: "One", status: "draft" },
    ],
  );
  await deps.repo.putInvite("PRIV-1", "priv");
  await openRound1(deps, "pub");
  await openRound1(deps, "priv");
  // Round 1 submitting: a standard public league is still open for claims.
  assert.deepEqual((await listOpenPublicLeagues(deps, "u-me")).map((l) => l.id), ["pub"]);
  assert.equal((await getPublicLeaguePreview(deps, "u-me", "pub")).hasStarted, false);
  await claimPublicSpot(deps, "u-me", "pub");
  // Past round 1's submissions: claims close with the old message...
  await updateRound(deps, "u-owner", "pub", "pub~0001", { status: "previewing" });
  await assert.rejects(claimPublicSpot(deps, "u-late", "pub"), (e: unknown) => isStatus(409)(e) && /too late to join/.test((e as Error).message));
  // ...while the invite path still bypasses the window, mid-season.
  await updateRound(deps, "u-owner", "priv", "priv~0001", { status: "previewing" });
  await updateRound(deps, "u-owner", "priv", "priv~0001", { status: "voting" });
  const { league: joined } = await joinLeague(deps, "u-late", "PRIV-1");
  assert.ok(joined.memberIds.includes("u-late"));
  for (const id of ["pub", "priv"]) {
    const stored = (await deps.repo.getLeague(id))!;
    assert.equal(stored.h2hParticipants, undefined);
    assert.equal(stored.roundCount, 8); // the owner's count, untouched
  }
});

// ---- the format on discovery, preview and browse (IMP-01) ----
// A player must be able to tell a head-to-head league apart before claiming a
// spot in it (or spectating it): the three non-member payloads carry
// `format`, read through `leagueFormat()` so a legacy row says "standard".

/** A MemoryRepository that hands the listed leagues back as raw legacy rows,
 *  with no `format` attribute. Both real repositories already fill the format
 *  in on read (MemoryRepository.readLeague, DynamoRepository.getLeague), so
 *  over them a handler that emitted a bare `league.format` would still say
 *  "standard". Over this one only the handlers' own `leagueFormat()` does. */
class RawLegacyRepository extends MemoryRepository {
  private readonly legacyIds: ReadonlySet<string>;
  constructor(legacyIds: string[]) {
    super(false);
    this.legacyIds = new Set(legacyIds);
  }
  private raw(lg: League): League {
    if (!this.legacyIds.has(lg.id)) return lg;
    const { format: _dropped, ...row } = lg;
    return row as League;
  }
  override async getLeague(...args: Parameters<MemoryRepository["getLeague"]>): Promise<League | undefined> {
    const lg = await super.getLeague(...args);
    return lg && this.raw(lg);
  }
  override async getPublicLeagues(): Promise<League[]> {
    return (await super.getPublicLeagues()).map((lg) => this.raw(lg));
  }
  override async getAllLeagues(): Promise<League[]> {
    return (await super.getAllLeagues()).map((lg) => this.raw(lg));
  }
}

test("discovery, preview and browse carry the league format: standard, head-to-head, and a legacy row (no attribute) as standard", async () => {
  const legacyOpen = league({ id: "old-pub", name: "Old Pub", visibility: "public" });
  const legacyRun = league({ id: "old-run", name: "Old Run", visibility: "private" });
  delete (legacyOpen as Partial<League>).format; // pre-format records, as old Dynamo rows would be
  delete (legacyRun as Partial<League>).format;
  const h2h = { format: "headToHead" as const, settings: { ...DEFAULT_LEAGUE_SETTINGS, ...H2H_FORCED_SETTINGS } };
  const leagues = [
    // Open public leagues (round 1 still in draft) → discovery + preview.
    league({ id: "std-pub", name: "Std Pub", visibility: "public" }),
    league({ id: "h2h-pub", name: "H2H Pub", visibility: "public", ...h2h }),
    legacyOpen,
    // Running leagues (round 1 past draft) → browse.
    league({ id: "std-run", name: "Std Run", visibility: "private" }),
    league({ id: "h2h-run", name: "H2H Run", visibility: "public", ...h2h }),
    legacyRun,
  ];
  const rounds: Round[] = [
    { id: "std-pub~1", leagueId: "std-pub", index: 1, theme: "One", status: "draft" },
    { id: "h2h-pub~1", leagueId: "h2h-pub", index: 1, theme: "One", status: "draft" },
    { id: "old-pub~1", leagueId: "old-pub", index: 1, theme: "One", status: "draft" },
    { id: "std-run~1", leagueId: "std-run", index: 1, theme: "One", status: "voting" },
    { id: "h2h-run~1", leagueId: "h2h-run", index: 1, theme: "One", status: "voting" },
    { id: "old-run~1", leagueId: "old-run", index: 1, theme: "One", status: "voting" },
  ];
  const expected: Record<string, string> = {
    "std-pub": "standard", "h2h-pub": "headToHead", "old-pub": "standard",
    "std-run": "standard", "h2h-run": "headToHead", "old-run": "standard",
  };
  const formats = (rows: { id: string; format: string }[]) => Object.fromEntries(rows.map((r) => [r.id, r.format]));

  // Twice: over the real MemoryRepository (end to end: a legacy row is
  // normalised on read, as DynamoRepository does), then over a repository
  // that hands the legacy rows back raw (pins the handlers' leagueFormat()).
  const raw = new RawLegacyRepository(["old-pub", "old-run"]);
  for (const lg of leagues) await raw.createLeague(lg);
  for (const r of rounds) await raw.createRound(r);
  assert.equal((await raw.getLeague("old-pub"))?.format, undefined, "the raw repo really drops the field");
  assert.equal((await raw.getLeague("h2h-pub"))?.format, "headToHead");

  for (const [label, deps] of [
    ["memory repo", await depsWith(leagues, rounds)],
    ["raw legacy rows", { repo: raw, users: new MemoryUserDirectory() }],
  ] as const) {
    const open = await listOpenPublicLeagues(deps, "u-me");
    assert.deepEqual(formats(open), { "std-pub": "standard", "h2h-pub": "headToHead", "old-pub": "standard" }, `${label}: discovery`);
    const browse = await listBrowseLeagues(deps, "u-me");
    assert.deepEqual(formats(browse), { "std-run": "standard", "h2h-run": "headToHead", "old-run": "standard" }, `${label}: browse`);
    for (const id of ["std-pub", "h2h-pub", "old-pub", "h2h-run"]) {
      assert.equal((await getPublicLeaguePreview(deps, "u-me", id)).format, expected[id], `${label}: preview ${id}`);
    }

    // The same through the real route table (what the HTTP adapters
    // serialize), so the field can't be dropped by a route-level mapping.
    const viaRoutes = [
      ...(await callRoute(deps, "GET", "/leagues/public", "u-me")) as { id: string; format: string }[],
      ...(await callRoute(deps, "GET", "/leagues/browse", "u-me")) as { id: string; format: string }[],
    ];
    assert.deepEqual(formats(viaRoutes), expected, `${label}: routes`);
    for (const id of ["std-pub", "h2h-pub", "old-pub"]) {
      const preview = (await callRoute(deps, "GET", `/leagues/${id}/public`, "u-me")) as { format: string };
      assert.equal(preview.format, expected[id], `${label}: route preview ${id}`);
    }
  }
});

test("a locked head-to-head league's preview says headToHead with hasStarted while round 1 still submits (the page words it as a season lock, not closed submissions)", async () => {
  const deps = await h2hDeps({ visibility: "public", maxMembers: 10 });
  const before = await getPublicLeaguePreview(deps, "u-me", "h2h");
  assert.equal(before.format, "headToHead");
  assert.equal(before.hasStarted, false);

  await openRound1(deps);
  assert.equal((await deps.repo.getRound("h2h~0001"))?.status, "submitting");
  const locked = await getPublicLeaguePreview(deps, "u-me", "h2h");
  assert.equal(locked.format, "headToHead");
  assert.equal(locked.hasStarted, true); // round 1 opened (not closed): season locked
  // Spectators see it in browse, tagged.
  const row = (await listBrowseLeagues(deps, "u-me")).find((b) => b.id === "h2h");
  assert.equal(row?.format, "headToHead");
  assert.equal(row?.currentRound?.status, "submitting");
});

// ---- head-to-head progress, departures and the finished flow (HTH-08) ----
// Driven through the real handlers (create → join → open round 1 = freeze →
// submit → vote → reveal) over MemoryRepository, seeded freeze RNG, manual
// leagues (the timed advance is in progression.test.ts). Seed users, so names
// resolve (u-me = the owner).

const DUEL_OWNER = "u-me";
const DUELISTS = ["u-me", "u-sarah", "u-james", "u-mia"];

interface Duel {
  deps: Deps;
  repo: MemoryRepository;
  leagueId: string;
  inviteCode: string;
}

/** A manual head-to-head league of `players` (owner first). */
async function duel(players: readonly string[] = DUELISTS): Promise<Duel> {
  const repo = new MemoryRepository(false);
  const deps: Deps = { repo, users: new MemoryUserDirectory(), randomInt: seededRng(20261107) };
  const lg = await createLeague(deps, players[0]!, { name: "Duel Club", musicProvider: "mock", format: "headToHead", roundCount: 3 });
  for (const p of players.slice(1)) await joinLeague(deps, p, lg.inviteCode);
  return { deps, repo, leagueId: lg.id, inviteCode: lg.inviteCode };
}

async function openDuelRound(f: Duel): Promise<Round> {
  const r = await createRound(f.deps, DUEL_OWNER, f.leagueId, { theme: "Openers" });
  return updateRound(f.deps, DUEL_OWNER, f.leagueId, r.id, { status: "submitting" });
}

const duelSubmit = (f: Duel, roundId: string, userId: string) =>
  submitSong(f.deps, userId, roundId, {
    track: { id: `t-${userId}-${roundId}`, provider: "mock", providerTrackId: `t-${userId}-${roundId}`, title: `${userId} anthem`, artists: [`Artist ${userId}`] },
  });

const advance = (f: Duel, roundId: string, status: "previewing" | "voting") =>
  updateRound(f.deps, DUEL_OWNER, f.leagueId, roundId, { status });

/** The round's server-side matchups (user ids + songs) — the tests' ground truth. */
async function duelSet(f: Duel, roundId: string): Promise<RoundMatchupSet> {
  return loadRoundMatchups(f.deps, (await f.repo.getLeague(f.leagueId))!, (await f.repo.getRound(roundId))!);
}

/** `voter`'s complete picks; `side` chooses per matchup (default side a). */
const duelPicks = (set: RoundMatchupSet, voter: string, side: (m: RoundMatchup) => "a" | "b" = () => "a") =>
  Object.fromEntries(votableMatchups(set, voter).map((m) => [m.matchupId, m[side(m)].submission!.id]));

async function duelRecords(f: Duel): Promise<Map<string, string>> {
  const rows = await f.repo.getStandings(f.leagueId);
  return new Map(rows.map((r) => [r.userId, `${r.wins}-${r.losses}-${r.draws}`]));
}

/** The owner's dashboard completion % for the league. */
async function pctOf(f: Duel, caller = DUEL_OWNER): Promise<number> {
  return (await listMyLeagues(f.deps, caller)).find((s) => s.league.id === f.leagueId)!.completionPct;
}

const ids = (users: Array<{ id: string }> | undefined) => users?.map((u) => u.id);

/** The who-voted panel as `viewer` gets it: the names it shows (done /
 *  waiting) and its "X of N" counts. */
async function votingPanelAs(f: Duel, viewer: string) {
  const p = (await getLeagueDetail(f.deps, viewer, f.leagueId)).votingProgress;
  assert.ok(p, `${viewer} gets a voting panel`);
  return { done: ids(p.submitted), waiting: ids(p.waiting), counts: [p.doneCount, p.totalCount] };
}

/** Whose "cast their votes" entries `viewer`'s activity feed shows (sorted). */
async function ballotFeedAs(f: Duel, viewer: string): Promise<string[]> {
  const { activity } = await getLeagueDetail(f.deps, viewer, f.leagueId);
  return activity.filter((a) => a.text === "cast their votes").map((a) => a.user.id).sort();
}

test("H2H voting progress: completion % and the who-voted counts include only members with a matchup to pick in; with one contest the panel and the activity feed name nobody's ballot but the viewer's (no walkover song attributable, even from one snapshot); a comments-only ballot isn't a vote; every ballot shows once revealed", async () => {
  const f = await duel();
  const round = await openDuelRound(f);
  const [contest, walk] = (await duelSet(f, round.id)).matchups as [RoundMatchup, RoundMatchup];
  for (const p of [contest.a.userId, contest.b.userId, walk.a.userId]) await duelSubmit(f, round.id, p);
  await advance(f, round.id, "previewing");
  await advance(f, round.id, "voting");
  const set = await duelSet(f, round.id);
  const voters = DUELISTS.filter((id) => id === walk.a.userId || id === walk.b.userId); // member order

  const detail0 = await getLeagueDetail(f.deps, DUEL_OWNER, f.leagueId);
  assert.equal(detail0.currentRound?.status, "voting");
  // Only the walkover pair can vote (in the one contest). Naming them would
  // name the contest's pair too, and so whose walkover song it is (the
  // no-show was named by the submissions panel): each voter sees only
  // themselves; the contest's pair and a spectator see no names. Same counts.
  for (const viewer of [...DUELISTS, "u-luna"]) {
    assert.deepEqual(await votingPanelAs(f, viewer), { done: [], waiting: voters.includes(viewer) ? [viewer] : [], counts: [0, 2] }, viewer);
  }
  assert.equal(await pctOf(f), 0);

  // One of the contest's players comments on their opponent's song: a ballot row, not a vote.
  const opponentSong = set.matchups.find((m) => m.matchupId === contest.matchupId)!.b.submission!.id;
  await castBallot(f.deps, contest.a.userId, round.id, { comments: { [opponentSong]: "may the best song win" } });
  assert.deepEqual(await votingPanelAs(f, contest.a.userId), { done: [], waiting: [], counts: [0, 2] }, "nothing to vote on: in neither list");
  assert.equal(await pctOf(f), 0);
  // Its feed entry would be a ballot that didn't move the count, i.e. a
  // contest player's: only its author sees it.
  for (const viewer of [...DUELISTS, "u-luna"]) {
    assert.deepEqual(await ballotFeedAs(f, viewer), viewer === contest.a.userId ? [viewer] : [], viewer);
  }

  await castBallot(f.deps, voters[0]!, round.id, { picks: duelPicks(set, voters[0]!) });
  assert.equal(await pctOf(f), 50);
  assert.deepEqual(await votingPanelAs(f, voters[0]!), { done: [voters[0]], waiting: [], counts: [1, 2] });
  assert.deepEqual(await votingPanelAs(f, voters[1]!), { done: [], waiting: [voters[1]], counts: [1, 2] });
  // One snapshot of "1 of 2" next to "<voter> cast their votes" would name a
  // member of the walkover pair, and with the no-show named by the
  // submissions feed, attribute the walkover song. Nobody else sees it.
  for (const viewer of [...DUELISTS, "u-luna"]) {
    const detail = await getLeagueDetail(f.deps, viewer, f.leagueId);
    const seen = detail.activity.filter((a) => a.text === "cast their votes").map((a) => a.user.id);
    assert.deepEqual(seen, [contest.a.userId, voters[0]!].filter((id) => id === viewer), viewer);
    if (viewer !== voters[0]) assert.ok(!JSON.stringify(detail.votingProgress).includes(voters[0]!), viewer);
  }
  await castBallot(f.deps, voters[1]!, round.id, { picks: duelPicks(set, voters[1]!) });
  assert.equal(await pctOf(f), 100, "a standard count (2 voted of 4 members) would say 50");
  for (const viewer of [...DUELISTS, "u-luna"]) {
    assert.deepEqual(await votingPanelAs(f, viewer), { done: voters.includes(viewer) ? [viewer] : [], waiting: [], counts: [2, 2] }, viewer);
  }
  const detail = await getLeagueDetail(f.deps, DUEL_OWNER, f.leagueId);
  assert.equal(detail.currentRound?.status, "voting", "a manual league waits for the owner's reveal");
  // Activity: each viewer's own ballot only; the submissions show as ever.
  for (const viewer of [...DUELISTS, "u-luna"]) {
    assert.deepEqual(await ballotFeedAs(f, viewer), [contest.a.userId, ...voters].filter((id) => id === viewer), viewer);
  }
  assert.equal(detail.activity.filter((a) => a.text === "submitted a song").length, 3);
  const json = JSON.stringify([detail.activity, detail.votingProgress]);
  assert.ok(!json.includes("anthem") && !json.includes(contest.matchupId), "no tracks or picks leak");

  await revealRound(f.deps, DUEL_OWNER, round.id);
  assert.equal(await pctOf(f), 100);
  // Revealed: the matchups and their voters are public, and so is the feed.
  for (const viewer of [DUEL_OWNER, "u-luna"]) {
    assert.deepEqual(await ballotFeedAs(f, viewer), [contest.a.userId, ...voters].sort(), viewer);
  }
});

test("H2H submitting progress counts members with their song: a kicked player's withdrawn song inflates neither the count nor the %, and their pair is a walkover at the reveal", async () => {
  const f = await duel();
  const round = await openDuelRound(f);
  const [first] = (await duelSet(f, round.id)).matchups as [RoundMatchup];
  const kicked = first.a.userId === DUEL_OWNER ? first.b.userId : first.a.userId;
  const stayer = kicked === first.a.userId ? first.b.userId : first.a.userId;
  const others = DUELISTS.filter((id) => id !== kicked);

  await duelSubmit(f, round.id, kicked);
  await duelSubmit(f, round.id, others[0]!);
  let detail = await getLeagueDetail(f.deps, DUEL_OWNER, f.leagueId);
  assert.deepEqual([detail.submissionProgress?.doneCount, detail.submissionProgress?.totalCount], [2, 4]);
  assert.equal(await pctOf(f), 50);

  await leaveLeague(f.deps, DUEL_OWNER, f.leagueId, kicked); // kicked mid-round, song already in
  detail = await getLeagueDetail(f.deps, DUEL_OWNER, f.leagueId);
  assert.deepEqual([detail.submissionProgress?.doneCount, detail.submissionProgress?.totalCount], [1, 3], "not 2 of 3");
  assert.deepEqual(ids(detail.submissionProgress?.submitted), [others[0]]);
  assert.equal(await pctOf(f), 33);

  for (const p of others.slice(1)) await duelSubmit(f, round.id, p);
  assert.equal(await pctOf(f), 100);
  await advance(f, round.id, "previewing");
  await advance(f, round.id, "voting");
  const set = await duelSet(f, round.id);
  for (const voter of others) {
    const picks = duelPicks(set, voter);
    if (Object.keys(picks).length > 0) await castBallot(f.deps, voter, round.id, { picks });
  }
  const payload = await revealRound(f.deps, DUEL_OWNER, round.id);
  assert.ok(!Array.isArray(payload));
  const theirs = payload.matchups.find((m) => m.matchupId === first.matchupId)!;
  assert.equal(theirs.outcome, "walkover");
  assert.equal(theirs.winnerUserId, stayer);
  const board = await duelRecords(f);
  assert.equal(board.get(stayer), "1-0-0");
  assert.equal(board.get(kicked), "0-0-0", "a departed player takes no L");
});

test("H2H kick mid-voting: the kicked player's pair resolves as a walkover at the reveal, and the voters' sets shrink with it — the round waits only for who can still vote; ballots stop being named once only one contest is left", async () => {
  const f = await duel();
  const round = await openDuelRound(f);
  for (const p of DUELISTS) await duelSubmit(f, round.id, p);
  await advance(f, round.id, "previewing");
  await advance(f, round.id, "voting");
  const before = await duelSet(f, round.id);
  // Two contests: everyone has the other matchup to judge, so the panel names
  // every member (eligibility says nothing about who plays whom).
  assert.deepEqual(await votingPanelAs(f, "u-luna"), { done: [], waiting: DUELISTS, counts: [0, 4] });

  // Kick a player from the matchup the owner isn't in.
  const theirs = before.matchups.find((m) => m.a.userId !== DUEL_OWNER && m.b.userId !== DUEL_OWNER)!;
  const owners = before.matchups.find((m) => m !== theirs)!;
  const [kicked, stayer] = [theirs.a.userId, theirs.b.userId];
  // While everyone can vote, the feed names a complete ballot (its author is
  // in the panel's done list).
  await castBallot(f.deps, DUEL_OWNER, round.id, { picks: duelPicks(before, DUEL_OWNER) });
  assert.deepEqual(await ballotFeedAs(f, "u-luna"), [DUEL_OWNER]);
  await leaveLeague(f.deps, DUEL_OWNER, f.leagueId, kicked);

  // Their pair is now a walkover: the owner's pair has nothing left to vote
  // on, and the stayer's only vote is in the owner's matchup. Only the
  // stayer is told they're the one the round waits on — naming them to the
  // league would attribute the walkover song.
  assert.deepEqual(await votingPanelAs(f, stayer), { done: [], waiting: [stayer], counts: [0, 1] });
  for (const viewer of [owners.a.userId, owners.b.userId, kicked]) {
    assert.deepEqual(await votingPanelAs(f, viewer), { done: [], waiting: [], counts: [0, 1] }, viewer);
  }
  assert.equal(await pctOf(f), 0, "the owner's ballot picked in the pair that's now a walkover: no vote");
  const now = await duelSet(f, round.id);
  await castBallot(f.deps, stayer, round.id, { picks: duelPicks(now, stayer, () => "b") });
  assert.equal(await pctOf(f), 100);
  // Now one contest: each viewer's feed names only their own ballot (the
  // stayer's entry next to "1 of 1" would attribute the walkover song).
  for (const viewer of [...DUELISTS, "u-luna"]) {
    assert.deepEqual(await ballotFeedAs(f, viewer), [DUEL_OWNER, stayer].filter((id) => id === viewer), viewer);
  }

  const payload = await revealRound(f.deps, DUEL_OWNER, round.id);
  assert.ok(!Array.isArray(payload));
  const walk = payload.matchups.find((m) => m.matchupId === theirs.matchupId)!;
  assert.deepEqual([walk.outcome, walk.winnerUserId, walk.a.departed], ["walkover", stayer, true]);
  const decided = payload.matchups.find((m) => m.matchupId === owners.matchupId)!;
  assert.deepEqual([decided.outcome, decided.winnerUserId], ["win", owners.b.userId], "the stayer's pick decided it");
  const board = await duelRecords(f);
  assert.equal(board.get(stayer), "1-0-0");
  assert.equal(board.get(kicked), "0-0-0");
  assert.equal(board.get(owners.b.userId), "1-0-0");
  assert.equal(board.get(owners.a.userId), "0-1-0");
});

test("H2H leave → comments-only row → vote → rejoin (BUG-06): once everyone can vote again, the feed names only members in the panel's done list — the contest player's comments-only row stays hidden, so it can't say who the viewer's anonymous opponent is", async () => {
  const f = await duel();
  const round = await openDuelRound(f);
  for (const p of DUELISTS) await duelSubmit(f, round.id, p);
  await advance(f, round.id, "previewing");
  await advance(f, round.id, "voting");
  const before = await duelSet(f, round.id);
  // leaver–partner and the owner's matchup (owner vs opponent).
  const theirs = before.matchups.find((m) => m.a.userId !== DUEL_OWNER && m.b.userId !== DUEL_OWNER)!;
  const owners = before.matchups.find((m) => m !== theirs)!;
  const [leaver, partner] = [theirs.a.userId, theirs.b.userId];
  const opponent = owners.a.userId === DUEL_OWNER ? owners.b.userId : owners.a.userId;
  const ownerSong = (owners.a.userId === DUEL_OWNER ? owners.a : owners.b).submission!.id;

  // The leaver goes: their pair is a walkover, the owner's matchup the only
  // contest. Its pair has nothing to vote on; the opponent comments on the
  // owner's song — a comments-only row, the only kind they can write now.
  await leaveLeague(f.deps, leaver, f.leagueId, leaver);
  const shrunk = await duelSet(f, round.id);
  assert.deepEqual(votableMatchups(shrunk, opponent), []);
  await castBallot(f.deps, opponent, round.id, { comments: { [ownerSong]: "see you in the final" } });
  // The walkover partner, the only one who can vote, picks in that contest.
  await castBallot(f.deps, partner, round.id, { picks: duelPicks(shrunk, partner) });

  // The leaver rejoins (a frozen participant may): two contests again, so
  // every member can vote and the panel names everyone.
  await joinLeague(f.deps, leaver, f.inviteCode);
  const members = (await f.repo.getLeague(f.leagueId))!.memberIds;
  const waiting = members.filter((id) => id !== partner);
  for (const viewer of [...DUELISTS, "u-luna"]) {
    assert.deepEqual(await votingPanelAs(f, viewer), { done: [partner], waiting, counts: [1, 4] }, viewer);
  }
  // The opponent is shown waiting; a feed entry for them would say they wrote
  // a row while they had nothing to vote on — i.e. that they're the owner's
  // opponent. Only the partner (done) and one's own row show.
  assert.deepEqual(await ballotFeedAs(f, DUEL_OWNER), [partner]);
  assert.deepEqual(await ballotFeedAs(f, "u-luna"), [partner]);
  assert.deepEqual(await ballotFeedAs(f, leaver), [partner]);
  assert.deepEqual(await ballotFeedAs(f, partner), [partner]);
  assert.deepEqual(await ballotFeedAs(f, opponent), [opponent, partner].sort(), "their own row still shows");
  // The other members' feed entries never say more than the panel's done list.
  for (const viewer of [...DUELISTS, "u-luna"]) {
    const others = (await ballotFeedAs(f, viewer)).filter((id) => id !== viewer);
    const { done } = await votingPanelAs(f, viewer);
    assert.deepEqual(others, [...done!].filter((id) => id !== viewer).sort(), viewer);
  }

  // Completing their picks puts the opponent in the done list — and the feed.
  const restored = await duelSet(f, round.id);
  await castBallot(f.deps, opponent, round.id, { picks: duelPicks(restored, opponent) });
  const done = [opponent, partner];
  for (const viewer of [DUEL_OWNER, "u-luna"]) {
    const panel = { done: members.filter((id) => done.includes(id)), waiting: members.filter((id) => !done.includes(id)), counts: [2, 4] };
    assert.deepEqual(await votingPanelAs(f, viewer), panel, viewer);
    assert.deepEqual(await ballotFeedAs(f, viewer), [...done].sort(), viewer);
  }

  // Revealed: every ballot shows.
  for (const voter of [DUEL_OWNER, leaver]) await castBallot(f.deps, voter, round.id, { picks: duelPicks(restored, voter) });
  await revealRound(f.deps, DUEL_OWNER, round.id);
  assert.deepEqual(await ballotFeedAs(f, "u-luna"), [...DUELISTS].sort());
});

test("three-player H2H league: the who-voted panel and the activity feed name nobody's ballot but the viewer's, so the bye song and each contest player's opponent stay anonymous until the reveal", async () => {
  const trio = ["u-me", "u-sarah", "u-james"];
  const f = await duel(trio);
  const round = await openDuelRound(f);
  for (const p of trio) await duelSubmit(f, round.id, p);
  await advance(f, round.id, "previewing");
  assert.equal((await advance(f, round.id, "voting")).status, "voting");
  const set = await duelSet(f, round.id);
  const [contest] = set.matchups as [RoundMatchup];
  const byePlayer = set.bye!.userId;

  // GET /matchups: one contest + an anonymous bye song; only `isMine` says anything about identity.
  const view = await listMatchups(f.deps, contest.a.userId, round.id);
  assert.deepEqual([view.matchups.length, view.matchups[0]!.isMine, view.bye !== null], [1, true, true]);
  // The panel must not undo that: only the bye player can vote, and naming
  // them would attribute the bye song (and tell each contest player who
  // their opponent is). Only the bye player sees their own name.
  assert.deepEqual(await votingPanelAs(f, byePlayer), { done: [], waiting: [byePlayer], counts: [0, 1] });
  for (const viewer of [contest.a.userId, contest.b.userId, "u-luna"]) {
    const panel = await votingPanelAs(f, viewer);
    assert.deepEqual(panel, { done: [], waiting: [], counts: [0, 1] }, viewer);
    const json = JSON.stringify((await getLeagueDetail(f.deps, viewer, f.leagueId)).votingProgress);
    assert.ok(!json.includes(byePlayer), `${viewer} isn't told who the bye is`);
  }

  // A contest player's comments-only row: its entry, next to a count that
  // didn't move, would say its author is in the contest.
  await castBallot(f.deps, contest.a.userId, round.id, { comments: { [contest.b.submission!.id]: "good luck" } });

  await castBallot(f.deps, byePlayer, round.id, { picks: duelPicks(set, byePlayer) });
  assert.deepEqual(await votingPanelAs(f, byePlayer), { done: [byePlayer], waiting: [], counts: [1, 1] });
  assert.deepEqual(await votingPanelAs(f, contest.a.userId), { done: [], waiting: [], counts: [1, 1] });
  assert.equal(await pctOf(f), 100);
  // One snapshot: "1 of 1 ballots in" and "<bye player> cast their votes"
  // side by side would name the bye. Each viewer's feed shows their own ballot only.
  assert.deepEqual(await ballotFeedAs(f, byePlayer), [byePlayer]);
  assert.deepEqual(await ballotFeedAs(f, contest.a.userId), [contest.a.userId]);
  for (const viewer of [contest.b.userId, "u-luna"]) assert.deepEqual(await ballotFeedAs(f, viewer), [], viewer);
  for (const viewer of [contest.a.userId, contest.b.userId, "u-luna"]) {
    const detail = await getLeagueDetail(f.deps, viewer, f.leagueId);
    const ballotsNamed = JSON.stringify([detail.votingProgress, detail.activity.filter((a) => a.text !== "submitted a song")]);
    assert.ok(!ballotsNamed.includes(byePlayer), `${viewer} isn't told who voted (the bye)`);
  }
});

test("H2H manual league, kick mid-voting leaves nobody able to vote: the round stays in voting for the owner (0 of 0, 100%), and the reveal banks the stayer's walkover W with no L for the kicked player", async () => {
  const trio = ["u-me", "u-sarah", "u-james"];
  const f = await duel(trio);
  const round = await openDuelRound(f);
  for (const p of trio) await duelSubmit(f, round.id, p);
  await advance(f, round.id, "previewing");
  await advance(f, round.id, "voting");
  const [contest] = (await duelSet(f, round.id)).matchups as [RoundMatchup];
  const kicked = contest.a.userId === DUEL_OWNER ? contest.b.userId : contest.a.userId;
  const stayer = kicked === contest.a.userId ? contest.b.userId : contest.a.userId;
  assert.equal(await pctOf(f), 0, "the bye player has the contest to judge");

  await leaveLeague(f.deps, DUEL_OWNER, f.leagueId, kicked);
  // The only contest is now a walkover: nobody has anything to vote on.
  const detail = await getLeagueDetail(f.deps, DUEL_OWNER, f.leagueId);
  assert.equal(detail.currentRound?.status, "voting", "a manual league isn't advanced by reads");
  for (const viewer of trio.filter((id) => id !== kicked)) {
    assert.deepEqual(await votingPanelAs(f, viewer), { done: [], waiting: [], counts: [0, 0] }, viewer);
  }
  assert.equal(await pctOf(f), 100, "nothing left to wait for: only the reveal");

  const payload = await revealRound(f.deps, DUEL_OWNER, round.id);
  assert.ok(!Array.isArray(payload));
  assert.deepEqual([payload.matchups[0]!.outcome, payload.matchups[0]!.winnerUserId], ["walkover", stayer]);
  const board = await duelRecords(f);
  assert.equal(board.get(stayer), "1-0-0");
  assert.equal(board.get(kicked), "0-0-0", "a departed player takes no L");
});

test("H2H opening voting on a round nobody can vote in, raced by a second open: one PATCH reveals with its edits, the other gets 409 (its edits never landed), and the W/L/D is banked once", async () => {
  const f = await duel(["u-me", "u-sarah"]);
  const round = await openDuelRound(f);
  for (const p of ["u-me", "u-sarah"]) await duelSubmit(f, round.id, p);
  await advance(f, round.id, "previewing");

  const outcomes = await Promise.allSettled(
    ["Theme A", "Theme B"].map((theme) => updateRound(f.deps, DUEL_OWNER, f.leagueId, round.id, { status: "voting", theme })),
  );
  const won = outcomes.filter((o): o is PromiseFulfilledResult<Round> => o.status === "fulfilled");
  const lost = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
  assert.equal(won.length, 1);
  assert.equal(lost.length, 1);
  assert.ok(isStatus(409)(lost[0]!.reason), "not a 200 carrying the other request's round");
  assert.equal(won[0]!.value.status, "revealed");
  const stored = (await f.repo.getRound(round.id))!;
  assert.deepEqual([stored.status, stored.theme], ["revealed", won[0]!.value.theme]);
  assert.deepEqual(Object.fromEntries(await duelRecords(f)), { "u-me": "0-0-1", "u-sarah": "0-0-1" });
});

test("two-player H2H league end to end: open → both submit → opening voting goes straight to the reveal (nobody can vote: a 0–0 draw) → finished at 100%, rematch offered", async () => {
  const f = await duel(["u-me", "u-sarah"]);
  const round = await openDuelRound(f);
  assert.equal((await f.repo.getLeague(f.leagueId))!.roundCount, 1, "two players: a one-round season");
  for (const p of ["u-me", "u-sarah"]) await duelSubmit(f, round.id, p);
  assert.equal(await pctOf(f), 100);
  await advance(f, round.id, "previewing");

  const opened = await advance(f, round.id, "voting");
  assert.equal(opened.status, "revealed", "never sits in voting");
  assert.equal((await f.repo.getRound(round.id))!.status, "revealed");
  assert.deepEqual(Object.fromEntries(await duelRecords(f)), { "u-me": "0-0-1", "u-sarah": "0-0-1" });
  const results = await getResults(f.deps, "u-sarah", round.id);
  assert.ok(!Array.isArray(results));
  assert.deepEqual(results.matchups.map((m) => [m.outcome, m.a.votes, m.b.votes]), [["draw", 0, 0]]);

  const detail = await getLeagueDetail(f.deps, DUEL_OWNER, f.leagueId);
  assert.equal(detail.finished, true);
  assert.equal(await pctOf(f), 100);
  assert.equal((await listMyLeagues(f.deps, "u-sarah"))[0]!.finished, true);
  await assert.rejects(revealRound(f.deps, DUEL_OWNER, round.id), isStatus(400), "already revealed — nothing to bank twice");
  assert.deepEqual(Object.fromEntries(await duelRecords(f)), { "u-me": "0-0-1", "u-sarah": "0-0-1" });
  const clone = await rematchLeague(f.deps, DUEL_OWNER, f.leagueId);
  assert.equal(clone.format, "headToHead");
});

test("two-player H2H league with a no-show: the owner opening voting reveals it on the spot and banks the walkover W/L", async () => {
  const f = await duel(["u-me", "u-sarah"]);
  const round = await openDuelRound(f);
  await duelSubmit(f, round.id, "u-sarah");
  assert.equal(await pctOf(f), 50);
  await advance(f, round.id, "previewing");
  // The PATCH may carry edits; they land with the reveal.
  const opened = await updateRound(f.deps, DUEL_OWNER, f.leagueId, round.id, { status: "voting", theme: "Renamed" });
  assert.equal(opened.status, "revealed");
  const stored = (await f.repo.getRound(round.id))!;
  assert.deepEqual([stored.status, stored.theme], ["revealed", "Renamed"]);
  assert.deepEqual(Object.fromEntries(await duelRecords(f)), { "u-me": "0-1-0", "u-sarah": "1-0-0" });
  const detail = await getLeagueDetail(f.deps, DUEL_OWNER, f.leagueId);
  assert.equal(detail.finished, true);
  assert.equal(detail.standings[0]?.user.id, "u-sarah", "the wrap-up winner");
});

test("H2H opening voting: a round with someone to vote stays in voting; a standard round with no songs stays in voting as before", async () => {
  const f = await duel();
  const round = await openDuelRound(f);
  const [contest] = (await duelSet(f, round.id)).matchups as [RoundMatchup];
  for (const p of [contest.a.userId, contest.b.userId]) await duelSubmit(f, round.id, p);
  await advance(f, round.id, "previewing");
  assert.equal((await advance(f, round.id, "voting")).status, "voting", "the other pair can judge the contest");

  const std = await depsWith([league({ id: "std", name: "Points", visibility: "private", memberIds: ["u-owner", "u-2"] })], [
    { id: "std~0001", leagueId: "std", index: 1, theme: "Go", status: "previewing" },
  ]);
  const opened = await updateRound(std, "u-owner", "std", "std~0001", { status: "voting" });
  assert.equal(opened.status, "voting");
  assert.equal((await std.repo.getRound("std~0001"))!.status, "voting");
});

test("finished flow: a 4-player H2H league plays its 3 rounds → finished; the wrap-up winner is the best record; the rematch clone is un-frozen and takes players again", async () => {
  const f = await duel();
  const star = "u-mia";
  for (let i = 1; i <= 3; i++) {
    const round = await openDuelRound(f);
    for (const p of DUELISTS) await duelSubmit(f, round.id, p);
    await advance(f, round.id, "previewing");
    await advance(f, round.id, "voting");
    const set = await duelSet(f, round.id);
    // Everyone backs the star when they play; otherwise side a.
    for (const voter of DUELISTS) {
      await castBallot(f.deps, voter, round.id, { picks: duelPicks(set, voter, (m) => (m.b.userId === star ? "b" : "a")) });
    }
    const detail = await getLeagueDetail(f.deps, DUEL_OWNER, f.leagueId);
    assert.equal(await pctOf(f), 100, `round ${i}: everyone voted`);
    // Two contests and every ballot complete: everyone is in the panel's done
    // list, so the feed names every ballot.
    assert.deepEqual(await ballotFeedAs(f, "u-luna"), [...DUELISTS].sort(), `round ${i}: feed`);
    assert.equal(detail.finished, false);
    await revealRound(f.deps, DUEL_OWNER, round.id);
  }

  const detail = await getLeagueDetail(f.deps, DUEL_OWNER, f.leagueId);
  assert.equal(detail.finished, true);
  assert.equal(detail.totalRounds, 3);
  assert.deepEqual([detail.standings[0]?.user.id, detail.standings[0]?.wins, detail.standings[0]?.losses], [star, 3, 0]);
  for (const s of detail.standings) assert.equal(s.wins + s.losses + s.draws, 3, `${s.user.id} played every round`);
  assert.ok((await listMyLeagues(f.deps, "u-sarah")).find((s) => s.league.id === f.leagueId)!.finished);
  assert.deepEqual(await listBrowseLeagues(f.deps, "u-stranger"), [], "played out: off the browse list");
  await assert.rejects(createRound(f.deps, DUEL_OWNER, f.leagueId, { theme: "Extra" }), isStatus(400));

  // Run it back: same players, a fresh 0–0–0, un-frozen until its own round 1.
  const clone = await rematchLeague(f.deps, DUEL_OWNER, f.leagueId);
  const stored = (await f.repo.getLeague(clone.id))!;
  assert.equal(stored.format, "headToHead");
  assert.equal(stored.h2hParticipants, undefined);
  assert.deepEqual([...stored.memberIds].sort(), [...DUELISTS].sort());
  const fresh = await getLeagueDetail(f.deps, DUEL_OWNER, clone.id);
  assert.ok(fresh.standings.every((s) => s.wins === 0 && s.losses === 0 && s.draws === 0));
  await joinLeague(f.deps, "u-jpop", clone.inviteCode); // the lobby is open again
  await assert.rejects(joinLeague(f.deps, "u-luna", f.inviteCode), seasonLockedError, "the original stays locked");
});

// ---- one live rematch per finished league (BUG-13) ----

/** A finished standard league "Szn 1": owner u-owner, three players, its one
 *  round revealed, invite code and standings wired as createLeague would. */
async function finishedDeps(repo: MemoryRepository = new MemoryRepository(false)): Promise<Deps> {
  const lg = league({ id: "s1", name: "Szn 1", visibility: "private", roundCount: 1, memberIds: ["u-owner", "u-2", "u-3"] });
  await repo.createLeague(lg);
  await repo.createRound({ id: "s1~1", leagueId: "s1", index: 1, theme: "One", status: "revealed" });
  await repo.putInvite(lg.inviteCode, lg.id);
  for (const id of lg.memberIds) await repo.addStandingPoints(lg.id, id, 0);
  return { repo, users: new MemoryUserDirectory() };
}

/** A MemoryRepository that records every league created through it, so a test
 *  can check that a rematch it threw away left nothing behind. */
class CreateSpyRepository extends MemoryRepository {
  created: League[] = [];
  override async createLeague(...args: Parameters<MemoryRepository["createLeague"]>): Promise<void> {
    this.created.push(structuredClone(args[0]));
    return super.createLeague(...args);
  }
}

/** Assert a league id left no trace: no META, no invite, no standing row. */
async function assertGone(deps: Deps, lg: League): Promise<void> {
  assert.equal(await deps.repo.getLeague(lg.id), undefined, `${lg.id} is gone`);
  assert.equal(await deps.repo.getLeagueIdForInvite(lg.inviteCode), undefined, `${lg.id}'s invite is gone`);
  assert.deepEqual(await deps.repo.getStandings(lg.id), [], `${lg.id} has no standing rows`);
}

test("BUG-13: rematching twice in a row creates one league — the second call returns it (idempotent)", async () => {
  const deps = await finishedDeps();
  const first = await rematchLeague(deps, "u-owner", "s1");
  const second = await rematchLeague(deps, "u-owner", "s1");
  assert.equal(second.id, first.id);
  assert.deepEqual([second.name, second.inviteCode, second.memberIds], [first.name, first.inviteCode, first.memberIds]);
  assert.deepEqual((await deps.repo.getAllLeagues()).map((lg) => lg.id).sort(), [first.id, "s1"].sort());
  // Every member's dashboard lists the old league and ONE rematch.
  for (const member of ["u-owner", "u-2", "u-3"]) {
    assert.deepEqual((await listMyLeagues(deps, member)).map((s) => s.league.name).sort(), ["Szn 1", "Szn 2"], member);
  }
  // The old league records its rematch; the rematch itself has none yet.
  assert.equal((await deps.repo.getLeague("s1"))!.rematchLeagueId, first.id);
  assert.equal((await deps.repo.getLeague(first.id))!.rematchLeagueId, undefined);
  assert.equal("rematchLeagueId" in first, false);
});

test("BUG-13: concurrent rematch calls create exactly one league and leave no orphan behind", async () => {
  const repo = new CreateSpyRepository(false);
  const deps = await finishedDeps(repo);
  repo.created = [];
  const results = await Promise.all([1, 2, 3].map(() => rematchLeague(deps, "u-owner", "s1")));
  const winner = results[0]!;
  assert.deepEqual(results.map((r) => r.id), [winner.id, winner.id, winner.id]);
  assert.deepEqual((await repo.getAllLeagues()).map((lg) => lg.id).sort(), [winner.id, "s1"].sort());
  assert.equal((await repo.getLeague("s1"))!.rematchLeagueId, winner.id);
  // Every league a losing call wrote (it creates before it claims) was removed.
  const losers = repo.created.filter((lg) => lg.id !== winner.id);
  assert.equal(losers.length, 2, "the race really happened: three leagues were written");
  for (const lg of losers) await assertGone(deps, lg);
  // The winner is whole: its invite and one 0-point standing row per player.
  assert.equal(await repo.getLeagueIdForInvite(winner.inviteCode), winner.id);
  assert.deepEqual((await repo.getStandings(winner.id)).map((s) => [s.userId, s.points]), [["u-owner", 0], ["u-2", 0], ["u-3", 0]]);
  assert.equal((await listMyLeagues(deps, "u-2")).length, 2);
});

test("BUG-13: once the rematch league is deleted, the old league stops pointing at it and a fresh rematch replaces the pointer", async () => {
  const deps = await finishedDeps();
  const first = await rematchLeague(deps, "u-owner", "s1");
  assert.equal((await getLeagueDetail(deps, "u-owner", "s1")).league.rematchLeagueId, first.id);
  await deleteLeague(deps, "u-owner", first.id);

  // The stored pointer dangles; the detail view drops it (the UI offers "Run it back" again).
  assert.equal((await deps.repo.getLeague("s1"))!.rematchLeagueId, first.id);
  const detail = await getLeagueDetail(deps, "u-owner", "s1");
  assert.equal("rematchLeagueId" in detail.league, false);

  const second = await rematchLeague(deps, "u-owner", "s1");
  assert.notEqual(second.id, first.id);
  assert.equal((await deps.repo.getLeague("s1"))!.rematchLeagueId, second.id);
  assert.equal((await getLeagueDetail(deps, "u-owner", "s1")).league.rematchLeagueId, second.id);
  assert.equal((await rematchLeague(deps, "u-owner", "s1")).id, second.id, "idempotent again");
  assert.deepEqual((await deps.repo.getAllLeagues()).map((lg) => lg.id).sort(), [second.id, "s1"].sort());
});

test("BUG-13: concurrent rematches after the rematch was deleted still make exactly one replacement", async () => {
  const repo = new CreateSpyRepository(false);
  const deps = await finishedDeps(repo);
  const first = await rematchLeague(deps, "u-owner", "s1");
  await deleteLeague(deps, "u-owner", first.id);
  repo.created = [];

  const results = await Promise.all([1, 2].map(() => rematchLeague(deps, "u-owner", "s1")));
  const winner = results[0]!;
  assert.equal(results[1]!.id, winner.id);
  assert.equal((await repo.getLeague("s1"))!.rematchLeagueId, winner.id);
  assert.deepEqual((await repo.getAllLeagues()).map((lg) => lg.id).sort(), [winner.id, "s1"].sort());
  for (const lg of repo.created.filter((c) => c.id !== winner.id)) await assertGone(deps, lg);
});

test("BUG-13: league detail names the rematch to its members only; a league with no rematch carries no pointer", async () => {
  const deps = await finishedDeps();
  for (const caller of ["u-owner", "u-2", "u-stranger"]) {
    assert.equal("rematchLeagueId" in (await getLeagueDetail(deps, caller, "s1")).league, false, caller);
  }
  const next = await rematchLeague(deps, "u-owner", "s1");
  for (const member of ["u-owner", "u-2", "u-3"]) {
    assert.equal((await getLeagueDetail(deps, member, "s1")).league.rematchLeagueId, next.id, member);
  }
  // A player who left the rematch, and a spectator, get no link to it.
  await leaveLeague(deps, "u-3", next.id, "u-3");
  assert.equal("rematchLeagueId" in (await getLeagueDetail(deps, "u-3", "s1")).league, false);
  assert.equal("rematchLeagueId" in (await getLeagueDetail(deps, "u-stranger", "s1")).league, false);
  // Someone who joined only the rematch does see where it went.
  await joinLeague(deps, "u-new", next.inviteCode);
  assert.equal((await getLeagueDetail(deps, "u-new", "s1")).league.rematchLeagueId, next.id);
});

/** A MemoryRepository whose eventually consistent league reads come from a
 *  replica that hasn't caught up: while `replica` holds a league id, a
 *  getLeague without `consistent` returns that copy (undefined = "not
 *  replicated yet"). Strongly consistent reads always see the latest write,
 *  as DynamoDB's do. */
class LaggingReplicaRepository extends MemoryRepository {
  replica = new Map<string, League | undefined>();
  override async getLeague(...args: Parameters<MemoryRepository["getLeague"]>): Promise<League | undefined> {
    const [id, opts] = args;
    if (!opts?.consistent && this.replica.has(id)) return structuredClone(this.replica.get(id));
    return super.getLeague(...args);
  }
}

test("BUG-13: a stale read that misses the pointer still ends on the existing rematch (the claim refuses, the new league is discarded)", async () => {
  const repo = new LaggingReplicaRepository(false);
  const deps = await finishedDeps(repo);
  repo.replica.set("s1", await repo.getLeague("s1", { consistent: true })); // the replica: no pointer, ever
  const first = await rematchLeague(deps, "u-owner", "s1");
  const second = await rematchLeague(deps, "u-owner", "s1");
  assert.equal(second.id, first.id);
  assert.deepEqual((await repo.getAllLeagues()).map((lg) => lg.id).sort(), [first.id, "s1"].sort());
});

test("BUG-13: a rematch league not yet replicated is never mistaken for a deleted one (its existence is read strongly consistent)", async () => {
  const repo = new LaggingReplicaRepository(false);
  const deps = await finishedDeps(repo);
  const first = await rematchLeague(deps, "u-owner", "s1");
  repo.replica.set(first.id, undefined); // an eventually consistent read would say it doesn't exist
  const again = await rematchLeague(deps, "u-owner", "s1");
  assert.equal(again.id, first.id, "not overwritten as if stale");
  assert.equal((await repo.getLeague("s1", { consistent: true }))!.rematchLeagueId, first.id);
  assert.deepEqual((await repo.getAllLeagues()).map((lg) => lg.id).sort(), [first.id, "s1"].sort());
});

test("BUG-13: a stale read that misses a pointer to a DELETED rematch retries over that pointer and replaces it", async () => {
  const repo = new LaggingReplicaRepository(false);
  const deps = await finishedDeps(repo);
  repo.replica.set("s1", await repo.getLeague("s1", { consistent: true })); // no pointer
  const first = await rematchLeague(deps, "u-owner", "s1");
  await deleteLeague(deps, "u-owner", first.id);
  const second = await rematchLeague(deps, "u-owner", "s1");
  assert.notEqual(second.id, first.id);
  assert.equal((await repo.getLeague("s1", { consistent: true }))!.rematchLeagueId, second.id);
  assert.deepEqual((await repo.getAllLeagues()).map((lg) => lg.id).sort(), [second.id, "s1"].sort());
});

test("BUG-13: a claim that errors discards the league it created and propagates the error", async () => {
  class FailingClaimRepository extends CreateSpyRepository {
    override async setRematchPointer(): Promise<boolean> {
      throw Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" });
    }
  }
  const repo = new FailingClaimRepository(false);
  const deps = await finishedDeps(repo);
  repo.created = [];
  await assert.rejects(rematchLeague(deps, "u-owner", "s1"), /throttled/);
  assert.equal(repo.created.length, 1);
  await assertGone(deps, repo.created[0]!);
  assert.deepEqual((await repo.getAllLeagues()).map((lg) => lg.id), ["s1"]);
});

test("BUG-13: a claim that landed but reported a failed condition (an SDK retry of it) keeps the new league", async () => {
  class RetriedClaimRepository extends MemoryRepository {
    override async setRematchPointer(...args: Parameters<MemoryRepository["setRematchPointer"]>): Promise<boolean> {
      await super.setRematchPointer(...args); // the first attempt lands…
      return super.setRematchPointer(...args); // …and the retry fails its write-once condition
    }
  }
  const repo = new RetriedClaimRepository(false);
  const deps = await finishedDeps(repo);
  const next = await rematchLeague(deps, "u-owner", "s1");
  assert.equal((await repo.getLeague("s1"))!.rematchLeagueId, next.id);
  assert.ok(await repo.getLeague(next.id), "not discarded");
  assert.equal(await repo.getLeagueIdForInvite(next.inviteCode), next.id);
  assert.equal((await repo.getStandings(next.id)).length, 3);
});

test("BUG-13: a claim that keeps losing to pointers at deleted leagues gives up after a few tries with a 409, leaving nothing behind", async () => {
  // Every claim is refused and the re-read always shows yet another pointer
  // at a league that's gone (rematches being made and deleted in between).
  class ChurningRepository extends CreateSpyRepository {
    tries = 0;
    override async setRematchPointer(): Promise<boolean> {
      this.tries++;
      return false;
    }
    override async getLeague(...args: Parameters<MemoryRepository["getLeague"]>): Promise<League | undefined> {
      const lg = await super.getLeague(...args);
      return lg?.id === "s1" ? { ...lg, rematchLeagueId: `lg-deleted-${this.tries}` } : lg;
    }
  }
  const repo = new ChurningRepository(false);
  const deps = await finishedDeps(repo);
  repo.created = [];
  await assert.rejects(rematchLeague(deps, "u-owner", "s1"), isStatus(409));
  assert.equal(repo.tries, 3);
  assert.equal(repo.created.length, 1);
  await assertGone(deps, repo.created[0]!);
});

test("BUG-13: H2H — concurrent rematches make one un-frozen clone, and asking again once it has frozen returns it without its season secrets", async () => {
  const deps = await h2hDeps({ memberIds: ["u-owner", "u-2", "u-3"] }, 5);
  await openRound1(deps);
  for (let index = 2; index <= 3; index++) await createRound(deps, "u-owner", "h2h", { theme: `R${index}` });
  for (const r of await deps.repo.getRoundsForLeague("h2h")) await deps.repo.updateRound({ ...r, status: "revealed" });

  const [a, b] = await Promise.all([rematchLeague(deps, "u-owner", "h2h"), rematchLeague(deps, "u-owner", "h2h")]);
  assert.equal(b!.id, a!.id);
  const clones = (await deps.repo.getAllLeagues()).filter((lg) => lg.id !== "h2h");
  assert.deepEqual(clones.map((lg) => lg.id), [a!.id]);
  const stored = clones[0]!;
  assert.equal(stored.format, "headToHead");
  assert.equal(stored.h2hParticipants, undefined);
  assert.equal(stored.h2hSalt, undefined);

  // The clone opens its own round 1 and freezes; the old league's rematch
  // button (a stale page) still lands on it — with no frozen order or salt.
  await createRound(deps, "u-owner", a!.id, { theme: "Rematch R1" });
  await updateRound(deps, "u-owner", a!.id, `${a!.id}~0001`, { status: "submitting" });
  const frozen = (await deps.repo.getLeague(a!.id))!;
  assert.ok(frozen.h2hParticipants?.length && frozen.h2hSalt);
  const again = await rematchLeague(deps, "u-owner", "h2h");
  assert.equal(again.id, a!.id);
  const json = JSON.stringify(again);
  assert.equal(json.includes("h2hParticipants"), false);
  assert.equal(json.includes("h2hSalt"), false);
  assert.equal(json.includes(frozen.h2hSalt!), false);
});

/** A CreateSpyRepository whose next strongly consistent league read matching
 *  `failOn` throws — but only once a claim has been refused, i.e. inside the
 *  losing request's follow-up reads (the old league's re-read, then the
 *  winner's existence check). */
class FailAfterLostClaimRepository extends CreateSpyRepository {
  armed = false;
  failOn: (id: string) => boolean;
  constructor(failOn: (id: string) => boolean) {
    super(false);
    this.failOn = failOn;
  }
  override async setRematchPointer(...args: Parameters<MemoryRepository["setRematchPointer"]>): Promise<boolean> {
    const claimed = await super.setRematchPointer(...args);
    if (!claimed) this.armed = true;
    return claimed;
  }
  override async getLeague(...args: Parameters<MemoryRepository["getLeague"]>): Promise<League | undefined> {
    const [id, opts] = args;
    if (this.armed && opts?.consistent && this.failOn(id)) {
      this.armed = false;
      throw Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" });
    }
    return super.getLeague(...args);
  }
}

for (const [step, failOn] of [
  ["the old league's consistent re-read", (id: string) => id === "s1"],
  ["the winner's existence check", (id: string) => id !== "s1"],
] as const) {
  test(`BUG-13: a lost claim whose follow-up read fails (${step}) still discards its league — no duplicate is left behind`, async () => {
    const repo = new FailAfterLostClaimRepository(failOn);
    const deps = await finishedDeps(repo);
    repo.created = [];
    const results = await Promise.allSettled([1, 2].map(() => rematchLeague(deps, "u-owner", "s1")));
    const won = results.filter((r): r is PromiseFulfilledResult<League> => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    assert.equal(won.length, 1);
    assert.equal(lost.length, 1);
    assert.match(String(lost[0]!.reason), /throttled/);
    const winner = won[0]!.value;
    assert.equal(repo.created.length, 2, "the race really happened");
    for (const lg of repo.created.filter((c) => c.id !== winner.id)) await assertGone(deps, lg);
    assert.deepEqual((await repo.getAllLeagues()).map((lg) => lg.id).sort(), [winner.id, "s1"].sort());
    assert.deepEqual((await listMyLeagues(deps, "u-2")).map((s) => s.league.name).sort(), ["Szn 1", "Szn 2"]);
  });
}

test("BUG-13: a losing request whose clean-up fails still answers with the winner (and logs the orphan's id)", async (t) => {
  class FailingDiscardRepository extends CreateSpyRepository {
    override async deleteLeague(): Promise<void> {
      throw Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" });
    }
  }
  const logged = t.mock.method(console, "error", () => undefined);
  const repo = new FailingDiscardRepository(false);
  const deps = await finishedDeps(repo);
  repo.created = [];
  const results = await Promise.all([1, 2].map(() => rematchLeague(deps, "u-owner", "s1")));
  const winner = results[0]!;
  assert.equal(results[1]!.id, winner.id);
  assert.equal((await repo.getLeague("s1"))!.rematchLeagueId, winner.id);
  const orphan = repo.created.find((c) => c.id !== winner.id)!;
  assert.ok(orphan, "the race really happened");
  assert.equal(logged.mock.callCount(), 1);
  assert.match(String(logged.mock.calls[0]!.arguments[0]), new RegExp(orphan.id));
});

for (const step of ["addStandingPoints", "putInvite"] as const) {
  test(`BUG-13: a rematch whose request died after its claim (${step} failed) is finished by the owner's retry`, async () => {
    class FlakyWriteRepository extends MemoryRepository {
      fail = true;
      writes = 0;
      override async addStandingPoints(...args: Parameters<MemoryRepository["addStandingPoints"]>): Promise<void> {
        if (args[0] !== "s1") this.writes++;
        if (step === "addStandingPoints" && args[0] !== "s1" && args[1] === "u-2" && this.fail) {
          this.fail = false; // dies part-way: u-owner is seeded, u-2 and u-3 aren't
          throw new Error("InternalServerError");
        }
        return super.addStandingPoints(...args);
      }
      override async putInvite(...args: Parameters<MemoryRepository["putInvite"]>): Promise<void> {
        if (args[1] !== "s1") this.writes++;
        if (step === "putInvite" && args[1] !== "s1" && this.fail) {
          this.fail = false;
          throw new Error("InternalServerError");
        }
        return super.putInvite(...args);
      }
    }
    const repo = new FlakyWriteRepository(false);
    const deps = await finishedDeps(repo);
    await assert.rejects(rematchLeague(deps, "u-owner", "s1"), /InternalServerError/);
    const pointer = (await repo.getLeague("s1"))!.rematchLeagueId!;
    assert.ok(pointer, "the claim had landed");
    assert.equal(await repo.getLeagueIdForInvite((await repo.getLeague(pointer))!.inviteCode), undefined, "half-built");

    const retry = await rematchLeague(deps, "u-owner", "s1");
    assert.equal(retry.id, pointer, "the same league, not a new one");
    assert.equal(await repo.getLeagueIdForInvite(retry.inviteCode), retry.id);
    assert.deepEqual((await repo.getStandings(retry.id)).map((s) => [s.userId, s.points]), [["u-owner", 0], ["u-2", 0], ["u-3", 0]]);
    await joinLeague(deps, "u-new", retry.inviteCode); // its code works
    assert.deepEqual((await repo.getAllLeagues()).map((lg) => lg.id).sort(), [retry.id, "s1"].sort());

    // Once whole, asking again only reads: no write repeats.
    repo.writes = 0;
    assert.equal((await rematchLeague(deps, "u-owner", "s1")).id, retry.id);
    assert.equal(repo.writes, 0);
  });
}

test("BUG-13: the detail's rematch link checks the rematch strongly consistent — a lagging replica neither hides a new rematch nor keeps a deleted one", async () => {
  const repo = new LaggingReplicaRepository(false);
  const deps = await finishedDeps(repo);
  const first = await rematchLeague(deps, "u-owner", "s1");
  const copy = await repo.getLeague(first.id, { consistent: true });
  repo.replica.set(first.id, undefined); // not replicated yet
  assert.equal((await getLeagueDetail(deps, "u-owner", "s1")).league.rematchLeagueId, first.id, "linked straight away");
  repo.replica.delete(first.id); // caught up
  await deleteLeague(deps, "u-owner", first.id);
  repo.replica.set(first.id, copy); // …but hasn't seen the delete yet
  assert.equal("rematchLeagueId" in (await getLeagueDetail(deps, "u-owner", "s1")).league, false, "no link to a deleted league");
});

// ---- join by code when already a member (IMP-03) ----
// The invite path's "already a member" 409 carries a machine-readable marker
// plus the league id, so a client re-opening an invite link for a league the
// caller is already in can go straight to that league instead of showing a
// dead-end error. Its message stays word-for-word (older clients show it);
// every other join refusal stays a plain `{ error }`.

/** The rejection of `attempt`, for asserting on its fields. */
async function rejectionOf(attempt: Promise<unknown>): Promise<ApiError> {
  const err = await attempt.then(
    () => assert.fail("expected the call to be refused"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof ApiError, `expected an ApiError, got ${String(err)}`);
  return err;
}

test("join by code: an existing member's 409 carries code 'already-member' and the league id (owner too, any code case)", async () => {
  const deps = await depsWith([league({ id: "lg", name: "Synth Club", visibility: "private", memberIds: ["u-owner", "u-me"] })]);
  await deps.repo.putInvite("C-LG", "lg");

  for (const [caller, code] of [["u-me", "C-LG"], ["u-owner", " c-lg "]] as const) {
    const err = await rejectionOf(joinLeague(deps, caller, code));
    assert.equal(err.statusCode, 409, caller);
    assert.equal(err.message, "You're already a member of Synth Club.", `${caller}: message text unchanged`);
    assert.deepEqual(err.details, { code: "already-member", leagueId: "lg" }, caller);
  }
  // Through the real route table (what both HTTP adapters run) as well.
  const viaRoute = await rejectionOf(callRoute(deps, "POST", "/leagues/join", "u-me", { code: "c-lg" }));
  assert.deepEqual(viaRoute.details, { code: "already-member", leagueId: "lg" });
  // …and the JSON body the adapters send: the old `error` plus the marker.
  assert.deepEqual(errorBody(viaRoute), { error: "You're already a member of Synth Club.", code: "already-member", leagueId: "lg" });
  assert.deepEqual((await deps.repo.getLeague("lg"))?.memberIds, ["u-owner", "u-me"], "nothing written");
});

test("join by code: a frozen H2H league's member still gets the already-member marker, not 'season locked'", async () => {
  const deps = await h2hDeps();
  await openRound1(deps);
  const err = await rejectionOf(joinLeague(deps, "u-2", "duel-1"));
  assert.equal(err.statusCode, 409);
  assert.match(err.message, /already a member/);
  assert.deepEqual(err.details, { code: "already-member", leagueId: "h2h" });
});

test("join and claim refusals other than already-member carry no marker: bad code, empty code, season locked, full, too late", async () => {
  // Bad + empty code (invite path).
  const deps = await depsWith([league({ id: "lg", name: "L", visibility: "private" })]);
  const bad = await rejectionOf(joinLeague(deps, "u-me", "NOPE-0"));
  assert.deepEqual([bad.statusCode, bad.message, bad.details], [404, "That code doesn't match any league.", undefined]);
  const empty = await rejectionOf(joinLeague(deps, "u-me", "   "));
  assert.deepEqual([empty.statusCode, empty.message, empty.details], [400, "Enter an invite code to join.", undefined]);
  assert.deepEqual(errorBody(bad), { error: "That code doesn't match any league." }, "body stays exactly { error }");

  // Season locked (invite path and claim path).
  const h2h = await h2hDeps({ visibility: "public", maxMembers: 10 });
  await openRound1(h2h);
  for (const attempt of [joinLeague(h2h, "u-late", "DUEL-1"), claimPublicSpot(h2h, "u-late", "h2h")]) {
    const locked = await rejectionOf(attempt);
    assert.deepEqual([locked.statusCode, locked.message, locked.details], [409, SEASON_LOCKED_MESSAGE, undefined]);
    assert.deepEqual(errorBody(locked), { error: SEASON_LOCKED_MESSAGE });
  }

  // Full and too late (the claim path; the invite path bypasses both).
  const pub = await depsWith(
    [
      league({ id: "full", name: "Full", visibility: "public", memberIds: ["u-owner", "u-2"], maxMembers: 2 }),
      league({ id: "late", name: "Late", visibility: "public" }),
    ],
    [{ id: "late~1", leagueId: "late", index: 1, theme: "Go", status: "voting" }],
  );
  const full = await rejectionOf(claimPublicSpot(pub, "u-me", "full"));
  assert.deepEqual([full.statusCode, full.message, full.details], [409, "This league is full.", undefined]);
  const late = await rejectionOf(claimPublicSpot(pub, "u-me", "late"));
  assert.equal(late.statusCode, 409);
  assert.match(late.message, /too late to join/);
  assert.equal(late.details, undefined);
});
