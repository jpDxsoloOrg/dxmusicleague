import { Link } from "react-router-dom";
import { getMyLeagueSummaries } from "../data/mock";
import type { Round, RoundStatus } from "../domain/types";
import { formatCountdown } from "../lib/time";
import "./RoundsPage.css";

const STATUS_LABEL: Record<RoundStatus, string> = {
  draft: "Draft",
  submitting: "Submitting",
  voting: "Voting",
  revealed: "Revealed",
  complete: "Complete",
};

function action(leagueId: string, round: Round) {
  switch (round.status) {
    case "submitting": return { label: "Submit song", to: `/leagues/${leagueId}/submit` };
    case "voting": return { label: "Vote now", to: `/leagues/${leagueId}/vote` };
    case "revealed":
    case "complete": return { label: "View results", to: `/leagues/${leagueId}/reveal` };
    default: return { label: "Open round", to: `/leagues/${leagueId}` };
  }
}

const NEEDS_ACTION: RoundStatus[] = ["submitting", "voting"];

export function RoundsPage() {
  const summaries = getMyLeagueSummaries().filter((s) => s.currentRound);
  const active = summaries.filter((s) => NEEDS_ACTION.includes(s.currentRound!.status));
  const other = summaries.filter((s) => !NEEDS_ACTION.includes(s.currentRound!.status));

  return (
    <div className="rounds-page">
      <h1 className="page-title">Rounds</h1>

      <section>
        <h2 className="rounds-section-head">Needs your attention</h2>
        {active.length === 0 && <p className="muted">Nothing waiting on you right now. 🎧</p>}
        <div className="rounds-list">
          {active.map((s) => {
            const round = s.currentRound!;
            const deadline = round.status === "voting" ? round.voteDeadline : round.submissionDeadline;
            const a = action(s.league.id, round);
            return (
              <div key={s.league.id} className="round-row attention">
                <div className="round-row-main">
                  <span className="round-row-league">{s.league.name}</span>
                  <strong className="round-row-theme">Round {round.index} · {round.theme}</strong>
                </div>
                <span className={`pill pill-${round.status}`}>{STATUS_LABEL[round.status]}</span>
                {deadline && <span className="round-row-deadline">{formatCountdown(deadline)} left</span>}
                <Link to={a.to} className="btn btn-primary round-row-cta">{a.label} →</Link>
              </div>
            );
          })}
        </div>
      </section>

      {other.length > 0 && (
        <section>
          <h2 className="rounds-section-head">Other rounds</h2>
          <div className="rounds-list">
            {other.map((s) => {
              const round = s.currentRound!;
              const a = action(s.league.id, round);
              return (
                <div key={s.league.id} className="round-row">
                  <div className="round-row-main">
                    <span className="round-row-league">{s.league.name}</span>
                    <strong className="round-row-theme">Round {round.index} · {round.theme}</strong>
                  </div>
                  <span className={`pill pill-${round.status}`}>{STATUS_LABEL[round.status]}</span>
                  <Link to={a.to} className="btn round-row-cta">{a.label} →</Link>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
