# Phase 2 — Data Model & API Contract

> Design doc for the backend that replaces the in-memory mock store
> ([src/data/mock.ts](../src/data/mock.ts)). Encodes the game rules decided in
> June 2026 (see `musicLeagueClone.md` §7 "Game Rules") as server-side validation.
> Nothing here is built yet — this is the contract the frontend already expects.

## Principles

- **Cognito owns identity.** The caller's `userId` is the JWT `sub` claim; it is never
  taken from the request body. Spotify auth stays entirely separate (host account only).
- **The server is the referee.** Every rule (full-pool ballots, per-song cap, no self-vote,
  one submission per player, deadlines) is validated server-side. The client UI mirrors the
  rules for UX, but a hand-crafted request must not be able to break them.
- **Provider-agnostic.** Submissions store a normalized `Track` snapshot (provider + native
  id + title/artist/art), never a Spotify-specific shape. All Spotify access is one Lambda
  proxy implementation behind the `MusicProvider` seam.

---

## 1. DynamoDB — single-table design

One table `MusicLeague`, partition key `PK`, sort key `SK`, plus two GSIs. Single-table
because every read below is a point-get or a single-partition `Query` — no cross-entity joins.

| Entity | PK | SK | Key attributes |
|---|---|---|---|
| League meta | `LEAGUE#<leagueId>` | `META` | `name, ownerId, musicProvider, settings{}, createdAt` |
| Membership | `LEAGUE#<leagueId>` | `MEMBER#<userId>` | `joinedAt, displayName` |
| Round | `LEAGUE#<leagueId>` | `ROUND#<index4>` | `roundId, theme, description, status, submissionDeadline, voteDeadline, playlistUrl` |
| Submission | `ROUND#<roundId>` | `SUB#<userId>` | `track{}, submittedAt` |
| Vote ballot | `ROUND#<roundId>` | `BALLOT#<voterId>` | `allocations{subId:pts}, comments{subId:text}, castAt` |
| Standing | `LEAGUE#<leagueId>` | `STANDING#<userId>` | `points` (running season total) |
| Invite code | `INVITE#<code>` | `META` | `leagueId` |

`index4` = zero-padded round number (`ROUND#0001`) so rounds sort in order within the league
partition.

### GSIs

- **GSI1 — "my leagues"**: `GSI1PK = USER#<userId>`, `GSI1SK = LEAGUE#<leagueId>`. Projected
  onto every Membership item. Query `GSI1PK = USER#<me>` → all my league ids in one shot.
- **GSI2 — round-status sweep (optional, Phase 6)**: `GSI2PK = STATUS#<status>`,
  `GSI2SK = <deadline ISO>`. Lets an EventBridge job find rounds due to transition. Skip until
  deadlines are automated.

### Rule storage

The per-league knobs live in the `settings` map on the League META item, mirroring
[`LeagueSettings`](../src/domain/types.ts) exactly:

```json
{ "votePoolSize": 10, "maxPointsPerSong": 5, "allowSelfVote": false, "submissionsPerPlayer": 1 }
```

The **tie-break is not a setting** — it is fixed algorithm in the reveal handler
(points desc → distinct-voter count desc → title A→Z).

### Why submission/vote keys are what they are

- `SUB#<userId>` as the sort key means a player physically *cannot* have two submissions in a
  round — a re-submit is a `PutItem` overwrite of the same key. That's `submissionsPerPlayer: 1`
  enforced by the schema itself, not just by code.
- `BALLOT#<voterId>` (one item holding the whole allocation map) means a ballot is atomic:
  it is validated as a complete unit (full pool, caps) and written once. No partial rows.

---

## 2. REST API (API Gateway + Lambda)

All routes require a valid Cognito JWT. `:me` denotes the caller's `sub`. Errors return
`{ "error": "<message>" }` with a 4xx status; the join flow's messages match
[`joinLeague`](../src/data/mock.ts) today.

### Leagues

| Method | Path | Body | Returns | Replaces |
|---|---|---|---|---|
| `POST` | `/leagues` | `{ name, musicProvider }` | `League` | `createLeague` |
| `GET` | `/leagues` | — | `LeagueSummary[]` | `getMyLeagueSummaries` |
| `GET` | `/leagues/{leagueId}` | — | `LeagueDetail` | `getLeagueDetail` |
| `POST` | `/leagues/join` | `{ code }` | `{ league }` \| 4xx | `joinLeague` |

- **Create**: owner = `:me`, `settings = DEFAULT_LEAGUE_SETTINGS`, member list seeded with
  the owner, and a fresh invite code minted (write League META + Membership + Invite items in
  one `TransactWriteItems`).
- **Join**: point-get `INVITE#<code.toUpperCase()>`; 404 → "That code doesn't match any
  league."; already a member → "You're already a member of {name}."; else write Membership +
  Standing(0) and return the league.
- **Summary** fields (`currentRound`, `totalRounds`, `completionPct`, `members`) are computed
  in the Lambda from the league's rounds + memberships; `completionPct` becomes real
  (votes-cast / members for voting rounds) instead of the mock's hardcoded map.

### Rounds (owner-only writes)

| Method | Path | Body | Notes |
|---|---|---|---|
| `POST` | `/leagues/{leagueId}/rounds` | `{ theme, description?, submissionDeadline?, voteDeadline? }` | Creates a `draft` round, `index = max+1`. |
| `PATCH` | `/leagues/{leagueId}/rounds/{roundId}` | `{ status?, theme?, ...deadlines }` | Drives the `draft → submitting → voting → revealed` lifecycle. |

Status transitions are validated (no skipping/reversing). `revealed` is reached only via the
reveal endpoint below, not a raw PATCH.

### Submissions

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/rounds/{roundId}/submission` | `{ track }` | `Submission` |
| `GET` | `/rounds/{roundId}/submissions` | — | `VotableSubmission[]` (anonymized) |

`POST` validations: caller is a league member; round status is `submitting`; submission
deadline not passed. Upserts `SUB#<me>` (re-submit overwrites). `GET` returns the anonymized
list **excluding the caller's own pick**, and only when the round is `voting`.

### Votes & reveal

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/rounds/{roundId}/ballot` | `{ allocations: {submissionId: points}, comments?: {submissionId: text} }` | `{ ok: true }` |
| `POST` | `/rounds/{roundId}/reveal` | — (owner-only) | `RoundResult[]` |
| `GET` | `/rounds/{roundId}/results` | — | `RoundResult[]` |

**Ballot validation (the core of the rules engine) — reject the whole ballot if any fail:**

1. Round status is `voting`; vote deadline not passed; caller is a member.
2. Every `submissionId` belongs to this round.
3. `allowSelfVote` is false → no points on the caller's own submission.
4. Each allocation is an integer `0 ≤ p ≤ maxPointsPerSong`.
5. `sum(points) === votePoolSize` exactly — no partial ballots.
6. One ballot per voter: overwrite of `BALLOT#<me>` allowed until the deadline.

**Reveal** (owner triggers once): tally points per submission from all ballots, rank with the
fixed tie-break (points → distinct voters → title), increment each member's `STANDING#`
total, create the Spotify playlist on the host account (§3), store `playlistUrl` on the round,
set status `revealed`. `GET /results` is the read side — available only once `revealed`, and
returns submitters, points, ranks, and all voter comments (matching
[`getRoundResults`](../src/data/mock.ts)).

### Standings

`GET /leagues/{leagueId}/standings → Standing[]` (also embedded in `LeagueDetail`). Reads the
`STANDING#` items, sorts by points desc, assigns rank. Maintained incrementally at reveal, so
this is a cheap single-partition query — no recomputation over all votes.

### Music provider proxy

| Method | Path | Returns |
|---|---|---|
| `GET` | `/providers/{provider}/search?q=&market=&limit=` | `Track[]` |

Backs [`MusicProvider.searchTracks`](../src/music/types.ts). For Spotify: Client Credentials
token (cached, app-level), `GET /v1/search?type=track`, **limit capped at 10** per the Feb 2026
change, normalized to `Track`. `client_secret` lives in Secrets Manager and never leaves the
Lambda. Playlist creation is **not** a public route — it runs inside `/reveal` using the host
account's refresh token (`POST /me/playlists`, `POST /playlists/{id}/items`).

---

## 3. Secrets & Spotify (unchanged from the spike)

- `client_id`, `client_secret`, host **refresh token** → Secrets Manager / SSM. Never the browser.
- Reuse the exact call patterns proven in `spotify_search.sh` / `spotify_playlist.mjs`.
- Host account must keep **Premium** active, or playlist creation fails at reveal.

---

## 4. Frontend swap map

Each mock function becomes one fetch. Keeping the return shapes identical means the pages
don't change — only [src/data/mock.ts](../src/data/mock.ts) is replaced by an API client.

| Mock function | Endpoint |
|---|---|
| `getMyLeagueSummaries()` | `GET /leagues` |
| `getLeagueDetail(id)` | `GET /leagues/{id}` |
| `createLeague(input)` | `POST /leagues` |
| `joinLeague(code)` | `POST /leagues/join` |
| `getVotableSubmissions(id)` | `GET /rounds/{roundId}/submissions` |
| `saveVoteComments(...)` → real ballot | `POST /rounds/{roundId}/ballot` |
| `getRoundResults(id)` | `GET /rounds/{roundId}/results` |
| `getStandings(id)` | `GET /leagues/{id}/standings` |
| provider search (SubmitSongPage) | `GET /providers/{provider}/search` |

---

## 5. Build order (suggested)

1. Table + GSIs (CDK/Amplify), Cognito user pool, an authorizer that injects `userId`.
2. League create/join/list/detail — the smallest closed loop, fully testable without Spotify.
3. Round lifecycle (draft → submitting → voting) + submission upsert.
4. Ballot validation + reveal/tally + standings — the rules engine.
5. Spotify proxy: search first (Client Credentials), then playlist-on-reveal (host token).
6. Swap `mock.ts` for the API client behind the existing page components.
