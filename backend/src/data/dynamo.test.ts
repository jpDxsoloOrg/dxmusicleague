// DynamoRepository league-META mapping tests — fully offline. No SDK client is
// constructed and nothing leaves the process: the repository's document
// client is swapped for an in-process fake that stores items in a Map, so
// these exercise only our own item <-> League mapping (e.g. the `format`
// attribute: written on create, defaulted to "standard" on legacy rows).

import { test } from "node:test";
import assert from "node:assert/strict";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
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
      const prefix = String(values[":m"] ?? "");
      return { Items: [...table.values()].filter((it) => it.PK === pk && String(it.SK).startsWith(prefix)) };
    }
    throw new Error(`fake doc client: unexpected command ${(cmd as object).constructor.name}`);
  };
  const repo = Object.create(DynamoRepository.prototype) as DynamoRepository;
  Object.assign(repo, { tableName: "MusicLeague-test", doc: { send } });
  return { repo, table };
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
