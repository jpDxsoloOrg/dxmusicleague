// Local dev-only proxy for YouTube Music search.
//
// `ytmusic-api` is a Node-only scraper (axios + cookie jar) and can't run in the
// browser, and YT Music's internal API has no CORS — so search must happen
// server-side. In production that's the Lambda proxy; for local `vite dev` this
// plugin runs `ytmusic-api` inside the dev server and exposes the SAME endpoint
// shape the real proxy will (`/youtube-music/search`, `/youtube-music/tracks/:id`),
// so YouTubeMusicProvider works end-to-end with zero env config.
//
// NOTE: search/get only. Playlist creation needs the official YouTube Data API v3
// (host OAuth) and is deliberately NOT implemented here — see docs/youtube-music-poc.md.

import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";

// Lazily create one shared, initialized client (init does a network handshake).
let clientPromise: Promise<any> | undefined;
async function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { default: YTMusic } = await import("ytmusic-api");
      const yt = new YTMusic();
      await yt.initialize(); // no cookies → unauthenticated
      return yt;
    })();
  }
  return clientPromise;
}

// Map ytmusic-api's SongDetailed onto the proxy's normalized ApiTrack shape.
// (duration is in seconds; artist is a single object; pick the largest thumbnail.)
function toApiTrack(song: any) {
  const art = [...(song.thumbnails ?? [])].sort((a: any, b: any) => b.width - a.width)[0];
  return {
    id: song.videoId,
    title: song.name,
    artists: song.artist?.name ? [song.artist.name] : [],
    album: song.album?.name,
    artworkUrl: art?.url,
    durationMs: song.duration != null ? song.duration * 1000 : undefined,
    externalUrl: `https://music.youtube.com/watch?v=${song.videoId}`,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export function ytmusicDevProxy(): Plugin {
  return {
    name: "ytmusic-dev-proxy",
    apply: "serve", // dev server only — never in the production build
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        const url = new URL(req.url ?? "", "http://localhost");
        if (!url.pathname.startsWith("/youtube-music/")) return next();

        try {
          const yt = await getClient();

          // GET /youtube-music/search?q=...&limit=...
          if (url.pathname === "/youtube-music/search") {
            const q = url.searchParams.get("q") ?? "";
            const limit = Number(url.searchParams.get("limit")) || 10;
            if (!q.trim()) return sendJson(res, 400, { error: "missing q" });
            const songs = await yt.searchSongs(q);
            return sendJson(res, 200, { tracks: songs.slice(0, limit).map(toApiTrack) });
          }

          // GET /youtube-music/tracks/:videoId
          const match = url.pathname.match(/^\/youtube-music\/tracks\/([^/]+)$/);
          if (match) {
            const song = await yt.getSong(decodeURIComponent(match[1]));
            return sendJson(res, 200, toApiTrack(song));
          }

          // Playlist writes intentionally unimplemented in dev.
          return sendJson(res, 501, { error: "not implemented in dev proxy" });
        } catch (err) {
          server.config.logger.error(`[ytmusic-dev-proxy] ${(err as Error).message}`);
          sendJson(res, 502, { error: "ytmusic-api request failed" });
        }
      });
    },
  };
}
