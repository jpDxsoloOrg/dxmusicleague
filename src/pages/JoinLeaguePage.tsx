import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { data } from "../data";
import "./CreateLeaguePage.css";
import "./JoinLeaguePage.css";

export function JoinLeaguePage() {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleJoin() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await data.joinLeague(code);
    if (result.ok) {
      navigate(`/leagues/${result.league.id}`);
    } else {
      setError(result.error);
      setBusy(false);
    }
  }

  return (
    <div className="create-league">
      <Link to="/" className="link-muted">← Back to dashboard</Link>

      <div className="create-card">
        <header className="create-head">
          <h1>Join a league</h1>
          <p>Got an invite code from a league owner? Enter it below to jump in.</p>
        </header>

        <label className="field">
          <span className="field-label">Invite code</span>
          <input
            autoFocus
            className="field-input join-code-input"
            placeholder="e.g. SYNTH-23"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && handleJoin()}
          />
          {error && <span className="field-error">{error}</span>}
        </label>

        <button className="btn btn-primary create-btn" disabled={!code.trim() || busy} onClick={handleJoin}>
          {busy ? "Joining…" : "Join league →"}
        </button>
      </div>
    </div>
  );
}
