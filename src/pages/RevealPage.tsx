import { Link, useParams } from "react-router-dom";
import { data } from "../data";
import type { VoterComment } from "../data";
import { getProvider } from "../music";
import { useAsync } from "../lib/useAsync";
import { TrackArt } from "../components/TrackArt";
import { Avatar } from "../components/Avatar";
import "./RevealPage.css";

export function RevealPage() {
  const { leagueId = "" } = useParams();
  const { data: detail, loading: detailLoading } = useAsync(() => data.getLeagueDetail(leagueId), [leagueId]);
  const { data: resultsData } = useAsync(() => data.getRoundResults(leagueId), [leagueId]);
  const results = resultsData ?? [];

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

  const { league, currentRound, standings } = detail;
  const providerName = getProvider(league.musicProvider).info.name;
  const winner = results[0];
  const rest = results.slice(1);
  // In production this comes from currentRound.playlistUrl (set on reveal by the host account).
  const playlistUrl = currentRound?.playlistUrl ?? "#";

  return (
    <div className="reveal-page">
      <div className="reveal-grid">
        <div className="reveal-main">
          <header className="reveal-head">
            <Link to={`/leagues/${league.id}`} className="link-muted">← {league.name}</Link>
            <h1>Round Results</h1>
            {currentRound && <p className="reveal-theme">{currentRound.theme}</p>}
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
                <CommentList comments={r.comments} />
              </div>
            ))}
          </div>

          <a className="playlist-btn" href={playlistUrl} target="_blank" rel="noreferrer">
            <span className="play-ic" aria-hidden /> Open round playlist on {providerName}
          </a>
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
