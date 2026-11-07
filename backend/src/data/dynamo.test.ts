// DynamoRepository league-META mapping tests — fully offline. No SDK client is
// constructed and nothing leaves the process: the repository's document
// client is swapped for an in-process fake that stores items in a Map, so
// these exercise only our own item <-> League mapping (e.g. the `format`
// attribute: written on create, defaulted to "standard" on legacy rows) and
// the head-to-head freeze's conditional writes (HTH-03): the write-once
// UpdateItem, its re-plan, the season-gated join transaction, and the
// strongly consistent read the freeze checks itself with; plus the W/L/D
// counters on the existing STANDING# item (HTH-04).

import { test } from "node:test";
import assert from "node:assert/strict";
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoRepository } from "./dynamo.ts";
import { DEFAULT_LEAGUE_SETTINGS } from "../domain/types.ts";
import type { League } from "../domain/types.ts";

type Item = Record<string, unknown>;

/** Split `expr` on a top-level ` AND ` / ` OR ` (outside parentheses). */
function splitTop(expr: string, op: "AND" | "OR"): string[] {
  const sep = ` ${op} `;
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === "(") depth++;
    else if (expr[i] === ")") depth--;
    else if (depth === 0 && expr.startsWith(sep, i)) {
      parts.push(expr.slice(start, i).trim());
      start = i + sep.length;
      i = start - 1;
    }
  }
  parts.push(expr.slice(start).trim());
  return parts;
}

/** Evaluate the small ConditionExpression subset the repo uses against an
 *  item, with DynamoDB's semantics: clauses joined by OR / AND (AND binds
 *  tighter; parentheses group), each one of `attribute_exists(a)`,
 *  `attribute_not_exists(a)`, `size(a) = :v`, `contains(a, :v)` (list
 *  membership) or `a = :v`. A function over a missing attribute is false. */
function conditionHolds(expression: string | undefined, item: Item | undefined, values: Item = {}): boolean {
  if (!expression) return true;
  const expr = expression.trim();
  const ors = splitTop(expr, "OR");
  if (ors.length > 1) return ors.some((e) => conditionHolds(e, item, values));
  const ands = splitTop(expr, "AND");
  if (ands.length > 1) return ands.every((e) => conditionHolds(e, item, values));
  if (expr.startsWith("(") && expr.endsWith(")")) return conditionHolds(expr.slice(1, -1), item, values);

  const attr = (name: string) => (item === undefined ? undefined : item[name]);
  let m = expr.match(/^(attribute_exists|attribute_not_exists)\((\w+)\)$/);
  if (m) return (attr(m[2]!) !== undefined) === (m[1] === "attribute_exists");
  m = expr.match(/^size\((\w+)\)\s*=\s*(:\w+)$/);
  if (m) {
    const v = attr(m[1]!);
    return (Array.isArray(v) || typeof v === "string") && v.length === values[m[2]!];
  }
  m = expr.match(/^contains\((\w+),\s*(:\w+)\)$/);
  if (m) {
    const v = attr(m[1]!);
    return Array.isArray(v) && v.includes(values[m[2]!]);
  }
  m = expr.match(/^(\w+)\s*=\s*(:\w+)$/);
  if (m) return attr(m[1]!) !== undefined && attr(m[1]!) === values[m[2]!];
  throw new Error(`fake doc client: unsupported condition ${expr}`);
}

/** A DynamoRepository over a Map-backed fake of the commands the league
 *  read/write path uses. Built without running the constructor, so no
 *  DynamoDBClient (credentials/region/network) is ever created. Every
 *  command sent is recorded in `sent`. */
function fakeRepo(): { repo: DynamoRepository; table: Map<string, Item>; sent: unknown[] } {
  const table = new Map<string, Item>();
  const sent: unknown[] = [];
  const key = (pk: unknown, sk: unknown) => `${String(pk)}|${String(sk)}`;
  const send = async (cmd: unknown): Promise<unknown> => {
    sent.push(cmd);
    if (cmd instanceof UpdateCommand) {
      // The SET subset `applySetExpression` models (plain `a = :x` and the
      // `if_not_exists(a, :zero) + :d` counters), guarded by the condition —
      // like DynamoDB, a failed condition throws ConditionalCheckFailedException
      // and writes nothing.
      const k = key(cmd.input.Key?.PK, cmd.input.Key?.SK);
      const existing = table.get(k);
      if (!conditionHolds(cmd.input.ConditionExpression, existing, cmd.input.ExpressionAttributeValues)) {
        throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
      }
      const next: Item = { ...(existing ?? { PK: cmd.input.Key?.PK, SK: cmd.input.Key?.SK }) };
      applySetExpression(
        next,
        cmd.input.UpdateExpression ?? "",
        cmd.input.ExpressionAttributeNames ?? {},
        structuredClone(cmd.input.ExpressionAttributeValues ?? {}),
      );
      table.set(k, next);
      return {};
    }
    if (cmd instanceof TransactWriteCommand) {
      // All-or-nothing, like DynamoDB: every ConditionCheck is evaluated
      // first; one failure cancels the whole transaction (writing nothing)
      // with a reason per item.
      const items = cmd.input.TransactItems ?? [];
      const reasons = items.map((t) => {
        const check = t.ConditionCheck;
        if (!check) return "None";
        const holds = conditionHolds(check.ConditionExpression, table.get(key(check.Key?.PK, check.Key?.SK)), check.ExpressionAttributeValues);
        return holds ? "None" : "ConditionalCheckFailed";
      });
      if (reasons.some((code) => code !== "None")) {
        throw Object.assign(new Error("Transaction cancelled"), {
          name: "TransactionCanceledException",
          CancellationReasons: reasons.map((Code) => ({ Code })),
        });
      }
      for (const t of items) {
        const it = t.Put?.Item as Item | undefined;
        if (it) table.set(key(it.PK, it.SK), structuredClone(it));
      }
      return {};
    }
    if (cmd instanceof GetCommand) {
      const it = table.get(key(cmd.input.Key?.PK, cmd.input.Key?.SK));
      return { Item: it ? structuredClone(it) : undefined };
    }
    if (cmd instanceof QueryCommand) {
      const values = cmd.input.ExpressionAttributeValues ?? {};
      const pk = values[":pk"];
      const prefix = String(values[":m"] ?? values[":s"] ?? "");
      return { Items: [...table.values()].filter((it) => it.PK === pk && String(it.SK).startsWith(prefix)) };
    }
    throw new Error(`fake doc client: unexpected command ${(cmd as object).constructor.name}`);
  };
  const repo = Object.create(DynamoRepository.prototype) as DynamoRepository;
  Object.assign(repo, { tableName: "MusicLeague-test", doc: { send } });
  return { repo, table, sent };
}

/** Evaluate the subset of UpdateExpression syntax the repository writes —
 *  `SET a = :v, b = if_not_exists(b, :zero) + :d, ...` (with optional `#name`
 *  placeholders) — against one item, the way DynamoDB would. Anything else
 *  throws, so an expression this fake can't faithfully model fails loudly. */
function applySetExpression(item: Item, expr: string, names: Record<string, string>, values: Record<string, unknown>): void {
  const m = expr.match(/^SET\s+(.+)$/s);
  if (!m) throw new Error(`fake doc client: unsupported UpdateExpression ${expr}`);
  const attr = (tok: string) => (tok.startsWith("#") ? names[tok] : tok) ?? tok;
  const value = (tok: string) => {
    if (!(tok in values)) throw new Error(`fake doc client: no value for ${tok}`);
    return values[tok];
  };
  // Split on top-level commas only (if_not_exists(...) has one inside).
  const clauses: string[] = [];
  let depth = 0, start = 0;
  const body = m[1]!;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "(") depth++;
    else if (body[i] === ")") depth--;
    else if (body[i] === "," && depth === 0) { clauses.push(body.slice(start, i)); start = i + 1; }
  }
  clauses.push(body.slice(start));
  for (const clause of clauses) {
    const [lhs, rhs] = clause.split("=").map((t) => t.trim()) as [string, string];
    const inc = rhs.match(/^if_not_exists\(\s*([#\w]+)\s*,\s*(:\w+)\s*\)\s*\+\s*(:\w+)$/);
    if (inc) {
      if (attr(inc[1]!) !== attr(lhs)) throw new Error(`fake doc client: if_not_exists on another attribute in ${clause}`);
      const current = item[attr(lhs)] ?? value(inc[2]!);
      item[attr(lhs)] = (current as number) + (value(inc[3]!) as number);
    } else if (/^:\w+$/.test(rhs)) {
      item[attr(lhs)] = value(rhs);
    } else {
      throw new Error(`fake doc client: unsupported SET clause ${clause}`);
    }
  }
}

function league(over: Partial<League> = {}): League {
  return {
    id: "lg-1", name: "League", ownerId: "u-owner", musicProvider: "mock", format: "standard",
    settings: DEFAULT_LEAGUE_SETTINGS, memberIds: ["u-owner"], inviteCode: "DXL-AAAAAA",
    visibility: "private", roundCount: 3, progression: "manual", ...over,
  };
}

test("createLeague writes `format` onto the META item and getLeague reads it back", async () => {
  const { repo, table } = fakeRepo();
  await repo.createLeague(league({ id: "h2h", format: "headToHead" }));
  assert.equal(table.get("LEAGUE#h2h|META")?.format, "headToHead");
  assert.equal((await repo.getLeague("h2h"))?.format, "headToHead");

  await repo.createLeague(league({ id: "std" }));
  assert.equal(table.get("LEAGUE#std|META")?.format, "standard");
  assert.equal((await repo.getLeague("std"))?.format, "standard");
});

test("a legacy META row with no `format` attribute reads as standard (no migration)", async () => {
  const { repo, table } = fakeRepo();
  await repo.createLeague(league({ id: "old" }));
  const meta = table.get("LEAGUE#old|META")!;
  delete meta.format; // exactly what a pre-format league's stored item looks like
  assert.equal("format" in meta, false);

  const read = await repo.getLeague("old");
  assert.equal(read?.format, "standard");
  assert.deepEqual(read?.memberIds, ["u-owner"]);
  // And it serializes with the field present — nothing undefined leaks out.
  assert.equal(JSON.parse(JSON.stringify(read)).format, "standard");
});

// ---- Standing rows: W/L/D on the existing STANDING# item (HTH-04) ----

test("addStandingRecord increments W/L/D in place on the STANDING# item; points untouched", async () => {
  const { repo, table } = fakeRepo();
  await repo.addStandingPoints("lg-1", "u-me", 7); // the join seed + some banked points
  await repo.addStandingRecord("lg-1", "u-me", { wins: 1 });
  await repo.addStandingRecord("lg-1", "u-me", { wins: 1, losses: 1 });
  await repo.addStandingRecord("lg-1", "u-me", { draws: 1 });

  // One item, same key as the points row — no new entity, table or GSI.
  const keys = [...table.keys()];
  assert.deepEqual(keys, ["LEAGUE#lg-1|STANDING#u-me"]);
  assert.deepEqual(table.get("LEAGUE#lg-1|STANDING#u-me"), {
    PK: "LEAGUE#lg-1", SK: "STANDING#u-me", userId: "u-me", entity: "standing",
    points: 7, wins: 2, losses: 1, draws: 1,
  });
  assert.deepEqual(await repo.getStandings("lg-1"), [{ userId: "u-me", points: 7, wins: 2, losses: 1, draws: 1 }]);

  await repo.addStandingPoints("lg-1", "u-me", 3); // and points don't disturb the record
  assert.deepEqual(await repo.getStandings("lg-1"), [{ userId: "u-me", points: 10, wins: 2, losses: 1, draws: 1 }]);
});

test("addStandingRecord is a single atomic UpdateItem (if_not_exists + delta), never a read-modify-write", async () => {
  const { repo } = fakeRepo();
  const sent: unknown[] = [];
  const doc = (repo as unknown as { doc: { send: (c: unknown) => Promise<unknown> } }).doc;
  const inner = doc.send;
  doc.send = async (c: unknown) => { sent.push(c); return inner(c); };

  await repo.addStandingRecord("lg-1", "u-me", { draws: 1 });
  assert.equal(sent.length, 1);
  const cmd = sent[0];
  assert.ok(cmd instanceof UpdateCommand);
  assert.deepEqual(cmd.input.Key, { PK: "LEAGUE#lg-1", SK: "STANDING#u-me" });
  for (const name of ["wins", "losses", "draws"]) {
    const ph = Object.entries(cmd.input.ExpressionAttributeNames ?? {}).find(([, v]) => v === name)?.[0];
    assert.ok(ph, `${name} has a name placeholder`);
    assert.match(cmd.input.UpdateExpression ?? "", new RegExp(`${ph} = if_not_exists\\(${ph}, :zero\\) \\+ :`));
  }
  assert.equal((cmd.input.UpdateExpression ?? "").includes("points"), false);
});

test("a legacy STANDING# row (points only) reads back with a 0–0–0 record; a record-first row reads 0 points", async () => {
  const { repo, table } = fakeRepo();
  // Exactly what every live-beta standing item looks like today.
  table.set("LEAGUE#lg-1|STANDING#u-old", { PK: "LEAGUE#lg-1", SK: "STANDING#u-old", userId: "u-old", entity: "standing", points: 12 });
  await repo.addStandingRecord("lg-1", "u-new", { losses: 1 }); // no points write ever happened
  table.set("LEAGUE#lg-1|META", { PK: "LEAGUE#lg-1", SK: "META", name: "not a standing" });

  const rows = await repo.getStandings("lg-1");
  assert.deepEqual(rows, [
    { userId: "u-old", points: 12, wins: 0, losses: 0, draws: 0 },
    { userId: "u-new", points: 0, wins: 0, losses: 1, draws: 0 },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), rows); // nothing undefined on the wire
});

test("addStandingRecord rejects a non-integer increment without writing", async () => {
  const { repo, table } = fakeRepo();
  await assert.rejects(repo.addStandingRecord("lg-1", "u-me", { wins: Number.NaN }), /integer/);
  assert.equal(table.size, 0);
});

// ---- head-to-head season freeze (HTH-03) ----

const FREEZE = { participants: ["u-3", "u-owner", "u-2"], salt: "0123456789abcdef0123456789abcdef", roundCount: 3 };

test("freezeH2HSeason: one conditional UpdateItem on META writes order, salt and roundCount; getLeague reads them back", async () => {
  const { repo, table, sent } = fakeRepo();
  await repo.createLeague(league({ id: "h2h", format: "headToHead", memberIds: ["u-owner", "u-2", "u-3"], roundCount: 8 }));
  assert.equal(table.get("LEAGUE#h2h|META")?.h2hParticipants, undefined); // un-frozen at creation
  sent.length = 0;

  assert.equal(await repo.freezeH2HSeason("h2h", FREEZE), true);
  assert.equal(sent.length, 1);
  const update = sent[0] as UpdateCommand;
  assert.ok(update instanceof UpdateCommand);
  assert.deepEqual(update.input.Key, { PK: "LEAGUE#h2h", SK: "META" });
  assert.match(update.input.ConditionExpression ?? "", /attribute_not_exists\(h2hParticipants\)/);
  assert.match(update.input.ConditionExpression ?? "", /attribute_exists\(PK\)/);

  const meta = table.get("LEAGUE#h2h|META")!;
  assert.deepEqual(meta.h2hParticipants, FREEZE.participants);
  assert.equal(meta.h2hSalt, FREEZE.salt);
  assert.equal(meta.roundCount, 3); // overrides the 8 typed at creation
  assert.equal(meta.name, "League"); // the rest of META untouched

  const read = (await repo.getLeague("h2h"))!;
  assert.deepEqual(read.h2hParticipants, FREEZE.participants);
  assert.equal(read.h2hSalt, FREEZE.salt);
  assert.equal(read.roundCount, 3);
  assert.deepEqual(read.memberIds.sort(), ["u-2", "u-3", "u-owner"]);
});

test("freezeH2HSeason is once: a second call fails the condition, returns false, and the first order stands", async () => {
  const { repo, table } = fakeRepo();
  await repo.createLeague(league({ id: "h2h", format: "headToHead" }));
  assert.equal(await repo.freezeH2HSeason("h2h", FREEZE), true);
  const reshuffle = { participants: ["u-2", "u-3", "u-owner"], salt: "f".repeat(32), roundCount: 3 };
  assert.equal(await repo.freezeH2HSeason("h2h", reshuffle), false);
  assert.deepEqual(table.get("LEAGUE#h2h|META")?.h2hParticipants, FREEZE.participants);
  assert.equal(table.get("LEAGUE#h2h|META")?.h2hSalt, FREEZE.salt);
});

test("freezeH2HSeason on a missing league writes no phantom META and returns false; other errors propagate", async () => {
  const { repo, table } = fakeRepo();
  assert.equal(await repo.freezeH2HSeason("gone", FREEZE), false);
  assert.equal(table.has("LEAGUE#gone|META"), false);

  const boom = fakeRepo();
  Object.assign(boom.repo, {
    doc: { send: async () => { throw Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" }); } },
  });
  await assert.rejects(boom.repo.freezeH2HSeason("h2h", FREEZE), /throttled/);
});

test("un-frozen and legacy META rows read back with no h2h fields; createLeague persists them only when given", async () => {
  const { repo, table } = fakeRepo();
  await repo.createLeague(league({ id: "std" }));
  const plain = (await repo.getLeague("std"))!;
  assert.equal(plain.h2hParticipants, undefined);
  assert.equal(plain.h2hSalt, undefined);
  const json = JSON.parse(JSON.stringify(plain));
  assert.equal("h2hParticipants" in json, false);
  assert.equal("h2hSalt" in json, false);

  // A META item that already carries a freeze (e.g. a seeded fixture) round-trips.
  await repo.createLeague(league({ id: "seeded", format: "headToHead", h2hParticipants: ["u-owner", "u-2"], h2hSalt: "a".repeat(32), roundCount: 1 }));
  assert.deepEqual(table.get("LEAGUE#seeded|META")?.h2hParticipants, ["u-owner", "u-2"]);
  assert.deepEqual((await repo.getLeague("seeded"))?.h2hParticipants, ["u-owner", "u-2"]);
  assert.equal((await repo.getLeague("seeded"))?.h2hSalt, "a".repeat(32));
});

test("an empty stored h2hParticipants counts as un-frozen, exactly as seasonLocked says: the freeze lands", async () => {
  const { repo, table } = fakeRepo();
  await repo.createLeague(league({ id: "h2h", format: "headToHead", h2hParticipants: [] }));
  assert.deepEqual(table.get("LEAGUE#h2h|META")?.h2hParticipants, []);
  assert.equal(await repo.freezeH2HSeason("h2h", FREEZE), true);
  assert.deepEqual(table.get("LEAGUE#h2h|META")?.h2hParticipants, FREEZE.participants);
  // …and once it holds players it's frozen: a second freeze is refused.
  assert.equal(await repo.freezeH2HSeason("h2h", { ...FREEZE, salt: "e".repeat(32) }), false);
});

test("freezeH2HSeason with replacesSalt re-plans only over that exact stored salt", async () => {
  const { repo, table, sent } = fakeRepo();
  await repo.createLeague(league({ id: "h2h", format: "headToHead" }));
  const replan = { participants: ["u-4", "u-owner", "u-3", "u-2"], salt: "9".repeat(32), roundCount: 3 };
  // Nothing frozen yet → no salt to replace → refused, nothing written.
  assert.equal(await repo.freezeH2HSeason("h2h", replan, FREEZE.salt), false);
  assert.equal(table.get("LEAGUE#h2h|META")?.h2hParticipants, undefined);

  assert.equal(await repo.freezeH2HSeason("h2h", FREEZE), true);
  assert.equal(await repo.freezeH2HSeason("h2h", replan, "f".repeat(32)), false); // a salt we never read
  assert.deepEqual(table.get("LEAGUE#h2h|META")?.h2hParticipants, FREEZE.participants);

  sent.length = 0;
  assert.equal(await repo.freezeH2HSeason("h2h", replan, FREEZE.salt), true);
  const update = sent[0] as UpdateCommand;
  assert.match(update.input.ConditionExpression ?? "", /h2hSalt = :old/);
  assert.match(update.input.ConditionExpression ?? "", /attribute_exists\(PK\)/);
  const meta = table.get("LEAGUE#h2h|META")!;
  assert.deepEqual(meta.h2hParticipants, replan.participants);
  assert.equal(meta.h2hSalt, replan.salt);
  // The old salt is spent: replaying the same re-plan is refused.
  assert.equal(await repo.freezeH2HSeason("h2h", FREEZE, FREEZE.salt), false);
  assert.equal(await repo.freezeH2HSeason("gone", replan, FREEZE.salt), false);
  assert.equal(table.has("LEAGUE#gone|META"), false);
});

test("addMemberUnlessSeasonLocked: one transaction (META season check + MEMBER# put) — open lobby joins, a newcomer after the freeze writes nothing, a frozen participant comes back", async () => {
  const { repo, table, sent } = fakeRepo();
  await repo.createLeague(league({ id: "h2h", format: "headToHead", memberIds: ["u-owner", "u-2"] }));

  sent.length = 0;
  const joined = await repo.addMemberUnlessSeasonLocked("h2h", "u-3");
  assert.deepEqual(joined?.memberIds.sort(), ["u-2", "u-3", "u-owner"]);
  const tx = sent[0] as TransactWriteCommand;
  assert.ok(tx instanceof TransactWriteCommand);
  const [check, put] = tx.input.TransactItems ?? [];
  assert.deepEqual(check?.ConditionCheck?.Key, { PK: "LEAGUE#h2h", SK: "META" });
  assert.match(check?.ConditionCheck?.ConditionExpression ?? "", /attribute_not_exists\(h2hParticipants\)/);
  assert.match(check?.ConditionCheck?.ConditionExpression ?? "", /contains\(h2hParticipants, :u\)/);
  assert.equal(put?.Put?.Item?.SK, "MEMBER#u-3");

  // Frozen (u-3 is in the order; u-late isn't).
  assert.equal(await repo.freezeH2HSeason("h2h", FREEZE), true);
  assert.equal(await repo.addMemberUnlessSeasonLocked("h2h", "u-late"), undefined);
  assert.equal(table.has("LEAGUE#h2h|MEMBER#u-late"), false);
  table.delete("LEAGUE#h2h|MEMBER#u-3"); // u-3 leaves (what removeMember deletes)
  assert.ok((await repo.addMemberUnlessSeasonLocked("h2h", "u-3"))?.memberIds.includes("u-3"));
});

test("addMemberUnlessSeasonLocked: a cancellation that isn't the season check (e.g. a transaction conflict) propagates", async () => {
  const { repo } = fakeRepo();
  Object.assign(repo, {
    doc: {
      send: async () => {
        throw Object.assign(new Error("conflict"), {
          name: "TransactionCanceledException",
          CancellationReasons: [{ Code: "TransactionConflict" }, { Code: "None" }],
        });
      },
    },
  });
  await assert.rejects(repo.addMemberUnlessSeasonLocked("h2h", "u-3"), /conflict/);
});

test("getLeague({ consistent: true }) reads META and members strongly consistently; the default read is unchanged", async () => {
  const { repo, sent } = fakeRepo();
  await repo.createLeague(league({ id: "h2h", format: "headToHead" }));
  sent.length = 0;
  await repo.getLeague("h2h");
  for (const cmd of sent as Array<GetCommand | QueryCommand>) assert.equal("ConsistentRead" in cmd.input, false);
  sent.length = 0;
  await repo.getLeague("h2h", { consistent: true });
  assert.equal(sent.length, 2);
  for (const cmd of sent as Array<GetCommand | QueryCommand>) assert.equal(cmd.input.ConsistentRead, true);
});
