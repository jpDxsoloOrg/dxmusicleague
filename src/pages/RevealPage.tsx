import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { data } from "../data";
import type { VoterComment } from "../data";
import { getProvider } from "../music";
import { useAsync } from "../lib/useAsync";
import { useAuth } from "../auth/AuthContext";
import { TrackArt } from "../components/TrackArt";
import { Avatar } from "../components/Avatar";
import "./RevealPage.css";

export function RevealPage() {
  const { leagueId = "" } = useParams();
  // ?round=<id> shows a past round's results; without it, the current round.
  const [params] = useSearchParams();
  const requestedRoundId = params.get("round");
  const { user } = useAuth();
  const { data: detail, loading: detailLoading, reload: reloadDetail } = useAsync(
    () => data.getLeagueDetail(leagueId),
    [leagueId],
  );

  const rounds = detail?.rounds ?? [];
  const round =
    (requestedRoundId ? rounds.find((r) => r.id === requestedRoundId) : undefined) ??
    detail?.currentRound;
  const roundId = round?.id ?? "";
  const status = round?.status;
  const revealed = status === "revealed" || status === "complete";

  // Results only exist once a round is revealed.
  const { data: resultsData, reload: reloadResults } = useAsync(
    () => (roundId && revealed ? data.getResults(roundId) : Promise.resolve([])),
    [roundId, revealed],
  );
  const results = resultsData ?? [];

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (detailLoading) {
    return <div className="reveal-page"><p className="page-loading">Loading…</p></div>;
  }
  if (!detail) {
    return (
      <div className="reveal-page">
        <h2>League not found</h2>
        <Link to="/" className="link-muted">← Back to dashboard</Link>
      </div>
    );
  }

  const { league, standings } = detail;
  const providerName = getProvider(league.musicProvider).info.name;
  const isOwner = league.ownerId === user?.id;

  async function reveal() {
    setBusy(true);
    setError(null);
    try {
      await data.revealRound(roundId);
      reloadDetail();
      reloadResults();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reveal the round.");
    } finally {
      setBusy(false);
    }
  }

  // Round not revealed yet: owner can reveal; everyone else waits.
  if (!revealed) {
    return (
      <div className="reveal-page">
        <header className="reveal-head">
          <Link to={`/leagues/${league.id}`} className="link-muted">← {league.name}</Link>
          <h1>{round ? `Round ${round.index} Results` : "Round Results"}</h1>
          {round && <p className="reveal-theme">{round.theme}</p>}
        </header>
        <div className="reveal-pending">
          {isOwner && status === "voting" ? (
            <>
              <p>Voting is open. Reveal the results to tally points and update the leaderboard.</p>
              <button className="btn btn-primary" disabled={busy} onClick={reveal}>
                {busy ? "Revealing…" : "Reveal results"}
              </button>
            </>
          ) : (
            <p>Results will appear once the league owner reveals this round.</p>
          )}
          {error && <p className="page-error">{error}</p>}
        </div>
      </div>
    );
  }

  const winner = results[0];
  const rest = results.slice(1);
  const playlistUrl = round?.playlistUrl ?? "#";

  return (
    <div className="reveal-page">
      <div className="reveal-grid">
        <div className="reveal-main">
          <header className="reveal-head">
            <Link to={`/leagues/${league.id}`} className="link-muted">← {league.name}</Link>
            <h1>{round ? `Round ${round.index} Results` : "Round Results"}</h1>
            {round && <p className="reveal-theme">{round.theme}</p>}
          </header>

          {/* winner */}
          {winner && (
            <div className="winner-card">
              <div className="winner-badge">🏆 Winner · {winner.points} pts</div>
              <div className="winner-top">
                <TrackArt track={winner.track} size={88} />
                <div className="winner-info">
                  <strong>{winner.track.title}</strong>
                  <span>{winner.track.artists.join(", ")}</span>
                  <span className="winner-by">
                    <Avatar name={winner.submitter.displayName} size={22} /> Submitted by {winner.submitter.displayName}
                  </span>
                </div>
              </div>
              {winner.submitterComment && (
                <p className="submitter-note">
                  “{winner.submitterComment}” — {winner.submitter.displayName}
                </p>
              )}
              <CommentList comments={winner.comments} onWinner />
            </div>
          )}

          {/* the rest, ranked */}
          <div className="result-list">
            {rest.map((r) => (
              <div key={r.track.id} className="result-item">
                <div className="result-rank-row">
                  <span className="rank-num">{r.rank}</span>
                  <TrackArt track={r.track} size={48} />
                  <div className="rank-info">
                    <strong>{r.track.title}</strong>
                    <span>{r.track.artists.join(", ")}</span>
                  </div>
                  <span className="rank-by">
                    <Avatar name={r.submitter.displayName} size={24} /> {r.submitter.displayName}
                  </span>
                  <span className="rank-pts">{r.points} pts</span>
                </div>
                {r.submitterComment && (
                  <p className="submitter-note">
                    “{r.submitterComment}” — {r.submitter.displayName}
                  </p>
                )}
                <CommentList comments={r.comments} />
              </div>
            ))}
          </div>

          {playlistUrl !== "#" && (
            <a className="playlist-btn" href={playlistUrl} target="_blank" rel="noreferrer">
              <span className="play-ic" aria-hidden /> Open round playlist on {providerName}
            </a>
          )}
        </div>

        {/* overall leaderboard */}
        <aside className="reveal-standings">
          <h3>Overall Leaderboard</h3>
          <ol>
            {standings.map((s) => (
              <li key={s.user.id} className={s.rank <= 3 ? `top top-${s.rank}` : ""}>
                <span className="rank">{s.rank}</span>
                <Avatar name={s.user.displayName} size={32} />
                <span className="standing-info"><strong>{s.user.displayName}</strong></span>
                <span className="standing-pts">{s.points}</span>
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </div>
  );
}

function CommentList({ comments, onWinner }: { comments: VoterComment[]; onWinner?: boolean }) {
  if (comments.length === 0) return null;
  return (
    <div className={`comments${onWinner ? " on-winner" : ""}`}>
      {comments.map((c, i) => (
        <div key={i} className="comment">
          <Avatar name={c.voter.displayName} size={22} />
          <span className="comment-text">
            <strong>{c.voter.displayName}</strong> {c.text}
          </span>
        </div>
      ))}
    </div>
  );
}
