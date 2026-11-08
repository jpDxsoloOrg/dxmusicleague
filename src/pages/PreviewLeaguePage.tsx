import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { data } from "../data";
import { leagueFormat } from "../domain/types";
import { useAsync } from "../lib/useAsync";
import { Avatar } from "../components/Avatar";
import { FormatTag } from "./DashboardPage";
import "./CreateLeaguePage.css";
import "./PreviewLeaguePage.css";

export function PreviewLeaguePage() {
  const { leagueId = "" } = useParams();
  const navigate = useNavigate();
  const { data: preview, loading, error } = useAsync(() => data.getPublicLeaguePreview(leagueId), [leagueId]);
  const [busy, setBusy] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  // A missing `format` (an API that predates it) reads as standard.
  const headToHead = preview ? leagueFormat(preview) === "headToHead" : false;

  async function handleClaim() {
    if (busy) return;
    setBusy(true);
    setClaimError(null);
    const result = await data.claimSpot(leagueId);
    if (result.ok) {
      navigate(`/leagues/${result.league.id}`);
    } else {
      setClaimError(result.error);
      setBusy(false);
    }
  }

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
              <h1>
                {preview.name}
                {headToHead && <FormatTag />}
              </h1>
              {/* A locked head-to-head season has no spots to offer (HTH-14),
                  however few players it has — so no "N of M spots open". */}
              <p>
                {headToHead && preview.hasStarted ? (
                  "Public league · season locked"
                ) : (
                  <>
                    Public league · {preview.openSlots} of {preview.maxMembers} spot
                    {preview.maxMembers === 1 ? "" : "s"} open
                  </>
                )}
              </p>
              {headToHead && (
                <p className="preview-format-note">
                  Head-to-head: one song a round, pick winners in 1v1 matchups. Joining closes when round 1 opens,
                  and from then on leaving is permanent.
                </p>
              )}
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
              // Head-to-head closes earlier: its season locks the moment round 1
              // opens (while round 1 is still taking songs), so "closed
              // submissions" would be false there. Locked means nobody gets in,
              // a player who left it included (HTH-14): no claim button for anyone.
              <p className="preview-status">
                {headToHead
                  ? "Round 1 has opened — this head-to-head season is locked: it can't take new players, and anyone who left can't rejoin."
                  : "Round 1 has closed submissions — this league isn't taking new members."}
              </p>
            ) : preview.isFull ? (
              <p className="preview-status">This league is full.</p>
            ) : (
              <>
                {claimError && <span className="field-error">{claimError}</span>}
                <button className="btn btn-primary create-btn" disabled={busy} onClick={handleClaim}>
                  {busy ? "Claiming…" : `Claim a spot (${preview.openSlots} left) →`}
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
