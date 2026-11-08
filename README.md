# DX Music League — Web App

Vite + React + TypeScript frontend for a self-hosted **Music League** clone: players join a
league, each round has a theme, everyone submits a song, and players vote by spreading a point
pool across submissions — or, in a **head-to-head** league, by picking the winner of each 1v1
matchup. Scores (or win–loss records) tally across rounds, and a Spotify league gets a playlist of
each round's songs. The app runs on in-memory mock data by default, and against the backend
([backend/](backend/README.md)) when `VITE_API_URL` is set
([src/data/index.ts](src/data/index.ts)).

## Run

```bash
npm install        # if sockets time out: npm install --maxsockets=1
npm run dev        # http://localhost:5173, mock data + mock sign-in (no AWS)
npm run lint       # oxlint
npm run build      # typecheck + production build
```

To run against the backend instead of the mock, start it locally (no AWS — see
[backend/README.md](backend/README.md)) and point `VITE_API_URL` at it:

```bash
(cd backend && npm run dev)                     # API on http://127.0.0.1:8787, in-memory store
VITE_API_URL=http://127.0.0.1:8787 npm run dev  # second shell, repo root
```

Sign-in stays the mock form unless the Cognito variables (`VITE_COGNITO_USER_POOL_ID`,
`VITE_COGNITO_CLIENT_ID`) are set too ([src/auth/config.ts](src/auth/config.ts)), and the local
backend ignores the mock token: every request acts as its default dev user, `u-me` (Curator Max).

## Architecture

The defining rule: **the app is music-service-agnostic.** Nothing in the UI or domain
references Spotify directly. A league picks a provider; everything else works through an
interface. Adding a service = write one new provider class (that's how YouTube Music came in).

```
src/
  music/                  ← the provider abstraction (keystone)
    types.ts              MusicProvider interface + normalized Track / Playlist
    providers/
      mockProvider.ts        in-memory catalog (the seeded head-to-head league plays on it)
      spotifyProvider.ts     talks to OUR backend proxy (never to Spotify from the browser)
      youtubeMusicProvider.ts talks to OUR proxy; in `vite dev` the bundled proxy makes search live
    index.ts              registry: getProvider(id), listAvailableProviders()
  data/                   ← the data-access seam, same pattern
    client.ts             DataClient interface — the only thing pages call
    index.ts              picks ApiClient (VITE_API_URL set) or MockClient
    apiClient.ts          REST client for the backend API
    mockClient.ts         DataClient over the in-memory store in mock.ts
    mock.ts               mock leagues/rounds + view-model types and helpers
  auth/                   AuthBackend seam: MockAuth locally, CognitoAuth when configured
  domain/types.ts         League (musicProvider, format), Round, Submission, Vote
  components/             AppLayout (sidebar + topbar), Avatar, TrackArt, StandingsTable,
                          MatchupBallot, RoundStateCard, Tutorial
  pages/                  Dashboard, Leagues, CreateLeague, JoinLeague, PreviewLeague,
                          RoundOverview, LeagueSettings, SubmitSong, Vote, Reveal, Rounds,
                          Leaderboard, Profile, Help, auth screens, Placeholder (not found)
  lib/                    small helpers (e.g. time/countdown formatting)
  styles/global.css       "Sonic Syndicate" theme tokens (from the original designs)
```

### Adding a music provider

1. Create `src/music/providers/<name>Provider.ts` implementing `MusicProvider`, and add its id to
   `MusicProviderId` (`src/music/types.ts`, mirrored in `backend/src/domain/types.ts`).
2. Register it in `REGISTRY` in `src/music/index.ts` (and in `listProviderOptions()` to offer it
   on Create league, which lists Spotify only for now).
3. That's it — UI/domain already consume it via `getProvider(league.musicProvider)`.

### Spotify rule

Players never authenticate with Spotify. `spotifyProvider` calls our backend proxy
(`GET /spotify/search` on `VITE_API_URL`, the same base URL as the data client), which holds the
client secret + host refresh token — the secret never reaches the browser. The Spotify provider
is `available` only once `VITE_API_URL` is set; in mock mode it has no proxy to call, and its
calls fail with "Spotify provider not configured". Only `youtubeMusicProvider` reads
`VITE_API_BASE` (below).

### YouTube Music

Same "players never authenticate" rule, but split across two APIs (see
[docs/youtube-music-poc.md](docs/youtube-music-poc.md)):

- **Search / get track** — the unofficial [`ytmusic-api`](https://github.com/zS1L3NT/ts-npm-ytmusic-api)
  (no auth, free, pinned to `5.3.1`). It's Node-only and CORS-blocked in the browser, so it
  must run server-side.
- **Round playlist** (not built yet) — the **official YouTube Data API v3** (host-account
  OAuth); `ytmusic-api` is read-only and can't create playlists.

For local dev, [`vite-plugin-ytmusic.ts`](vite-plugin-ytmusic.ts) runs `ytmusic-api` inside the
Vite dev server and serves the same `/youtube-music/*` endpoints the real proxy will, so search
works end-to-end with **zero config** in `npm run dev`. Playlist writes are deliberately not
implemented there (they need the official API). `poc/ytmusic_search.mjs` is the standalone spike
that proved the search path.

## Status

Every screen runs in both modes — on mock data, and against the backend.

- ✅ Sign in / sign up / confirm email / forgot password — mock auth locally, Cognito when configured
- ✅ Dashboard (`/`) — create / join cards, your leagues with round progress and completion %, trending public leagues
- ✅ Leagues (`/leagues`) — your leagues, open public leagues to claim a spot in, leagues in progress to spectate
- ✅ Create league (`/leagues/new`) — name, music service (Spotify only for now; saves to
  `League.musicProvider`), format (Points or Head-to-Head), rounds, manual or timed phases, private or public
- ✅ Join league (`/leagues/join`) — by invite code or link (`?code=`); a league you're already in just opens
- ✅ League preview (`/leagues/:id/preview`) — a public league's theme, members, open slots and format; claim a spot
- ✅ Round Overview (`/leagues/:id`) — stepper, active-round hero, the round's anonymous song list
  while listening / voting (points leagues), who's in vs. pending, standings, activity, invite
  strip, owner round controls, leave, wrap-up + rematch once the final round is revealed
- ✅ League settings (`/leagues/:id/settings`) — owner only: songs per player, voting rules,
  invite code, kick members, delete the league
- ✅ Submit a Song (`/leagues/:id/submit`) — live provider search, select, comment, submit (up to the league's songs per player)
- ✅ Vote (`/leagues/:id/vote`) — point-pool allocation (+ anti-votes when the league enables them), anonymous submissions, spend-all-to-submit, optional per-song comment
- ✅ Reveal (`/leagues/:id/reveal`) — winner highlight, ranked results w/ submitters, +for / −against breakdown, per-song voter comments, playlist link, leaderboard; past rounds via `?round=`
- ✅ Rounds (`/rounds`) — active rounds across leagues with per-status CTAs
- ✅ Leaderboard (`/leaderboard`) — per-league standings, tabbed, highlights you
- ✅ Profile (`/profile`) — stats (leagues, points, best finish) + per-league standings
- ✅ Help (`/help`) — wiki-style rules for both formats, plus the first-login tour
- ✅ Head-to-head format — the format picker on Create league; a round-robin schedule drawn when
  round 1 opens (one bye a round for an odd field); the matchup vote page (pick a winner in every
  matchup but your own); the matchup reveal (wins, draws, walkovers, no contests, the bye's
  exhibition song); W–L standings on the overview, leaderboard and profile; and the season lock
  (once round 1 opens nobody joins, and a player who leaves or is removed can't rejoin). One
  seeded league, Friday Faceoff (`lg-faceoff`), plays it in both modes. Design notes:
  [docs/plans/head-to-head-format.md](docs/plans/head-to-head-format.md).
- ✅ Backend — REST API on AWS (Cognito, API Gateway + Lambda, DynamoDB, Spotify proxy), runnable
  locally against an in-memory store. See [backend/README.md](backend/README.md).
- ⬜ YouTube Music outside `vite dev` — the backend has no `/youtube-music/*` routes yet, so its
  search runs only in the Vite dev server's bundled proxy, and no YouTube playlist is made.
