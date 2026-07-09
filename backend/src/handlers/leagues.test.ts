// Discovery service tests — listOpenPublicLeagues filtering + ranking.
// Pure logic over MemoryRepository (no AWS).

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository, MemoryUserDirectory } from "../data/memory.ts";
import type { Deps } from "./leagues.ts";
import { claimPublicSpot, getLeagueDetail, getPublicLeaguePreview, leaveLeague, listOpenPublicLeagues } from "./leagues.ts";
import { ApiError } from "../domain/errors.ts";
import { DEFAULT_LEAGUE_SETTINGS } from "../domain/types.ts";
import type { League, Round } from "../domain/types.ts";

function league(over: Partial<League> & Pick<League, "id" | "name" | "visibility">): League {
  return {
    ownerId: "u-owner",
    musicProvider: "spotify",
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
  assert.equal(results.length, 1);
});
