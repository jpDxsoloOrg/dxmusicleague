// Safe "Listen" links for anonymous songs. Shared by the screens that offer a
// Listen link on another member's song before the reveal: the head-to-head
// ballot (MatchupBallot) and the round overview's song list (RoundOverviewPage).

import type { Track } from "../music";

/** Music-service hosts a "Listen" link may open. A track's URLs are stored as
 *  the submitting member's client sent them (the server keeps any string,
 *  `javascript:` included), and this link shows to every other member before
 *  the reveal, so only an https link to a known provider gets one; anything
 *  else gets no link (as the points cards have none). Spotify: track page +
 *  preview clips. YouTube Music: watch links. */
export const LISTEN_HOSTS = new Set([
  "open.spotify.com",
  "p.scdn.co",
  "music.youtube.com",
  "www.youtube.com",
  "youtube.com",
  "youtu.be",
]);

/** The track's deep link, else its preview, if it passes LISTEN_HOSTS. */
export function listenUrl(track: Pick<Track, "externalUrl" | "previewUrl">): string | undefined {
  for (const raw of [track.externalUrl, track.previewUrl]) {
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (url.protocol === "https:" && LISTEN_HOSTS.has(url.hostname)) return url.href;
    } catch {
      // not a URL: no link
    }
  }
  return undefined;
}
