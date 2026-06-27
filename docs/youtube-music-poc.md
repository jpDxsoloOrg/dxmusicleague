# YouTube Music PoC — `ytmusic-api`

A Phase-1-style spike to de-risk a YouTube Music provider, the same way the Spotify
spike de-risked Spotify. Run it: `node poc/ytmusic_search.mjs` (writes a results
table to [SEARCH_RESULTS_YTMUSIC.md](SEARCH_RESULTS_YTMUSIC.md)).

Library: [`ytmusic-api`](https://github.com/zS1L3NT/ts-npm-ytmusic-api) **v5.3.1**
(deps: axios, tough-cookie, zod). Unofficial — it scrapes YT Music's internal API.

## Verdict

**Half the integration is proven and cheap; the other half (playlist creation) is
NOT covered by this library and needs a separate official-API integration.**

| Function | `ytmusic-api`? | Notes |
|---|---|---|
| Song search | ✅ **Proven, no auth** | `searchSongs(q)` works with zero cookies/login |
| Fetch one track | ✅ Proven | `getSong(videoId)` round-trips |
| **Playlist creation** | ❌ **Not supported** | Library is **read-only** — no `createPlaylist` exists |

## What the spike proved (empirically)

- **Search works with NO authentication.** `new YTMusic(); await initialize()` with
  no cookies returns real, relevant songs. This is the YT-Music parallel to Spotify's
  Client Credentials flow — and it's even simpler (no client id/secret at all).
- **`SongDetailed` maps cleanly onto our `Track`.** One quirk: `duration` is in
  **seconds** (we use ms), and `artist` is a **single** object, not an array. The
  spike's `toTrack()` handles both. No preview-clip URL is exposed.
- **`getSong(videoId)` round-trips**, covering the app's `getTrack`.

## The one real gap: playlist creation

`ytmusic-api` exposes only `search*` / `get*` methods — there is **no way to create
or modify a playlist** through it, authenticated or not. So the "share a public
playlist on round reveal" step (the thing the Spotify spike's `spotify_playlist.mjs`
proved) is **not solved by this library**. Options, in order of preference:

1. **Official YouTube Data API v3** for playlist writes — `playlists.insert` +
   `playlistItems.insert`, OAuth on a single **host Google account**. This is the
   exact analogue of the Spotify host-account pattern: players never authenticate;
   one host account owns the playlists. Has a daily quota (playlist writes are
   relatively expensive) but our volume is tiny. **Recommended.**
2. Skip real playlists — share a YT Music search/queue deep link. Weak UX; avoid.

So a full YouTube Music provider = **`ytmusic-api` for the read path (search/get,
no auth)** + **YouTube Data API v3 for the write path (playlist on reveal, host
OAuth)**. Two libraries, mirroring Spotify's read/write split.

## Architectural constraints (carry into the build)

- **Node-only.** `ytmusic-api` uses axios + a cookie jar and is **not browser-safe**.
  Like Spotify, all calls go through our **backend (Lambda) proxy**; the app's
  `YouTubeMusicProvider` would call OUR API, never YT Music directly — same shape as
  [spotifyProvider.ts](../src/music/providers/spotifyProvider.ts).
- **Unofficial / scraping risk.** It can break if YT Music changes its internal API.
  Acceptable for a hobby app; pin the version and treat breakage as a known risk.
- **No per-user data needed** — search is anonymous, playlists are host-owned. The
  whole "players never authenticate" rule from CLAUDE.md holds here too.

## Next step to wire it into the app

Write `src/music/providers/youtubeMusicProvider.ts` implementing `MusicProvider`
against the backend proxy (copy the `spotifyProvider.ts` structure), then swap the
`youtube-music` entry in [src/music/index.ts](../src/music/index.ts) off the mock
placeholder. The proxy's search handler is what `poc/ytmusic_search.mjs` prototypes;
its playlist handler will use YouTube Data API v3, not `ytmusic-api`.
