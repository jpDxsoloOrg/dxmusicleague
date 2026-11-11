import { useState } from "react";
import { data } from "../data";
import { leagueFormat } from "../domain/types";
import { useAsync } from "../lib/useAsync";
import { useAuth } from "../auth/AuthContext";
import { StandingsTable } from "../components/StandingsTable";
import "./LeaderboardPage.css";

export function LeaderboardPage() {
  const { user } = useAuth();
  const { data: summaries, loading } = useAsync(() => data.getMyLeagueSummaries(), []);
  const leagues = (summaries ?? []).map((s) => s.league);

  const [selectedId, setSelectedId] = useState("");
  const activeId = selectedId || leagues[0]?.id || "";

  // The board carries the id of the league it belongs to: while a newly
  // picked tab loads, the previous league's rows are still on screen, and
  // they must keep that league's format (points vs W–L record).
  const { data: board } = useAsync(
    async () => (activeId ? { leagueId: activeId, standings: await data.getStandings(activeId) } : undefined),
    [activeId],
  );
  const activeLeague = leagues.find((l) => l.id === activeId);
  const boardLeague = leagues.find((l) => l.id === board?.leagueId);

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
        <StandingsTable
          standings={board?.standings ?? []}
          format={boardLeague ? leagueFormat(boardLeague) : "standard"}
          avatarSize={40}
          className="leaderboard-list"
          showNotes
          meId={user?.id}
          pointsUnit
        />
      </div>
    </div>
  );
}
