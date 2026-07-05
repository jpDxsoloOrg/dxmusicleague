// Provider registry. The app asks for a provider by id; it never `new`s one directly.
//
// A league stores which provider it uses (League.musicProvider). UI code does:
//   const provider = getProvider(league.musicProvider);
//   await provider.searchTracks(...)
// and stays completely unaware of which service is behind it.

import type { MusicProvider, MusicProviderId, MusicProviderInfo } from "./types";
import { MockMusicProvider } from "./providers/mockProvider";
import { SpotifyMusicProvider } from "./providers/spotifyProvider";
import { YouTubeMusicProvider } from "./providers/youtubeMusicProvider";

const REGISTRY: Record<MusicProviderId, MusicProvider> = {
  mock: new MockMusicProvider(),
  spotify: new SpotifyMusicProvider(),
  "youtube-music": new YouTubeMusicProvider(),
};

/** Get the provider implementation for a given id. */
export function getProvider(id: MusicProviderId): MusicProvider {
  return REGISTRY[id];
}

/** All providers a league owner could choose from (only the wired-up ones). */
export function listAvailableProviders(): MusicProviderInfo[] {
  return Object.values(REGISTRY)
    .map((p) => p.info)
    .filter((info) => info.available);
}

/**
 * Options for the create-league music-service picker. Spotify only for now —
 * YouTube Music and the demo catalog are hidden from new leagues until they're
 * ready to promote (existing leagues on those providers keep working via the
 * registry above; add them back here to re-enable them for new leagues).
 */
export function listProviderOptions(): MusicProviderInfo[] {
  return [{ id: "spotify", name: "Spotify", available: true }];
}

export * from "./types";
