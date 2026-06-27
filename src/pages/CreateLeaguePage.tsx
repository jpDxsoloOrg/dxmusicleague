import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createLeague } from "../data/mock";
import { listProviderOptions } from "../music";
import type { MusicProviderId } from "../music";
import "./CreateLeaguePage.css";

export function CreateLeaguePage() {
  const navigate = useNavigate();
  const providers = listProviderOptions();

  const [name, setName] = useState("");
  // Default to Spotify per the product decision (musicLeagueClone.md §8).
  const [provider, setProvider] = useState<MusicProviderId>("spotify");

  const canCreate = name.trim().length >= 3;

  function handleCreate() {
    if (!canCreate) return;
    const league = createLeague({ name, musicProvider: provider });
    navigate(`/leagues/${league.id}`);
  }

  return (
    <div className="create-league">
      <Link to="/" className="link-muted">← Back to dashboard</Link>

      <div className="create-card">
        <header className="create-head">
          <h1>Create a league</h1>
          <p>Start a new competition and invite your circle. You can set up the first round once it's created.</p>
        </header>

        <label className="field">
          <span className="field-label">League name</span>
          <input
            autoFocus
            className="field-input"
            placeholder="e.g. Friday Night Bangers"
            value={name}
            maxLength={50}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          />
          <span className="field-hint">At least 3 characters.</span>
        </label>

        <label className="field">
          <span className="field-label">Music service</span>
          <select
            className="field-input"
            value={provider}
            onChange={(e) => setProvider(e.target.value as MusicProviderId)}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.available}>
                {p.name}{p.available ? "" : " — coming soon"}
              </option>
            ))}
          </select>
          <span className="field-hint">
            Players never log in to this service — they just open the public playlist you share each round.
          </span>
        </label>

        <button className="btn btn-primary create-btn" disabled={!canCreate} onClick={handleCreate}>
          Create league →
        </button>
      </div>
    </div>
  );
}
