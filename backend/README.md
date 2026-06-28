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
npm run dev          # → http://127.0.0.1:8787, in-memory store
```

Auth is stubbed: send `x-dev-user: <id>` to act as a seed user (default `u-me`).
Seed users: `u-me` (Curator Max), `u-sarah`, `u-james`, `u-mia`, `u-jpop`, `u-luna`.

```bash
curl http://127.0.0.1:8787/leagues                          # my leagues
curl http://127.0.0.1:8787/leagues/lg-synthwave             # league detail
curl -X POST http://127.0.0.1:8787/leagues \
  -H 'Content-Type: application/json' \
  -d '{"name":"My League","musicProvider":"youtube-music"}' # create
curl -X POST http://127.0.0.1:8787/leagues/join \
  -H 'Content-Type: application/json' -d '{"code":"INDIE-25"}'
```

## Test & typecheck

```bash
npm test         # rules-engine unit tests (pure, no infra)
npm run typecheck
```

## Deploy (real AWS)

```bash
npm run synth                 # validate the stack (no AWS creds needed)
npx cdk bootstrap             # once per account/region
npx cdk deploy                # provisions Table, Cognito, API GW, Lambda
```

Outputs `ApiUrl`, `UserPoolId`, `UserPoolClientId`, `TableName` for the frontend.

## Status

Implemented: build-order steps 1–2 (infra scaffold + league create/join/list/detail).
The `Repository` port already declares the round / submission / ballot / standing
methods, and `DynamoRepository` implements them, so steps 3–4 (round lifecycle,
submissions, ballot validation + reveal) are mostly handler + route wiring on top
of the rules engine in [src/domain/rules.ts](src/domain/rules.ts).

## Layout

| Path | What |
|---|---|
| `src/domain/` | Types, typed errors, the pure rules engine (referee logic) |
| `src/data/repository.ts` | The data-access port both backends implement |
| `src/data/memory.ts` | In-memory store + seed data (local + tests) |
| `src/data/dynamo.ts` | Single-table DynamoDB implementation |
| `src/data/users.ts` | Cognito-backed display-name directory |
| `src/handlers/` | Business logic (league loop) over the port |
| `src/http/routes.ts` | Transport-agnostic route table + matcher |
| `src/http/local-server.ts` | Local dev adapter (Node http, mock store) |
| `src/http/lambda.ts` | Production adapter (API Gateway proxy → Dynamo) |
| `infra/` | CDK app + stack |
