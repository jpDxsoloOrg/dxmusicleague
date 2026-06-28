import { Link } from "react-router-dom";
import { data } from "../data";
import { useAsync } from "../lib/useAsync";
import { LeagueCard } from "./DashboardPage";
import "./DashboardPage.css";
import "./LeaguesPage.css";

export function LeaguesPage() {
  const { data: summaries, loading, error } = useAsync(() => data.getMyLeagueSummaries(), []);

  return (
    <div className="leagues-page">
      <div className="section-head">
        <h2>Your Leagues</h2>
        <div className="leagues-actions">
          <Link to="/leagues/join" className="btn">Join a league</Link>
          <Link to="/leagues/new" className="btn btn-primary">Create league</Link>
        </div>
      </div>

      {loading && <p className="page-loading">Loading your leagues…</p>}
      {error && <p className="page-error">{error}</p>}

      {summaries && summaries.length === 0 ? (
        <div className="leagues-empty">
          <p>You're not in any leagues yet.</p>
          <Link to="/leagues/new" className="btn btn-primary">Create your first league</Link>
        </div>
      ) : (
        <div className="league-grid">
          {summaries?.map((s) => (
            <LeagueCard key={s.league.id} summary={s} />
          ))}
        </div>
      )}
    </div>
  );
}
