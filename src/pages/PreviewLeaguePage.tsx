import { Link, useParams } from "react-router-dom";
import { data } from "../data";
import { useAsync } from "../lib/useAsync";
import { Avatar } from "../components/Avatar";
import "./CreateLeaguePage.css";
import "./PreviewLeaguePage.css";

export function PreviewLeaguePage() {
  const { leagueId = "" } = useParams();
  const { data: preview, loading, error } = useAsync(() => data.getPublicLeaguePreview(leagueId), [leagueId]);

  return (
    <div className="create-league">
      <Link to="/" className="link-muted">← Back to dashboard</Link>

      <div className="create-card">
        {loading && <p className="page-loading">Loading league…</p>}
        {error && <p className="page-error">{error}</p>}
        {!loading && !error && !preview && (
          <p className="page-error">That public league doesn't exist, or it isn't open to join.</p>
        )}

        {preview && (
          <>
            <header className="create-head">
              <h1>{preview.name}</h1>
              <p>
                Public league · {preview.openSlots} of {preview.maxMembers} spot
                {preview.maxMembers === 1 ? "" : "s"} open
              </p>
            </header>

            <section className="preview-block">
              <span className="preview-label">First round</span>
              <p className="preview-theme">{preview.firstRoundTheme ?? "To be announced"}</p>
            </section>

            <section className="preview-block">
              <span className="preview-label">
                Members · {preview.memberCount}/{preview.maxMembers}
              </span>
              <ul className="preview-members">
                {preview.members.map((m) => (
                  <li key={m.id}>
                    <Avatar name={m.displayName} size={28} />
                    <span>{m.displayName}</span>
                  </li>
                ))}
              </ul>
            </section>

            {preview.alreadyMember ? (
              <Link to={`/leagues/${preview.id}`} className="btn btn-primary create-btn">
                You're already in — open league →
              </Link>
            ) : preview.hasStarted ? (
              <p className="preview-status">This league has already started and isn't taking new members.</p>
            ) : preview.isFull ? (
              <p className="preview-status">This league is full.</p>
            ) : (
              <p className="preview-status">Open for new members — {preview.openSlots} spots left.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
