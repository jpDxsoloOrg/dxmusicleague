// The seeded head-to-head league — ONE fixture shared by the in-memory backend
// seed (data/memory.ts) and the frontend mock (src/data/mock.ts, HTH-09), so
// mock mode and API mode against the local backend show the same league with
// the same ids, songs, ballots and record, and the downstream UI tickets
// (HTH-10 vote page, HTH-11 reveal + standings) have one fixture to test on.
//
// Pure data plus domain derivation — no I/O, no Node APIs (isomorphic like
// domain/schedule.ts, which the frontend imports too). Nothing here is
// hand-computed: round 1's tally, outcomes and everyone's W/L/D are settled by
// the same domain rules the reveal uses (domain/rules.ts over
// domain/matchups.ts), so the seeded record always matches its ballots.
//
// "Friday Faceoff": 5 players (odd field → one bye a round, 5-round season),
// owned by u-me so the owner flows (reveal, next round) work in mock mode.
// The season is frozen (round 1 opened) with a fixed order + salt, so joins
// are refused with the season-locked message.
//   Round 1 — revealed: Sarah vs Max is a 1–1 DRAW; Mia vs J-Pop is a
//     WALKOVER (J-Pop never submitted — Mia W, J-Pop L); James has the BYE
//     (exhibition song, no result).
//   Round 2 — voting: Max vs Mia (Max's own matchup, locked for him) and
//     Sarah vs James (Max's one pick); J-Pop has the bye. J-Pop and Sarah have
//     voted; Max, Mia and James haven't.
// Submission ids are opaque (no submitter in them): they reach voters before
// the reveal.

import type { Ballot, League, Round, Submission, Track } from "../domain/types.ts";
import { DEFAULT_LEAGUE_SETTINGS, applyFormatSettings } from "../domain/types.ts";
import { deriveRoundMatchups } from "../domain/matchups.ts";
import { matchupRecords, resolveMatchups, tallyMatchups } from "../domain/rules.ts";
import type { StandingTotals } from "../domain/standings.ts";

export const H2H_SEED_LEAGUE_ID = "lg-faceoff";

/** Everything the seed writes: the league WITH its server-only season secrets
 *  (`h2hParticipants`, `h2hSalt` — callers keep them off client payloads),
 *  its rounds (round 1 carrying the reveal's pins), every submission and
 *  ballot, and one standing row per member. */
export interface HeadToHeadSeed {
  league: League;
  rounds: Round[];
  submissions: Submission[];
  ballots: Ballot[];
  standings: StandingTotals[];
}

const PLAYERS = ["u-me", "u-sarah", "u-james", "u-mia", "u-jpop"];
/** The frozen order + salt, as round 1's open would have drawn them. Chosen so
 *  the first two rounds exercise every matchup state (see the header). */
const ORDER = ["u-mia", "u-me", "u-jpop", "u-sarah", "u-james"];
const SALT = "015eedf00dc0ffee42015eedf00dc0ff";

const R1 = "r-ff-1";
const R2 = "r-ff-2";

const track = (pid: string, title: string, artist: string, album: string, durationMs: number): Track => ({
  id: `mock:${pid}`, // trackKey("mock", pid) — the mock music catalog's tracks
  provider: "mock",
  providerTrackId: pid,
  title,
  artists: [artist],
  album,
  durationMs,
});

/**
 * Build the fixture. `now` anchors the activity timestamps (submittedAt /
 * castAt) a few hours back, so the activity feed reads naturally; nothing
 * else depends on it (the league is manual: no deadlines).
 */
export function headToHeadSeed(now: Date = new Date()): HeadToHeadSeed {
  const ago = (minutes: number): string => new Date(now.getTime() - minutes * 60_000).toISOString();

  const league: League = {
    id: H2H_SEED_LEAGUE_ID,
    name: "Friday Faceoff",
    ownerId: "u-me",
    musicProvider: "mock",
    format: "headToHead",
    settings: applyFormatSettings("headToHead", DEFAULT_LEAGUE_SETTINGS),
    memberIds: [...PLAYERS],
    inviteCode: "FACE-5",
    visibility: "private",
    // = scheduleLength(5): set by the freeze, whatever was typed at creation.
    roundCount: 5,
    progression: "manual",
    h2hParticipants: [...ORDER],
    h2hSalt: SALT,
  };

  const submissions: Submission[] = [
    // Round 1 — J-Pop never submitted (his pair is a walkover).
    { id: "sub-ff1-7c2a", roundId: R1, userId: "u-sarah", track: track("m6", "Levitating", "Dua Lipa", "Future Nostalgia", 203000),
      comment: "Pure walk-out energy.", submittedAt: ago(4 * 24 * 60) },
    { id: "sub-ff1-19e4", roundId: R1, userId: "u-me", track: track("m1", "Midnight City", "M83", "Hurry Up, We're Dreaming", 243000),
      comment: "Those horns at the drop.", submittedAt: ago(4 * 24 * 60 - 30) },
    { id: "sub-ff1-b305", roundId: R1, userId: "u-mia", track: track("m7", "Good 4 U", "Olivia Rodrigo", "SOUR", 178000),
      submittedAt: ago(4 * 24 * 60 - 90) },
    { id: "sub-ff1-e8d1", roundId: R1, userId: "u-james", track: track("m8", "Digital Love", "Daft Punk", "Discovery", 301000),
      comment: "Bye week, so here's a deep cut.", submittedAt: ago(4 * 24 * 60 - 120) },
    // Round 2 — everyone submitted.
    { id: "sub-ff2-4b9f", roundId: R2, userId: "u-me", track: track("m2", "Nightcall", "Kavinsky", "OutRun", 258000),
      comment: "Night drive essential.", submittedAt: ago(26 * 60) },
    { id: "sub-ff2-a06c", roundId: R2, userId: "u-mia", track: track("m5", "Blinding Lights", "The Weeknd", "After Hours", 200000),
      submittedAt: ago(25 * 60) },
    { id: "sub-ff2-5d37", roundId: R2, userId: "u-sarah", track: track("m10", "Heat Waves", "Glass Animals", "Dreamland", 238000),
      comment: "Windows down for this one.", submittedAt: ago(24 * 60) },
    { id: "sub-ff2-c812", roundId: R2, userId: "u-james", track: track("m3", "Resonance", "HOME", "Odyssey", 213000),
      submittedAt: ago(22 * 60) },
    { id: "sub-ff2-0fe5", roundId: R2, userId: "u-jpop", track: track("m9", "Starlight", "Muse", "Black Holes and Revelations", 240000),
      comment: "Back in the game.", submittedAt: ago(21 * 60) },
  ];

  // Round 1 matchups: Sarah vs Max (M0), Mia vs J-Pop (M1), James on the bye.
  // Round 2 matchups: Max vs Mia (M0), Sarah vs James (M1), J-Pop on the bye.
  // (Derived from ORDER + SALT; the seed test pins these.)
  const ballots: Ballot[] = [
    // Round 1: the only contest is Sarah vs Max — Mia and James split it 1–1.
    { roundId: R1, voterId: "u-mia", allocations: {}, picks: { [`${R1}~M0`]: "sub-ff1-7c2a" },
      comments: { "sub-ff1-7c2a": "Instant dancefloor filler.", "sub-ff1-19e4": "So close — love this one too." },
      castAt: ago(3 * 24 * 60) },
    { roundId: R1, voterId: "u-james", allocations: {}, picks: { [`${R1}~M0`]: "sub-ff1-19e4" },
      comments: { "sub-ff1-19e4": "A certified classic." },
      castAt: ago(3 * 24 * 60 - 45) },
    // Round 2 (voting): J-Pop (bye) picks in both; Sarah picks in Max vs Mia.
    { roundId: R2, voterId: "u-jpop", allocations: {},
      picks: { [`${R2}~M0`]: "sub-ff2-a06c", [`${R2}~M1`]: "sub-ff2-5d37" },
      comments: { "sub-ff2-a06c": "Undefeated synth line." },
      castAt: ago(3 * 60) },
    { roundId: R2, voterId: "u-sarah", allocations: {}, picks: { [`${R2}~M0`]: "sub-ff2-a06c" },
      castAt: ago(90) },
  ];

  const round1: Round = { id: R1, leagueId: league.id, index: 1, theme: "Walk-out songs", status: "revealed",
    description: "The track you'd walk out to before a title fight.", playlistUrl: "https://example.com/mock-playlist/ff1" };
  const round2: Round = { id: R2, leagueId: league.id, index: 2, theme: "Late-night drive", status: "voting",
    playlistUrl: "https://example.com/mock-playlist/ff2" };

  // Settle round 1 exactly as finalizeReveal does — nobody had departed — and
  // pin what it counted on the round, so every later read re-derives it.
  const r1Matchups = deriveRoundMatchups(league, { ...round1, status: "voting" },
    submissions.filter((s) => s.roundId === R1), { departed: [] });
  const tally = tallyMatchups(r1Matchups, ballots.filter((b) => b.roundId === R1));
  round1.h2hDeparted = [];
  round1.h2hTally = tally;

  // Every member's standing row (points stay 0 in head-to-head) + round 1's W/L/D.
  const rows = new Map<string, StandingTotals>(
    PLAYERS.map((userId) => [userId, { userId, points: 0, wins: 0, losses: 0, draws: 0 }]),
  );
  for (const { userId, delta } of matchupRecords(resolveMatchups(r1Matchups, tally).matchups)) {
    const row = rows.get(userId)!;
    row.wins += delta.wins ?? 0;
    row.losses += delta.losses ?? 0;
    row.draws += delta.draws ?? 0;
  }

  return { league, rounds: [round1, round2], submissions, ballots, standings: [...rows.values()] };
}
