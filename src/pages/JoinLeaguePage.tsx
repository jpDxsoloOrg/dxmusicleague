import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { joinLeague } from "../data/mock";
import "./CreateLeaguePage.css";
import "./JoinLeaguePage.css";

export function JoinLeaguePage() {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleJoin() {
    const result = joinLeague(code);
    if (result.ok) {
      navigate(`/leagues/${result.league.id}`);
    } else {
      setError(result.error);
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

        <button className="btn btn-primary create-btn" disabled={!code.trim()} onClick={handleJoin}>
          Join league →
        </button>
      </div>
    </div>
  );
}
