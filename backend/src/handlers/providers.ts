// Music-provider proxy — Spotify search via the Client Credentials flow (an
// app-level token, NO user auth), exactly the pattern proven in the Phase 1
// spike (spotify_search.sh). The client secret never leaves this Lambda: it's
// read from Secrets Manager (or env for local dev) and the app-level token is
// cached in memory across invocations. Players never authenticate with Spotify.
//
// Returns the simplified `{ tracks }` shape the frontend SpotifyMusicProvider
// already expects. Playlist creation (host token) is a separate, later slice.

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { badRequest } from "../domain/errors.ts";
import type { League, Round, Submission } from "../domain/types.ts";

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

// ---- credentials (cached per cold start) ----
// clientId/clientSecret authorize search (Client Credentials); refreshToken is
// the host account's token used to create playlists (playlist-modify-public).
interface SpotifyCreds {
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
}
let creds: SpotifyCreds | undefined;

async function getCreds(): Promise<SpotifyCreds> {
  if (creds) return creds;
  // Local dev convenience: plain env vars win if set.
  if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
    creds = {
      clientId: process.env.SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      refreshToken: process.env.SPOTIFY_REFRESH_TOKEN,
    };
    return creds;
  }
  const secretId = process.env.SPOTIFY_SECRET_ID;
  if (!secretId) throw new Error("Spotify is not configured (no SPOTIFY_SECRET_ID / env credentials).");
  const sm = new SecretsManagerClient({});
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  const parsed = JSON.parse(res.SecretString ?? "{}");
  if (!parsed.clientId || !parsed.clientSecret) throw new Error("Spotify secret is missing clientId/clientSecret.");
  creds = { clientId: parsed.clientId, clientSecret: parsed.clientSecret, refreshToken: parsed.refreshToken };
  return creds;
}

// ---- app-level token (cached until shortly before expiry) ----
let token: { value: string; expiresAt: number } | undefined;

async function getToken(): Promise<string> {
  if (token && Date.now() < token.expiresAt) return token.value;
  const { clientId, clientSecret } = await getCreds();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Spotify token request failed (${res.status}).`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return token.value;
}

interface SpotifyItem {
  id: string;
  name: string;
  artists?: Array<{ name: string }>;
  album?: { name?: string; images?: Array<{ url: string }> };
  duration_ms?: number;
  preview_url?: string | null;
  external_urls?: { spotify?: string };
}

function normalize(item: SpotifyItem): ApiTrack {
  return {
    id: item.id,
    title: item.name,
    artists: (item.artists ?? []).map((a) => a.name),
    album: item.album?.name,
    artworkUrl: item.album?.images?.[0]?.url,
    durationMs: item.duration_ms,
    previewUrl: item.preview_url ?? undefined,
    externalUrl: item.external_urls?.spotify,
  };
}

/** GET /spotify/search — `type=track`, limit capped at 10 (Feb 2026 rule). */
export async function searchSpotify(query: string, market: string, limit: number): Promise<{ tracks: ApiTrack[] }> {
  const q = (query ?? "").trim();
  if (!q) return { tracks: [] };

  const accessToken = await getToken();
  const params = new URLSearchParams({ q, type: "track", limit: String(Math.min(Math.max(limit || 10, 1), 10)) });
  if (market) params.set("market", market);

  const res = await fetch(`https://api.spotify.com/v1/search?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw badRequest(`Spotify search failed (${res.status}).`);

  const data = (await res.json()) as { tracks?: { items?: SpotifyItem[] } };
  return { tracks: (data.tracks?.items ?? []).map(normalize) };
}

// ---- playlist creation (host account, playlist-modify-public) ----------------
// Uses the host refresh token to mint a user-scoped token, then the post-Feb-2026
// endpoints: POST /me/playlists and POST /playlists/{id}/items. The user-scoped
// token is cached separately from the app-level search token.

let hostToken: { value: string; expiresAt: number } | undefined;

async function getHostToken(): Promise<string> {
  if (hostToken && Date.now() < hostToken.expiresAt) return hostToken.value;
  const { clientId, clientSecret, refreshToken } = await getCreds();
  if (!refreshToken) throw new Error("No Spotify host refresh token configured.");
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!res.ok) throw new Error(`Spotify host token refresh failed (${res.status}).`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  hostToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return hostToken.value;
}

async function spotifyWrite<T>(token: string, method: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Spotify ${method} ${path} failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<T>;
}

/**
 * Create the public playlist for a round (host account) and return its public
 * URL, or null when there's nothing to make one from (non-Spotify league, no
 * Spotify tracks). Throws only on an actual Spotify failure — callers decide
 * whether that should block the round transition.
 */
export async function createPlaylistForRound(
  league: League,
  round: Round,
  submissions: Submission[],
): Promise<string | null> {
  if (league.musicProvider !== "spotify") return null;
  const trackIds = submissions
    .filter((s) => s.track.provider === "spotify" && s.track.providerTrackId)
    .map((s) => s.track.providerTrackId);
  if (trackIds.length === 0) return null;

  const token = await getHostToken();
  const playlist = await spotifyWrite<{ id: string; external_urls?: { spotify?: string } }>(
    token,
    "POST",
    "/me/playlists",
    { name: `${league.name} — ${round.theme}`, public: true, description: `DX Music League · Round ${round.index}` },
  );
  await spotifyWrite(token, "POST", `/playlists/${playlist.id}/items`, {
    uris: trackIds.map((id) => `spotify:track:${id}`),
  });
  return playlist.external_urls?.spotify ?? null;
}
