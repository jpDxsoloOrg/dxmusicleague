import { Link, useParams } from "react-router-dom";
import { getLeagueDetail } from "../data/mock";
import type { Round, RoundStatus } from "../domain/types";
import { getProvider } from "../music";
import { formatCountdown } from "../lib/time";
import { Avatar } from "../components/Avatar";
import "./RoundOverviewPage.css";

const STATUS_LABEL: Record<RoundStatus, string> = {
  draft: "Draft",
  submitting: "Submitting",
  voting: "Voting",
  revealed: "Revealed",
  complete: "Complete",
};

// What the active round's primary button does, by status.
function primaryAction(leagueId: string, round: Round) {
  switch (round.status) {
    case "submitting":
      return { label: "Submit your song", to: `/leagues/${leagueId}/submit` };
    case "voting":
      return { label: "Vote now", to: `/leagues/${leagueId}/vote` };
    case "revealed":
    case "complete":
      return { label: "View results", to: `/leagues/${leagueId}/reveal` };
    default:
      return { label: "Open round", to: `/leagues/${leagueId}` };
  }
}

export function RoundOverviewPage() {
  const { leagueId = "" } = useParams();
  const detail = getLeagueDetail(leagueId);

  if (!detail) {
    return (
      <div className="round-overview">
        <h2>League not found</h2>
        <Link to="/" className="link-muted">← Back to dashboard</Link>
      </div>
    );
  }

  const { league, rounds, currentRound, totalRounds, standings, activity } = detail;
  const providerName = getProvider(league.musicProvider).info.name;
  const deadline = currentRound?.status === "voting"
    ? currentRound?.voteDeadline
    : currentRound?.submissionDeadline;
  const countdown = formatCountdown(deadline);
  const action = currentRound ? primaryAction(league.id, currentRound) : undefined;

  // Build the stepper: one node per round index up to totalRounds.
  const steps = Array.from({ length: totalRounds }, (_, i) => {
    const idx = i + 1;
    const round = rounds.find((r) => r.index === idx);
    const status: RoundStatus | "upcoming" = round?.status ?? "upcoming";
    const isCurrent = currentRound?.index === idx;
    return { idx, status, isCurrent };
  });

  return (
    <div className="round-overview">
      <div className="ro-grid">
        {/* main column */}
        <div className="ro-main">
          <header className="ro-head">
            <div>
              <Link to="/" className="link-muted ro-back">← Leagues</Link>
              <h1>{league.name}</h1>
            </div>
            <span className="provider-badge">via {providerName}</span>
          </header>

          {/* round stepper */}
          <div className="stepper">
            {steps.map((s) => (
              <div key={s.idx} className={`step step-${s.status}${s.isCurrent ? " current" : ""}`}>
                <span className="step-dot">
                  {s.status === "complete" || s.status === "revealed" ? "✓" : s.idx}
                </span>
                <span className="step-label">R{s.idx}</span>
              </div>
            ))}
          </div>

          {/* active round hero */}
          {currentRound ? (
            <section className="hero-round">
              <div className="hero-round-top">
                <span className="round-tag">Round {currentRound.index} · Active</span>
                <span className={`pill pill-${currentRound.status}`}>
                  {STATUS_LABEL[currentRound.status]}
                </span>
              </div>
              <h2 className="hero-theme">{currentRound.theme}</h2>
              {currentRound.description && <p className="hero-desc">{currentRound.description}</p>}

              <div className="hero-footer">
                {countdown && (
                  <span className="countdown">
                    <span className="clock" aria-hidden /> {countdown} left
                  </span>
                )}
                {action && (
                  <Link to={action.to} className="btn btn-primary hero-cta">
                    {action.label} →
                  </Link>
                )}
              </div>
            </section>
          ) : (
            <section className="hero-round empty">
              <h2 className="hero-theme">No active round yet</h2>
              <p className="hero-desc">The league owner hasn't started the next round.</p>
            </section>
          )}

          {/* activity */}
          <section className="activity">
            <h3>Recent Activity</h3>
            <ul>
              {activity.map((a) => (
                <li key={a.id}>
                  <Avatar name={a.user.displayName} size={32} />
                  <span className="activity-text">
                    <strong>{a.user.displayName}</strong> {a.text}
                  </span>
                  <span className="activity-time">{a.timeAgo}</span>
                </li>
              ))}
              {activity.length === 0 && <li className="muted">No activity yet.</li>}
            </ul>
          </section>
        </div>

        {/* standings sidebar */}
        <aside className="standings">
          <div className="standings-head">
            <h3>Overall Leaderboard</h3>
            <Link to={`/leagues/${league.id}/reveal`} className="link-muted">Full</Link>
          </div>
          <ol>
            {standings.map((s) => (
              <li key={s.user.id} className={s.rank <= 3 ? `top top-${s.rank}` : ""}>
                <span className="rank">{s.rank}</span>
                <Avatar name={s.user.displayName} size={34} />
                <span className="standing-info">
                  <strong>{s.user.displayName}</strong>
                  {s.note && <span className="standing-note">{s.note}</span>}
                </span>
                <span className="standing-pts">{s.points}</span>
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </div>
  );
}
