// DynamoRepository — the real single-table implementation behind the same
// Repository port the MemoryRepository implements. Schema is exactly
// docs/data-model-and-api.md §1:
//
//   League meta   PK=LEAGUE#<id>      SK=META
//   Membership    PK=LEAGUE#<id>      SK=MEMBER#<userId>   (+ GSI1: USER#<id> / LEAGUE#<id>)
//   Round         PK=LEAGUE#<id>      SK=ROUND#<index4>
//   Submission    PK=ROUND#<roundId>  SK=SUB#<userId>
//   Ballot        PK=ROUND#<roundId>  SK=BALLOT#<voterId>
//   Standing      PK=LEAGUE#<id>      SK=STANDING#<userId>
//   Invite        PK=INVITE#<code>    SK=META
//
// The league-loop methods (create/get/list/addMember/invites/rounds/standings)
// are fully implemented. Submission/ballot methods follow the same pattern and
// are exercised once the round + voting handlers land (build-order steps 3–4).

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Ballot, League, LeagueSettings, Round, Submission } from "../domain/types.ts";
import type { Repository } from "./repository.ts";

const index4 = (n: number) => String(n).padStart(4, "0");

export class DynamoRepository implements Repository {
  private doc: DynamoDBDocumentClient;
  constructor(private tableName: string, client = new DynamoDBClient({})) {
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  // ---- Leagues ----
  async createLeague(league: League): Promise<void> {
    // META + one MEMBER# per seeded member (the owner), written atomically.
    const items = [
      {
        PK: `LEAGUE#${league.id}`,
        SK: "META",
        entity: "league",
        id: league.id,
        name: league.name,
        ownerId: league.ownerId,
        musicProvider: league.musicProvider,
        settings: league.settings,
        inviteCode: league.inviteCode,
        visibility: league.visibility,
        maxMembers: league.maxMembers,
        roundCount: league.roundCount,
        progression: league.progression,
        startAt: league.startAt,
        phaseDays: league.phaseDays,
        createdAt: new Date().toISOString(),
      },
      ...league.memberIds.map((userId) => this.memberItem(league.id, userId)),
    ];
    await this.doc.send(
      new TransactWriteCommand({
        TransactItems: items.map((Item) => ({ Put: { TableName: this.tableName, Item } })),
      }),
    );
  }

  async getLeague(leagueId: string): Promise<League | undefined> {
    const meta = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { PK: `LEAGUE#${leagueId}`, SK: "META" } }),
    );
    if (!meta.Item) return undefined;

    const members = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :m)",
        ExpressionAttributeValues: { ":pk": `LEAGUE#${leagueId}`, ":m": "MEMBER#" },
      }),
    );
    const memberIds = (members.Items ?? []).map((it) => it.userId as string);

    return {
      id: meta.Item.id,
      name: meta.Item.name,
      ownerId: meta.Item.ownerId,
      musicProvider: meta.Item.musicProvider,
      settings: meta.Item.settings,
      memberIds,
      // Older leagues created before invite codes were stored on META fall back to "".
      inviteCode: (meta.Item.inviteCode as string | undefined) ?? "",
      // Older leagues predate visibility — treat them as private.
      visibility: (meta.Item.visibility as League["visibility"] | undefined) ?? "private",
      maxMembers: meta.Item.maxMembers as number | undefined,
      // Legacy leagues predate roundCount → 0, which the view models fall back
      // from to the count of created rounds.
      roundCount: (meta.Item.roundCount as number | undefined) ?? 0,
      // Older leagues predate timed progression — treat them as manual.
      progression: (meta.Item.progression as League["progression"] | undefined) ?? "manual",
      startAt: meta.Item.startAt as string | undefined,
      phaseDays: meta.Item.phaseDays as number | undefined,
    };
  }

  async getLeaguesForUser(userId: string): Promise<League[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :u",
        ExpressionAttributeValues: { ":u": `USER#${userId}` },
      }),
    );
    const leagueIds = (res.Items ?? []).map((it) => it.leagueId as string);
    const leagues = await Promise.all(leagueIds.map((id) => this.getLeague(id)));
    return leagues.filter((lg): lg is League => Boolean(lg));
  }

  async getPublicLeagues(): Promise<League[]> {
    // Discovery is a low-frequency, small-result read; a filtered Scan for the
    // handful of public league META rows is fine at this scale. If public
    // leagues ever grow large, promote this to a dedicated GSI.
    const metas: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression: "entity = :e AND visibility = :v",
          ExpressionAttributeValues: { ":e": "league", ":v": "public" },
          ExclusiveStartKey: start,
        }),
      );
      for (const it of res.Items ?? []) metas.push(it);
      start = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (start);

    // Hydrate each with its members (a separate query per league).
    const leagues = await Promise.all(metas.map((it) => this.getLeague(it.id as string)));
    return leagues.filter((lg): lg is League => Boolean(lg));
  }

  async addMember(leagueId: string, userId: string): Promise<League> {
    await this.doc.send(new PutCommand({ TableName: this.tableName, Item: this.memberItem(leagueId, userId) }));
    const lg = await this.getLeague(leagueId);
    if (!lg) throw new Error(`League not found after addMember: ${leagueId}`);
    return lg;
  }

  async removeMember(leagueId: string, userId: string): Promise<void> {
    // Drop the membership row (and its GSI1 projection) plus the standing row.
    await this.doc.send(
      new DeleteCommand({ TableName: this.tableName, Key: { PK: `LEAGUE#${leagueId}`, SK: `MEMBER#${userId}` } }),
    );
    await this.doc.send(
      new DeleteCommand({ TableName: this.tableName, Key: { PK: `LEAGUE#${leagueId}`, SK: `STANDING#${userId}` } }),
    );
  }

  async updateLeagueSettings(leagueId: string, settings: LeagueSettings): Promise<League> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { PK: `LEAGUE#${leagueId}`, SK: "META" },
        UpdateExpression: "SET settings = :s",
        ConditionExpression: "attribute_exists(PK)", // fail loud if the league is gone
        ExpressionAttributeValues: { ":s": settings },
      }),
    );
    const lg = await this.getLeague(leagueId);
    if (!lg) throw new Error(`League not found after updateLeagueSettings: ${leagueId}`);
    return lg;
  }

  async deleteLeague(leagueId: string): Promise<void> {
    // 1) Everything under PK=LEAGUE#<id>: META, MEMBER#, ROUND#, STANDING#.
    const leagueItems = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": `LEAGUE#${leagueId}` },
      }),
    );
    const keys: Array<{ PK: string; SK: string }> = (leagueItems.Items ?? []).map((it) => ({
      PK: it.PK as string,
      SK: it.SK as string,
    }));

    // 2) Per-round children live under their own PK=ROUND#<roundId>.
    const roundIds = (leagueItems.Items ?? [])
      .filter((it) => typeof it.SK === "string" && (it.SK as string).startsWith("ROUND#"))
      .map((it) => it.roundId as string);
    for (const roundId of roundIds) {
      const children = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": `ROUND#${roundId}` },
        }),
      );
      for (const it of children.Items ?? []) keys.push({ PK: it.PK as string, SK: it.SK as string });
    }

    // 3) The invite-code lookup row (separate partition).
    const inviteCode = (leagueItems.Items ?? []).find((it) => it.SK === "META")?.inviteCode as string | undefined;
    if (inviteCode) keys.push({ PK: `INVITE#${inviteCode.toUpperCase()}`, SK: "META" });

    // BatchWrite caps at 25 deletes per request — chunk it.
    for (let i = 0; i < keys.length; i += 25) {
      const chunk = keys.slice(i, i + 25);
      await this.doc.send(
        new BatchWriteCommand({
          RequestItems: { [this.tableName]: chunk.map((Key) => ({ DeleteRequest: { Key } })) },
        }),
      );
    }
  }

  private memberItem(leagueId: string, userId: string) {
    return {
      PK: `LEAGUE#${leagueId}`,
      SK: `MEMBER#${userId}`,
      entity: "membership",
      leagueId,
      userId,
      joinedAt: new Date().toISOString(),
      GSI1PK: `USER#${userId}`,
      GSI1SK: `LEAGUE#${leagueId}`,
    };
  }

  // ---- Invites ----
  async putInvite(code: string, leagueId: string): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { PK: `INVITE#${code.toUpperCase()}`, SK: "META", entity: "invite", leagueId },
      }),
    );
  }
  async getLeagueIdForInvite(code: string): Promise<string | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { PK: `INVITE#${code.toUpperCase()}`, SK: "META" } }),
    );
    return res.Item?.leagueId as string | undefined;
  }

  // ---- Rounds ----
  async createRound(round: Round): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.tableName, Item: this.roundItem(round) }));
  }
  async getRound(roundId: string): Promise<Round | undefined> {
    // roundId encodes its league + index as `<leagueId>~<index4>` (see roundItem).
    const sep = roundId.lastIndexOf("~");
    if (sep < 0) return undefined;
    const leagueId = roundId.slice(0, sep);
    const idx = roundId.slice(sep + 1);
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { PK: `LEAGUE#${leagueId}`, SK: `ROUND#${idx}` } }),
    );
    return res.Item ? this.toRound(res.Item) : undefined;
  }
  async getRoundsForLeague(leagueId: string): Promise<Round[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :r)",
        ExpressionAttributeValues: { ":pk": `LEAGUE#${leagueId}`, ":r": "ROUND#" },
      }),
    );
    return (res.Items ?? []).map((it) => this.toRound(it));
  }
  async updateRound(round: Round): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.tableName, Item: this.roundItem(round) }));
  }
  private roundItem(round: Round) {
    return {
      PK: `LEAGUE#${round.leagueId}`,
      SK: `ROUND#${index4(round.index)}`,
      entity: "round",
      roundId: `${round.leagueId}~${index4(round.index)}`,
      leagueId: round.leagueId,
      index: round.index,
      theme: round.theme,
      description: round.description,
      status: round.status,
      submissionDeadline: round.submissionDeadline,
      previewDeadline: round.previewDeadline,
      voteDeadline: round.voteDeadline,
      playlistUrl: round.playlistUrl,
    };
  }
  private toRound(it: Record<string, unknown>): Round {
    return {
      id: it.roundId as string,
      leagueId: it.leagueId as string,
      index: it.index as number,
      theme: it.theme as string,
      description: it.description as string | undefined,
      status: it.status as Round["status"],
      submissionDeadline: it.submissionDeadline as string | undefined,
      previewDeadline: it.previewDeadline as string | undefined,
      voteDeadline: it.voteDeadline as string | undefined,
      playlistUrl: it.playlistUrl as string | undefined,
    };
  }

  // ---- Submissions ----
  async putSubmission(submission: Submission): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `ROUND#${submission.roundId}`,
          SK: `SUB#${submission.userId}`,
          entity: "submission",
          id: submission.id,
          roundId: submission.roundId,
          userId: submission.userId,
          track: submission.track,
          comment: submission.comment,
          submittedAt: new Date().toISOString(),
        },
      }),
    );
  }
  async getSubmission(roundId: string, userId: string): Promise<Submission | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { PK: `ROUND#${roundId}`, SK: `SUB#${userId}` } }),
    );
    return res.Item ? this.toSubmission(res.Item) : undefined;
  }
  async getSubmissionsForRound(roundId: string): Promise<Submission[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :s)",
        ExpressionAttributeValues: { ":pk": `ROUND#${roundId}`, ":s": "SUB#" },
      }),
    );
    return (res.Items ?? []).map((it) => this.toSubmission(it));
  }
  private toSubmission(it: Record<string, unknown>): Submission {
    return {
      id: it.id as string,
      roundId: it.roundId as string,
      userId: it.userId as string,
      track: it.track as Submission["track"],
      comment: it.comment as string | undefined,
    };
  }

  // ---- Ballots ----
  async putBallot(ballot: Ballot): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `ROUND#${ballot.roundId}`,
          SK: `BALLOT#${ballot.voterId}`,
          entity: "ballot",
          roundId: ballot.roundId,
          voterId: ballot.voterId,
          allocations: ballot.allocations,
          comments: ballot.comments,
          castAt: ballot.castAt,
        },
      }),
    );
  }
  async getBallotsForRound(roundId: string): Promise<Ballot[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :b)",
        ExpressionAttributeValues: { ":pk": `ROUND#${roundId}`, ":b": "BALLOT#" },
      }),
    );
    return (res.Items ?? []).map((it) => ({
      roundId: it.roundId as string,
      voterId: it.voterId as string,
      allocations: (it.allocations ?? {}) as Record<string, number>,
      comments: it.comments as Record<string, string> | undefined,
      castAt: it.castAt as string,
    }));
  }

  // ---- Standings ----
  async getStandings(leagueId: string): Promise<Array<{ userId: string; points: number }>> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :s)",
        ExpressionAttributeValues: { ":pk": `LEAGUE#${leagueId}`, ":s": "STANDING#" },
      }),
    );
    return (res.Items ?? []).map((it) => ({ userId: it.userId as string, points: (it.points as number) ?? 0 }));
  }
  async addStandingPoints(leagueId: string, userId: string, delta: number): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { PK: `LEAGUE#${leagueId}`, SK: `STANDING#${userId}` },
        UpdateExpression: "SET points = if_not_exists(points, :zero) + :d, userId = :u, entity = :e",
        ExpressionAttributeValues: { ":zero": 0, ":d": delta, ":u": userId, ":e": "standing" },
      }),
    );
  }
}
