// MatchupBallot — the head-to-head vote screen (HTH-10). VotePage renders it
// instead of the points ballot when the league's format is headToHead.
//
// One card per matchup of the current round (GET /rounds/:roundId/matchups,
// HTH-05), in the payload's order (sorted by matchup id): two anonymous songs
// with a "vs" between them — side by side on wide screens, stacked on phones —
// and a tap on one picks it to win. The viewer's own matchup is shown locked
// ("others decide this one"), a walkover or no-contest matchup is
// informational (nothing to pick), and the bye player's song is an
// "Exhibition" card. Every song but the viewer's own takes an optional
// comment, exactly as on the points ballot.
//
// The submit gate mirrors the server's referee (validateH2HBallot, HTH-06):
// enabled once every votable matchup holds a pick. It is computed by the
// backend domain's own view helpers (domain/matchups.ts `viewPickProgress`,
// imported the way the mock imports the domain: isomorphic, no Node APIs),
// whose tests pin them to the referee's votable set. The server still
// referees; its 400 message is shown on a rejection (and if the round has left
// voting meanwhile, the page says voting has closed).
//
// State is keyed exactly as the wire, never by position: picks are
// matchupId → submissionId, comments submissionId → text. A ballot already
// cast pre-fills both (GET my-ballot, the same pattern as the points page),
// and a re-cast sends back everything it pre-filled, so re-voting never wipes
// a comment, nor a pick the page no longer offers (one made before an
// opponent left turned the pair into a walkover; the referee keeps it).
//
// Shares the vote page's shell styles (VotePage.css: header + picks-left chip,
// sticky footer, comment box, done panel); MatchupBallot.css styles the cards.

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { data } from "../data";
import type { LeagueDetail, MatchupView, VotableSubmission } from "../data";
import { formatDuration } from "../music";
import { useAsync } from "../lib/useAsync";
import { listenUrl } from "../lib/listenUrl";
import { TrackArt } from "./TrackArt";
import { canPickInView, viewMatchupState, viewPick, viewPickProgress } from "../../backend/src/domain/matchups.ts";
import "./MatchupBallot.css";

const COMMENT_PLACEHOLDER = "Add a comment (optional) — shown with the song at reveal";

/** The gate's hint, mirroring the points page's "Allocate all N points". With
 *  nothing to pick, a first ballot is comments only, so it needs one. */
function gateHint(votable: number, remaining: number): string {
  if (votable === 0) return "Write a comment to submit";
  return votable === 1
    ? "Pick a winner in the matchup to submit"
    : `Pick a winner in all ${votable} matchups to submit (${remaining} left)`;
}

export function MatchupBallot({ detail }: { detail: LeagueDetail }) {
  const { league, currentRound } = detail;
  // Voting always targets the league's current round.
  const roundId = currentRound?.id ?? "";
  const open = currentRound?.status === "voting";

  const { data: view, error: viewError, reload: reloadView } = useAsync(
    () => (open ? data.getMatchups(roundId) : Promise.resolve(null)),
    [roundId, open],
  );
  // The payload says which matchup is the viewer's, not which side: their own
  // submission tells us, so their song is labelled and takes no comment.
  const { data: mine } = useAsync(
    () => (open ? data.getMySubmissions(roundId) : Promise.resolve([])),
    [roundId, open],
  );
  // A ballot already cast for this round: pre-fill it so editing picks
  // doesn't silently wipe the earlier picks and comments.
  const { data: myBallot } = useAsync(
    () => (open ? data.getMyBallot(roundId) : Promise.resolve(null)),
    [roundId, open],
  );

  // matchupId → the submission id picked to win it
  const [picks, setPicks] = useState<Record<string, string>>({});
  // optional voter comment per submission id (shown on reveal)
  const [comments, setComments] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when a rejected submit finds this round no longer open (the owner
  // revealed it meanwhile): the page then says voting has closed instead of
  // offering a ballot every retry of which is refused.
  const [closedNow, setClosedNow] = useState(false);

  const hasVoted = Boolean(myBallot);
  const seeded = useRef(false);
  useEffect(() => {
    if (myBallot && !seeded.current) {
      seeded.current = true;
      // Anything touched before the ballot arrived wins over the pre-fill.
      setPicks((prev) => ({ ...(myBallot.picks ?? {}), ...prev }));
      setComments((prev) => ({ ...myBallot.comments, ...prev }));
    }
  }, [myBallot]);

  const back = <Link to={`/leagues/${league.id}`} className="link-muted">← {league.name}</Link>;

  if (!currentRound || !open || closedNow) {
    const closed = closedNow || currentRound?.status === "revealed" || currentRound?.status === "complete";
    return (
      <div className="vote-page">
        <div className="vote-done">
          <h2>{closed ? "Voting has closed" : "Voting isn't open yet"}</h2>
          <p>
            {!currentRound
              ? "There's no round in progress."
              : closedNow
                ? "This round isn't open for voting any more — the results are on the league page once it's revealed."
                : closed
                  ? "This round has been revealed — the results are on the league page."
                  : "The matchups open for picks when voting starts."}
          </p>
          <Link to={`/leagues/${league.id}`} className="btn btn-primary">Back to league</Link>
        </div>
      </div>
    );
  }

  if (!view) {
    if (viewError) {
      // e.g. a spectator: the server's members-only message, in the page's panel
      return (
        <div className="vote-page">
          <div className="vote-done">
            <h2>The matchups aren't available</h2>
            <p>{viewError}</p>
            <Link to={`/leagues/${league.id}`} className="btn btn-primary">Back to league</Link>
          </div>
        </div>
      );
    }
    return (
      <div className="vote-page">
        {back}
        <p className="page-loading">Loading…</p>
      </div>
    );
  }

  const { votable, picked } = viewPickProgress(view, picks);
  const remaining = votable - picked;
  // With nothing to pick the ballot is comments only: a first one needs a
  // comment (an update may clear them all).
  const canSubmit = remaining === 0 && (votable > 0 || hasVoted || Object.values(comments).some((c) => c.trim()));
  const mySongIds = new Set((mine ?? []).map((s) => s.id));

  const pick = (matchupId: string, submissionId: string) => {
    // a server rejection is about the ballot as it was: editing it brings the
    // live gate hint back
    setError(null);
    setPicks((prev) => ({ ...prev, [matchupId]: submissionId }));
  };
  const comment = (submissionId: string, text: string) =>
    setComments((prev) => ({ ...prev, [submissionId]: text }));

  if (submitted) {
    return (
      <div className="vote-page">
        <div className="vote-done">
          <div className="submitted-check">✓</div>
          <h2>{votable === 0 ? "Comments saved" : "Picks locked in"}</h2>
          <p>
            {votable === 0
              ? "They're shown with the songs at reveal. You can come back and edit them until voting closes."
              : `${
                  votable === 1
                    ? "You picked a winner in the one matchup you vote in."
                    : `You picked a winner in all ${votable} matchups.`
                } You can come back and change your picks until voting closes; results appear when the round is revealed.`}
          </p>
          <Link to={`/leagues/${league.id}`} className="btn btn-primary">Back to league</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="vote-page">
      <header className="vote-head">
        <div>
          {back}
          <h1>Vote: {currentRound.theme}</h1>
          <p className="vote-sub">
            Pick the song you want to win each matchup — most votes takes it. Submitters stay hidden until
            reveal.
          </p>
        </div>
        {votable > 0 && (
          <div className="vote-pools">
            <div className={`points-left${remaining === 0 ? " spent" : ""}`}>
              <span className="points-num">{remaining}</span>
              <span className="points-label">{remaining === 1 ? "pick left" : "picks left"}</span>
            </div>
          </div>
        )}
      </header>

      {votable === 0 && (
        <p className="mb-nothing">
          There's no matchup for you to pick in this round — the others decide them. You can still leave
          comments.
        </p>
      )}

      <div className="mb-list">
        {view.matchups.map((m, i) => (
          <MatchupCard
            key={m.matchupId}
            n={i + 1}
            matchup={m}
            pick={viewPick(m, picks)}
            onPick={(submissionId) => pick(m.matchupId, submissionId)}
            mySongIds={mySongIds}
            comments={comments}
            onComment={comment}
          />
        ))}
        {view.bye && (
          <ExhibitionCard song={view.bye} mine={mySongIds.has(view.bye.id)} comments={comments} onComment={comment} />
        )}
      </div>

      <div className="vote-footer">
        <button
          className="btn btn-primary vote-submit"
          disabled={!canSubmit || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await data.castMatchupBallot(roundId, picks, comments);
              setSubmitted(true);
            } catch (err) {
              setError(err instanceof Error ? err.message : "Couldn't submit your picks.");
              setBusy(false);
              // The server referees against the round as it stands now (a
              // departure changes what's votable): show it that way.
              reloadView();
              // ...and if it's no longer in voting at all, say so.
              data
                .getLeagueDetail(league.id)
                .then((fresh) => {
                  if (fresh && (fresh.currentRound?.id !== roundId || fresh.currentRound.status !== "voting")) {
                    setClosedNow(true);
                  }
                })
                .catch(() => {});
            }
          }}
        >
          {busy ? "Submitting…" : `${hasVoted ? "Update" : "Submit"} ${votable === 0 ? "comments" : "picks"}`}
        </button>
        {error && <span className="vote-hint mb-error" role="alert">{error}</span>}
        {!canSubmit && !error && <span className="vote-hint">{gateHint(votable, remaining)}</span>}
      </div>
    </div>
  );
}

interface CommentProps {
  comments: Record<string, string>;
  onComment: (submissionId: string, text: string) => void;
}

/** What a matchup card says about itself: the status chip and, when the
 *  viewer can't pick, why not. */
function describe(m: MatchupView, picked: boolean): { status: string; tone: string; note?: string } {
  const state = viewMatchupState(m);
  if (m.isMine) {
    return {
      status: "Locked",
      tone: "mine",
      note:
        state === "contest"
          ? "Your matchup — others decide this one."
          : state === "walkover"
            ? "Your matchup — only one song is in, so it's a walkover. No vote."
            : "Your matchup — neither song is in, so there's no contest.",
    };
  }
  if (state === "walkover") {
    return { status: "Walkover", tone: "info", note: "Only one song is in this matchup, so it's a walkover — no vote." };
  }
  if (state === "noContest") {
    return { status: "No contest", tone: "info", note: "Neither player has a song in this matchup — no contest." };
  }
  return picked ? { status: "Picked", tone: "picked" } : { status: "Pick one", tone: "open" };
}

function MatchupCard({
  n,
  matchup,
  pick,
  onPick,
  mySongIds,
  comments,
  onComment,
}: {
  n: number;
  matchup: MatchupView;
  pick: string | undefined;
  onPick: (submissionId: string) => void;
  mySongIds: Set<string>;
} & CommentProps) {
  const pickable = canPickInView(matchup);
  // Only a matchup the viewer picks in shows a pick. A stored pick on a pair
  // that turned into a walkover (the opponent left after the vote) stays in
  // the ballot state, so a re-cast keeps it, but isn't drawn on a card that
  // says there's no vote.
  const shown = pickable ? pick : undefined;
  const { status, tone, note } = describe(matchup, shown !== undefined);
  const side = (song: VotableSubmission | null) => (
    <SongSide
      song={song}
      group={pickable ? `pick-${matchup.matchupId}` : undefined}
      picked={song !== null && shown === song.id}
      onPick={onPick}
      mine={song !== null && mySongIds.has(song.id)}
      comments={comments}
      onComment={onComment}
    />
  );
  return (
    <section
      className={`mb-card${pickable ? "" : " locked"}${shown !== undefined ? " has-pick" : ""}`}
      aria-label={`Matchup ${n}`}
    >
      <div className="mb-card-head">
        <span className="mb-card-title">Matchup {n}</span>
        <span className={`mb-status ${tone}`}>{status}</span>
      </div>
      {note && <p className="mb-note">{note}</p>}
      <div
        className="mb-pair"
        role={pickable ? "radiogroup" : undefined}
        aria-label={pickable ? `Pick the winner of matchup ${n}` : undefined}
      >
        {side(matchup.a)}
        <div className="mb-vs" aria-hidden>
          <span>vs</span>
        </div>
        {side(matchup.b)}
      </div>
    </section>
  );
}

function ExhibitionCard({ song, mine, comments, onComment }: { song: VotableSubmission; mine: boolean } & CommentProps) {
  return (
    <section className="mb-card locked mb-exhibition" aria-label="Exhibition">
      <div className="mb-card-head">
        <span className="mb-card-title">Exhibition</span>
        <span className="mb-status info">Bye — no vote</span>
      </div>
      <p className="mb-note">
        {mine
          ? "You have the bye this round — your song plays as an exhibition, with no vote and no result."
          : "The player with the bye this round still brings a song. No vote and no result — comments welcome."}
      </p>
      <div className="mb-pair single">
        <SongSide song={song} picked={false} onPick={() => {}} mine={mine} comments={comments} onComment={onComment} />
      </div>
    </section>
  );
}

/** One song of a matchup: the same rendering as a points vote card (art,
 *  title, artists, "Anonymous submitter", duration), a radio to pick it when
 *  `group` is set, a listen link when the track has one that passes
 *  `listenUrl` (https, a known music service), and the comment
 *  box — except on the viewer's own song. `null` = this side has no song. */
function SongSide({
  song,
  group,
  picked,
  onPick,
  mine,
  comments,
  onComment,
}: {
  song: VotableSubmission | null;
  group?: string;
  picked: boolean;
  onPick: (submissionId: string) => void;
  mine: boolean;
} & CommentProps) {
  if (!song) {
    return (
      <div className="mb-side">
        <div className="mb-song mb-empty">
          <span className="mb-empty-art" aria-hidden />
          <div className="vote-info">
            <strong>No song</strong>
          </div>
        </div>
      </div>
    );
  }
  const { track } = song;
  const listen = listenUrl(track);
  const face = (
    <>
      <TrackArt track={track} size={56} />
      <div className="vote-info">
        <strong>{track.title}</strong>
        <span>{track.artists.join(", ")}</span>
        <span className="anon">{mine ? "Your song" : "Anonymous submitter"}</span>
      </div>
      <span className="vote-dur">{formatDuration(track.durationMs)}</span>
    </>
  );
  return (
    <div className={`mb-side${picked ? " picked" : ""}`}>
      {group ? (
        <label className="mb-song pickable">
          <input
            type="radio"
            className="mb-radio"
            name={group}
            value={song.id}
            checked={picked}
            onChange={() => onPick(song.id)}
          />
          {face}
          <span className="mb-check" aria-hidden>{picked ? "✓" : ""}</span>
        </label>
      ) : (
        <div className={`mb-song${mine ? " mine" : ""}`}>{face}</div>
      )}
      {listen && (
        <a className="mb-listen" href={listen} target="_blank" rel="noreferrer">
          ▶ Listen
        </a>
      )}
      {!mine && (
        <textarea
          className="vote-comment"
          placeholder={COMMENT_PLACEHOLDER}
          aria-label={`Comment on ${track.title}`}
          value={comments[song.id] ?? ""}
          onChange={(e) => onComment(song.id, e.target.value)}
          rows={2}
        />
      )}
    </div>
  );
}
