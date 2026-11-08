// Music-provider proxy tests — fully offline. BUG-01: the round's public
// Spotify playlist lists its tracks in submission-id order, not in the order
// the repository read the submissions (insertion order in memory, submitter
// user-id order on DynamoDB), which would say whose song is whose.
//
// Spotify is never reached: `fetch` is stubbed for the test and records the
// calls, and the credentials come from env vars (the local-dev path in
// `getCreds`), so Secrets Manager is never asked either.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LEAGUE_SETTINGS } from "../domain/types.ts";
import type { League, Round, Submission } from "../domain/types.ts";
import { createPlaylistForRound } from "./providers.ts";

const league: League = {
  id: "lg-sp", name: "Spotify League", ownerId: "u-ana", musicProvider: "spotify", format: "standard",
  settings: { ...DEFAULT_LEAGUE_SETTINGS }, memberIds: ["u-ana", "u-ben", "u-cyd", "u-dot"], inviteCode: "SP-1",
  visibility: "private", roundCount: 3, progression: "manual",
};
const round: Round = { id: "lg-sp~0001", leagueId: league.id, index: 1, theme: "Openers", status: "previewing" };

const sub = (userId: string, id: string, providerTrackId: string): Submission => ({
  id, roundId: round.id, userId,
  track: { id: `spotify:${providerTrackId}`, provider: "spotify", providerTrackId, title: `Song ${providerTrackId}`, artists: [`Artist ${providerTrackId}`] },
});

test("createPlaylistForRound adds the tracks in submission-id order, whatever order the submissions come in", async () => {
  // Repository order here is the user-id order DynamoDB reads in (ana, ben,
  // cyd, dot); the ids sort as dot, ana, cyd, ben.
  const subs = [sub("u-ana", "sub-5b2d", "trkAna"), sub("u-ben", "sub-e07a", "trkBen"), sub("u-cyd", "sub-9a6e", "trkCyd"), sub("u-dot", "sub-0d93", "trkDot")];
  const expected = ["spotify:track:trkDot", "spotify:track:trkAna", "spotify:track:trkCyd", "spotify:track:trkBen"];

  const testEnv = { SPOTIFY_CLIENT_ID: "test-client", SPOTIFY_CLIENT_SECRET: "test-secret", SPOTIFY_REFRESH_TOKEN: "test-refresh" };
  const savedEnv = Object.fromEntries(Object.keys(testEnv).map((k) => [k, process.env[k]]));
  const realFetch = globalThis.fetch;
  const added: string[][] = [];
  Object.assign(process.env, testEnv);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "https://accounts.spotify.com/api/token") return json({ access_token: "host-token", expires_in: 3600 });
    if (url === "https://api.spotify.com/v1/me/playlists") return json({ id: "pl-1", external_urls: { spotify: "https://open.spotify.com/playlist/pl-1" } });
    if (url === "https://api.spotify.com/v1/playlists/pl-1/items") {
      added.push((JSON.parse(String(init?.body)) as { uris: string[] }).uris);
      return json({ snapshot_id: "s" });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
  try {
    for (const order of [subs, [...subs].reverse(), [subs[2]!, subs[0]!, subs[3]!, subs[1]!]]) {
      const before = order.map((s) => s.id);
      assert.equal(await createPlaylistForRound(league, round, order), "https://open.spotify.com/playlist/pl-1");
      assert.deepEqual(order.map((s) => s.id), before, "the caller's array is left as it was");
    }
    assert.deepEqual(added, [expected, expected, expected]);
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
