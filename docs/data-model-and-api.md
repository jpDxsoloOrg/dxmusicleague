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
| League meta | `LEAGUE#<leagueId>` | `META` | `name, ownerId, musicProvider, format, settings{}, roundCount, createdAt`, head-to-head only once frozen: `h2hParticipants[], h2hSalt` |
| Membership | `LEAGUE#<leagueId>` | `MEMBER#<userId>` | `joinedAt, displayName` |
| Round | `LEAGUE#<leagueId>` | `ROUND#<index4>` | `roundId, theme, description, status, submissionDeadline, voteDeadline, playlistUrl`; head-to-head once revealed: `h2hDeparted[]` (who had departed at the reveal) and `h2hTally[]` (`{ matchupId, votesA, votesB }` as the reveal counted them) |
| Submission | `ROUND#<roundId>` | `SUB#<userId>` | `track{}, submittedAt` |
| Vote ballot | `ROUND#<roundId>` | `BALLOT#<voterId>` | `allocations{subId:pts}, comments{subId:text}, castAt`; head-to-head: `picks{matchupId:subId}` with `allocations` empty |
| Standing | `LEAGUE#<leagueId>` | `STANDING#<userId>` | `points` (running season total); `wins, losses, draws` (head-to-head record — absent on older rows, read as 0) |
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

### League format

`format` on the League META item is `"standard"` (points) or `"headToHead"`
(round-robin 1v1 matchups, W/L/D standings). It is chosen at creation
(`POST /leagues` body `format`, omitted → `"standard"`, unknown → 400) and is
**immutable** — no route writes it afterwards (the settings PATCH ignores it).
Leagues stored before formats existed have no attribute and read as
`"standard"` via `leagueFormat()` on every read — no migration. Head-to-head
leagues are locked to `submissionsPerPlayer: 1` and `downvotePoolSize: 0`:
creation and rematch clamp to those values, and a settings PATCH that changes
either is rejected with a 400.

### Head-to-head season freeze

A head-to-head league is a lobby until its round 1 opens
(`PATCH /leagues/{id}/rounds/{roundId}` `draft → submitting` — the only way
any round leaves draft, manual or timed). That transition freezes the season
once, in one conditional `UpdateItem` on META (season not frozen yet — no, or
an empty, `h2hParticipants` — so concurrent opens can't both shuffle):

- `h2hParticipants` — every member at that moment, shuffled (Fisher–Yates
  over `node:crypto` randomness). Every round's pairings derive from it
  (`domain/schedule.ts`); it never changes again.
- `h2hSalt` — 128 random bits (32 hex chars) keying the schedule's per-round
  presentation order.
- `roundCount` — overwritten with the round-robin length (`n − 1` rounds for
  an even field, `n` for odd), whatever the owner typed at creation; the
  existing "no round beyond roundCount" cap then ends the season on schedule.

Rules around it: round 1 needs at least 2 members to open (400); no round 2
can be created before round 1 has opened (400); once frozen the league takes
no new players — the invite-code join and the public claim both answer 409
"Season locked — …", discovery hides it and its preview reports
`hasStarted` — though a frozen participant who left or was kicked may rejoin
by invite (they're already in the schedule).

Joins can't slip past the freeze. A head-to-head join writes its `MEMBER#`
row in a `TransactWriteItems` together with a `ConditionCheck` on META
(not frozen, or the joiner already in `h2hParticipants`), so DynamoDB
serializes it against the freeze's `UpdateItem`: a join either commits
before the freeze or is refused. The one join the freeze can't see coming —
committed after the opener read the member list but before its freeze write
— is caught by the opener itself: right after the write it re-reads the
league strongly consistently (`ConsistentRead`), and if a member is missing
from the order it re-plans the whole order (fresh shuffle, salt and
`roundCount`) over participants + latecomers, conditional on the salt it
just read (`h2hSalt = :old`). That happens before round 1 is written, so no
pairing has been derived yet; once round 1 has opened, the order never
changes. Hence every member of a frozen league is in `h2hParticipants`
(participants who left are the only difference the other way round). Both attributes are
**server-only**: every response strips them (owner included), the frontend
types don't carry them, and a rematch never copies them (the clone freezes
afresh at its own round 1). Standard leagues never get either attribute.

### Why submission/vote keys are what they are

- `SUB#<userId>` as the sort key means a player physically *cannot* have two submissions in a
  round — a re-submit is a `PutItem` overwrite of the same key. That's `submissionsPerPlayer: 1`
  enforced by the schema itself, not just by code.
- `BALLOT#<voterId>` (one item holding the whole allocation map) means a ballot is atomic:
  it is validated as a complete unit (effective pool, caps) and written once. No partial rows.
  A head-to-head ballot is the same one item per voter (its `picks` map instead of points),
  so per-voter counts — completion %, the timed everyone-voted reveal — hold for both formats.

---

## 2. REST API (API Gateway + Lambda)

All routes require a valid Cognito JWT. `:me` denotes the caller's `sub`. Errors return
`{ "error": "<message>" }` with a 4xx status; the join flow's messages match
[`joinLeague`](../src/data/mock.ts) today.

### Leagues

| Method | Path | Body | Returns | Replaces |
|---|---|---|---|---|
| `POST` | `/leagues` | `{ name, musicProvider, roundCount, format?, … }` (see [League format](#league-format)) | `League` | `createLeague` |
| `GET` | `/leagues` | — | `LeagueSummary[]` | `getMyLeagueSummaries` |
| `GET` | `/leagues/{leagueId}` | — | `LeagueDetail` | `getLeagueDetail` |
| `POST` | `/leagues/join` | `{ code }` | `{ league }` \| 4xx | `joinLeague` |

- **Create**: owner = `:me`, `settings = DEFAULT_LEAGUE_SETTINGS`, member list seeded with
  the owner, and a fresh invite code minted (write League META + Membership + Invite items in
  one `TransactWriteItems`).
- **Join**: point-get `INVITE#<code.toUpperCase()>`; 404 → "That code doesn't match any
  league."; already a member → "You're already a member of {name}."; a frozen head-to-head
  season → 409 "Season locked — …" (see [Head-to-head season freeze](#head-to-head-season-freeze));
  else write Membership + Standing(0) and return the league.
- **Summary** fields (`currentRound`, `totalRounds`, `completionPct`, `members`) are computed
  in the Lambda from the league's rounds + memberships; `completionPct` becomes real
  (votes-cast / members for voting rounds) instead of the mock's hardcoded map.

### Rounds (owner-only writes)

| Method | Path | Body | Notes |
|---|---|---|---|
| `POST` | `/leagues/{leagueId}/rounds` | `{ theme, description?, submissionDeadline?, voteDeadline? }` | Creates a `draft` round, `index = max+1`. |
| `PATCH` | `/leagues/{leagueId}/rounds/{roundId}` | `{ status?, theme?, ...deadlines }` | Drives the `draft → submitting → voting → revealed` lifecycle. |

Status transitions are validated (no skipping/reversing). `revealed` is reached only via the
reveal endpoint below, not a raw PATCH. A PATCH that read the round before it was revealed is
written only while the round is still unsettled (`updateRoundUnlessSettled`), so it can't put a
revealed round back in voting (to be revealed, and banked, again) — it answers `409` "That round
was just revealed. Reload to see the results." instead; the timed auto-advance writes the same
way. Both formats (head-to-head since HTH-07, standard since BUG-04). If the league was deleted
under the PATCH, the refused write answers `404` "That round doesn't exist." instead. A PATCH
that read the round already revealed (a theme fix) is an ordinary write.

### Submissions

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/rounds/{roundId}/submission` | `{ track }` | `Submission` |
| `GET` | `/rounds/{roundId}/submissions` | — | `VotableSubmission[]` (anonymized) |

`POST` validations: caller is a league member; round status is `submitting`; submission
deadline not passed. Upserts `SUB#<me>` (re-submit overwrites). `GET` returns the anonymized
list **excluding the caller's own pick**, only once submissions close (`previewing` or
`voting`). The list is in submission-id order, never the order the repository reads in: that
follows the submitter (insertion time in memory, user id via DynamoDB's `SUB#<userId>#<subId>`
key), so it would say whose song is whose. The round's public Spotify playlist lists its tracks
in the same order.

### Votes & reveal

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/rounds/{roundId}/ballot` | `{ allocations: {submissionId: points}, comments?: {submissionId: text} }` — head-to-head: `{ picks: {matchupId: submissionId}, comments? }` | `{ ok: true }` |
| `GET` | `/rounds/{roundId}/my-ballot` | — | `{ allocations, downvotes, comments }` (+ `picks` in head-to-head leagues), or `null` before voting |
| `POST` | `/rounds/{roundId}/reveal` | — (owner-only) | `RoundResult[]` — head-to-head: `{ format: "headToHead", matchups, bye }` |
| `GET` | `/rounds/{roundId}/results` | — | same as the reveal |

**Ballot validation (the core of the rules engine) — reject the whole ballot if any fail:**

1. Round status is `voting`; vote deadline not passed; caller is a member.
2. Every `submissionId` belongs to this round.
3. `allowSelfVote` is false → no points on the caller's own submission.
4. Each allocation is an integer `0 ≤ p ≤ maxPointsPerSong`.
5. `sum(points) === effectivePool` exactly — no partial ballots. The effective pool is
   `min(votePoolSize, songsOnOffer × maxPointsPerSong)` (`effectivePool`, `domain/rules.ts`), where
   the songs on offer are the vote page's list: every song in the round except all of the caller's
   own, whatever `allowSelfVote` says. It is the whole pool unless those songs can't take it (a
   two-player league, players who didn't submit, a low cap); with no songs on offer it is 0, and the
   empty ballot still counts as the caller's vote.
6. One ballot per voter: overwrite of `BALLOT#<me>` allowed until the deadline.

**Head-to-head ballots** (`validateH2HBallot`, `domain/rules.ts`) pick a winner per matchup,
over the same derived matchups as `GET /matchups` — reject the whole ballot if any fail:

1. Same guards as above: round `voting`, deadline not passed, caller is a member.
2. Every pick's `matchupId` is a matchup of this round (the bye is not a matchup). In a
   contest, its value is the id of one of that matchup's two songs (walkover / no-contest
   picks aren't refereed — see 4).
3. No pick in the caller's own matchup (the self-vote rule; `allowSelfVote` doesn't apply).
4. A pick in **every** votable matchup — every contest (both songs present) except the
   caller's own (`votableMatchups`, the set the tally shares). A pick in a walkover / no-contest
   matchup is never rejected and never counts: a mid-voting departure can turn a picked contest
   into a walkover, and the re-cast pre-filled from my-ballot must still go through. Such a
   pick is kept if it names one of the pair's songs as scheduled (made before the departure, so
   a rejoin — the pair is a contest again — restores it) and dropped otherwise. The tally counts
   only picks in matchups that are contests at the reveal. A caller with nothing votable (e.g. a
   two-player league) casts an empty `picks` and may still comment.
5. No points and no anti-votes (`allocations` / `downvotes` must be absent or empty); a standard
   league's ballot with non-empty `picks` is rejected the same way.

Comments work as for points ballots, keyed by submission id: any song of the round's frozen
participants — both songs of every matchup (their own included) and the bye's exhibition
song. A departed player's withdrawn song keeps its comments too (as on a points ballot), so a
pre-filled re-cast loses nothing. Stored as `allocations: {}` + `picks`; a re-cast overwrites
the row.

**Reveal** (owner triggers once): tally points per submission from all ballots, rank with the
fixed tie-break (points → distinct voters → title), increment each member's `STANDING#`
total, create the Spotify playlist on the host account (§3), store `playlistUrl` on the round,
set status `revealed`. `GET /results` is the read side — available only once `revealed`, and
returns submitters, points, ranks, and all voter comments (matching
[`getRoundResults`](../src/data/mock.ts)). **Exactly once** (BUG-04): the claim and the banking
are ONE atomic write (`revealPointsRoundOnce` — the same `TransactWriteItems` as the
head-to-head reveal below, with one in-place `points` increment per player instead of W/L/D).
A submitter's results are summed into one increment first (with `submissionsPerPlayer` > 1 one
player has several, and a transaction can't touch a row twice; the 99-row cap counts players).
Zero-point results bank nothing; negative totals (anti-votes) bank. Of two concurrent reveals
(the owner's, or the timed auto-advance run by league reads, ballots and submissions) only the
one whose write lands banks; the loser re-reads the round strongly consistently and answers the
same ranked list. A round where nobody scored is just the conditional round write. The payload
is unchanged: the bare ranked array.

**Head-to-head reveal** (same endpoints; `finalizeReveal` / `domain/rules.ts`
`settleMatchups`): each matchup is tallied from the ballots' `picks` — a pick counts only in a
matchup that is a contest at the reveal and isn't the voter's own, naming one of its two songs
(`tallyMatchups`; everything else a ballot holds is inert). Outcomes: most votes wins (`win`,
`winnerUserId`), equal votes `draw` (0–0 included), one song `walkover` (its player wins; stray
picks ignored), no songs `noContest`. A player who left / was kicked before the reveal has their
song withdrawn, so their pair is a walkover for whoever stayed. Banking: one W/L/D increment
per player whose record changes — win `{wins: 1}`, loss `{losses: 1}` (even on 0 votes), draw
`{draws: 1}` each, walkover W for the winner and L for the no-show unless they departed (a
departed player's row takes nothing); `noContest` and the bye bank nothing; points never move.
**Exactly once:** the claim and the banking are ONE atomic write (`revealRoundOnce` — a
`TransactWriteItems` of the round `PutItem`, conditioned on
`attribute_exists(PK) AND #status <> :revealed AND #status <> :complete`, plus one in-place
W/L/D `Update` per player). The claim also pins `h2hDeparted` (the departed set as it stood) and
`h2hTally` (the picks it counted). Only the reveal whose write lands banks, so the owner's
reveal racing a timed auto-advance (or two auto-advancing reads) can't double-bank; the loser
re-reads the round strongly consistently and answers with it. When two reveals' transactions
overlap, DynamoDB cancels the later one with `TransactionConflict` (not `ConditionalCheckFailed`)
— nothing written — so the repository sends it again after a short backoff (25 / 50 / 100 ms,
jittered, at most 3 times; the same for a settle-guarded `PutItem` refused with
`TransactionConflictException`): it then loses the claim cleanly once the winner has committed.
Any other failed write banks nothing and leaves the round in voting, so the reveal can be
retried. (Above 99 banked rows — DynamoDB's
100-item transaction cap — it falls back to the conditional round write, then one write per row:
at most once.) Every later read uses the pins: the pinned players' songs are withdrawn and the
pinned tally decides the outcomes, so results (and `GET /matchups`) read back as banked whatever
the member list or a ballot written after the reveal read them does afterwards. (Voter comments
are still read live from the ballot rows.) A standard round's reveal claims and banks through
the same transaction (`revealPointsRoundOnce`, above) but pins nothing.

The payload (readable by any signed-in user once revealed, like standard results):

```ts
{ format: "headToHead",
  matchups: [{ matchupId,                       // sorted by matchupId
    a: { player: {id, displayName}, song: RevealedSong | null, votes, departed },
    b: { ... },
    outcome: "win" | "draw" | "walkover" | "noContest",   // open set (playoffs may add more)
    winnerUserId? }],                            // win / walkover only
  bye: { player: {id, displayName}, song: RevealedSong } | null }
// RevealedSong = { id (submissionId), track, submitterComment?, comments: [{ voter, text }] }
```

`song: null` = that player didn't submit or had departed (`departed: true`). `bye` is the
sitting-out player's exhibition song, `null` for an even field, or when they didn't submit or
had departed by the reveal.
**Wire compatibility:** a standard round still answers with the bare `RoundResult[]` array,
byte-identical to before formats existed, so an older frontend never breaks; only head-to-head
rounds answer with the object (discriminate with `Array.isArray`). The frontend data layer
normalizes both into its own `{ format: "standard", results } | { format: "headToHead", ... }`.

### Head-to-head matchups

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/rounds/{roundId}/matchups` | — | `{ matchups: [{ matchupId, a, b, isMine }], bye }` |

The voting-phase view of a head-to-head round, derived on every read (nothing
stored): pairings from `h2hParticipants` + `h2hSalt` + the round index
(`domain/schedule.ts`), each player's song attached from the round's
submissions (`domain/matchups.ts`, the one derivation ballots and the tally
share). `a`, `b` and `bye` are anonymized songs — the same `{ id, track }`
shape as `GET /submissions` items — or `null` when that player has no song:
they didn't submit, or they've left / been kicked while the round is in play
(a departed player's song is withdrawn, so their pair shows as a walkover;
`GET /submissions` drops it too for head-to-head leagues). Both sides `null` =
no contest; `bye` is the sitting-out player's exhibition song (`null` for even
fields). `matchupId` is `<roundId>~M<n>`, matchups come sorted by it, and
`isMine` (the caller is one of the two players in the frozen schedule — a
player who has since left still matches their own matchup in a revealed
round; a spectator who never played never does) is the payload's only
identity signal — no user ids, no submitter notes, never the frozen order.

A revealed (or complete) round is never re-judged against the current member
list, so a later leave/kick (or a rejoin) doesn't rewrite it: it withdraws
exactly the songs of the players the reveal pinned as departed
(`h2hDeparted`), so it agrees with `GET /results` about its walkovers.

Access: members from `voting` on (403 while `draft` / `submitting` /
`previewing` — no peeking before voting opens); once `revealed` (or
`complete`) any signed-in user, spectators included, like `GET /results`.
Non-members before the reveal → 403; a standard league's round → 400.

### Standings

`GET /leagues/{leagueId}/standings → Standing[]` (also embedded in `LeagueDetail`). Reads the
`STANDING#` items, sorts them in the league format's board order (below), assigns rank.
Maintained incrementally at reveal, so this is a cheap single-partition query — no
recomputation over all votes.

Every `Standing` row carries `points` **and** a `wins`/`losses`/`draws` record (the side a
league's format doesn't use is 0). Head-to-head leagues rank by wins desc → losses asc →
display name, collated in English whatever the host locale (draws don't break ties); standard
leagues keep points desc, equal points in stored order. The record lives on the same
`STANDING#` item, bumped with one atomic
`SET #w = if_not_exists(#w, :zero) + :w, #l = if_not_exists(#l, :zero) + :l, #d = …` per
player (`addStandingRecord`; `#w`/`#l`/`#d` name `wins`/`losses`/`draws`), so leave/rejoin
durability, rematch reseeding and the league cascade delete cover it unchanged; rows written
before head-to-head existed have no such attributes and read back as 0–0–0 (no migration).

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
