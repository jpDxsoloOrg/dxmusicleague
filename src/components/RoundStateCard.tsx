// RoundStateCard — what the vote and submit pages show instead of their
// interactive UI when it isn't that page's turn (BUG-12).
//
// The app's own buttons only ever link to /vote while the current round is
// voting and to /submit while it's submitting, and only for members. These
// pages are still reached in the wrong phase: a restored or stale tab, a
// bookmark, the back button, a shared link, or a timed league whose deadline
// passed as the page loaded (reading the league advances the round). Rather
// than an interactive page whose every action the server refuses — or an
// empty points ballot that can never be submitted — each page gates itself
// (VotePage before mounting the points ballot, SubmitSongPage before mounting
// the search) and renders this card, with a link back to the league and, where
// there's an obvious next step, a button to it: the reveal once the round is
// revealed (spectators too — results are public then, as on the league
// page), the submit page while songs are still coming in, the vote page once
// voting has opened. The head-to-head ballot has its own closed states for
// members (MatchupBallot); this card covers the points ballot, the submit page
// (which both formats share) and a spectator on either format's vote page.
//
// The eyebrow names the league as well as the round: someone landing here
// from a bookmark or a restored tab sees which league the card is about.
//
// It only reads the league detail the page already loaded: no fetches. The
// server stays the referee — a round that moves on while the page is open is
// still caught by its error on submit.

import { Link } from "react-router-dom";
import type { LeagueDetail } from "../data";
import type { RoundStatus } from "../domain/types";
import { leagueFormat } from "../domain/types";
import "./RoundStateCard.css";

const STATUS_LABEL: Record<RoundStatus, string> = {
  draft: "Draft",
  submitting: "Submitting",
  previewing: "Listening",
  voting: "Voting",
  revealed: "Revealed",
  complete: "Complete",
};

interface RoundStateCardProps {
  /** Which page is closed: the copy says what can't be done here, and why. */
  page: "vote" | "submit";
  detail: LeagueDetail;
  /** The viewer isn't a member of the league (only members vote and submit). */
  spectator: boolean;
}

interface CardCopy {
  title: string;
  body: string;
  /** The next step, when there's a better one than going back to the league. */
  action?: { label: string; to: string };
}

function cardCopy({ page, detail, spectator }: RoundStateCardProps): CardCopy {
  const { league, currentRound: round, finished } = detail;
  const base = `/leagues/${league.id}`;
  const voting = page === "vote";

  if (spectator) {
    // Results are public once a round is revealed: the same read-only action
    // the league page offers a spectator.
    const revealed = round?.status === "revealed" || round?.status === "complete";
    return {
      title: "You're spectating this league",
      body: `Only the league's members can ${voting ? "vote" : "submit songs"}. ${
        revealed ? "This round's results are open to everyone, though." : "You can follow along on the league page."
      }`,
      action: revealed ? { label: "View results", to: `${base}/reveal` } : undefined,
    };
  }
  if (!round) {
    return {
      title: "There's no round in progress",
      body: voting
        ? "The league hasn't started a round yet, so there's nothing to vote on."
        : "The league hasn't started a round yet. Submissions open when it does.",
    };
  }

  const theme = `“${round.theme}”`;
  // Only Spotify leagues get a playlist (and only best-effort), so the
  // Listening copy names one only when the round has it. Without one, a
  // standard league lists its songs on the league page, and a head-to-head
  // round's songs stay hidden until voting opens and they appear in their
  // matchups.
  const headToHeadNoPlaylist = !round.playlistUrl && leagueFormat(league) === "headToHead";
  const listenWhere = round.playlistUrl ? "the playlist is on the league page" : "they're listed on the league page";
  switch (round.status) {
    case "draft":
      return voting
        ? { title: "Voting isn't open yet", body: `${theme} hasn't started yet. Songs go in first, then everyone listens and votes.` }
        : { title: "Submissions aren't open yet", body: `${theme} hasn't opened for submissions yet. Check back once it does.` };
    case "submitting":
      // Only the vote page gets here: an open submit page never shows the card.
      return {
        title: "Voting isn't open yet",
        body: `Songs are still coming in for ${theme}. Voting opens after the listening phase.`,
        action: { label: "Submit a song", to: `${base}/submit` },
      };
    case "previewing":
      if (headToHeadNoPlaylist) {
        return {
          title: voting ? "Voting opens after the listening phase" : "Submissions are closed for this round",
          body: `The songs for ${theme} are in. You'll hear them in their matchups once voting opens.`,
        };
      }
      return voting
        ? {
            title: "Voting opens after the listening phase",
            body: `The songs for ${theme} are in, and ${listenWhere}. Give them a listen before voting opens.`,
          }
        : {
            title: "Submissions are closed for this round",
            body: `The songs for ${theme} are in, and ${listenWhere}. Voting opens after the listening phase.`,
          };
    case "voting":
      // Only the submit page gets here: an open vote page never shows the card.
      return {
        title: "Submissions are closed for this round",
        body: `${theme} is in voting now.`,
        action: { label: "Go to voting", to: `${base}/vote` },
      };
    case "revealed":
    case "complete": {
      const results = { label: "View results", to: `${base}/reveal` };
      if (voting) {
        return { title: "Voting has closed", body: `${theme} has been revealed, and the results are in.`, action: results };
      }
      return {
        title: "Submissions are closed for this round",
        body: finished
          ? `${theme} has been revealed, and it was the season's last round.`
          : `${theme} has been revealed. Submissions open again when the next round starts.`,
        action: results,
      };
    }
  }
}

export function RoundStateCard(props: RoundStateCardProps) {
  const { league, currentRound: round } = props.detail;
  const { title, body, action } = cardCopy(props);
  return (
    <div className="round-state">
      <p className="round-state-eyebrow">
        <span className="round-state-where">
          {league.name}
          {round && ` · Round ${round.index}`}
        </span>
        {round && <span className={`pill pill-${round.status}`}>{STATUS_LABEL[round.status]}</span>}
      </p>
      <h2>{title}</h2>
      <p className="round-state-body">{body}</p>
      <div className="round-state-actions">
        {action && <Link to={action.to} className="btn btn-primary">{action.label}</Link>}
        <Link to={`/leagues/${league.id}`} className={action ? "btn" : "btn btn-primary"}>Back to league</Link>
      </div>
    </div>
  );
}
