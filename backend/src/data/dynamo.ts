// DynamoRepository — the real single-table implementation behind the same
// Repository port the MemoryRepository implements. Schema is exactly
// docs/data-model-and-api.md §1:
//
//   League meta   PK=LEAGUE#<id>      SK=META
//   Membership    PK=LEAGUE#<id>      SK=MEMBER#<userId>   (+ GSI1: USER#<id> / LEAGUE#<id>)
//   Round         PK=LEAGUE#<id>      SK=ROUND#<index4>   (h2hDeparted + h2hTally once an H2H round is revealed)
//   Submission    PK=ROUND#<roundId>  SK=SUB#<userId>
//   Ballot        PK=ROUND#<roundId>  SK=BALLOT#<voterId>   (allocations; picks for H2H)
//   Standing      PK=LEAGUE#<id>      SK=STANDING#<userId>  (points; wins/losses/draws for H2H)
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
import type { Ballot, League, LeagueSettings, MatchupTally, Round, Submission } from "../domain/types.ts";
import { leagueFormat } from "../domain/types.ts";
import type { StandingRecordDelta, StandingTotals } from "../domain/standings.ts";
import { recordIncrements } from "../domain/standings.ts";
import type { SeasonFreeze } from "../domain/freeze.ts";
import type { Repository } from "./repository.ts";

const index4 = (n: number) => String(n).padStart(4, "0");

export class DynamoRepository implements Repository {
  // Plain fields (no constructor parameter properties) so this module also
  // loads under `node --experimental-strip-types`, which the offline unit
  // tests run with.
  private tableName: string;
  private doc: DynamoDBDocumentClient;
  constructor(tableName: string, client = new DynamoDBClient({})) {
    this.tableName = tableName;
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
        format: leagueFormat(league),
        settings: league.settings,
        inviteCode: league.inviteCode,
        visibility: league.visibility,
        maxMembers: league.maxMembers,
        roundCount: league.roundCount,
        progression: league.progression,
        startAt: league.startAt,
        phaseDays: league.phaseDays,
        // Head-to-head freeze fields (normally absent at creation — a rematch
        // never copies them — and written later by freezeH2HSeason). Undefined
        // values are dropped by removeUndefinedValues.
        h2hParticipants: league.h2hParticipants,
        h2hSalt: league.h2hSalt,
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

  async getLeague(leagueId: string, opts?: { consistent?: boolean }): Promise<League | undefined> {
    // Strongly consistent only when asked (the head-to-head freeze's
    // post-write check); every other read keeps the default, unchanged.
    const consistency = opts?.consistent ? { ConsistentRead: true } : {};
    const meta = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { PK: `LEAGUE#${leagueId}`, SK: "META" }, ...consistency }),
    );
    if (!meta.Item) return undefined;

    const members = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :m)",
        ExpressionAttributeValues: { ":pk": `LEAGUE#${leagueId}`, ":m": "MEMBER#" },
        ...consistency,
      }),
    );
    const memberIds = (members.Items ?? []).map((it) => it.userId as string);

    return {
      id: meta.Item.id,
      name: meta.Item.name,
      ownerId: meta.Item.ownerId,
      musicProvider: meta.Item.musicProvider,
      // Older leagues predate formats (no attribute) — they read as standard.
      // No migration: the default is applied on every read.
      format: leagueFormat(meta.Item),
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
      // Head-to-head season freeze (absent until round 1 opens, and on every
      // standard league). Server-only: handlers strip both from payloads.
      h2hParticipants: meta.Item.h2hParticipants as string[] | undefined,
      h2hSalt: meta.Item.h2hSalt as string | undefined,
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
    return this.scanLeagues("public");
  }
  async getAllLeagues(): Promise<League[]> {
    return this.scanLeagues();
  }
  /** Discovery/browse are low-frequency, small-result reads; a filtered Scan
   *  for the handful of league META rows is fine at this scale. If leagues
   *  ever grow large, promote this to a dedicated GSI. */
  private async scanLeagues(visibility?: "public" | "private"): Promise<League[]> {
    const metas: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression: visibility ? "entity = :e AND visibility = :v" : "entity = :e",
          ExpressionAttributeValues: visibility ? { ":e": "league", ":v": visibility } : { ":e": "league" },
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
    // Drop the membership row (and its GSI1 projection) ONLY. The standing row
    // is deliberately kept: a player who leaves (or is kicked) and later rejoins
    // gets their accumulated points back — the leaderboard just filters display
    // to current members while they're gone. (Standings are removed for real
    // only by deleteLeague's cascade.)
    await this.doc.send(
      new DeleteCommand({ TableName: this.tableName, Key: { PK: `LEAGUE#${leagueId}`, SK: `MEMBER#${userId}` } }),
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

  async addMemberUnlessSeasonLocked(leagueId: string, userId: string): Promise<League | undefined> {
    // One transaction: a ConditionCheck on META (season not frozen — no or an
    // empty frozen order — or the joiner already in it) plus the MEMBER# put.
    // DynamoDB serializes it against the freeze's UpdateItem on the same META,
    // so a join either commits before the freeze (and the opener's post-write
    // check takes the joiner in) or fails here — never lands outside the
    // schedule. A failed season check means "locked" (undefined); anything
    // else (e.g. a TransactionConflict) propagates.
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: { PK: `LEAGUE#${leagueId}`, SK: "META" },
                ConditionExpression:
                  "attribute_not_exists(h2hParticipants) OR size(h2hParticipants) = :zero OR contains(h2hParticipants, :u)",
                ExpressionAttributeValues: { ":zero": 0, ":u": userId },
              },
            },
            { Put: { TableName: this.tableName, Item: this.memberItem(leagueId, userId) } },
          ],
        }),
      );
    } catch (err) {
      const e = err as { name?: string; CancellationReasons?: Array<{ Code?: string }> } | null;
      if (e?.name === "TransactionCanceledException" && e.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed") {
        return undefined;
      }
      throw err;
    }
    const lg = await this.getLeague(leagueId);
    if (!lg) throw new Error(`League not found after addMemberUnlessSeasonLocked: ${leagueId}`);
    return lg;
  }

  async freezeH2HSeason(leagueId: string, freeze: SeasonFreeze, replacesSalt?: string): Promise<boolean> {
    // One conditional UpdateItem on META: the order, its salt and the
    // schedule-derived roundCount land together or not at all. The initial
    // freeze lands only while the season isn't frozen (no, or an empty,
    // frozen order — seasonLocked's definition), so two concurrent round-1
    // opens can't both shuffle; a re-plan lands only over the exact salt it
    // read. Losing either race is a normal outcome (false), not an error.
    // attribute_exists(PK): never create a phantom META for a deleted league.
    const condition =
      replacesSalt === undefined
        ? "attribute_exists(PK) AND (attribute_not_exists(h2hParticipants) OR size(h2hParticipants) = :zero)"
        : "attribute_exists(PK) AND h2hSalt = :old";
    const guard = replacesSalt === undefined ? { ":zero": 0 } : { ":old": replacesSalt };
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: `LEAGUE#${leagueId}`, SK: "META" },
          UpdateExpression: "SET h2hParticipants = :p, h2hSalt = :s, roundCount = :n",
          ConditionExpression: condition,
          ExpressionAttributeValues: { ":p": freeze.participants, ":s": freeze.salt, ":n": freeze.roundCount, ...guard },
        }),
      );
      return true;
    } catch (err) {
      if ((err as { name?: string } | null)?.name === "ConditionalCheckFailedException") return false;
      throw err;
    }
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
  async deleteInvite(code: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.tableName, Key: { PK: `INVITE#${code.toUpperCase()}`, SK: "META" } }),
    );
  }
  async updateInviteCode(leagueId: string, code: string): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { PK: `LEAGUE#${leagueId}`, SK: "META" },
        UpdateExpression: "SET inviteCode = :c",
        ExpressionAttributeValues: { ":c": code },
      }),
    );
  }

  // ---- Rounds ----
  async createRound(round: Round): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.tableName, Item: this.roundItem(round) }));
  }
  async getRound(roundId: string, opts?: { consistent?: boolean }): Promise<Round | undefined> {
    // roundId encodes its league + index as `<leagueId>~<index4>` (see roundItem).
    const sep = roundId.lastIndexOf("~");
    if (sep < 0) return undefined;
    const leagueId = roundId.slice(0, sep);
    const idx = roundId.slice(sep + 1);
    // Strongly consistent only when asked (the head-to-head reveal's re-read
    // after losing its claim); every other read keeps the default, unchanged.
    const res = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: `LEAGUE#${leagueId}`, SK: `ROUND#${idx}` },
        ...(opts?.consistent ? { ConsistentRead: true } : {}),
      }),
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
  async updateRoundUnlessSettled(round: Round): Promise<boolean> {
    // One conditional PutItem: the whole round item lands only while the
    // stored round isn't settled — roundSettled's definition — so a write
    // built from a copy read before a reveal can't un-reveal the round, and
    // of two concurrent reveals exactly one wins. The loser writes nothing.
    try {
      await this.doc.send(new PutCommand({ TableName: this.tableName, Item: this.roundItem(round), ...UNSETTLED_ROUND }));
      return true;
    } catch (err) {
      if ((err as { name?: string } | null)?.name === "ConditionalCheckFailedException") return false;
      throw err;
    }
  }
  async revealRoundOnce(
    round: Round,
    records: ReadonlyArray<{ userId: string; delta: StandingRecordDelta }> = [],
  ): Promise<boolean> {
    const banked = mergeRecords(records); // validates every increment before any write
    if (banked.length === 0) return this.updateRoundUnlessSettled(round);
    if (banked.length + 1 > MAX_TRANSACT_ITEMS) {
      // Too many standing rows for one transaction (a 100+-player league):
      // claim first, then bank row by row — at most once (a failure part-way
      // leaves the round revealed with rows missing) but never twice.
      if (!(await this.updateRoundUnlessSettled(round))) return false;
      for (const { userId, inc } of banked) await this.addStandingRecord(round.leagueId, userId, inc);
      return true;
    }
    // One TransactWriteItems: the conditional round write (the claim) plus
    // every standing row's in-place W/L/D increment — all land or none do.
    // A refused claim (another reveal settled it) cancels the whole
    // transaction with ConditionalCheckFailed on item 0: nothing is banked.
    // Any other failure (throttling, a conflict with a concurrent write)
    // also writes nothing, and the round is still in voting to reveal again.
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: this.tableName, Item: this.roundItem(round), ...UNSETTLED_ROUND } },
            ...banked.map(({ userId, inc }) => ({ Update: this.standingRecordUpdate(round.leagueId, userId, inc) })),
          ],
        }),
      );
      return true;
    } catch (err) {
      const e = err as { name?: string; CancellationReasons?: Array<{ Code?: string }> } | null;
      if (e?.name === "TransactionCanceledException" && e.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed") {
        return false;
      }
      throw err;
    }
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
      h2hDeparted: round.h2hDeparted, // head-to-head, pinned at the reveal (undefined → not stored)
      h2hTally: round.h2hTally, // head-to-head, pinned at the reveal (undefined → not stored)
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
      // Only revealed head-to-head rounds carry it; every other round reads
      // back without the key, exactly as before.
      ...(Array.isArray(it.h2hDeparted) ? { h2hDeparted: it.h2hDeparted as string[] } : {}),
      ...(Array.isArray(it.h2hTally) ? { h2hTally: it.h2hTally as MatchupTally[] } : {}),
    };
  }

  // ---- Submissions ----
  // Keyed SUB#<userId>#<submissionId> so a player can hold several per round.
  // Rows written before multi-submission used SK = SUB#<userId> (no id); reads
  // filter on the userId attribute rather than the key, so both shapes work.
  async putSubmission(submission: Submission): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `ROUND#${submission.roundId}`,
          SK: `SUB#${submission.userId}#${submission.id}`,
          entity: "submission",
          id: submission.id,
          roundId: submission.roundId,
          userId: submission.userId,
          track: submission.track,
          comment: submission.comment,
          submittedAt: submission.submittedAt ?? new Date().toISOString(),
        },
      }),
    );
  }
  async getSubmissionsForUser(roundId: string, userId: string): Promise<Submission[]> {
    return (await this.rawSubmissionItems(roundId, userId)).map((it) => this.toSubmission(it));
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
  async deleteSubmission(roundId: string, userId: string, submissionId: string): Promise<void> {
    // Look the row up first so legacy keys (no id suffix) delete correctly.
    const item = (await this.rawSubmissionItems(roundId, userId)).find((it) => it.id === submissionId);
    if (!item) return;
    await this.doc.send(
      new DeleteCommand({ TableName: this.tableName, Key: { PK: item.PK, SK: item.SK } }),
    );
  }
  /** One player's raw submission rows (keys included). The key prefix
   *  SUB#<userId> would also match users whose id extends this one, so filter
   *  on the userId attribute. */
  private async rawSubmissionItems(roundId: string, userId: string): Promise<Array<Record<string, unknown>>> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :s)",
        ExpressionAttributeValues: { ":pk": `ROUND#${roundId}`, ":s": `SUB#${userId}` },
      }),
    );
    return (res.Items ?? []).filter((it) => it.userId === userId);
  }
  private toSubmission(it: Record<string, unknown>): Submission {
    return {
      id: it.id as string,
      roundId: it.roundId as string,
      userId: it.userId as string,
      track: it.track as Submission["track"],
      comment: it.comment as string | undefined,
      submittedAt: it.submittedAt as string | undefined,
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
          downvotes: ballot.downvotes,
          // Head-to-head winner picks (absent on standard ballots — dropped by
          // removeUndefinedValues, so a points ballot's item is unchanged).
          picks: ballot.picks,
          comments: ballot.comments,
          castAt: ballot.castAt,
        },
      }),
    );
  }
  async getBallot(roundId: string, voterId: string): Promise<Ballot | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { PK: `ROUND#${roundId}`, SK: `BALLOT#${voterId}` } }),
    );
    if (!res.Item) return undefined;
    const it = res.Item;
    return {
      roundId: it.roundId as string,
      voterId: it.voterId as string,
      allocations: (it.allocations ?? {}) as Record<string, number>,
      downvotes: it.downvotes as Record<string, number> | undefined,
      ...(it.picks ? { picks: it.picks as Record<string, string> } : {}),
      comments: it.comments as Record<string, string> | undefined,
      castAt: it.castAt as string,
    };
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
      downvotes: it.downvotes as Record<string, number> | undefined,
      ...(it.picks ? { picks: it.picks as Record<string, string> } : {}),
      comments: it.comments as Record<string, string> | undefined,
      castAt: it.castAt as string,
    }));
  }

  // ---- Standings ----
  async getStandings(leagueId: string): Promise<StandingTotals[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :s)",
        ExpressionAttributeValues: { ":pk": `LEAGUE#${leagueId}`, ":s": "STANDING#" },
      }),
    );
    // W/L/D are plain attributes on the same item, absent on every row written
    // before head-to-head existed — those read back as 0 (no migration).
    return (res.Items ?? []).map((it) => ({
      userId: it.userId as string,
      points: (it.points as number) ?? 0,
      wins: (it.wins as number) ?? 0,
      losses: (it.losses as number) ?? 0,
      draws: (it.draws as number) ?? 0,
    }));
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
  async addStandingRecord(leagueId: string, userId: string, delta: StandingRecordDelta): Promise<void> {
    await this.doc.send(new UpdateCommand(this.standingRecordUpdate(leagueId, userId, delta)));
  }
  /** The W/L/D increment's UpdateItem — sent alone by addStandingRecord, and
   *  as one item of the head-to-head reveal's transaction. Same item and same
   *  atomic in-place increment as addStandingPoints: every counter created at
   *  0 if absent, `points` untouched. Attribute names go through placeholders
   *  so no counter name can ever collide with a DynamoDB reserved word.
   *  Validates the delta (recordIncrements) before anything is sent. */
  private standingRecordUpdate(leagueId: string, userId: string, delta: StandingRecordDelta) {
    const inc = recordIncrements(delta);
    return {
      TableName: this.tableName,
      Key: { PK: `LEAGUE#${leagueId}`, SK: `STANDING#${userId}` },
      UpdateExpression:
        "SET #w = if_not_exists(#w, :zero) + :w, #l = if_not_exists(#l, :zero) + :l, " +
        "#d = if_not_exists(#d, :zero) + :d, userId = :u, entity = :e",
      ExpressionAttributeNames: { "#w": "wins", "#l": "losses", "#d": "draws" },
      ExpressionAttributeValues: {
        ":zero": 0, ":w": inc.wins, ":l": inc.losses, ":d": inc.draws, ":u": userId, ":e": "standing",
      },
    };
  }
}

/** DynamoDB's cap on the items of one TransactWriteItems call. */
const MAX_TRANSACT_ITEMS = 100;

/** The condition every settle-guarded round write carries: the round exists
 *  (never a phantom item for one that was deleted) and isn't settled —
 *  roundSettled's definition. `status` is a DynamoDB reserved word, hence the
 *  placeholder. */
const UNSETTLED_ROUND = {
  ConditionExpression: "attribute_exists(PK) AND #status <> :revealed AND #status <> :complete",
  ExpressionAttributeNames: { "#status": "status" },
  ExpressionAttributeValues: { ":revealed": "revealed", ":complete": "complete" },
};

/** A reveal's records as one validated increment per player — a transaction
 *  can't touch the same standing row twice, so repeated players are summed
 *  (the reveal never sends any: nobody plays twice in a round). */
function mergeRecords(
  records: ReadonlyArray<{ userId: string; delta: StandingRecordDelta }>,
): Array<{ userId: string; inc: ReturnType<typeof recordIncrements> }> {
  const byUser = new Map<string, ReturnType<typeof recordIncrements>>();
  for (const { userId, delta } of records) {
    const inc = recordIncrements(delta);
    const prev = byUser.get(userId);
    byUser.set(userId, prev ? { wins: prev.wins + inc.wins, losses: prev.losses + inc.losses, draws: prev.draws + inc.draws } : inc);
  }
  return [...byUser].map(([userId, inc]) => ({ userId, inc }));
}
