// Timed auto-advance tests — a round whose phase deadlines are in the past
// advances (cascading), and a manual league never does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository, MemoryUserDirectory } from "../data/memory.ts";
import { DEFAULT_LEAGUE_SETTINGS } from "../domain/types.ts";
import type { League, Round } from "../domain/types.ts";
import type { Deps } from "./leagues.ts";
import { autoAdvanceRound } from "./progression.ts";

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

function timedLeague(over: Partial<League> = {}): League {
  return {
    id: "lg", name: "Timed", ownerId: "u-owner", musicProvider: "spotify",
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
