import { useState } from "react";
import { Link } from "react-router-dom";
import { data } from "../data";
import { useAsync } from "../lib/useAsync";
import { useAuth } from "../auth/AuthContext";
import { Avatar } from "../components/Avatar";
import "./ProfilePage.css";

export function ProfilePage() {
  const { user, updateDisplayName } = useAuth();

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEdit() {
    setName(user?.displayName ?? "");
    setError(null);
    setEditing(true);
  }

  async function saveName() {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setError("Display name must be at least 2 characters.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await updateDisplayName(trimmed);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update your profile.");
    } finally {
      setBusy(false);
    }
  }

  // My per-league standing: load my leagues, then my rank within each.
  const { data: myRanks, loading } = useAsync(async () => {
    const summaries = await data.getMyLeagueSummaries();
    return Promise.all(
      summaries.map(async (s) => {
        const standings = await data.getStandings(s.league.id);
        const mine = standings.find((st) => st.user.id === user?.id);
        return { league: s.league, rank: mine?.rank, points: mine?.points ?? 0, field: standings.length };
      }),
    );
  }, [user?.id]);

  const ranks = myRanks ?? [];
  const totalPoints = ranks.reduce((a, r) => a + r.points, 0);
  const bestRank = ranks.reduce<number | undefined>(
    (best, r) => (r.rank && (best === undefined || r.rank < best) ? r.rank : best),
    undefined,
  );

  const stats = [
    { label: "Leagues", value: ranks.length },
    { label: "Total points", value: totalPoints },
    { label: "Best finish", value: bestRank ? `#${bestRank}` : "—" },
  ];

  return (
    <div className="profile-page">
      <header className="profile-header">
        <Avatar name={user?.displayName ?? "Player"} size={84} />
        {editing ? (
          <div className="profile-id profile-id-edit">
            <input
              className="profile-name-input"
              value={name}
              maxLength={50}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveName();
                if (e.key === "Escape") setEditing(false);
              }}
            />
            {user?.email && <span className="profile-email">{user.email}</span>}
            {error && <span className="profile-edit-error">{error}</span>}
            <div className="profile-edit-actions">
              <button className="btn btn-primary" disabled={busy} onClick={saveName}>
                {busy ? "Saving…" : "Save"}
              </button>
              <button className="btn" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <>
            <div className="profile-id">
              <h1>{user?.displayName ?? "Player"}</h1>
              {user?.email && <span className="profile-email">{user.email}</span>}
            </div>
            <button className="btn profile-edit" onClick={startEdit}>Edit profile</button>
          </>
        )}
      </header>

      <div className="stat-grid">
        {stats.map((s) => (
          <div key={s.label} className="stat-card">
            <span className="stat-value">{s.value}</span>
            <span className="stat-label">{s.label}</span>
          </div>
        ))}
      </div>

      <section>
        <h2 className="profile-section-head">Your standings</h2>
        {loading && <p className="page-loading">Loading…</p>}
        <div className="profile-leagues">
          {ranks.map((r) => (
            <Link key={r.league.id} to={`/leagues/${r.league.id}`} className="profile-league-row">
              <strong>{r.league.name}</strong>
              <span className="profile-league-rank">
                {r.rank ? `Rank #${r.rank} of ${r.field}` : "Unranked"}
              </span>
              <span className="standing-pts">{r.points} pts</span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
