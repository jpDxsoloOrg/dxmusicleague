# DX Music League — Backend

REST API for the Music League clone. Built on **AWS CDK** (DynamoDB + Cognito +
API Gateway + Lambda), but designed so the **exact same handlers run locally
against an in-memory mock** — you can build the whole app with no AWS account.

Implements the contract in [../docs/data-model-and-api.md](../docs/data-model-and-api.md).

## The one idea: one set of handlers, two backends

```
                       ┌──────────────────────┐
  local dev  ───────▶  │  routes.ts (shared)  │  ◀─────── API Gateway + Lambda
  http/local-server.ts │  handlers/*.ts       │           http/lambda.ts
  (Node http,          │  domain/rules.ts     │           (Cognito-authorized)
   x-dev-user auth)    └──────────┬───────────┘
                                  │ Repository port (data/repository.ts)
                     ┌────────────┴────────────┐
            MemoryRepository            DynamoRepository
            (data/memory.ts)            (data/dynamo.ts)
            seeded mock data            single-table DynamoDB
```

Handlers depend only on the `Repository` interface. Locally they run against
`MemoryRepository` (seeded with the same fixtures as the frontend mock);
deployed, the identical code runs on Lambda against `DynamoRepository`.

## Run locally (no AWS)

```bash
cd backend
npm install
npm run dev          # → http://127.0.0.1:8787, in-memory store (PORT=… to change)
```

The store is re-seeded on every start (and on every `--watch` reload), so a restart
resets it. Auth is stubbed: send `x-dev-user: <id>` to act as a seed user (default `u-me`).
Seed users: `u-me` (Curator Max), `u-sarah`, `u-james`, `u-mia`, `u-jpop`, `u-luna`.

```bash
curl http://127.0.0.1:8787/leagues                          # my leagues
curl http://127.0.0.1:8787/leagues/lg-synthwave             # league detail (standings embedded)
curl -X POST http://127.0.0.1:8787/leagues \
  -H 'Content-Type: application/json' \
  -d '{"name":"My League","musicProvider":"youtube-music","roundCount":3}' # create
curl -X POST http://127.0.0.1:8787/leagues/join \
  -H 'Content-Type: application/json' -d '{"code":"INDIE-25"}'
```

The seed includes one **head-to-head** league, Friday Faceoff (`lg-faceoff`, invite code
`FACE-5`): five players, round 1 revealed (a draw and a walkover), round 2 (`r-ff-2`) in voting.
Its season is locked, so a newcomer's join is refused with a 409.

```bash
curl http://127.0.0.1:8787/rounds/r-ff-2/matchups -H 'x-dev-user: u-me'     # anonymous matchups, yours flagged isMine
curl http://127.0.0.1:8787/rounds/r-ff-1/results                            # revealed: { format: "headToHead", matchups, bye }
curl -X POST http://127.0.0.1:8787/leagues/join -H 'x-dev-user: u-luna' \
  -H 'Content-Type: application/json' -d '{"code":"FACE-5"}'                # 409 "Season locked — …"
```

Spotify is the only outside service the backend calls. Its credentials come from the
environment: `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET` (with `SPOTIFY_REFRESH_TOKEN`), which
win when both are set, or else `SPOTIFY_SECRET_ID` naming a Secrets Manager secret that holds
`{ clientId, clientSecret, refreshToken }`. Search needs only the client id and secret: without
them `GET /spotify/search` answers 500 (an empty `q` still returns no tracks). A Spotify league's
round playlist also needs the refresh token, the host account's (`playlist-modify-public`):
without it the playlist is skipped with an error logged, and the round advances anyway.

## Test & typecheck

```bash
npm test         # node:test: domain rules, handlers over the in-memory store, both repositories (no infra)
npm run typecheck
```

## Deploy (real AWS)

```bash
npm run synth                 # validate the stack (no AWS creds needed)
npx cdk bootstrap             # once per account/region
npx cdk deploy                # provisions Table, Cognito, API GW, Lambda, site bucket + CDN
```

Outputs `ApiUrl`, `UserPoolId`, `UserPoolClientId`, `TableName` for the frontend, plus
`SiteBucketName`, `DistributionId` and `SiteUrl` for the hosted web app (S3 + CloudFront).

## Status

The whole league loop is wired in [src/http/routes.ts](src/http/routes.ts), over both
repositories:

- **Leagues** — create (points or head-to-head `format`), list, detail, join by code,
  public discovery / preview / claim a spot, browse to spectate, leave / kick, regenerate the
  invite, settings, delete, rematch.
- **Rounds** — create, and the `draft → submitting → previewing → voting` lifecycle (owner
  PATCH, or the lazy auto-advance of timed leagues); a Spotify league's round playlist is made
  when submissions close.
- **Submissions** — submit (up to the league's songs per player), list your own, remove one,
  and the anonymized vote list.
- **Ballots** — points ballots, head-to-head winner `picks`, and `my-ballot` for pre-fill,
  all refereed by [src/domain/rules.ts](src/domain/rules.ts).
- **Reveal / results** — ranked results for points rounds, matchup results for head-to-head
  rounds, banked exactly once.
- **Standings** — points, or W/L/D for head-to-head, embedded in the league detail
  (`GET /leagues/:leagueId`).
- **Matchups** — `GET /rounds/:roundId/matchups`, the anonymous head-to-head view.
- **Spotify search proxy** — `GET /spotify/search`.

The API contract is in [../docs/data-model-and-api.md](../docs/data-model-and-api.md); the
head-to-head design notes are in
[../docs/plans/head-to-head-format.md](../docs/plans/head-to-head-format.md).

## Layout

| Path | What |
|---|---|
| `src/domain/` | Types, typed errors and the pure rules: the referee (`rules.ts`), standings order (`standings.ts`), and for head-to-head the round-robin schedule (`schedule.ts`), season freeze (`freeze.ts`) and matchup derivation + turnout (`matchups.ts`) |
| `src/data/repository.ts` | The data-access port both backends implement |
| `src/data/memory.ts` | In-memory store + seed data (local + tests) |
| `src/data/seedHeadToHead.ts` | The seeded head-to-head league, shared with the frontend mock |
| `src/data/dynamo.ts` | Single-table DynamoDB implementation |
| `src/data/users.ts` | Cognito-backed display-name directory |
| `src/handlers/` | Business logic (league loop) over the port |
| `src/http/routes.ts` | Transport-agnostic route table + matcher |
| `src/http/local-server.ts` | Local dev adapter (Node http, mock store) |
| `src/http/lambda.ts` | Production adapter (API Gateway proxy → Dynamo) |
| `infra/` | CDK app + stack |
