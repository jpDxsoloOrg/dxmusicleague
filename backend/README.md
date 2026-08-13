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

## Email delivery

Sign-up codes, resends and password resets are all sent by the Cognito user
pool. Cognito's **built-in sender is capped at 50 messages/day** — a hard AWS
limit that support cannot raise. Past it, every registration fails with
`LimitExceededException: Exceeded daily email limit for the operation or the
account` until the daily counter resets.

Mind the scope of that cap when tracing a failure: AWS's email settings page
describes it as a limit "for your user pool", but Cognito's other quotas are
account-and-Region scoped and the error text names the *account*. So if this
pool's own traffic doesn't plausibly add up to 50 sends, check what else in the
account is sending before digging any further here — see triage below.

The stack therefore accepts an SES sender, which swaps that cap for the SES
account quota. It is **optional** — omit it and the pool stays on the 50/day
default sender, which is fine for a test stack.

To switch the deployed pool over:

1. **Verify the sender** in SES, in a region Cognito supports (`us-east-1`,
   `us-west-2`, `eu-west-1`). Verify either a single address or a whole domain —
   a domain gets you DKIM and better deliverability.

   ```bash
   aws ses verify-email-identity --email-address no-reply@example.com
   # or, for a domain:
   aws ses verify-domain-identity --domain example.com   # then add the DNS records
   ```

2. **Leave the SES sandbox.** A sandboxed account can only send *to* verified
   addresses, so new registrants would get nothing at all — this step is not
   optional. Request production access in the SES console (Account dashboard →
   "Request production access"); approval is usually same-day.

3. **Deploy with the sender set:**

   ```bash
   npx cdk deploy -c sesFromEmail=no-reply@example.com
   # domain identity instead of a single address:
   npx cdk deploy -c sesFromEmail=no-reply@example.com -c sesVerifiedDomain=example.com
   # identity in a different region than the stack:
   npx cdk deploy -c sesFromEmail=no-reply@example.com -c sesRegion=us-east-1
   ```

   `sesFromName` overrides the From display name (default "DX Music League").
   Each flag also reads an env var — `SES_FROM_EMAIL`, `SES_VERIFIED_DOMAIN`,
   `SES_REGION`, `SES_FROM_NAME` — for CI. **Pass the flag on every subsequent
   deploy:** dropping it reverts the pool to the 50/day default sender.

### Triage: who actually spent the 50?

Work outward from the pool, because the answer is often not in it. Moving to SES
raises the ceiling but does not stop whatever is spending it.

**1. Did signups spend it?** A successful `SignUp` creates the user *and* sends
the code, so ~50 spent this way leaves ~50 new accounts behind. (A `SignUp` that
fails on the quota creates nothing — the address never lands in the pool, which
is what the failure looks like from the outside.) Few or no recent accounts here
means signups did not spend it:

```bash
aws cognito-idp list-users --user-pool-id <pool-id> \
  --filter 'cognito:user_status = "UNCONFIRMED"' --max-results 60 \
  --query 'Users[].[Username,UserCreateDate]' --output table
```

**2. Did resets or resends spend it?** These send mail *without* creating a user,
so they leave no trace in the pool at all — repeated `ForgotPassword` against one
real address will drain the allowance invisibly. CloudTrail Event history keeps
90 days and needs no trail set up:

```bash
for op in SignUp ResendConfirmationCode ForgotPassword \
          AdminCreateUser AdminResetUserPassword GetUserAttributeVerificationCode; do
  printf '%-32s %s\n' "$op" "$(aws cloudtrail lookup-events \
    --lookup-attributes AttributeKey=EventName,AttributeValue=$op \
    --start-time "$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)" \
    --query 'length(Events)' --output text)"
done
```

**3. Did another user pool spend it?** Every pool left on the built-in sender
draws on the same allowance. List the pools in this account and Region, and check
what each one sends with — `COGNITO_DEFAULT` means it shares:

```bash
aws cognito-idp list-user-pools --max-results 60 --query 'UserPools[].[Id,Name]' --output table
aws cognito-idp describe-user-pool --user-pool-id <id> --query 'UserPool.EmailConfiguration'
```

Configuring SES per the steps above fixes this pool regardless of which of the
three it turns out to be. If it is #1, the AWS-recommended guard is additionally a
[pre-sign-up Lambda trigger](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-pre-sign-up.html)
rejecting signups that fail a CAPTCHA or allowlist check — not wired up here.

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
