// Discovery service tests — listOpenPublicLeagues filtering + ranking.
// Pure logic over MemoryRepository (no AWS).

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository, MemoryUserDirectory } from "../data/memory.ts";
import type { Deps } from "./leagues.ts";
import { claimPublicSpot, getPublicLeaguePreview, leaveLeague, listOpenPublicLeagues } from "./leagues.ts";
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

test("excludes private, full, started, and already-joined leagues", async () => {
  const deps = await depsWith(
    [
      league({ id: "priv", name: "Priv", visibility: "private" }),
      league({ id: "full", name: "Full", visibility: "public", memberIds: ["u-owner", "u-2"], maxMembers: 2 }),
      league({ id: "started", name: "Started", visibility: "public", maxMembers: 8 }),
      league({ id: "mine", name: "Mine", visibility: "public", memberIds: ["u-owner", "u-me"], maxMembers: 8 }),
      league({ id: "ok", name: "Ok", visibility: "public", maxMembers: 8 }),
    ],
    [{ id: "started~1", leagueId: "started", index: 1, theme: "Go", status: "submitting" }],
  );
  const out = await listOpenPublicLeagues(deps, "u-me");
  assert.deepEqual(out.map((l) => l.id), ["ok"]);
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

test("claim rejects full / started / already-member / private-or-missing", async () => {
  const deps = await depsWith(
    [
      league({ id: "full", name: "Full", visibility: "public", memberIds: ["u-owner", "u-2"], maxMembers: 2 }),
      league({ id: "started", name: "Started", visibility: "public", memberIds: ["u-owner"], maxMembers: 4 }),
      league({ id: "mine", name: "Mine", visibility: "public", memberIds: ["u-owner", "u-me"], maxMembers: 4 }),
      league({ id: "priv", name: "Priv", visibility: "private", maxMembers: 4 }),
    ],
    [{ id: "started~1", leagueId: "started", index: 1, theme: "Go", status: "submitting" }],
  );
  const is = (code: number) => (e: unknown) => e instanceof ApiError && e.statusCode === code;
  await assert.rejects(claimPublicSpot(deps, "u-me", "full"), is(409));
  await assert.rejects(claimPublicSpot(deps, "u-me", "started"), is(409));
  await assert.rejects(claimPublicSpot(deps, "u-me", "mine"), is(409));
  await assert.rejects(claimPublicSpot(deps, "u-me", "priv"), is(404));
  await assert.rejects(claimPublicSpot(deps, "u-me", "nope"), is(404));
});
