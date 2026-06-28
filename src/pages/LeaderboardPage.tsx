import { useState } from "react";
import { data } from "../data";
import { useAsync } from "../lib/useAsync";
import { useAuth } from "../auth/AuthContext";
import { Avatar } from "../components/Avatar";
import "./LeaderboardPage.css";

export function LeaderboardPage() {
  const { user } = useAuth();
  const { data: summaries, loading } = useAsync(() => data.getMyLeagueSummaries(), []);
  const leagues = (summaries ?? []).map((s) => s.league);

  const [selectedId, setSelectedId] = useState("");
  const activeId = selectedId || leagues[0]?.id || "";

  const { data: standings } = useAsync(
    () => (activeId ? data.getStandings(activeId) : Promise.resolve([])),
    [activeId],
  );
  const activeLeague = leagues.find((l) => l.id === activeId);

  return (
    <div className="leaderboard-page">
      <h1 className="page-title">Leaderboard</h1>

      {loading && <p className="page-loading">Loading…</p>}

      <div className="league-tabs">
        {leagues.map((l) => (
          <button
            key={l.id}
            className={`league-tab${l.id === activeId ? " active" : ""}`}
            onClick={() => setSelectedId(l.id)}
          >
            {l.name}
          </button>
        ))}
      </div>

      <div className="leaderboard-panel">
        {activeLeague && <h2 className="leaderboard-league-name">{activeLeague.name} · Season 1</h2>}
        <ol className="leaderboard-list">
          {standings?.map((s) => {
            const isMe = s.user.id === user?.id;
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
