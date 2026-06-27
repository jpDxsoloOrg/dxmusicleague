import { Link } from "react-router-dom";
import { getMyLeagueSummaries } from "../data/mock";
import { LeagueCard } from "./DashboardPage";
import "./DashboardPage.css";
import "./LeaguesPage.css";

export function LeaguesPage() {
  const summaries = getMyLeagueSummaries();

  return (
    <div className="leagues-page">
      <div className="section-head">
        <h2>Your Leagues</h2>
        <div className="leagues-actions">
          <Link to="/leagues/join" className="btn">Join a league</Link>
          <Link to="/leagues/new" className="btn btn-primary">Create league</Link>
        </div>
      </div>

      {summaries.length === 0 ? (
        <div className="leagues-empty">
          <p>You're not in any leagues yet.</p>
          <Link to="/leagues/new" className="btn btn-primary">Create your first league</Link>
        </div>
      ) : (
        <div className="league-grid">
          {summaries.map((s) => (
            <LeagueCard key={s.league.id} summary={s} />
          ))}
        </div>
      )}
    </div>
  );
}
