// DynamoRepository league-META mapping tests — fully offline. No SDK client is
// constructed and nothing leaves the process: the repository's document
// client is swapped for an in-process fake that stores items in a Map, so
// these exercise only our own item <-> League mapping (e.g. the `format`
// attribute: written on create, defaulted to "standard" on legacy rows).

import { test } from "node:test";
import assert from "node:assert/strict";
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoRepository } from "./dynamo.ts";
import { DEFAULT_LEAGUE_SETTINGS } from "../domain/types.ts";
import type { League } from "../domain/types.ts";

type Item = Record<string, unknown>;

/** A DynamoRepository over a Map-backed fake of the three commands the
 *  league read/write path uses. Built without running the constructor, so no
 *  DynamoDBClient (credentials/region/network) is ever created. */
function fakeRepo(): { repo: DynamoRepository; table: Map<string, Item> } {
  const table = new Map<string, Item>();
  const key = (pk: unknown, sk: unknown) => `${String(pk)}|${String(sk)}`;
  const send = async (cmd: unknown): Promise<unknown> => {
    if (cmd instanceof TransactWriteCommand) {
      for (const t of cmd.input.TransactItems ?? []) {
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
    if (cmd instanceof UpdateCommand) {
      const k = key(cmd.input.Key?.PK, cmd.input.Key?.SK);
      const item: Item = table.get(k) ?? { ...cmd.input.Key };
      applySetExpression(item, cmd.input.UpdateExpression ?? "", cmd.input.ExpressionAttributeNames ?? {}, cmd.input.ExpressionAttributeValues ?? {});
      table.set(k, item);
      return {};
    }
    throw new Error(`fake doc client: unexpected command ${(cmd as object).constructor.name}`);
  };
  const repo = Object.create(DynamoRepository.prototype) as DynamoRepository;
  Object.assign(repo, { tableName: "MusicLeague-test", doc: { send } });
  return { repo, table };
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
