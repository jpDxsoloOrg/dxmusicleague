import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { data } from "../data";
import { formatDuration } from "../music";
import { useAsync } from "../lib/useAsync";
import { TrackArt } from "../components/TrackArt";
import "./VotePage.css";

export function VotePage() {
  const { leagueId = "" } = useParams();
  const { data: detail, loading: detailLoading } = useAsync(() => data.getLeagueDetail(leagueId), [leagueId]);
  // Voting always targets the league's current round.
  const roundId = detail?.currentRound?.id ?? "";
  const { data: subs } = useAsync(
    () => (roundId ? data.getVotableSubmissions(roundId) : Promise.resolve([])),
    [roundId],
  );
  const submissions = subs ?? [];

  // points allocated per submission id
  const [allocations, setAllocations] = useState<Record<string, number>>({});
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
      setComments(myBallot.comments);
    }
  }, [myBallot]);

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

  const { league, currentRound } = detail;
  const pool = league.settings.votePoolSize;
  const perSongMax = league.settings.maxPointsPerSong;
  const spent = Object.values(allocations).reduce((a, b) => a + b, 0);
  const remaining = pool - spent;
  const canSubmit = remaining === 0;

  const setPoints = (id: string, next: number) => {
    const clamped = Math.max(0, next);
    setAllocations((prev) => {
      const others = spent - (prev[id] ?? 0);
      // never exceed the remaining pool, nor the per-song cap
      const capped = Math.min(clamped, pool - others, perSongMax);
      return { ...prev, [id]: capped };
    });
  };

  if (submitted) {
    return (
      <div className="vote-page">
        <div className="vote-done">
          <div className="submitted-check">✓</div>
          <h2>Votes locked in</h2>
          <p>
            You spent all {pool} points. You can come back and adjust your votes until voting
            closes; results appear when the round is revealed.
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
          <Link to={`/leagues/${league.id}`} className="link-muted">← {league.name}</Link>
          <h1>Vote{currentRound ? `: ${currentRound.theme}` : ""}</h1>
          <p className="vote-sub">Spread your points across the songs you want to win — up to {perSongMax} on any one song. Submitters stay hidden until reveal.</p>
        </div>
        <div className={`points-left${remaining === 0 ? " spent" : ""}`}>
          <span className="points-num">{remaining}</span>
          <span className="points-label">points left</span>
        </div>
      </header>

      <div className="vote-list">
        {submissions.map((sub) => {
          const pts = allocations[sub.id] ?? 0;
          return (
            <div key={sub.id} className={`vote-card${pts > 0 ? " has-points" : ""}`}>
              <div className="vote-card-top">
                <TrackArt track={sub.track} size={56} />
                <div className="vote-info">
                  <strong>{sub.track.title}</strong>
                  <span>{sub.track.artists.join(", ")}</span>
                  <span className="anon">Anonymous submitter</span>
                </div>
                <span className="vote-dur">{formatDuration(sub.track.durationMs)}</span>
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
              await data.castBallot(roundId, allocations, comments);
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
        {!canSubmit && !error && (
          <span className="vote-hint">Allocate all {pool} points to submit ({remaining} left)</span>
        )}
      </div>
    </div>
  );
}
