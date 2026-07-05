import { Link } from "react-router-dom";
import { data } from "../data";
import { useAsync } from "../lib/useAsync";
import { LeagueCard, PublicLeagueCard } from "./DashboardPage";
import "./DashboardPage.css";
import "./LeaguesPage.css";

export function LeaguesPage() {
  const { data: summaries, loading, error } = useAsync(() => data.getMyLeagueSummaries(), []);
  // Open public leagues (still forming, with free slots) anyone can claim a spot in.
  const { data: publicLeagues, loading: loadingPublic } = useAsync(() => data.getPublicLeagues(), []);

  return (
    <div className="leagues-page">
      <section>
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
      </section>

      <section>
        <div className="section-head">
          <h2>Discover Leagues</h2>
          <span className="leagues-discover-sub">Open public leagues you can claim a spot in</span>
        </div>

        {loadingPublic && <p className="page-loading">Finding open leagues…</p>}
        {publicLeagues && publicLeagues.length === 0 && (
          <p className="leagues-discover-empty">
            No open public leagues right now. Start one yourself — set it to public when you{" "}
            <Link to="/leagues/new" className="link-inline">create a league</Link>.
          </p>
        )}
        {publicLeagues && publicLeagues.length > 0 && (
          <div className="trending-grid">
            {publicLeagues.map((league) => (
              <PublicLeagueCard key={league.id} league={league} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
