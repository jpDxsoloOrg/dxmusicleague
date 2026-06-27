// Provider registry. The app asks for a provider by id; it never `new`s one directly.
//
// A league stores which provider it uses (League.musicProvider). UI code does:
//   const provider = getProvider(league.musicProvider);
//   await provider.searchTracks(...)
// and stays completely unaware of which service is behind it.

import type { MusicProvider, MusicProviderId, MusicProviderInfo } from "./types";
import { MockMusicProvider } from "./providers/mockProvider";
import { SpotifyMusicProvider } from "./providers/spotifyProvider";

const REGISTRY: Record<MusicProviderId, MusicProvider> = {
  mock: new MockMusicProvider(),
  spotify: new SpotifyMusicProvider(),
  // "youtube-music": new YouTubeMusicProvider(),  // future — just add a class + this line
  "youtube-music": new MockMusicProvider(), // placeholder until implemented
};

/** Get the provider implementation for a given id. */
export function getProvider(id: MusicProviderId): MusicProvider {
  return REGISTRY[id];
}

/** All providers a league owner could choose from (only the wired-up ones). */
export function listAvailableProviders(): MusicProviderInfo[] {
  return Object.values(REGISTRY)
    .map((p) => p.info)
    // de-dupe placeholders that reuse the mock implementation
    .filter((info, i, arr) => arr.findIndex((x) => x.id === info.id) === i)
    .filter((info) => info.available);
}

/**
 * Options for the create-league music-service picker. Unlike
 * `listAvailableProviders`, this lists the full roadmap — services not yet wired
 * up appear with `available: false` so the form can show them disabled
 * ("coming soon"). Choosing a provider is a league-config decision, kept
 * independent of whether its backend proxy happens to be running right now.
 */
export function listProviderOptions(): MusicProviderInfo[] {
  return [
    { id: "spotify", name: "Spotify", available: true },
    { id: "youtube-music", name: "YouTube Music", available: false },
    { id: "mock", name: "Demo Catalog", available: true },
  ];
}

export * from "./types";
