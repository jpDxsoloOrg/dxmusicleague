import { Link } from "react-router-dom";
import { data } from "../data";
import type { LeagueSummary } from "../data";
import type { RoundStatus } from "../domain/types";
import { useAsync } from "../lib/useAsync";
import { Avatar } from "../components/Avatar";
import "./DashboardPage.css";

const STATUS_LABEL: Record<RoundStatus, string> = {
  draft: "Draft",
  submitting: "Submitting",
  previewing: "Listening",
  voting: "Voting",
  revealed: "Revealed",
  complete: "Complete",
};

export function DashboardPage() {
  const { data: summaries, loading, error } = useAsync(() => data.getMyLeagueSummaries(), []);
  const { data: publicLeagues } = useAsync(() => data.getPublicLeagues(), []);
  const trending = (publicLeagues ?? []).slice(0, 3);

  return (
    <div className="dashboard">
      {/* primary actions */}
      <div className="action-row">
        <Link to="/leagues/new" className="action-card action-create">
          <div>
            <h3>Create league</h3>
            <p>Start a new competition with your circle.</p>
          </div>
          <span className="action-plus">+</span>
        </Link>
        <Link to="/leagues/join" className="action-card">
          <div>
            <h3>Join a league</h3>
            <p>Enter a private code or find trending ones.</p>
          </div>
          <span className="action-plus subtle">+</span>
        </Link>
      </div>

      {/* your leagues */}
      <section>
        <div className="section-head">
          <h2>Your Leagues</h2>
          <Link to="/leagues" className="link-muted">View all</Link>
        </div>
        {loading && <p className="page-loading">Loading your leagues…</p>}
        {error && <p className="page-error">{error}</p>}
        <div className="league-grid">
          {summaries?.map((s) => (
            <LeagueCard key={s.league.id} summary={s} />
          ))}
        </div>
      </section>

      {/* trending — open public leagues waiting for members */}
      {trending.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Trending Leagues</h2>
          </div>
          <div className="trending-grid">
            {trending.map((t) => (
              <div key={t.id} className="trending-card">
                <div className="trending-art" aria-hidden />
                <div className="trending-info">
                  <strong>{t.name}</strong>
                  <span>{t.firstRoundTheme ?? "Round 1 coming soon"}</span>
                  <span className="trending-slots">
                    {t.memberCount}/{t.maxMembers} players · {t.openSlots} open
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export function LeagueCard({ summary }: { summary: LeagueSummary }) {
  const { league, currentRound, totalRounds, completionPct, members } = summary;
  const status = currentRound?.status ?? "draft";

  return (
    <Link to={`/leagues/${league.id}`} className="league-card">
      <div className="league-card-top">
        <span className="round-tag">
          Round {currentRound?.index ?? 0} of {totalRounds}
        </span>
        <span className={`pill pill-${status}`}>{STATUS_LABEL[status]}</span>
      </div>

      <h3 className="league-name">{league.name}</h3>
      {currentRound && <p className="league-theme">{currentRound.theme}</p>}

      <div className="avatar-stack">
        {members.slice(0, 5).map((m) => (
          <Avatar key={m.id} name={m.displayName} size={28} />
        ))}
        {members.length > 5 && <span className="avatar-more">+{members.length - 5}</span>}
      </div>

      <div className="completion">
        <div className="completion-head">
          <span>Round completion</span>
          <span>{completionPct}%</span>
        </div>
        <div className="bar">
          <div className="bar-fill" style={{ width: `${completionPct}%` }} />
        </div>
      </div>
    </Link>
  );
}
