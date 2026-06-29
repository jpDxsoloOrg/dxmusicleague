// Spotify implementation of the MusicProvider contract.
//
// IMPORTANT (see CLAUDE.md): players NEVER authenticate with Spotify. All calls go
// through our backend (Lambda) proxy, which holds the client secret and the host
// refresh token. This class therefore talks only to OUR API, not to Spotify directly.
// The backend endpoints don't exist yet — this maps the agreed contract so the UI is
// ready to switch from the mock provider to live the moment the proxy ships.

import type {
  MusicProvider,
  MusicProviderInfo,
  Playlist,
  SearchOptions,
  Track,
} from "../types";
import { trackKey } from "../types";
import { auth } from "../../auth/config";

// Same backend base URL as the data client; in AWS mode the proxy is live.
const API_BASE = import.meta.env.VITE_API_URL ?? "";

// Shape our backend proxy returns for a track (already simplified server-side).
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
    id: trackKey("spotify", raw.id),
    provider: "spotify",
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
  if (!API_BASE) {
    throw new Error("Spotify provider not configured: set VITE_API_URL to the backend proxy URL.");
  }
  // The proxy sits behind the Cognito authorizer, so send the caller's token.
  const token = await auth.idToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) throw new Error(`Backend error ${res.status} for ${path}`);
  return res.json() as Promise<T>;
}

export class SpotifyMusicProvider implements MusicProvider {
  // `available` once VITE_API_URL points at the live proxy (AWS mode).
  readonly info: MusicProviderInfo = {
    id: "spotify",
    name: "Spotify",
    available: Boolean(API_BASE),
  };

  async searchTracks(query: string, opts?: SearchOptions): Promise<Track[]> {
    const params = new URLSearchParams({ q: query });
    if (opts?.limit) params.set("limit", String(Math.min(opts.limit, 10))); // Feb 2026 cap
    if (opts?.market) params.set("market", opts.market);
    const data = await api<{ tracks: ApiTrack[] }>(`/spotify/search?${params}`);
    return data.tracks.map(toTrack);
  }

  async getTrack(providerTrackId: string): Promise<Track | null> {
    try {
      const data = await api<ApiTrack>(`/spotify/tracks/${providerTrackId}`);
      return toTrack(data);
    } catch {
      return null;
    }
  }

  async createPlaylist(name: string, tracks: Track[], description?: string): Promise<Playlist> {
    const data = await api<{ id: string; url: string }>(`/spotify/playlists`, {
      method: "POST",
      body: JSON.stringify({
        name,
        description,
        trackIds: tracks.map((t) => t.providerTrackId),
      }),
    });
    return {
      id: trackKey("spotify", data.id),
      provider: "spotify",
      providerPlaylistId: data.id,
      name,
      url: data.url,
    };
  }
}
