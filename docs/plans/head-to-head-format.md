# Head-to-head format — design notes

> Living notes for the "Head-to-Head Format" epic (HTH-01 … HTH-12). Each section
> records a behavior that was a judgment call, so the next person (or playoffs,
> HTH-13) doesn't have to rediscover it from the code. The code comments carry
> the detail; this is the overview.

## Progression, completion % and departures (HTH-08)

The round machinery — timed auto-advance (`backend/src/handlers/progression.ts`),
the owner's phase changes (`handlers/rounds.ts`), the dashboard completion %
and the round's who-submitted / who-voted panels (`handlers/leagues.ts`) — stays
format-agnostic: one song and one ballot row per member. Deadlines, cascades
through elapsed phases, and early-advance re-basing work unchanged for
head-to-head leagues. The only thing that differs is **who "everyone" is**,
defined once in `backend/src/domain/matchups.ts` ("turnout"):

| Phase | Standard league | Head-to-head league |
|---|---|---|
| Submitting is done when… | songs ≥ members × songs-per-player | every **current** member has their one song |
| Voting is done when… | a ballot row per member (and songs exist) | every member **who has a matchup to pick in** has picked in all of them |
| Completion % | songs / slots, ballots / members | the same people-counts as the row above (100 when nobody can vote) |
| Who-voted panel names | every member, voted or waiting | every member while everyone can vote; otherwise only the viewer (see below) |
| Activity feed "cast their votes" | every ballot | every ballot while everyone can vote; otherwise only the viewer's own (see below) |

Why the head-to-head counts differ:

- **A departed player's song doesn't count toward "everyone submitted".** Their
  song is withdrawn (their pair plays as a walkover), so it must not stand in
  for a member who stayed and hasn't submitted yet — in head-to-head that member
  would lose by walkover the moment the phase closed early.
- **Members with nothing to vote on aren't waited for.** A voter's votable set is
  every contest (both songs present) that isn't their own matchup. It is empty
  for both players of a two-player league, and for the pair of a round whose
  only contest is their own. Counting them would keep the round from ever
  finishing early and the completion % from ever reaching 100.
- **A ballot row isn't proof of a vote.** A member with nothing to vote on can
  still leave a comments-only ballot, and a ballot cast while a player was
  departed has no pick in that player's pair once they rejoin (the pair is a
  contest again). A member counts as voted only when their ballot picks one of
  the two songs in every matchup they can vote in now — exactly the picks the
  tally would count.

### A round nobody can vote in goes straight to the reveal

When no member has a matchup to pick in — every pair is a walkover or a no
contest, or it's a two-player league whose one matchup is both players' own —
no ballot could ever arrive. Rather than sit dead in voting until a deadline
(timed) or until the owner notices (manual), the round is revealed on the spot:

- **Owner opens voting** (`PATCH` previewing → voting, manual or timed league):
  the response is the round already `revealed`, the PATCH's own edits included,
  with W/L/D banked by the normal reveal (HTH-07 rules: walkover W/L, no contest
  nothing, a contest nobody could vote in is a 0–0 draw). If another reveal
  settled the round first (a second PATCH, or a timed advance), the PATCH's
  edits never landed, so it answers 409 "That round was just revealed", as any
  head-to-head round write does in that race; nothing is banked twice.
- **Timed league reaches voting by deadline:** the auto-advance's everyone-voted
  check is vacuously true when nobody can vote, so the same read that moves the
  round into voting reveals it. The same applies if departures mid-voting leave
  nobody who can vote: the next read reveals the round.

A consequence worth knowing: a two-player head-to-head league never has a
voting phase. Both players submit, and the round reveals as a draw (or a
walkover if one of them didn't submit). That's inherent to the format — nobody
outside the matchup exists to judge it.

### Who-voted panel and anonymity

The panel's counts (`X of N ballots in`) are over the voters the round waits
on, as above. Its **names** are a different matter, because eligibility is
itself identifying. Two or more contests give every member something to judge,
and with none nobody can vote; so a round has members with nothing to vote on
exactly when it has a single contest, and those members are that contest's
pair. Listing only the eligible voters, or showing the others as "n/a", would
therefore name the pair of the only contest, and with it:

- the owner of every song outside that contest: the bye song (shown anonymously
  by `GET /rounds/:id/matchups`), and any walkover song (the no-show was
  already named by the submissions panel);
- for each of the two contest players, who their opponent is, and so who wrote
  the other song in their own matchup. In a three-player league (one contest
  plus a bye, every round) that attributes every song in the round.

That is exactly what the matchups payload hides (`isMine` is its only identity
signal, HTH-05). So the panel names voters only while **every** member can vote
(eligibility then says nothing about who plays whom). Otherwise it names
nobody but the viewer, and only if they can vote, which they already know from
their own matchups. The counts are still sent (the number of eligible voters
follows from the matchups payload anyway). `votingPanelNames` in
`domain/matchups.ts` is the rule; the HTH-09 MockClient must mirror it.

A useful side effect: a member who appears in **neither** list has nothing to
vote on this round (the pair of the only contest), which the round overview can
use for its call to action (HTH-11) instead of "Vote now".

**The activity feed follows the same rule.** Its "cast their votes" entries name
a ballot's author, and next to a voted / eligible count that is attributable
from a single snapshot: an entry that moved the count belongs to an eligible
voter (in a three-player league, the bye player, so the bye song is theirs and
each contest player learns their opponent), and an entry that didn't is a
contest player's comments-only ballot. (Before HTH-08 the count was ballot
rows / members, so every entry moved it and said nothing about eligibility;
counting only eligible voters is what makes the names identifying.) So while
the panel withholds names, the feed shows each viewer **only their own**
ballot entry; other members' ballots (comments-only rows and departed voters'
ballots included) are left out until the reveal, when the feed shows them all
again. While every member can vote, the feed is unchanged. One predicate,
`votersNameable` in `domain/matchups.ts`, drives both the panel
(`votingPanelNames`) and the feed (`ballotAuthorVisible`); the HTH-09
MockClient must mirror both.

Remaining residual: names shown while everyone could vote stay in a viewer's
memory. If a departure mid-voting then leaves a single contest, the count after
it can be read against who had voted before, which can narrow down who is in
that contest. That needs a leave or kick mid-voting that drops the round to a
single contest, and a viewer who looked before it. Closing it would mean never
naming head-to-head voters at all, in the panel or the feed; that is a product
call for the lead, not made here.

### Leave / kick mid-season

Allowed at any point, as for standard leagues. The departed player's song is
withdrawn from the current round, so their pair resolves as a walkover for the
player who stayed at that round's reveal (the departed player takes no L; their
standing row survives for a rejoin — HTH-04/HTH-07). Every voter whose set
included that pair simply has one fewer matchup to pick in, so progress and the
everyone-voted check follow the shrunken sets immediately.

### Finished league and rematch

Unchanged: the league is finished once its final round (`roundCount`, set to
the round-robin length when round 1 opens — HTH-03) is revealed; the wrap-up
winner is `standings[0]`, which the head-to-head sort makes the best record
(HTH-04); the rematch clone keeps the format and starts un-frozen (HTH-03).

### Places progression needed a format branch

Flagged per the ticket, in case they point at a leak worth refactoring:

1. `autoAdvanceRound` everyone-submitted — counted by member, not by row.
2. `autoAdvanceRound` everyone-voted — the turnout above instead of a row count.
3. `updateRound` opening voting — the reveal-on-the-spot for a round nobody can
   vote in.
4. `completionPct`, and the submitting / voting panels in `getLeagueDetail` —
   the same people-counts (plus the voting-round activity feed's ballot
   entries, which follow the panel's naming rule).

All four read the one turnout definition in `domain/matchups.ts`, so they can't
drift from each other or from ballot validation and the tally (which share
`votableMatchups`). The standard league's row counts are untouched — including
its known quirk that a departed member's song or ballot still counts toward
"everyone".

## Help, tour and copy (HTH-12)

- **The first-login tour stays format-neutral.** It opens on a first sign-in
  (`AppLayout`) or from Help, never inside a league, so it can't know which
  format the player will meet. The scoring, voting and standings steps
  describe both formats and point to Help (`src/components/Tutorial.tsx`).
- **Help keeps the full head-to-head rules in one place.** "League formats"
  compares Points and Head-to-Head, and "Head-to-head, in detail" covers
  pairings, byes, picking winners, draws, walkovers and no contests,
  standings, the season lock, and rounds that skip voting. The other sections
  still describe the points game and add a short head-to-head note that links
  there (`src/pages/HelpPage.tsx`).
- **Help isn't gated on `H2H_ENABLED`.** That flag only hides the format
  picker on Create league. Existing head-to-head leagues and the rest of the
  head-to-head UI stay live when it's off, and Help already documents timed
  rounds without checking `TIMED_ROUNDS_ENABLED`, so Help follows the same rule.
- **Nothing user-facing promises playoffs** (HTH-13).
- **Copy audit of HTH-01 to HTH-11.** The server messages read clearly and
  are unchanged: season locked, forced settings, ballot referee, matchup
  read guards. The UI copy for the lock note, ballot gate and outcome badges
  is also unchanged. Changes: the Create-league one-liners (the Points blurb
  said everyone votes on every song, but players spread a capped pool
  instead), "W/L" changed to "W–L" to match the standings table, and the
  head-to-head leave confirmation now mentions walkovers, as the owner's kick
  confirmation already did.
- **Known gap, not fixed here:** the public league card and the public
  preview page don't show the format, because `PublicLeagueSummary` and
  `PublicLeaguePreview` don't carry it. A player can claim a spot without
  knowing the league is head-to-head. Fixing this means changing the API
  payload, which is outside a copy ticket.
