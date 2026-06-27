import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getLeagueDetail, getVotableSubmissions, saveVoteComments } from "../data/mock";
import { formatDuration } from "../music";
import { TrackArt } from "../components/TrackArt";
import "./VotePage.css";

export function VotePage() {
  const { leagueId = "" } = useParams();
  const detail = getLeagueDetail(leagueId);
  const submissions = useMemo(() => getVotableSubmissions(leagueId), [leagueId]);

  // points allocated per submission id
  const [allocations, setAllocations] = useState<Record<string, number>>({});
  // optional voter comment per submission id (shown on reveal)
  const [comments, setComments] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

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
  const spent = Object.values(allocations).reduce((a, b) => a + b, 0);
  const remaining = pool - spent;
  const canSubmit = remaining === 0;

  const setPoints = (id: string, next: number) => {
    const clamped = Math.max(0, next);
    setAllocations((prev) => {
      const others = spent - (prev[id] ?? 0);
      const capped = Math.min(clamped, pool - others); // never exceed the pool
      return { ...prev, [id]: capped };
    });
  };

  if (submitted) {
    return (
      <div className="vote-page">
        <div className="vote-done">
          <div className="submitted-check">✓</div>
          <h2>Votes locked in</h2>
          <p>You spent all {pool} points. Results appear when the round is revealed.</p>
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
          <p className="vote-sub">Spread your points across the songs you want to win. Submitters stay hidden until reveal.</p>
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
                    disabled={remaining <= 0}
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
          disabled={!canSubmit}
          onClick={() => { saveVoteComments(league.id, comments); setSubmitted(true); }}
        >
          Submit votes
        </button>
        {!canSubmit && (
          <span className="vote-hint">Allocate all {pool} points to submit ({remaining} left)</span>
        )}
      </div>
    </div>
  );
}
