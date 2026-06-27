import { Link } from "react-router-dom";
import { currentUser, getMyLeagueSummaries, getStandings } from "../data/mock";
import { Avatar } from "../components/Avatar";
import "./ProfilePage.css";

export function ProfilePage() {
  const summaries = getMyLeagueSummaries();

  // Per-league standing for the current user.
  const myRanks = summaries.map((s) => {
    const standing = getStandings(s.league.id).find((st) => st.user.id === currentUser.id);
    return { league: s.league, rank: standing?.rank, points: standing?.points ?? 0, field: getStandings(s.league.id).length };
  });

  const totalPoints = myRanks.reduce((a, r) => a + r.points, 0);
  const bestRank = myRanks.reduce<number | undefined>(
    (best, r) => (r.rank && (best === undefined || r.rank < best) ? r.rank : best),
    undefined,
  );

  const stats = [
    { label: "Leagues", value: summaries.length },
    { label: "Total points", value: totalPoints },
    { label: "Best finish", value: bestRank ? `#${bestRank}` : "—" },
  ];

  return (
    <div className="profile-page">
      <header className="profile-header">
        <Avatar name={currentUser.displayName} size={84} />
        <div className="profile-id">
          <h1>{currentUser.displayName}</h1>
          <span className="grad-text profile-plan">PRO PLAN · Curator</span>
        </div>
        <button className="btn profile-edit">Edit profile</button>
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
        <div className="profile-leagues">
          {myRanks.map((r) => (
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
