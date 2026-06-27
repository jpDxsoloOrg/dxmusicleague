// YouTube Music implementation of the MusicProvider contract.
//
// IMPORTANT (see docs/youtube-music-poc.md): like Spotify, players NEVER authenticate.
// All calls go through our backend (Lambda) proxy. This class talks only to OUR API,
// never to YouTube directly — `ytmusic-api` is a Node-only scraper and can't run in the
// browser. The provider is split across two backend integrations, hidden behind one
// proxy: search/get use `ytmusic-api` (no auth), and playlist creation uses the
// official YouTube Data API v3 on a single host Google account.
//
// The backend endpoints don't exist yet — this maps the agreed contract so the UI is
// ready to switch from the mock provider to live the moment the proxy ships. The PoC in
// poc/ytmusic_search.mjs prototypes the proxy's search handler.

import type {
  MusicProvider,
  MusicProviderInfo,
  Playlist,
  SearchOptions,
  Track,
} from "../types";
import { trackKey } from "../types";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

// Shape our backend proxy returns for a track (already normalized server-side).
// The proxy maps ytmusic-api's SongDetailed onto this — `id` is the YT Music videoId.
interface ApiTrack {
  id: string;
  title: string;
  artists: string[];
  album?: string;
  artworkUrl?: string;
  durationMs?: number;
  previewUrl?: string;
  externalUrl?: string;
}

function toTrack(raw: ApiTrack): Track {
  return {
    id: trackKey("youtube-music", raw.id),
    provider: "youtube-music",
    providerTrackId: raw.id,
    title: raw.title,
    artists: raw.artists,
    album: raw.album,
    artworkUrl: raw.artworkUrl,
    durationMs: raw.durationMs,
    previewUrl: raw.previewUrl,
    externalUrl: raw.externalUrl,
  };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // In `vite dev` the bundled dev proxy (vite-plugin-ytmusic) serves these paths
  // same-origin, so an empty API_BASE (relative fetch) is correct. In a production
  // build with no proxy configured, fail loudly instead of fetching our own origin.
  if (!API_BASE && !import.meta.env.DEV) {
    throw new Error(
      "YouTube Music provider not configured: set VITE_API_BASE to the backend proxy URL.",
    );
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`Backend error ${res.status} for ${path}`);
  return res.json() as Promise<T>;
}

export class YouTubeMusicProvider implements MusicProvider {
  // Available when a real proxy is configured, OR in `vite dev` where the bundled
  // dev proxy serves search/get same-origin (playlist writes still need the proxy).
  readonly info: MusicProviderInfo = {
    id: "youtube-music",
    name: "YouTube Music",
    available: Boolean(API_BASE) || import.meta.env.DEV,
  };

  async searchTracks(query: string, opts?: SearchOptions): Promise<Track[]> {
    const params = new URLSearchParams({ q: query });
    if (opts?.limit) params.set("limit", String(opts.limit));
    // `market` has no analogue in ytmusic-api; the proxy uses GL/HL region hints instead.
    if (opts?.market) params.set("region", opts.market);
    const data = await api<{ tracks: ApiTrack[] }>(`/youtube-music/search?${params}`);
    return data.tracks.map(toTrack);
  }

  async getTrack(providerTrackId: string): Promise<Track | null> {
    try {
      const data = await api<ApiTrack>(`/youtube-music/tracks/${providerTrackId}`);
      return toTrack(data);
    } catch {
      return null;
    }
  }

  async createPlaylist(name: string, tracks: Track[], description?: string): Promise<Playlist> {
    // Backend-side this uses YouTube Data API v3 (host account), NOT ytmusic-api,
    // which is read-only. From here it's just our proxy contract — same as Spotify.
    const data = await api<{ id: string; url: string }>(`/youtube-music/playlists`, {
      method: "POST",
      body: JSON.stringify({
        name,
        description,
        trackIds: tracks.map((t) => t.providerTrackId),
      }),
    });
    return {
      id: trackKey("youtube-music", data.id),
      provider: "youtube-music",
      providerPlaylistId: data.id,
      name,
      url: data.url,
    };
  }
}
