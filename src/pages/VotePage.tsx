import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { data } from "../data";
import type { LeagueDetail } from "../data";
import { leagueFormat } from "../domain/types";
import { formatDuration } from "../music";
import { useAsync } from "../lib/useAsync";
import { TrackArt } from "../components/TrackArt";
import { MatchupBallot } from "../components/MatchupBallot";
import { effectivePool } from "../../backend/src/domain/rules.ts";
import "./VotePage.css";

export function VotePage() {
  const { leagueId = "" } = useParams();
  const { data: detail, loading: detailLoading } = useAsync(() => data.getLeagueDetail(leagueId), [leagueId]);

  if (detailLoading) {
    return <div className="vote-page"><p className="page-loading">Loading…</p></div>;
  }

  if (!detail) {
    return (
      <div className="vote-page">
        <h2>League not found</h2>
        <Link to="/" className="link-muted">← Back to dashboard</Link>
      </div>
    );
  }

  // Head-to-head leagues pick a winner in each matchup instead of spending
  // points (HTH-10): a ballot of their own. The points ballot below is the
  // standard path, unchanged. Keyed by round so a new round starts blank.
  if (leagueFormat(detail.league) === "headToHead") {
    return <MatchupBallot key={detail.currentRound?.id ?? ""} detail={detail} />;
  }
  return <PointsBallot detail={detail} />;
}

/** "1 point" / "8 points" — an effective pool of 1 is an ordinary state
 *  (a two-player league with cap 1), so the copy says it properly. */
function pointsLabel(n: number): string {
  return `${n} ${n === 1 ? "point" : "points"}`;
}

/** The standard (points) ballot. */
function PointsBallot({ detail }: { detail: LeagueDetail }) {
  // Voting always targets the league's current round.
  const roundId = detail.currentRound?.id ?? "";
  const { data: subs, loading: subsLoading } = useAsync(
    () => (roundId ? data.getVotableSubmissions(roundId) : Promise.resolve([])),
    [roundId],
  );
  const submissions = subs ?? [];

  // points allocated per submission id
  const [allocations, setAllocations] = useState<Record<string, number>>({});
  // anti-votes per submission id (only when the league enables them)
  const [downvotes, setDownvotes] = useState<Record<string, number>>({});
  // optional voter comment per submission id (shown on reveal)
  const [comments, setComments] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A ballot already cast for this round: pre-fill it so editing votes doesn't
  // silently wipe the earlier points and comments (which a blank re-cast did).
  const { data: myBallot } = useAsync(
    () => (roundId ? data.getMyBallot(roundId) : Promise.resolve(null)),
    [roundId],
  );
  const hasVoted = Boolean(myBallot);
  const seeded = useRef(false);
  useEffect(() => {
    if (myBallot && !seeded.current) {
      seeded.current = true;
      setAllocations(myBallot.allocations);
      setDownvotes(myBallot.downvotes ?? {});
      setComments(myBallot.comments);
    }
  }, [myBallot]);

  const { league, currentRound } = detail;
  const perSongMax = league.settings.maxPointsPerSong;
  // The points to spend: the league's pool, or — when the songs on offer can't
  // take it all (a two-player league, players who didn't submit, a low cap) —
  // as many as they can: the referee's own `effectivePool`, so the page and
  // the server agree. Only once the current round's song list has loaded: an
  // empty list would read as a pool of 0 and enable Submit, so while it loads,
  // with no current round, or if it couldn't load, the pool reads as the
  // league's and Submit stays disabled (as it always did there).
  const songsLoaded = roundId !== "" && subs !== undefined;
  const pool = songsLoaded ? effectivePool(league.settings, submissions.length) : league.settings.votePoolSize;
  const poolReduced = pool < league.settings.votePoolSize;
  // Nothing on offer (e.g. only the voter submitted): an empty ballot to send.
  const nothingToVoteOn = songsLoaded && submissions.length === 0;
  const antiPool = league.settings.downvotePoolSize ?? 0;
  const spent = Object.values(allocations).reduce((a, b) => a + b, 0);
  const remaining = pool - spent;
  const antiSpent = Object.values(downvotes).reduce((a, b) => a + b, 0);
  const antiRemaining = antiPool - antiSpent;
  // The (effective) vote pool must be spent exactly; anti-votes are optional.
  const canSubmit = songsLoaded && remaining === 0;

  const setPoints = (id: string, next: number) => {
    const clamped = Math.max(0, next);
    setAllocations((prev) => {
      const others = spent - (prev[id] ?? 0);
      // never exceed the remaining pool, nor the per-song cap
      const capped = Math.min(clamped, pool - others, perSongMax);
      return { ...prev, [id]: capped };
    });
  };

  const setAnti = (id: string, next: number) => {
    const clamped = Math.max(0, next);
    setDownvotes((prev) => {
      const others = antiSpent - (prev[id] ?? 0);
      return { ...prev, [id]: Math.min(clamped, antiPool - others) };
    });
  };

  if (submitted) {
    return (
      <div className="vote-page">
        <div className="vote-done">
          <div className="submitted-check">✓</div>
          <h2>Votes locked in</h2>
          {pool > 0 ? (
            <p>
              You spent all {pointsLabel(pool)}. You can come back and adjust your votes until voting
              closes; results appear when the round is revealed.
            </p>
          ) : (
            <p>There were no songs for you to vote on this round. Results appear when the round is revealed.</p>
          )}
          <Link to={`/leagues/${league.id}`} className="btn btn-primary">Back to league</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="vote-page">
      <header className="vote-head">
        <div>
          <Link to={`/leagues/${league.id}`} className="link-muted">← {league.name}</Link>
          <h1>Vote{currentRound ? `: ${currentRound.theme}` : ""}</h1>
          {!nothingToVoteOn && (
            <p className="vote-sub">Spread your points across the songs you want to win — up to {perSongMax} on any one song. Submitters stay hidden until reveal.</p>
          )}
          {poolReduced && (
            <p className="vote-pool-note">
              {!nothingToVoteOn
                ? `Only ${pointsLabel(pool)} can be placed this round: ${submissions.length} ${submissions.length === 1 ? "song is" : "songs are"} on offer, up to ${perSongMax} each.`
                : hasVoted
                  ? "There are no songs for you to vote on this round — your empty ballot is recorded."
                  : "There are no songs for you to vote on this round — submit to record your ballot."}
            </p>
          )}
        </div>
        <div className="vote-pools">
          <div className={`points-left${remaining === 0 ? " spent" : ""}`}>
            <span className="points-num">{remaining}</span>
            <span className="points-label">points left</span>
          </div>
          {antiPool > 0 && (
            <div className="points-left anti">
              <span className="points-num">{antiRemaining}</span>
              <span className="points-label">anti-votes left</span>
            </div>
          )}
        </div>
      </header>

      <div className="vote-list">
        {submissions.map((sub) => {
          const pts = allocations[sub.id] ?? 0;
          const anti = downvotes[sub.id] ?? 0;
          return (
            <div key={sub.id} className={`vote-card${pts > 0 ? " has-points" : ""}${anti > 0 ? " has-anti" : ""}`}>
              <div className="vote-card-top">
                <TrackArt track={sub.track} size={56} />
                <div className="vote-info">
                  <strong>{sub.track.title}</strong>
                  <span>{sub.track.artists.join(", ")}</span>
                  <span className="anon">Anonymous submitter</span>
                </div>
                <span className="vote-dur">{formatDuration(sub.track.durationMs)}</span>
                <div className="vote-controls">
                  <div className="stepper-control">
                    <button
                      className="step-btn"
                      onClick={() => setPoints(sub.id, pts - 1)}
                      disabled={pts <= 0}
                      aria-label="Remove a point"
                    >−</button>
                    <span className="step-value">{pts}</span>
                    <button
                      className="step-btn plus"
                      onClick={() => setPoints(sub.id, pts + 1)}
                      disabled={remaining <= 0 || pts >= perSongMax}
                      aria-label="Add a point"
                    >+</button>
                  </div>
                  {antiPool > 0 && (
                    <div className="stepper-control anti-control">
                      <button
                        className="step-btn"
                        onClick={() => setAnti(sub.id, anti - 1)}
                        disabled={anti <= 0}
                        aria-label="Remove an anti-vote"
                      >−</button>
                      <span className="step-value">{anti > 0 ? `−${anti}` : 0}</span>
                      <button
                        className="step-btn anti-plus"
                        onClick={() => setAnti(sub.id, anti + 1)}
                        disabled={antiRemaining <= 0}
                        aria-label="Add an anti-vote"
                      >💔</button>
                    </div>
                  )}
                </div>
              </div>
              <textarea
                className="vote-comment"
                placeholder="Add a comment (optional) — shown with the song at reveal"
                value={comments[sub.id] ?? ""}
                onChange={(e) => setComments((prev) => ({ ...prev, [sub.id]: e.target.value }))}
                rows={2}
              />
            </div>
          );
        })}
      </div>

      <div className="vote-footer">
        <button
          className="btn btn-primary vote-submit"
          disabled={!canSubmit || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await data.castBallot(roundId, allocations, comments, antiPool > 0 ? downvotes : undefined);
              setSubmitted(true);
            } catch (err) {
              setError(err instanceof Error ? err.message : "Couldn't submit your votes.");
              setBusy(false);
            }
          }}
        >
          {busy ? "Submitting…" : hasVoted ? "Update votes" : "Submit votes"}
        </button>
        {error && <span className="vote-hint" style={{ color: "#ff8a8a" }}>{error}</span>}
        {/* not while the song list loads: a pre-filled re-cast would flash
            "(N left)" against the league's pool rather than the effective one */}
        {!canSubmit && !error && !subsLoading && (
          <span className="vote-hint">Allocate all {pointsLabel(pool)} to submit ({remaining} left)</span>
        )}
      </div>
    </div>
  );
}
