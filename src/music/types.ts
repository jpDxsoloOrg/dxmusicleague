// The music-service abstraction layer.
//
// The rest of the app (UI + domain) NEVER talks to Spotify (or any service) directly.
// It only uses the normalized `Track` / `Playlist` shapes and the `MusicProvider`
// interface below. Adding a new service (e.g. YouTube Music) means writing one new
// class that implements `MusicProvider` and registering it — nothing else changes.

export type MusicProviderId = "spotify" | "youtube-music" | "mock";

export interface MusicProviderInfo {
  id: MusicProviderId;
  /** Human-readable name, e.g. "Spotify". */
  name: string;
  /** Whether this provider is wired up and selectable right now. */
  available: boolean;
}

/** A track normalized across providers. The app only ever sees this shape. */
export interface Track {
  /** App-wide unique id: `${provider}:${providerTrackId}`. See `trackKey`. */
  id: string;
  provider: MusicProviderId;
  /** The service's own track id (e.g. a Spotify track id). */
  providerTrackId: string;
  title: string;
  artists: string[];
  album?: string;
  artworkUrl?: string;
  durationMs?: number;
  /** Short preview clip, if the service exposes one. */
  previewUrl?: string;
  /** Public deep link to open the track in the service. */
  externalUrl?: string;
}

/** A shareable public playlist players can open without logging in. */
export interface Playlist {
  id: string;
  provider: MusicProviderId;
  providerPlaylistId: string;
  name: string;
  /** Public URL — no login required. */
  url: string;
}

export interface SearchOptions {
  /** Max results to return. Providers may return fewer. */
  limit?: number;
  /** Market/region hint so results are actually playable (e.g. "US"). */
  market?: string;
}

/** Everything the app needs from a music service. Each service implements this. */
export interface MusicProvider {
  readonly info: MusicProviderInfo;

  /** Search the catalog for tracks matching a free-text query. */
  searchTracks(query: string, opts?: SearchOptions): Promise<Track[]>;

  /** Fetch one track by its provider-native id, or null if not found. */
  getTrack(providerTrackId: string): Promise<Track | null>;

  /**
   * Create a public playlist of the given tracks on the host/service account and
   * return its shareable URL. Used on round reveal. (Backend-side in production.)
   */
  createPlaylist(name: string, tracks: Track[], description?: string): Promise<Playlist>;
}

/** Build the app-wide unique track id from a provider + native id. */
export function trackKey(provider: MusicProviderId, providerTrackId: string): string {
  return `${provider}:${providerTrackId}`;
}

/** Format a track duration (ms) as `m:ss`. */
export function formatDuration(durationMs?: number): string {
  if (!durationMs) return "";
  const total = Math.round(durationMs / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
