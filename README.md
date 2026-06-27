# DX Music League — Web App

Vite + React + TypeScript frontend. Phase 2 of [../musicLeagueClone.md](../musicLeagueClone.md).

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
      mockProvider.ts     in-memory catalog; powers the UI today
      spotifyProvider.ts  talks to OUR backend proxy (never to Spotify from the browser)
    index.ts              registry: getProvider(id), listAvailableProviders()
  domain/types.ts         League, Round, Submission, Vote (League.musicProvider selects service)
  data/mock.ts            mock leagues/rounds + view-model helpers (swap for API in Phase 2+)
  components/             AppLayout (sidebar + topbar), Avatar
  pages/                  DashboardPage (built), Placeholder (stubs for the rest)
  styles/global.css       "Sonic Syndicate" theme tokens (from the Stitch designs)
```

### Adding a music provider

1. Create `src/music/providers/youtubeMusicProvider.ts` implementing `MusicProvider`.
2. Register it in `src/music/index.ts`.
3. That's it — UI/domain already consume it via `getProvider(league.musicProvider)`.

### Spotify rule (see ../CLAUDE.md)

Players never authenticate with Spotify. `spotifyProvider` calls our Lambda proxy
(`VITE_API_BASE`), which holds the client secret + host refresh token. It's `available`
only once `VITE_API_BASE` is set; until then the app runs on the `mock` provider.

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
