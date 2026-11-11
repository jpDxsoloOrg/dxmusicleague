// Round lifecycle tests — the head-to-head season freeze (HTH-03) at round-1
// open: the shuffle into `h2hParticipants`, the schedule salt, the roundCount
// override + the existing cap, freeze-once, the minimum-player guard, the
// join-vs-open race (no member is ever left outside the frozen order), and
// the proof that standard leagues are untouched. Pure logic over MemoryRepository
// (no AWS); the freeze's RNG is injected through deps, seeded. BUG-04 (last):
// a standard owner PATCH read before the round's reveal can't write over it,
// and one that loses to the league's deletion answers 404, not 409.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository, MemoryUserDirectory } from "../data/memory.ts";
import type { Deps } from "./leagues.ts";
import { getLeagueDetail, joinLeague, leaveLeague } from "./leagues.ts";
import { createRound, updateRound } from "./rounds.ts";
import { autoAdvanceRound } from "./progression.ts";
import { ApiError } from "../domain/errors.ts";
import {
  H2H_MIN_PLAYERS_MESSAGE,
  H2H_ROUND_ONE_FIRST_MESSAGE,
  SEASON_LOCKED_MESSAGE,
  membersOutsideOrder,
  planSeasonFreeze,
} from "../domain/freeze.ts";
import type { RandomInt, SeasonFreeze } from "../domain/freeze.ts";
import { DEFAULT_LEAGUE_SETTINGS, H2H_FORCED_SETTINGS } from "../domain/types.ts";
import type { League, Round } from "../domain/types.ts";
import { buildRoutes, matchRoute } from "../http/routes.ts";

const OWNER = "u-owner";
const FIVE = [OWNER, "u-2", "u-3", "u-4", "u-5"];
const SEED = 20261107;

/** Seeded RandomInt (mulberry32) that also counts how often it's drawn from. */
function seeded(seed: number): RandomInt & { calls: number } {
  let a = seed >>> 0;
  const rng = ((max: number) => {
    rng.calls++;
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max);
  }) as RandomInt & { calls: number };
  rng.calls = 0;
  return rng;
}

function h2hLeague(over: Partial<League> = {}): League {
  return {
    id: "h2h", name: "Duel League", ownerId: OWNER, musicProvider: "mock", format: "headToHead",
    settings: { ...DEFAULT_LEAGUE_SETTINGS, ...H2H_FORCED_SETTINGS }, memberIds: [...FIVE],
    inviteCode: "DUEL-1", visibility: "private", roundCount: 3, progression: "manual", ...over,
  };
}

function standardLeague(over: Partial<League> = {}): League {
  return { ...h2hLeague(), id: "std", name: "Points League", format: "standard", settings: DEFAULT_LEAGUE_SETTINGS, inviteCode: "STD-1", roundCount: 8, ...over };
}

const draft = (leagueId: string, index: number, over: Partial<Round> = {}): Round => ({
  id: `${leagueId}~${String(index).padStart(4, "0")}`, leagueId, index, theme: `Round ${index}`, status: "draft", ...over,
});

/** A memory repo (no seed) holding `leagues` + `rounds`, with invites wired,
 *  and a seeded freeze RNG. Also counts the repo's freeze writes. */
async function setup(leagues: League[], rounds: Round[] = [], rng = seeded(SEED)) {
  const repo = new MemoryRepository(false);
  for (const lg of leagues) {
    await repo.createLeague(lg);
    await repo.putInvite(lg.inviteCode, lg.id);
    for (const id of lg.memberIds) await repo.addStandingPoints(lg.id, id, 0);
  }
  for (const r of rounds) await repo.createRound(r);
  const freezes: boolean[] = [];
  const freeze = repo.freezeH2HSeason.bind(repo);
  repo.freezeH2HSeason = async (leagueId, plan, replacesSalt) => {
    const won = await freeze(leagueId, plan, replacesSalt);
    freezes.push(won);
    return won;
  };
  const deps: Deps = { repo, users: new MemoryUserDirectory(), randomInt: rng };
  return { deps, repo, rng, freezes };
}

const open = (deps: Deps, leagueId: string, index: number) =>
  updateRound(deps, OWNER, leagueId, `${leagueId}~${String(index).padStart(4, "0")}`, { status: "submitting" });

const isStatus = (code: number, message?: RegExp | string) => (e: unknown) =>
  e instanceof ApiError &&
  e.statusCode === code &&
  (message === undefined || (typeof message === "string" ? e.message === message : message.test(e.message)));

const sorted = (xs: readonly string[] | undefined) => [...(xs ?? [])].sort();

/** Drive a request through the real route table (the Lambda + local server's). */
async function callRoute(deps: Deps, method: string, path: string, caller: string, body?: unknown): Promise<unknown> {
  const match = matchRoute(buildRoutes(deps), method, path);
  assert.ok(match, `no route for ${method} ${path}`);
  return match.route.handler({ caller, params: match.params, query: {}, body });
}

test("opening round 1 (5 members) freezes the season: all 5 shuffled in, roundCount 3 → 5, round 6 rejected by the cap", async () => {
  const { deps, repo, rng } = await setup([h2hLeague({ roundCount: 3 })], [draft("h2h", 1)]);

  // Through the real PATCH route, as the owner's "Open for submissions" does.
  const opened = (await callRoute(deps, "PATCH", "/leagues/h2h/rounds/h2h~0001", OWNER, { status: "submitting" })) as Round;
  assert.equal(opened.status, "submitting");
  assert.equal((await repo.getRound("h2h~0001"))?.status, "submitting");

  const stored = (await repo.getLeague("h2h"))!;
  assert.equal(stored.h2hParticipants?.length, 5);
  assert.deepEqual(sorted(stored.h2hParticipants), sorted(FIVE)); // everyone, once each
  assert.equal(stored.roundCount, 5); // scheduleLength(5), overriding the owner's 3
  assert.match(stored.h2hSalt ?? "", /^[0-9a-f]{32}$/);
  // The shuffle + salt come from the injected RNG and nothing else: replaying
  // the same seed over the same members reproduces the stored freeze exactly.
  assert.ok(rng.calls > 0);
  const replay = planSeasonFreeze(FIVE, seeded(SEED));
  assert.deepEqual(stored.h2hParticipants, replay.participants);
  assert.equal(stored.h2hSalt, replay.salt);

  // League detail reports the new length (and never the frozen order/salt).
  const detail = await getLeagueDetail(deps, OWNER, "h2h");
  assert.equal(detail.league.roundCount, 5);
  assert.equal(detail.totalRounds, 5);
  assert.equal("h2hParticipants" in detail.league, false);
  assert.equal("h2hSalt" in detail.league, false);

  // Everyone faces everyone once: rounds 2–5 can be created, round 6 can't.
  for (let index = 2; index <= 5; index++) {
    assert.equal((await createRound(deps, OWNER, "h2h", { theme: `Round ${index}` })).index, index);
  }
  await assert.rejects(createRound(deps, OWNER, "h2h", { theme: "Round 6" }), isStatus(400, /set to 5 rounds/));
  await assert.rejects(
    callRoute(deps, "POST", "/leagues/h2h/rounds", OWNER, { theme: "Round 6" }),
    isStatus(400, /set to 5 rounds/),
  );
});

test("the frozen roundCount is the round-robin length: 4 players → 3 rounds, 2 players → 1", async () => {
  const four = await setup([h2hLeague({ memberIds: FIVE.slice(0, 4), roundCount: 10 })], [draft("h2h", 1)]);
  await open(four.deps, "h2h", 1);
  assert.equal((await four.repo.getLeague("h2h"))?.roundCount, 3);
  assert.equal((await four.repo.getLeague("h2h"))?.h2hParticipants?.length, 4);

  const two = await setup([h2hLeague({ memberIds: FIVE.slice(0, 2), roundCount: 10 })], [draft("h2h", 1)]);
  await open(two.deps, "h2h", 1);
  assert.equal((await two.repo.getLeague("h2h"))?.roundCount, 1);
  await assert.rejects(createRound(two.deps, OWNER, "h2h", { theme: "Two" }), isStatus(400, /set to 1 round /));
});

test("opening round 1 with fewer than 2 members → 400; nothing frozen, round stays draft", async () => {
  const { deps, repo, rng, freezes } = await setup([h2hLeague({ memberIds: [OWNER] })], [draft("h2h", 1)]);
  await assert.rejects(open(deps, "h2h", 1), isStatus(400, H2H_MIN_PLAYERS_MESSAGE));
  const stored = (await repo.getLeague("h2h"))!;
  assert.equal(stored.h2hParticipants, undefined);
  assert.equal(stored.h2hSalt, undefined);
  assert.equal(stored.roundCount, 3);
  assert.equal((await repo.getRound("h2h~0001"))?.status, "draft");
  assert.deepEqual(freezes, []);
  assert.equal(rng.calls, 0);

  // A second player joins (still un-frozen, so the invite works) → round 1 opens.
  await joinLeague(deps, "u-2", "DUEL-1");
  await open(deps, "h2h", 1);
  assert.deepEqual(sorted((await repo.getLeague("h2h"))?.h2hParticipants), sorted([OWNER, "u-2"]));
});

test("freeze is once: advancing round 1 and opening later rounds never re-shuffles", async () => {
  const { deps, repo, freezes } = await setup([h2hLeague()], [draft("h2h", 1)]);
  await open(deps, "h2h", 1);
  const frozen = (await repo.getLeague("h2h"))!;
  const snapshot = { order: [...frozen.h2hParticipants!], salt: frozen.h2hSalt, roundCount: frozen.roundCount };
  assert.deepEqual(freezes, [true]);

  // Swap in a different RNG: if anything re-shuffled, the order would change.
  const later = seeded(SEED + 1);
  deps.randomInt = later;
  const unchanged = async () => {
    const lg = (await repo.getLeague("h2h"))!;
    assert.deepEqual(lg.h2hParticipants, snapshot.order);
    assert.equal(lg.h2hSalt, snapshot.salt);
    assert.equal(lg.roundCount, snapshot.roundCount);
  };

  // Everyone submits, so the round has contests to vote on (HTH-08: opening
  // voting on a round nobody can vote in would reveal it on the spot).
  for (const id of FIVE) {
    await repo.putSubmission({ id: `s-${id}`, roundId: "h2h~0001", userId: id, track: { id: `t-${id}`, provider: "mock", providerTrackId: `t-${id}`, title: id, artists: [id] } });
  }
  await updateRound(deps, OWNER, "h2h", "h2h~0001", { status: "previewing" });
  await updateRound(deps, OWNER, "h2h", "h2h~0001", { status: "voting" });
  assert.equal((await repo.getRound("h2h~0001"))?.status, "voting");
  // "Re-open" no-ops: same status again, plus an edit while it's live.
  await updateRound(deps, OWNER, "h2h", "h2h~0001", { status: "voting", theme: "Renamed" });
  await unchanged();
  await repo.updateRound({ ...(await repo.getRound("h2h~0001"))!, status: "revealed" });

  // A member leaves mid-season: the frozen order (and the schedule) stand.
  await leaveLeague(deps, "u-3", "h2h", "u-3");
  for (let index = 2; index <= 3; index++) {
    await createRound(deps, OWNER, "h2h", { theme: `Round ${index}` });
    await open(deps, "h2h", index);
    await updateRound(deps, OWNER, "h2h", `h2h~000${index}`, { status: "previewing" });
    await unchanged();
  }
  assert.equal(later.calls, 0, "no randomness is drawn after the freeze");
  assert.deepEqual(freezes, [true], "the repo's freeze write ran exactly once");
});

test("a freeze already stored while round 1 is still draft is kept on (re-)opening it", async () => {
  // E.g. the freeze write landed but the round write after it failed: the
  // owner just clicks "Open" again, and the stored order must stand.
  const { deps, repo, rng, freezes } = await setup([h2hLeague()], [draft("h2h", 1)]);
  const earlier: SeasonFreeze = { participants: ["u-5", "u-3", OWNER, "u-2", "u-4"], salt: "ab".repeat(16), roundCount: 5 };
  assert.equal(await repo.freezeH2HSeason("h2h", earlier), true);
  await open(deps, "h2h", 1);
  const stored = (await repo.getLeague("h2h"))!;
  assert.deepEqual(stored.h2hParticipants, earlier.participants);
  assert.equal(stored.h2hSalt, earlier.salt);
  assert.equal((await repo.getRound("h2h~0001"))?.status, "submitting");
  assert.equal(rng.calls, 0);
  assert.deepEqual(freezes, [true]); // only the direct call above
});

test("a concurrent round-1 open that wins the race keeps its shuffle; the loser's is discarded", async () => {
  const { deps, repo, freezes } = await setup([h2hLeague()], [draft("h2h", 1)]);
  const winner: SeasonFreeze = { participants: ["u-4", "u-2", "u-5", OWNER, "u-3"], salt: "cd".repeat(16), roundCount: 5 };
  // Interleave deterministically: just before this request's conditional
  // write, another request's freeze lands first.
  const write = repo.freezeH2HSeason;
  let raced = false;
  repo.freezeH2HSeason = async (leagueId, plan, replacesSalt) => {
    if (!raced) {
      raced = true;
      await write(leagueId, winner);
    }
    return write(leagueId, plan, replacesSalt);
  };
  await open(deps, "h2h", 1);
  assert.deepEqual(freezes, [true, false]); // the racer won, ours was refused
  const stored = (await repo.getLeague("h2h"))!;
  assert.deepEqual(stored.h2hParticipants, winner.participants);
  assert.equal(stored.h2hSalt, winner.salt);
  assert.equal((await repo.getRound("h2h~0001"))?.status, "submitting");
});

test("a league deleted mid-open → 404 and no round is written for it", async () => {
  const { deps, repo } = await setup([h2hLeague()], [draft("h2h", 1)]);
  const write = repo.freezeH2HSeason;
  repo.freezeH2HSeason = async (leagueId, plan, replacesSalt) => {
    await repo.deleteLeague(leagueId);
    return write(leagueId, plan, replacesSalt);
  };
  await assert.rejects(open(deps, "h2h", 1), isStatus(404));
  assert.equal(await repo.getRound("h2h~0001"), undefined);
  assert.equal(await repo.getLeague("h2h"), undefined);
});

test("a newcomer whose join commits between the open's member snapshot and its freeze write is taken into the order", async () => {
  // 4 members when the owner's PATCH reads the league; u-late's invite join
  // (seeing an un-frozen lobby) commits just before the freeze write.
  const { deps, repo, freezes } = await setup([h2hLeague({ memberIds: FIVE.slice(0, 4) })], [draft("h2h", 1)]);
  const reads: Array<{ consistent?: boolean } | undefined> = [];
  const read = repo.getLeague.bind(repo);
  repo.getLeague = async (leagueId, opts) => {
    reads.push(opts);
    return read(leagueId, opts);
  };
  const write = repo.freezeH2HSeason;
  let initial: SeasonFreeze | undefined;
  repo.freezeH2HSeason = async (leagueId, plan, replacesSalt) => {
    if (!initial) {
      initial = plan;
      await joinLeague(deps, "u-late", "DUEL-1");
    }
    return write(leagueId, plan, replacesSalt);
  };
  await open(deps, "h2h", 1);

  assert.equal(initial?.participants.length, 4); // planned from the stale snapshot…
  const stored = (await repo.getLeague("h2h"))!;
  assert.deepEqual(sorted(stored.h2hParticipants), sorted([...FIVE.slice(0, 4), "u-late"])); // …re-planned to take u-late in
  assert.deepEqual(membersOutsideOrder(stored), []);
  assert.equal(stored.roundCount, 5); // 5 players, not the 4-player 3
  assert.notEqual(stored.h2hSalt, initial?.salt); // a fresh plan, salt included
  assert.deepEqual(freezes, [true, true]); // the freeze, then its one re-plan
  // The check after the freeze write is a strongly consistent read (an
  // eventually consistent one could miss the join that just committed).
  assert.ok(reads.some((opts) => opts?.consistent === true));
  assert.equal((await repo.getRound("h2h~0001"))?.status, "submitting");
  // Joins are closed from the freeze on.
  await assert.rejects(joinLeague(deps, "u-later", "DUEL-1"), isStatus(409, SEASON_LOCKED_MESSAGE));
});

test("open vs join, truly concurrent, either order: every member ends up in the frozen order", async () => {
  for (const joinFirst of [false, true]) {
    const { deps, repo } = await setup([h2hLeague({ memberIds: FIVE.slice(0, 4) })], [draft("h2h", 1)]);
    const join = () => joinLeague(deps, "u-late", "DUEL-1");
    const [a, b] = await Promise.allSettled(joinFirst ? [join(), open(deps, "h2h", 1)] : [open(deps, "h2h", 1), join()]);
    const [openRes, joinRes] = joinFirst ? [b, a] : [a, b];
    assert.equal(openRes.status, "fulfilled");
    const stored = (await repo.getLeague("h2h"))!;
    assert.deepEqual(membersOutsideOrder(stored), [], `joinFirst=${joinFirst}`);
    if (joinRes.status === "fulfilled") assert.ok(stored.h2hParticipants?.includes("u-late"));
    else assert.ok(isStatus(409, SEASON_LOCKED_MESSAGE)(joinRes.reason));
    assert.equal(stored.roundCount, stored.h2hParticipants!.length % 2 === 0 ? stored.h2hParticipants!.length - 1 : stored.h2hParticipants!.length);
  }
});

test("two openers re-planning at once: the loser's re-plan is refused and the winner's order stands", async () => {
  const { deps, repo } = await setup([h2hLeague({ memberIds: FIVE.slice(0, 4) })], [draft("h2h", 1)]);
  const write = repo.freezeH2HSeason;
  let joined = false;
  let racer: SeasonFreeze | undefined;
  repo.freezeH2HSeason = async (leagueId, plan, replacesSalt) => {
    if (!joined) {
      joined = true;
      await joinLeague(deps, "u-late", "DUEL-1");
    } else if (replacesSalt !== undefined && !racer) {
      // A concurrent opener's identical correction lands first.
      racer = { participants: ["u-late", ...FIVE.slice(0, 4)], salt: "ef".repeat(16), roundCount: 5 };
      assert.equal(await write(leagueId, racer, replacesSalt), true);
    }
    return write(leagueId, plan, replacesSalt);
  };
  await open(deps, "h2h", 1);
  const stored = (await repo.getLeague("h2h"))!;
  assert.deepEqual(stored.h2hParticipants, racer?.participants);
  assert.equal(stored.h2hSalt, racer?.salt);
  assert.equal((await repo.getRound("h2h~0001"))?.status, "submitting");
});

test("a freeze write refused while the league still reads un-frozen fails loudly; round 1 stays draft", async () => {
  // Can't happen with the real repos (the write conditions and seasonLocked
  // share one definition) — the guard keeps a broken store from opening
  // round 1 on a league that could then never freeze.
  const { deps, repo } = await setup([h2hLeague()], [draft("h2h", 1)]);
  repo.freezeH2HSeason = async () => false;
  await assert.rejects(open(deps, "h2h", 1), (e: unknown) => !(e instanceof ApiError) && /didn't freeze the season/.test((e as Error).message));
  assert.equal((await repo.getRound("h2h~0001"))?.status, "draft");
  assert.equal((await repo.getLeague("h2h"))?.h2hParticipants, undefined);
});

test("a stored empty h2hParticipants reads as a lobby everywhere: joins work, and round 1 freezes it properly", async () => {
  const { deps, repo } = await setup([h2hLeague({ memberIds: FIVE.slice(0, 3), roundCount: 7, h2hParticipants: [] })], [draft("h2h", 1)]);
  await joinLeague(deps, "u-4", "DUEL-1");
  await open(deps, "h2h", 1);
  const stored = (await repo.getLeague("h2h"))!;
  assert.deepEqual(sorted(stored.h2hParticipants), sorted(FIVE.slice(0, 4)));
  assert.match(stored.h2hSalt ?? "", /^[0-9a-f]{32}$/);
  assert.equal(stored.roundCount, 3);
  assert.equal((await createRound(deps, OWNER, "h2h", { theme: "Two" })).index, 2);
  await assert.rejects(joinLeague(deps, "u-5", "DUEL-1"), isStatus(409, SEASON_LOCKED_MESSAGE));
});

test("H2H: no round 2 before round 1 has opened (the season length isn't known yet)", async () => {
  const { deps, repo } = await setup([h2hLeague({ roundCount: 8 })], [draft("h2h", 1)]);
  await assert.rejects(createRound(deps, OWNER, "h2h", { theme: "Two" }), isStatus(400, H2H_ROUND_ONE_FIRST_MESSAGE));
  assert.equal((await repo.getRoundsForLeague("h2h")).length, 1);
  // Round 1 itself may be created on an empty league, before any freeze.
  const empty = await setup([h2hLeague()]);
  assert.equal((await createRound(empty.deps, OWNER, "h2h", { theme: "One" })).index, 1);

  await open(deps, "h2h", 1);
  assert.equal((await createRound(deps, OWNER, "h2h", { theme: "Two" })).index, 2);
});

test("H2H: opening a later round of an un-frozen league is refused (defensive, hand-edited data)", async () => {
  const { deps, repo, freezes } = await setup([h2hLeague()], [draft("h2h", 1), draft("h2h", 2)]);
  await assert.rejects(open(deps, "h2h", 2), isStatus(400, H2H_ROUND_ONE_FIRST_MESSAGE));
  assert.equal((await repo.getRound("h2h~0002"))?.status, "draft");
  assert.equal((await repo.getLeague("h2h"))?.h2hParticipants, undefined);
  assert.deepEqual(freezes, []);
});

test("the freeze fires on the draft → submitting transition only, not on a same-status PATCH", async () => {
  // Hand-edited data: round 1 already submitting in a never-frozen league. A
  // PATCH repeating the status (with an edit) is no transition, so no freeze.
  const { deps, repo, rng, freezes } = await setup([h2hLeague()], [draft("h2h", 1, { status: "submitting" })]);
  const out = await updateRound(deps, OWNER, "h2h", "h2h~0001", { status: "submitting", theme: "Edited" });
  assert.equal(out.theme, "Edited");
  assert.equal((await repo.getLeague("h2h"))?.h2hParticipants, undefined);
  assert.deepEqual(freezes, []);
  assert.equal(rng.calls, 0);
});

test("a round-1 PATCH refused for another reason (empty theme) freezes nothing", async () => {
  const { deps, repo, freezes } = await setup([h2hLeague()], [draft("h2h", 1)]);
  await assert.rejects(
    updateRound(deps, OWNER, "h2h", "h2h~0001", { status: "submitting", theme: "   " }),
    isStatus(400, /Theme can't be empty/),
  );
  assert.equal((await repo.getLeague("h2h"))?.h2hParticipants, undefined);
  assert.equal((await repo.getRound("h2h~0001"))?.status, "draft");
  assert.deepEqual(freezes, []);
  // Non-owners can't open (or freeze) anything either.
  await assert.rejects(updateRound(deps, "u-2", "h2h", "h2h~0001", { status: "submitting" }), isStatus(403));
  assert.equal((await repo.getLeague("h2h"))?.h2hParticipants, undefined);
});

test("timed H2H leagues freeze through the same hook: the owner opens round 1, auto-advance never does", async () => {
  const lg = h2hLeague({ progression: "timed", phaseDays: 2, startAt: new Date(Date.now() - 1000).toISOString() });
  const { deps, repo } = await setup([lg], [draft("h2h", 1)]);
  // progression.ts has no draft → submitting step: a draft round 1 is left alone.
  const untouched = await autoAdvanceRound(deps, (await repo.getLeague("h2h"))!, (await repo.getRound("h2h~0001"))!);
  assert.equal(untouched?.status, "draft");
  assert.equal((await repo.getLeague("h2h"))?.h2hParticipants, undefined);

  const opened = await open(deps, "h2h", 1);
  assert.equal(opened.status, "submitting");
  assert.ok(opened.submissionDeadline && opened.previewDeadline && opened.voteDeadline); // timed schedule laid down
  const stored = (await repo.getLeague("h2h"))!;
  assert.equal(stored.h2hParticipants?.length, 5);
  assert.equal(stored.roundCount, 5);
});

test("standard league: none of it fires — no participants, no salt, no roundCount override, no RNG", async () => {
  const { deps, repo, rng, freezes } = await setup(
    [standardLeague({ roundCount: 3 }), standardLeague({ id: "solo", inviteCode: "SOLO-1", memberIds: [OWNER] })],
    [draft("std", 1), draft("solo", 1)],
  );
  // Rounds may still be pre-created before round 1 opens (unchanged behavior).
  assert.equal((await createRound(deps, OWNER, "std", { theme: "Two" })).index, 2);

  await open(deps, "std", 1);
  const stored = (await repo.getLeague("std"))!;
  assert.equal("h2hParticipants" in stored, false);
  assert.equal("h2hSalt" in stored, false);
  assert.equal(stored.roundCount, 3); // 5 members, but the owner's count stands
  // A lone member can open round 1 of a standard league (no 2-player floor).
  assert.equal((await open(deps, "solo", 1)).status, "submitting");
  assert.equal("h2hParticipants" in (await repo.getLeague("solo"))!, false);
  // Opening round 2 before round 1 was revealed is the old (permissive) behavior.
  assert.equal((await open(deps, "std", 2)).status, "submitting");
  assert.deepEqual(freezes, []);
  assert.equal(rng.calls, 0);

  // Join window unchanged: the invite path still lets a player in mid-season.
  await joinLeague(deps, "u-new", "STD-1");
  assert.ok((await repo.getLeague("std"))?.memberIds.includes("u-new"));
  // And the roundCount cap is still the owner's.
  await createRound(deps, OWNER, "std", { theme: "Three" });
  await assert.rejects(createRound(deps, OWNER, "std", { theme: "Four" }), isStatus(400, /set to 3 rounds/));
});

test("a legacy league stored without `format` opens as standard (no freeze)", async () => {
  const legacy = standardLeague({ memberIds: [OWNER] });
  delete (legacy as Partial<League>).format;
  const { deps, repo, freezes } = await setup([legacy], [draft("std", 1)]);
  await open(deps, "std", 1);
  assert.equal((await repo.getLeague("std"))?.h2hParticipants, undefined);
  assert.deepEqual(freezes, []);
});

test("standard: an owner's PATCH built from a round read before its reveal gets 409 and can't put it back in voting, so no second reveal can bank it; a PATCH that reads the revealed round lands as before (BUG-04)", async () => {
  const { revealRound } = await import("./voting.ts");
  const three = [OWNER, "u-2", "u-3"];
  const voting = draft("std", 1, { status: "voting", voteDeadline: "2030-01-01T00:00:00.000Z" });
  const { deps, repo } = await setup([standardLeague({ memberIds: three })], [voting]);
  for (const u of three) {
    await repo.putSubmission({
      id: `s-${u}`, roundId: voting.id, userId: u,
      track: { id: `t-${u}`, provider: "mock", providerTrackId: `t-${u}`, title: `${u} anthem`, artists: [`Artist ${u}`] },
    });
  }
  await repo.putBallot({ roundId: voting.id, voterId: OWNER, allocations: { "s-u-2": 5, "s-u-3": 5 }, castAt: "2030-01-01T00:00:00.000Z" });
  const points = async () => Object.fromEntries((await repo.getStandings("std")).map((s) => [s.userId, s.points]));

  // The owner's PATCH (extending the vote deadline) reads the round while it's voting…
  const stale = (await repo.getRound(voting.id))!;
  // …a reveal lands (the owner's, or a member's page load past the deadline)…
  await revealRound(deps, OWNER, voting.id);
  const banked = await points();
  assert.deepEqual(banked, { [OWNER]: 0, "u-2": 5, "u-3": 5 });
  const settled = (await repo.getRound(voting.id))!;
  assert.equal(settled.status, "revealed");

  // …and the PATCH's write arrives after it.
  const late: Deps = {
    ...deps,
    repo: new Proxy(repo, {
      get: (target, prop) => {
        if (prop === "getRound") return async () => structuredClone(stale);
        const value: unknown = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
  await assert.rejects(
    updateRound(late, OWNER, "std", voting.id, { voteDeadline: "2030-01-02T00:00:00.000Z" }),
    isStatus(409, "That round was just revealed. Reload to see the results."),
  );
  assert.deepEqual(await repo.getRound(voting.id), settled, "still revealed, the edit not written");
  await assert.rejects(revealRound(deps, OWNER, voting.id), isStatus(400, /in voting/));
  assert.deepEqual(await points(), banked, "nothing banked twice");

  // An edit made from a fresh read of the revealed round is an ordinary write, as ever.
  await updateRound(deps, OWNER, "std", voting.id, { theme: "Renamed" });
  assert.deepEqual(await repo.getRound(voting.id), { ...settled, theme: "Renamed" });
});

test("a PATCH whose settle-guarded write loses to the league's deletion answers 404 (not 'just revealed') and recreates nothing, in either format (BUG-04)", async () => {
  const stdVoting = draft("std", 1, { status: "voting", voteDeadline: "2030-01-01T00:00:00.000Z" });
  const h2hVoting = draft("h2h", 1, { status: "voting", voteDeadline: "2030-01-01T00:00:00.000Z" });
  const { deps, repo } = await setup([standardLeague(), h2hLeague({ h2hParticipants: [...FIVE], h2hSalt: "salt" })], [stdVoting, h2hVoting]);
  for (const [leagueId, round] of [["std", stdVoting], ["h2h", h2hVoting]] as const) {
    // The owner deletes the league after this PATCH read it, before its write.
    const racing: Deps = {
      ...deps,
      repo: new Proxy(repo, {
        get: (target, prop) => {
          if (prop === "updateRoundUnlessSettled") {
            return async (r: Round) => {
              await target.deleteLeague(leagueId);
              return target.updateRoundUnlessSettled(r);
            };
          }
          const value: unknown = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    };
    await assert.rejects(
      updateRound(racing, OWNER, leagueId, round.id, { voteDeadline: "2030-01-02T00:00:00.000Z" }),
      isStatus(404, "That round doesn't exist."),
    );
    assert.equal(await repo.getRound(round.id), undefined, "no phantom round");
    assert.deepEqual(await repo.getRoundsForLeague(leagueId), []);
  }
});
