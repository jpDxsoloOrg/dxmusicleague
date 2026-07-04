// Discovery service tests — listOpenPublicLeagues filtering + ranking.
// Pure logic over MemoryRepository (no AWS).

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository, MemoryUserDirectory } from "../data/memory.ts";
import type { Deps } from "./leagues.ts";
import { listOpenPublicLeagues } from "./leagues.ts";
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
