# DX Music League — Web App

Vite + React + TypeScript frontend for a self-hosted **Music League** clone: players join a
league, each round has a theme, everyone submits one song, players vote by spreading a point
pool across submissions, scores tally across rounds, and a playlist of each round's songs is
shared. Currently runs on mock data — no backend yet.

## Run

```bash
npm install        # if sockets time out: npm install --maxsockets=1
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build
```

## Architecture

The defining rule: **the app is music-service-agnostic.** Nothing in the UI or domain
references Spotify directly. A league picks a provider; everything else works through an
interface. Swapping to (or adding) YouTube Music later = write one new provider class.

```
src/
  music/                  ← the provider abstraction (keystone)
    types.ts              MusicProvider interface + normalized Track / Playlist
    providers/
      mockProvider.ts        in-memory catalog; powers the UI today
      spotifyProvider.ts     talks to OUR backend proxy (never to Spotify from the browser)
      youtubeMusicProvider.ts talks to OUR proxy; in `vite dev` the bundled proxy makes search live
    index.ts              registry: getProvider(id), listAvailableProviders()
  domain/types.ts         League, Round, Submission, Vote (League.musicProvider selects service)
  data/mock.ts            mock leagues/rounds + view-model helpers (swap for API in Phase 2+)
  components/             AppLayout (sidebar + topbar), Avatar, TrackArt
  pages/                  Dashboard, RoundOverview, SubmitSong, Vote, Reveal, Rounds,
                          Leaderboard, Profile, Placeholder (for not-yet-built routes)
  lib/                    small helpers (e.g. time/countdown formatting)
  styles/global.css       "Sonic Syndicate" theme tokens (from the original designs)
```

### Adding a music provider

1. Create `src/music/providers/youtubeMusicProvider.ts` implementing `MusicProvider`.
2. Register it in `src/music/index.ts`.
3. That's it — UI/domain already consume it via `getProvider(league.musicProvider)`.

### Spotify rule

Players never authenticate with Spotify. `spotifyProvider` calls our backend proxy
(`VITE_API_BASE`), which holds the client secret + host refresh token — the secret never
reaches the browser. The Spotify provider is `available` only once `VITE_API_BASE` is set;
until then the app runs on the `mock` provider.

### YouTube Music

Same "players never authenticate" rule, but split across two APIs (see
[docs/youtube-music-poc.md](docs/youtube-music-poc.md)):

- **Search / get track** — the unofficial [`ytmusic-api`](https://github.com/zS1L3NT/ts-npm-ytmusic-api)
  (no auth, free, pinned to `5.3.1`). It's Node-only and CORS-blocked in the browser, so it
  must run server-side.
- **Playlist on reveal** — the **official YouTube Data API v3** (host-account OAuth);
  `ytmusic-api` is read-only and can't create playlists.

For local dev, [`vite-plugin-ytmusic.ts`](vite-plugin-ytmusic.ts) runs `ytmusic-api` inside the
Vite dev server and serves the same `/youtube-music/*` endpoints the real proxy will, so search
works end-to-end with **zero config** in `npm run dev`. Playlist writes are deliberately not
implemented there (they need the official API). `poc/ytmusic_search.mjs` is the standalone spike
that proved the search path.

## Status

- ✅ Dashboard (live, mock data)
- ✅ Round Overview (`/leagues/:id`) — stepper, active-round hero, standings, activity
- ✅ Submit a Song (`/leagues/:id/submit`) — live provider search, select, comment, submit
- ✅ Vote (`/leagues/:id/vote`) — point-pool allocation, anonymous submissions, spend-all-to-submit, optional per-song comment
- ✅ Reveal (`/leagues/:id/reveal`) — winner highlight, ranked results w/ submitters, per-song voter comments, playlist link, leaderboard
- ✅ Rounds (`/rounds`) — active rounds across leagues with per-status CTAs
- ✅ Leaderboard (`/leaderboard`) — per-league standings, tabbed, highlights you
- ✅ Profile (`/profile`) — stats (leagues, points, best finish) + per-league standings
- ⬜ Create / Join league flows (dashboard action cards still stubbed with `Placeholder`)
  - Create-league: include a "Music service" dropdown defaulting to **Spotify**, with Spotify
    the only selectable option for now (saves to `League.musicProvider`).
- ⬜ Backend (Cognito, DynamoDB, Spotify proxy) — not started.
