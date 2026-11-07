// Discovery service tests — listOpenPublicLeagues filtering + ranking.
// Pure logic over MemoryRepository (no AWS).

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository, MemoryUserDirectory } from "../data/memory.ts";
import type { Deps } from "./leagues.ts";
import { claimPublicSpot, createLeague, getLeagueDetail, getPublicLeaguePreview, joinLeague, leaveLeague, listBrowseLeagues, listMyLeagues, listOpenPublicLeagues, rematchLeague, toLeagueView, updateLeagueSettings } from "./leagues.ts";
import { createRound, updateRound } from "./rounds.ts";
import { ApiError } from "../domain/errors.ts";
import { SEASON_LOCKED_MESSAGE } from "../domain/freeze.ts";
import type { RandomInt } from "../domain/freeze.ts";
import { DEFAULT_LEAGUE_SETTINGS, H2H_FORCED_SETTINGS, applyFormatSettings, leagueFormat } from "../domain/types.ts";
import type { League, Round } from "../domain/types.ts";
import { buildRoutes, matchRoute } from "../http/routes.ts";

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
