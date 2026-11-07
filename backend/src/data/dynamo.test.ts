// DynamoRepository league-META mapping tests — fully offline. No SDK client is
// constructed and nothing leaves the process: the repository's document
// client is swapped for an in-process fake that stores items in a Map, so
// these exercise only our own item <-> League mapping (e.g. the `format`
// attribute: written on create, defaulted to "standard" on legacy rows) and
// the head-to-head freeze's conditional writes (HTH-03): the write-once
// UpdateItem, its re-plan, the season-gated join transaction, and the
// strongly consistent read the freeze checks itself with; plus the W/L/D
// counters on the existing STANDING# item (HTH-04), head-to-head `picks` on
// the existing BALLOT# item (HTH-06), and the once-only reveal (HTH-07): its
// transaction (conditional round write with the pinned `h2hDeparted` /
// `h2hTally` + every W/L/D increment), the settle-guarded round write, and
// the strongly consistent round read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoRepository } from "./dynamo.ts";
import { DEFAULT_LEAGUE_SETTINGS } from "../domain/types.ts";
import type { Ballot, League, Round } from "../domain/types.ts";

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
 *  membership), `a = :v` or `a <> :v` (`#name` placeholders resolved through
 *  `names`). A function over a missing attribute is false; so is any
 *  comparison with one here (the repo never compares a possibly-missing
 *  attribute, so the fake needn't model DynamoDB's rule for `<>` there). */
function conditionHolds(
  expression: string | undefined,
  item: Item | undefined,
  values: Item = {},
  names: Record<string, string> = {},
): boolean {
  if (!expression) return true;
  const expr = expression.trim();
  const ors = splitTop(expr, "OR");
  if (ors.length > 1) return ors.some((e) => conditionHolds(e, item, values, names));
  const ands = splitTop(expr, "AND");
  if (ands.length > 1) return ands.every((e) => conditionHolds(e, item, values, names));
  if (expr.startsWith("(") && expr.endsWith(")")) return conditionHolds(expr.slice(1, -1), item, values, names);

  const attr = (name: string) => (item === undefined ? undefined : item[names[name] ?? name]);
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
  m = expr.match(/^([#\w]+)\s*(=|<>)\s*(:\w+)$/);
  if (m) {
    const v = attr(m[1]!);
    if (v === undefined) return false;
    return m[2] === "=" ? v === values[m[3]!] : v !== values[m[3]!];
  }
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
      if (!conditionHolds(cmd.input.ConditionExpression, existing, cmd.input.ExpressionAttributeValues, cmd.input.ExpressionAttributeNames)) {
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
      // All-or-nothing, like DynamoDB: every item's condition (ConditionCheck,
      // or a conditional Put / Update) is evaluated first; one failure
      // cancels the whole transaction (writing nothing) with a reason per
      // item. Then the Puts (JSON round-trip = removeUndefinedValues) and the
      // Updates (applySetExpression) apply. Like DynamoDB, it refuses more
      // than 100 items or two operations on the same item.
      const items = cmd.input.TransactItems ?? [];
      if (items.length > 100) throw Object.assign(new Error("Too many items"), { name: "ValidationException" });
      const target = (t: (typeof items)[number]) => {
        const op = t.ConditionCheck ?? t.Update ?? t.Put;
        const k = t.Put ? { PK: t.Put.Item?.PK, SK: t.Put.Item?.SK } : (op as { Key?: Item }).Key;
        return { op: op as { ConditionExpression?: string; ExpressionAttributeValues?: Item; ExpressionAttributeNames?: Record<string, string> }, k: key(k?.PK, k?.SK) };
      };
      const keys = items.map((t) => target(t).k);
      if (new Set(keys).size !== keys.length) throw Object.assign(new Error("Duplicate item"), { name: "ValidationException" });
      const reasons = items.map((t) => {
        const { op, k } = target(t);
        const holds = conditionHolds(op.ConditionExpression, table.get(k), op.ExpressionAttributeValues, op.ExpressionAttributeNames);
        return holds ? "None" : "ConditionalCheckFailed";
      });
      if (reasons.some((code) => code !== "None")) {
        throw Object.assign(new Error("Transaction cancelled"), {
          name: "TransactionCanceledException",
          CancellationReasons: reasons.map((Code) => ({ Code })),
        });
      }
      for (const t of items) {
        if (t.Put) {
          const it = JSON.parse(JSON.stringify(t.Put.Item ?? {})) as Item;
          table.set(key(it.PK, it.SK), it);
        } else if (t.Update) {
          const k = key(t.Update.Key?.PK, t.Update.Key?.SK);
          const next: Item = { ...(table.get(k) ?? { PK: t.Update.Key?.PK, SK: t.Update.Key?.SK }) };
          applySetExpression(
            next, t.Update.UpdateExpression ?? "", t.Update.ExpressionAttributeNames ?? {},
            structuredClone(t.Update.ExpressionAttributeValues ?? {}),
          );
          table.set(k, next);
        }
      }
      return {};
    }
    if (cmd instanceof PutCommand) {
      // A whole-item write. JSON round-trip = the real client's
      // removeUndefinedValues: an undefined attribute is never stored.
      const it = JSON.parse(JSON.stringify(cmd.input.Item ?? {})) as Item;
      if (!conditionHolds(cmd.input.ConditionExpression, table.get(key(it.PK, it.SK)), cmd.input.ExpressionAttributeValues, cmd.input.ExpressionAttributeNames)) {
        throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
      }
      table.set(key(it.PK, it.SK), it);
      return {};
    }
    if (cmd instanceof GetCommand) {
      const it = table.get(key(cmd.input.Key?.PK, cmd.input.Key?.SK));
      return { Item: it ? structuredClone(it) : undefined };
    }
    if (cmd instanceof QueryCommand) {
      const values = cmd.input.ExpressionAttributeValues ?? {};
      const pk = values[":pk"];
      const prefix = String(values[":m"] ?? values[":s"] ?? values[":b"] ?? "");
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

// ---- Ballots: head-to-head picks on the existing BALLOT# item (HTH-06) ----

test("an H2H ballot's picks round-trip on the same BALLOT#<voterId> item; a points ballot's item carries no picks attribute", async () => {
  const { repo, table } = fakeRepo();
  const h2h: Ballot = {
    roundId: "lg-1~0001", voterId: "u-me", allocations: {},
    picks: { "lg-1~0001~M0": "sub-a", "lg-1~0001~M1": "sub-d" },
    comments: { "sub-a": "nice" }, castAt: "2026-11-07T12:00:00.000Z",
  };
  const points: Ballot = {
    roundId: "lg-1~0001", voterId: "u-you", allocations: { "sub-a": 6, "sub-b": 4 }, downvotes: {},
    comments: {}, castAt: "2026-11-07T12:01:00.000Z",
  };
  await repo.putBallot(h2h);
  await repo.putBallot(points);

  // Same key scheme as ever — no new entity; picks is just another attribute.
  assert.deepEqual([...table.keys()].sort(), ["ROUND#lg-1~0001|BALLOT#u-me", "ROUND#lg-1~0001|BALLOT#u-you"]);
  assert.deepEqual(table.get("ROUND#lg-1~0001|BALLOT#u-me")?.picks, h2h.picks);
  assert.equal("picks" in table.get("ROUND#lg-1~0001|BALLOT#u-you")!, false);

  // (Compared as JSON: the existing mapping reads an absent `downvotes` as an
  // undefined-valued key, which is the same on the wire.)
  const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;
  assert.deepEqual(json(await repo.getBallot("lg-1~0001", "u-me")), h2h);
  const readPoints = await repo.getBallot("lg-1~0001", "u-you");
  assert.deepEqual(json(readPoints), points);
  assert.equal("picks" in readPoints!, false, "a points ballot reads back without a picks key");
  const all = await repo.getBallotsForRound("lg-1~0001");
  assert.deepEqual(json(all.sort((x, y) => x.voterId.localeCompare(y.voterId))), [h2h, points]);

  // A re-cast overwrites the one item, picks included.
  await repo.putBallot({ ...h2h, picks: { "lg-1~0001~M0": "sub-b" }, castAt: "2026-11-07T13:00:00.000Z" });
  assert.deepEqual((await repo.getBallot("lg-1~0001", "u-me"))?.picks, { "lg-1~0001~M0": "sub-b" });
  assert.equal((await repo.getBallotsForRound("lg-1~0001")).length, 2);
});

// ---- Rounds: the once-only head-to-head reveal (HTH-07) ----

test("revealRoundOnce without records: one conditional PutItem — lands while the round is unsettled and pins h2hDeparted / h2hTally; refused (writing nothing) once revealed / complete, or for a missing round", async () => {
  const { repo, table, sent } = fakeRepo();
  const voting: Round = { id: "lg-1~0001", leagueId: "lg-1", index: 1, theme: "Openers", status: "voting" };
  await repo.createRound(voting);
  // Rounds without the attributes (every standard round, any unrevealed one) read back without the keys.
  assert.equal("h2hDeparted" in table.get("LEAGUE#lg-1|ROUND#0001")!, false);
  assert.equal("h2hDeparted" in (await repo.getRound(voting.id))!, false);
  assert.equal("h2hTally" in (await repo.getRound(voting.id))!, false);

  const tally = [{ matchupId: "lg-1~0001~M0", votesA: 2, votesB: 1 }];
  sent.length = 0;
  assert.equal(await repo.revealRoundOnce({ ...voting, status: "revealed", h2hDeparted: ["u-gone"], h2hTally: tally }), true);
  assert.equal(sent.length, 1);
  const put = sent[0] as PutCommand;
  assert.ok(put instanceof PutCommand);
  assert.match(put.input.ConditionExpression ?? "", /attribute_exists\(PK\)/);
  assert.match(put.input.ConditionExpression ?? "", /#status <> :revealed AND #status <> :complete/);
  assert.deepEqual(put.input.ExpressionAttributeNames, { "#status": "status" });
  const item = table.get("LEAGUE#lg-1|ROUND#0001")!;
  assert.equal(item.status, "revealed");
  assert.deepEqual(item.h2hDeparted, ["u-gone"]);
  assert.deepEqual(item.h2hTally, tally);
  assert.deepEqual((await repo.getRound(voting.id))?.h2hDeparted, ["u-gone"]);
  assert.deepEqual((await repo.getRound(voting.id))?.h2hTally, tally);
  assert.deepEqual((await repo.getRoundsForLeague("lg-1"))[0]?.h2hTally, tally);

  // A second reveal (e.g. the loser of a race, holding a stale "voting" copy) writes nothing.
  assert.equal(await repo.revealRoundOnce({ ...voting, status: "revealed", h2hDeparted: [] }), false);
  assert.deepEqual(table.get("LEAGUE#lg-1|ROUND#0001")?.h2hDeparted, ["u-gone"]);

  // An ordinary round write (an owner's theme edit) keeps the pinned sets.
  await repo.updateRound({ ...(await repo.getRound(voting.id))!, theme: "Renamed" });
  assert.deepEqual((await repo.getRound(voting.id))?.h2hDeparted, ["u-gone"]);
  assert.deepEqual((await repo.getRound(voting.id))?.h2hTally, tally);

  // complete counts as settled too; an empty pinned set round-trips as an empty list.
  await repo.createRound({ ...voting, id: "lg-1~0002", index: 2, status: "complete" });
  assert.equal(await repo.revealRoundOnce({ ...voting, id: "lg-1~0002", index: 2, status: "revealed" }), false);
  await repo.createRound({ ...voting, id: "lg-1~0003", index: 3, status: "previewing" });
  assert.equal(await repo.revealRoundOnce({ ...voting, id: "lg-1~0003", index: 3, status: "revealed", h2hDeparted: [] }), true);
  assert.deepEqual((await repo.getRound("lg-1~0003"))?.h2hDeparted, []);

  // A missing round: no phantom item.
  assert.equal(await repo.revealRoundOnce({ ...voting, id: "lg-1~0009", index: 9, status: "revealed" }), false);
  assert.equal(table.has("LEAGUE#lg-1|ROUND#0009"), false);

  // Anything but a failed condition propagates.
  const boom = fakeRepo();
  Object.assign(boom.repo, {
    doc: { send: async () => { throw Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" }); } },
  });
  await assert.rejects(boom.repo.revealRoundOnce({ ...voting, status: "revealed" }), /throttled/);
});

/** Each STANDING# row's W/L/D in the fake table, by user. */
function storedRecords(table: Map<string, Item>): Record<string, string> {
  return Object.fromEntries(
    [...table.values()]
      .filter((it) => String(it.SK).startsWith("STANDING#"))
      .map((it) => [it.userId as string, `${it.wins ?? 0}-${it.losses ?? 0}-${it.draws ?? 0}`]),
  );
}

test("revealRoundOnce with records: ONE TransactWriteItems — the conditional round put plus every W/L/D increment — so the claim and the banking land together or not at all", async () => {
  const { repo, table, sent } = fakeRepo();
  const voting: Round = { id: "lg-1~0001", leagueId: "lg-1", index: 1, theme: "Openers", status: "voting" };
  await repo.createRound(voting);
  await repo.addStandingPoints("lg-1", "u-a", 0); // an existing row (joined earlier)
  const recs = [
    { userId: "u-a", delta: { wins: 1 } },
    { userId: "u-b", delta: { losses: 1 } },
    { userId: "u-c", delta: { draws: 1 } },
  ];
  const claimed: Round = { ...voting, status: "revealed", h2hDeparted: [], h2hTally: [] };

  sent.length = 0;
  assert.equal(await repo.revealRoundOnce(claimed, recs), true);
  assert.equal(sent.length, 1, "one request");
  const tx = sent[0] as TransactWriteCommand;
  assert.ok(tx instanceof TransactWriteCommand);
  const items = tx.input.TransactItems!;
  assert.equal(items.length, 4);
  assert.match(items[0]!.Put?.ConditionExpression ?? "", /attribute_exists\(PK\) AND #status <> :revealed AND #status <> :complete/);
  assert.equal(items[0]!.Put?.Item?.status, "revealed");
  assert.deepEqual(items.slice(1).map((t) => t.Update?.Key?.SK), ["STANDING#u-a", "STANDING#u-b", "STANDING#u-c"]);
  assert.ok(items.slice(1).every((t) => /if_not_exists/.test(t.Update?.UpdateExpression ?? "")), "in-place increments, like addStandingRecord");
  assert.equal(table.get("LEAGUE#lg-1|ROUND#0001")?.status, "revealed");
  assert.deepEqual(storedRecords(table), { "u-a": "1-0-0", "u-b": "0-1-0", "u-c": "0-0-1" });

  // The loser of a race: the claim fails, the whole transaction is cancelled, nothing banks twice.
  assert.equal(await repo.revealRoundOnce(claimed, recs), false);
  assert.deepEqual(storedRecords(table), { "u-a": "1-0-0", "u-b": "0-1-0", "u-c": "0-0-1" });

  // A failure that isn't the claim (throttling, a conflicting write) propagates
  // and leaves NOTHING written: the round stays in voting, ready to retry.
  const flaky = fakeRepo();
  await flaky.repo.createRound(voting);
  const realSend = (flaky.repo as unknown as { doc: { send: (c: unknown) => Promise<unknown> } }).doc.send;
  Object.assign(flaky.repo, {
    doc: {
      send: async (c: unknown) => {
        if (c instanceof TransactWriteCommand) {
          throw Object.assign(new Error("Transaction cancelled"), {
            name: "TransactionCanceledException",
            CancellationReasons: [{ Code: "None" }, { Code: "ThrottlingError" }],
          });
        }
        return realSend(c);
      },
    },
  });
  await assert.rejects(flaky.repo.revealRoundOnce(claimed, recs), /cancelled/);
  assert.equal(flaky.table.get("LEAGUE#lg-1|ROUND#0001")?.status, "voting");
  assert.deepEqual(storedRecords(flaky.table), {});

  // A bad increment is refused before anything is sent.
  const strict = fakeRepo();
  await strict.repo.createRound(voting);
  strict.sent.length = 0;
  await assert.rejects(strict.repo.revealRoundOnce(claimed, [{ userId: "u-a", delta: { wins: Number.NaN } }]), /integer/);
  assert.equal(strict.sent.length, 0);
});

test("revealRoundOnce: one entry per player (repeats summed — a transaction can't touch a row twice); past DynamoDB's 100-item cap it claims first, then banks row by row", async () => {
  const { repo, table, sent } = fakeRepo();
  const voting: Round = { id: "lg-1~0001", leagueId: "lg-1", index: 1, theme: "Openers", status: "voting" };
  await repo.createRound(voting);
  assert.equal(
    await repo.revealRoundOnce({ ...voting, status: "revealed" }, [
      { userId: "u-a", delta: { wins: 1 } },
      { userId: "u-a", delta: { draws: 1 } },
    ]),
    true,
  );
  assert.deepEqual(storedRecords(table), { "u-a": "1-0-1" });

  // 99 rows + the round = 100 items: still one transaction.
  const players = (n: number) => Array.from({ length: n }, (_, i) => ({ userId: `u-${i}`, delta: { wins: 1 } }));
  await repo.createRound({ ...voting, id: "lg-1~0002", index: 2 });
  sent.length = 0;
  assert.equal(await repo.revealRoundOnce({ ...voting, id: "lg-1~0002", index: 2, status: "revealed" }, players(99)), true);
  assert.deepEqual(sent.map((c) => (c as object).constructor.name), ["TransactWriteCommand"]);

  // 100 rows: the conditional round put, then one UpdateItem per row.
  await repo.createRound({ ...voting, id: "lg-1~0003", index: 3 });
  sent.length = 0;
  assert.equal(await repo.revealRoundOnce({ ...voting, id: "lg-1~0003", index: 3, status: "revealed" }, players(100)), true);
  assert.ok(sent[0] instanceof PutCommand);
  assert.equal(sent.length, 101);
  assert.ok(sent.slice(1).every((c) => c instanceof UpdateCommand));
  assert.equal(storedRecords(table)["u-99"], "1-0-0");
  assert.equal(storedRecords(table)["u-0"], "2-0-0", "rounds 2 and 3 each banked once");
  // …and a refused claim there banks nothing either.
  sent.length = 0;
  assert.equal(await repo.revealRoundOnce({ ...voting, id: "lg-1~0003", index: 3, status: "revealed" }, players(100)), false);
  assert.equal(sent.length, 1);
});

test("updateRoundUnlessSettled: the same conditional PutItem as the claim — lands on an unsettled round, refused (writing nothing) on a settled or missing one", async () => {
  const { repo, table, sent } = fakeRepo();
  const previewing: Round = { id: "lg-1~0001", leagueId: "lg-1", index: 1, theme: "Openers", status: "previewing" };
  await repo.createRound(previewing);
  sent.length = 0;
  assert.equal(await repo.updateRoundUnlessSettled({ ...previewing, status: "voting" }), true);
  const put = sent[0] as PutCommand;
  assert.ok(put instanceof PutCommand);
  assert.match(put.input.ConditionExpression ?? "", /attribute_exists\(PK\) AND #status <> :revealed AND #status <> :complete/);
  assert.equal(table.get("LEAGUE#lg-1|ROUND#0001")?.status, "voting");

  await repo.revealRoundOnce({ ...previewing, status: "revealed", h2hDeparted: ["u-x"] });
  // A stale "voting" copy can't un-reveal the round or drop its pins.
  assert.equal(await repo.updateRoundUnlessSettled({ ...previewing, status: "voting", theme: "Stale" }), false);
  assert.deepEqual(
    [table.get("LEAGUE#lg-1|ROUND#0001")?.status, table.get("LEAGUE#lg-1|ROUND#0001")?.h2hDeparted],
    ["revealed", ["u-x"]],
  );
  assert.equal(await repo.updateRoundUnlessSettled({ ...previewing, id: "lg-1~0009", index: 9 }), false);
  assert.equal(table.has("LEAGUE#lg-1|ROUND#0009"), false);
});

test("getRound({ consistent: true }) is a strongly consistent GetItem; the default read is unchanged", async () => {
  const { repo, sent } = fakeRepo();
  await repo.createRound({ id: "lg-1~0001", leagueId: "lg-1", index: 1, theme: "Openers", status: "voting" });
  sent.length = 0;
  await repo.getRound("lg-1~0001");
  await repo.getRound("lg-1~0001", { consistent: true });
  const [plain, strong] = sent as [GetCommand, GetCommand];
  assert.equal("ConsistentRead" in plain.input, false);
  assert.equal(strong.input.ConsistentRead, true);
});
