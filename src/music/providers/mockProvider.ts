// In-memory provider used during development so the UI works without any backend.
// It mimics the MusicProvider contract every real service must satisfy.

import type {
  MusicProvider,
  MusicProviderInfo,
  Playlist,
  SearchOptions,
  Track,
} from "../types";
import { trackKey } from "../types";

const CATALOG: Omit<Track, "id" | "provider">[] = [
  { providerTrackId: "m1", title: "Midnight City", artists: ["M83"], album: "Hurry Up, We're Dreaming", durationMs: 243000 },
  { providerTrackId: "m2", title: "Nightcall", artists: ["Kavinsky"], album: "OutRun", durationMs: 258000 },
  { providerTrackId: "m3", title: "Resonance", artists: ["HOME"], album: "Odyssey", durationMs: 213000 },
  { providerTrackId: "m4", title: "The Sound of Silence", artists: ["Disturbed"], album: "Immortalized", durationMs: 245000 },
  { providerTrackId: "m5", title: "Blinding Lights", artists: ["The Weeknd"], album: "After Hours", durationMs: 200000 },
  { providerTrackId: "m6", title: "Levitating", artists: ["Dua Lipa"], album: "Future Nostalgia", durationMs: 203000 },
  { providerTrackId: "m7", title: "Good 4 U", artists: ["Olivia Rodrigo"], album: "SOUR", durationMs: 178000 },
  { providerTrackId: "m8", title: "Digital Love", artists: ["Daft Punk"], album: "Discovery", durationMs: 301000 },
  { providerTrackId: "m9", title: "Starlight", artists: ["Muse"], album: "Black Holes and Revelations", durationMs: 240000 },
  { providerTrackId: "m10", title: "Heat Waves", artists: ["Glass Animals"], album: "Dreamland", durationMs: 238000 },
];

function toTrack(raw: Omit<Track, "id" | "provider">): Track {
  return { ...raw, provider: "mock", id: trackKey("mock", raw.providerTrackId) };
}

export class MockMusicProvider implements MusicProvider {
  readonly info: MusicProviderInfo = { id: "mock", name: "Demo Catalog", available: true };

  async searchTracks(query: string, opts?: SearchOptions): Promise<Track[]> {
    const q = query.trim().toLowerCase();
    const matches = CATALOG.filter(
      (t) =>
        !q ||
        t.title.toLowerCase().includes(q) ||
        t.artists.some((a) => a.toLowerCase().includes(q)),
    );
    return matches.slice(0, opts?.limit ?? 10).map(toTrack);
  }

  async getTrack(providerTrackId: string): Promise<Track | null> {
    const found = CATALOG.find((t) => t.providerTrackId === providerTrackId);
    return found ? toTrack(found) : null;
  }

  async createPlaylist(name: string, tracks: Track[]): Promise<Playlist> {
    const id = `mock-pl-${Date.now()}`;
    return {
      id,
      provider: "mock",
      providerPlaylistId: id,
      name,
      url: `https://example.com/mock-playlist/${id}?tracks=${tracks.length}`,
    };
  }
}
