# Phase 2 — Data Model & API Contract

> Design doc for the backend API. Encodes the game rules decided in June 2026 (see
> `musicLeagueClone.md` §7 "Game Rules") as server-side validation. Built: the backend in
> [backend/](../backend/README.md) implements it (one set of handlers over a `Repository`
> port — in memory locally, DynamoDB on AWS), and the frontend reaches it through
> [src/data/apiClient.ts](../src/data/apiClient.ts) (§4). The head-to-head format's design
> notes are in [plans/head-to-head-format.md](plans/head-to-head-format.md).

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
| League meta | `LEAGUE#<leagueId>` | `META` | `name, ownerId, musicProvider, format, settings{}, roundCount, createdAt`, head-to-head only once frozen: `h2hParticipants[], h2hSalt`; once rematched: `rematchLeagueId` (its one live rematch — claimed by a conditional write, replaced only once that league is deleted) |
| Membership | `LEAGUE#<leagueId>` | `MEMBER#<userId>` | `joinedAt, displayName` |
| Round | `LEAGUE#<leagueId>` | `ROUND#<index4>` | `roundId, theme, description, status, submissionDeadline, voteDeadline, playlistUrl`; head-to-head once revealed: `h2hDeparted[]` (who had departed at the reveal) and `h2hTally[]` (`{ matchupId, votesA, votesB }` as the reveal counted them); standard once revealed: `pointsTally[]` (`{ submissionId, pointsFor, pointsAgainst, distinctVoters }` per song, as the reveal counted them) |
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

**Self-voting is not a setting** — no league allows it. `allowSelfVote` is deprecated and always
`false`: create, rematch and the settings PATCH (`PATCH /leagues/{id}/settings`) store `false`
whatever they are sent (the PATCH accepts and ignores the field, so an older frontend that still
sends it keeps saving), every League the API returns reads `false`, and the ballot referee never
reads it. A row stored before the option was removed may still hold `true`; it needs no
migration — the attribute just stops mattering, and the league's next settings save writes `false`.
Ballots are refereed when cast, not again at the reveal: a self-vote ballot already stored before
the option was removed, in a league that then allowed it, still counts as cast (the app never
offered one — only a hand-written API ballot could hold it).

The **tie-break is not a setting** — it is fixed algorithm in the reveal handler
(points desc → distinct-voter count desc → title A→Z).

### League format

`format` on the League META item is `"standard"` (points) or `"headToHead"`
(round-robin 1v1 matchups, W/L/D standings). It is chosen at creation
(`POST /leagues` body `format`, omitted → `"standard"`, unknown → 400) and is
**immutable** — no route writes it afterwards (the settings PATCH ignores it).
Leagues stored before formats existed have no attribute and read as
`"standard"` via `leagueFormat()` on every read — no migration. The
non-member payloads carry it too — public discovery (`GET /leagues/public`),
the public preview (`GET /leagues/{id}/public`) and browse
(`GET /leagues/browse`) — so a player can tell a head-to-head league apart
before claiming a spot or spectating. Head-to-head
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
can be created before round 1 has opened (400); once frozen **nobody joins
the league, ever** (`seasonJoinRefusal`, `domain/freeze.ts`): the invite-code
join and the public claim both answer 409 — "Season locked — …" to a
newcomer, and "You can't rejoin this head-to-head season — …" to a frozen
participant who left or was kicked (HTH-14: leaving a locked season is
permanent, so nobody can dodge a loss by leaving before a reveal and coming
back after it). Discovery hides the league and its preview reports
`hasStarted` (no claim, for a former participant too). Leaving and kicking
themselves are unchanged — they just can't be undone: the departed player's
remaining matchups play as walkovers for their opponents, and their standing
row stays stored, off the board. Before the freeze (the lobby) players can
leave and join again freely.

Joins can't slip past the freeze. A head-to-head join writes its `MEMBER#`
row in a `TransactWriteItems` together with a `ConditionCheck` on META
(not frozen — no, or an empty, `h2hParticipants`; no exception for a former
participant), so DynamoDB serializes it against the freeze's `UpdateItem`: a
join either commits before the freeze or is refused. The handler then
answers from a fresh, strongly consistent read: a caller who is a member by
now (their own duplicate join landed first and the freeze took them in)
simply succeeds, since the join they asked for happened; anyone else gets the
409 with its reason. The one join the freeze can't see coming — committed
after the opener read the member list but before its freeze write — is
caught by the opener itself: right after the write it re-reads the
league strongly consistently (`ConsistentRead`), and if a member is missing
from the order it re-plans the whole order (fresh shuffle, salt and
`roundCount`) over participants + latecomers, conditional on the salt it
just read (`h2hSalt = :old`). That happens before round 1 is written, so no
pairing has been derived yet; once round 1 has opened, the order never
changes. Hence every member of a frozen league is in `h2hParticipants`
(participants who left or were kicked are the only difference the other way
round, and they stay out). Both attributes are
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
[`joinLeague`](../src/data/mock.ts) today. A few errors add machine-readable fields beside
`error` (a `code`, plus whatever it names); clients branch on `code`, never on the message.
The tables name the routes that matter to the game rules, not all of them;
[backend/src/http/routes.ts](../backend/src/http/routes.ts) is the full list. In the prose,
`GET /submissions`, `GET /matchups` and `GET /results` are short for the round's
`/rounds/{roundId}/…` routes.

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
  league."; already a member → 409 "You're already a member of {name}." with
  `code: "already-member"` and the `leagueId` (the client opens that league); a frozen head-to-head
  season → 409 "Season locked — …" for a newcomer, or "You can't rejoin this head-to-head season — …"
  for a participant who left or was kicked (see [Head-to-head season freeze](#head-to-head-season-freeze));
  else write Membership + Standing(0) and return the league. (The public claim,
  `POST /leagues/{id}/members`, answers a frozen season with the same two 409s.)
- **Summary** fields (`currentRound`, `totalRounds`, `completionPct`, `members`, `finished`) are
  computed in the Lambda from the league's rounds + memberships. `completionPct` is real (the
  frontend mock keeps a hardcoded map for its points leagues) and counts current members only:
  for a submitting round, members' songs (each up to the allowance) / slots; for a voting round,
  members with a ballot / members; 100 once revealed, 0 otherwise. **Head-to-head** counts its
  own people: while submitting, members with their one song / members; while voting, **voted /
  eligible** — the members who have picked in every matchup they can vote in, out of the members
  with a matchup to pick in (100 when nobody can vote; `headToHeadCompletionPct` in
  `backend/src/handlers/leagues.ts`). The design notes in
  [plans/head-to-head-format.md](plans/head-to-head-format.md) cover the
  [turnout](plans/head-to-head-format.md#progression-completion--and-departures-hth-08) behind
  it, and [when the who-voted panel and the activity feed may name head-to-head
  voters](plans/head-to-head-format.md#who-voted-panel-and-anonymity).

### Rounds (owner-only writes)

| Method | Path | Body | Notes |
|---|---|---|---|
| `POST` | `/leagues/{leagueId}/rounds` | `{ theme, description?, submissionDeadline?, voteDeadline? }` | Creates a `draft` round, `index = max+1`. |
| `PATCH` | `/leagues/{leagueId}/rounds/{roundId}` | `{ status?, theme?, ...deadlines }` | Drives the `draft → submitting → previewing → voting → revealed` lifecycle. |

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
| `POST` | `/rounds/{roundId}/submission` | `{ track, comment? }` | `Submission` |
| `GET` | `/rounds/{roundId}/submissions` | — | `VotableSubmission[]` (anonymized) |

`POST` validations: caller is a league member; round status is `submitting`; submission
deadline not passed; not a song, or an artist, already in the round (400). With
`submissionsPerPlayer` 1 a re-submit replaces the pick (same id); otherwise each submit adds
one, up to the allowance (400 at the cap — remove a pick to change it). `GET` returns the
anonymized list **excluding the caller's own pick**, only once submissions close (`previewing`
or `voting`). The list is in submission-id order, never the order the repository reads in: that
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
3. No points and no anti-votes on any of the caller's own submissions in the round, in every
   league (self-voting is not a setting; a legacy row's `allowSelfVote: true` is ignored).
4. Each allocation is an integer `0 ≤ p ≤ maxPointsPerSong`.
5. `sum(points) === effectivePool` exactly — no partial ballots. The effective pool is
   `min(votePoolSize, songsOnOffer × maxPointsPerSong)` (`effectivePool`, `domain/rules.ts`), where
   the songs on offer are the vote page's list: every song in the round except all of the caller's
   own. It is the whole pool unless those songs can't take it (a
   two-player league, players who didn't submit, a low cap); with no songs on offer it is 0, and the
   empty ballot still counts as the caller's vote.
6. One ballot per voter: overwrite of `BALLOT#<me>` allowed until the deadline.

**Head-to-head ballots** (`validateH2HBallot`, `domain/rules.ts`) pick a winner per matchup,
over the same derived matchups as `GET /matchups` — reject the whole ballot if any fail:

1. Same guards as above: round `voting`, deadline not passed, caller is a member.
2. Every pick's `matchupId` is a matchup of this round (the bye is not a matchup). In a
   contest, its value is the id of one of that matchup's two songs (walkover / no-contest
   picks aren't refereed — see 4).
3. No pick in the caller's own matchup (the self-vote rule, as for points ballots).
4. A pick in **every** votable matchup — every contest (both songs present) except the
   caller's own (`votableMatchups`, the set the tally shares). A pick in a walkover / no-contest
   matchup is never rejected and never counts: a mid-voting departure can turn a picked contest
   into a walkover, and the re-cast pre-filled from my-ballot must still go through. Such a
   pick is kept, inert, if it names one of the pair's songs as scheduled (made before the
   departure) and dropped otherwise. (Built so a rejoin would restore it; since HTH-14 a locked
   season can't be rejoined, so it just stays put.) The tally counts
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
total, set status `revealed` (the Spotify playlist was made earlier, when submissions closed —
see [Music provider proxy](#music-provider-proxy)). `GET /results` is the read side — available
only once `revealed`, and
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
is unchanged: the bare ranked array. **Pinned tally** (BUG-18): the claim also pins the per-song
tally the list was ranked from — `pointsTally`, one `{ submissionId, pointsFor, pointsAgainst,
distinctVoters }` per song, zeros included (net points = `pointsFor − pointsAgainst`) — and
`GET /results`, the reveal page on reload and a reveal that lost its claim all rank from it with
the same tie-break instead of re-tallying the `BALLOT#` rows (titles, submitters and notes come
from the live submissions; voter comments still from the live ballot rows, as head to head).
`castBallot` checks the round is in `voting` and then writes its row without a condition, so a
ballot can land after the reveal read the ballots — it passed the check just before the reveal,
or arrived between the reveal's read and its claim. The voter gets `{ ok: true }` and the row is
stored, but it was never banked, so it never counts: the results always agree with the
standings. A revealed round without `pointsTally` (seeded, or revealed before the pin existed)
re-tallies its rows as before. Like the head-to-head pins it rides along on round payloads (the
frontend ignores it); the results payload is unchanged. **Consistent tally** (BUG-05): both
reveals (this one and the head-to-head reveal below) tally from a strongly consistent `Query` of
the round's `BALLOT#` items (`ConsistentRead`). In a timed league the vote that completes the
turnout triggers the reveal, and a default (eventually consistent) read right after that write
could miss it, banking and pinning a tally without an acknowledged vote. GET results and the
turnout / progress counts keep the default read.

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
the same transaction (`revealPointsRoundOnce`, above) and pins what it counted the same way: its
per-song `pointsTally` (above), which every later read ranks from.

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
list, so a later leave/kick doesn't rewrite it: it withdraws
exactly the songs of the players the reveal pinned as departed
(`h2hDeparted`), so it agrees with `GET /results` about its walkovers.

Access: members from `voting` on (403 while `draft` / `submitting` /
`previewing` — no peeking before voting opens); once `revealed` (or
`complete`) any signed-in user, spectators included, like `GET /results`.
Non-members before the reveal → 403; a standard league's round → 400.

### Standings

No route of their own: the board comes embedded in the league detail,
`GET /leagues/{leagueId}` → `LeagueDetail.standings` (`Standing[]`; the frontend's
`getStandings` reads it from there). It reads the `STANDING#` items, sorts them in the league
format's board order (below), assigns rank. Maintained incrementally at reveal, so this is a
cheap single-partition query — no recomputation over all votes.

Every `Standing` row carries `points` **and** a `wins`/`losses`/`draws` record (the side a
league's format doesn't use is 0). Head-to-head leagues rank by wins desc → losses asc →
display name, collated in English whatever the host locale (draws don't break ties); standard
leagues keep points desc, equal points in stored order. The record lives on the same
`STANDING#` item, bumped with one atomic
`SET #w = if_not_exists(#w, :zero) + :w, #l = if_not_exists(#l, :zero) + :l, #d = …` per
player (`addStandingRecord`; `#w`/`#l`/`#d` name `wins`/`losses`/`draws`), so leave/kick
durability (the row is kept, off the board — a locked season can't be rejoined), rematch
reseeding and the league cascade delete cover it unchanged; rows written
before head-to-head existed have no such attributes and read back as 0–0–0 (no migration).

### Music provider proxy

| Method | Path | Returns |
|---|---|---|
| `GET` | `/spotify/search?q=&market=&limit=` | `{ tracks }` — simplified tracks the Spotify provider maps to `Track` |

Backs [`MusicProvider.searchTracks`](../src/music/types.ts) for Spotify leagues: Client
Credentials token (cached, app-level), Spotify's `GET /v1/search?type=track`, **limit capped at
10** per the Feb 2026 change; an empty `q` returns no tracks. Search needs only the client id
and secret; playlist creation (below) also needs the host account's refresh token. All three
live in Secrets Manager (`SPOTIFY_SECRET_ID` names a secret holding
`{ clientId, clientSecret, refreshToken }`; locally, the `SPOTIFY_CLIENT_ID` /
`SPOTIFY_CLIENT_SECRET` / `SPOTIFY_REFRESH_TOKEN` env vars, which win when the first two are set)
and never leave the Lambda. The backend has no YouTube Music route: its search is served by the
Vite dev plugin's `/youtube-music/*` endpoints ([vite-plugin-ytmusic.ts](../vite-plugin-ytmusic.ts)),
so it runs in `vite dev` only. Playlist creation is **not** a public route — it runs when a
Spotify league's round leaves `submitting` for `previewing` (the owner's PATCH or the timed
auto-advance), best-effort (a Spotify failure doesn't block the round), using the host account's
refresh token (Spotify's `POST /me/playlists`, `POST /playlists/{id}/items`), and stores
`playlistUrl` on the round.

---

## 3. Secrets & Spotify (unchanged from the spike)

- `client_id`, `client_secret`, host **refresh token** → Secrets Manager / SSM. Never the browser.
- Reuse the exact call patterns proven in `spotify_search.sh` / `spotify_playlist.mjs`.
- Host account must keep **Premium** active, or playlist creation fails when submissions close.

---

## 4. Frontend swap map

Done. Pages call a `DataClient` ([src/data/client.ts](../src/data/client.ts)), and
[src/data/index.ts](../src/data/index.ts) picks the implementation: `ApiClient`
([src/data/apiClient.ts](../src/data/apiClient.ts)), one fetch per method, when `VITE_API_URL`
is set; otherwise `MockClient` over the in-memory store in [src/data/mock.ts](../src/data/mock.ts).
Both resolve to the same view-model shapes, so the pages don't change. The main methods:

| `DataClient` method | Endpoint |
|---|---|
| `getMyLeagueSummaries()` | `GET /leagues` |
| `getLeagueDetail(leagueId)` | `GET /leagues/{id}` |
| `createLeague(input)` | `POST /leagues` |
| `joinLeague(code)` | `POST /leagues/join` |
| `getStandings(leagueId)` | `GET /leagues/{id}` (`.standings`) |
| `getVotableSubmissions(roundId)` | `GET /rounds/{roundId}/submissions` |
| `castBallot(roundId, allocations, comments?, downvotes?)` | `POST /rounds/{roundId}/ballot` (`allocations`) |
| `castMatchupBallot(roundId, picks, comments?)` | `POST /rounds/{roundId}/ballot` (`picks`) |
| `getMyBallot(roundId)` | `GET /rounds/{roundId}/my-ballot` |
| `getMatchups(roundId)` | `GET /rounds/{roundId}/matchups` |
| `getResults(roundId)` | `GET /rounds/{roundId}/results` |
| provider search (SubmitSongPage; the Spotify `MusicProvider`, not a `DataClient` method) | `GET /spotify/search` |

---

## 5. Build order (suggested)

1. Table + GSIs (CDK/Amplify), Cognito user pool, an authorizer that injects `userId`.
2. League create/join/list/detail — the smallest closed loop, fully testable without Spotify.
3. Round lifecycle (draft → submitting → voting) + submission upsert.
4. Ballot validation + reveal/tally + standings — the rules engine.
5. Spotify proxy: search first (Client Credentials), then playlist-on-reveal (host token).
6. Swap `mock.ts` for the API client behind the existing page components.

All six are built. The one change of plan: the round playlist is made when submissions close,
not at the reveal (see [Music provider proxy](#music-provider-proxy)).
