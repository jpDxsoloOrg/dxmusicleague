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
let creds: { clientId: string; clientSecret: string } | undefined;

async function getCreds(): Promise<{ clientId: string; clientSecret: string }> {
  if (creds) return creds;
  // Local dev convenience: plain env vars win if set.
  if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
    creds = { clientId: process.env.SPOTIFY_CLIENT_ID, clientSecret: process.env.SPOTIFY_CLIENT_SECRET };
    return creds;
  }
  const secretId = process.env.SPOTIFY_SECRET_ID;
  if (!secretId) throw new Error("Spotify is not configured (no SPOTIFY_SECRET_ID / env credentials).");
  const sm = new SecretsManagerClient({});
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  const parsed = JSON.parse(res.SecretString ?? "{}");
  if (!parsed.clientId || !parsed.clientSecret) throw new Error("Spotify secret is missing clientId/clientSecret.");
  creds = { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
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
