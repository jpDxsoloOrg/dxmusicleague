import { useState } from "react";
import { getMyLeagueSummaries, getStandings, currentUser } from "../data/mock";
import { Avatar } from "../components/Avatar";
import "./LeaderboardPage.css";

export function LeaderboardPage() {
  const leagues = getMyLeagueSummaries().map((s) => s.league);
  const [activeId, setActiveId] = useState(leagues[0]?.id ?? "");
  const standings = getStandings(activeId);
  const activeLeague = leagues.find((l) => l.id === activeId);

  return (
    <div className="leaderboard-page">
      <h1 className="page-title">Leaderboard</h1>

      <div className="league-tabs">
        {leagues.map((l) => (
          <button
            key={l.id}
            className={`league-tab${l.id === activeId ? " active" : ""}`}
            onClick={() => setActiveId(l.id)}
          >
            {l.name}
          </button>
        ))}
      </div>

      <div className="leaderboard-panel">
        {activeLeague && <h2 className="leaderboard-league-name">{activeLeague.name} · Season 1</h2>}
        <ol className="leaderboard-list">
          {standings.map((s) => {
            const isMe = s.user.id === currentUser.id;
            return (
              <li key={s.user.id} className={`${s.rank <= 3 ? `top top-${s.rank}` : ""}${isMe ? " is-me" : ""}`}>
                <span className="rank">{s.rank}</span>
                <Avatar name={s.user.displayName} size={40} />
                <span className="standing-info">
                  <strong>{s.user.displayName}{isMe && <span className="you-tag">You</span>}</strong>
                  {s.note && <span className="standing-note">{s.note}</span>}
                </span>
                <span className="standing-pts">{s.points} pts</span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
