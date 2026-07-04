import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { data } from "../data";
import { listProviderOptions } from "../music";
import type { MusicProviderId } from "../music";
import type { LeagueVisibility } from "../domain/types";
import "./CreateLeaguePage.css";

export function CreateLeaguePage() {
  const navigate = useNavigate();
  const providers = listProviderOptions();

  const [name, setName] = useState("");
  // Default to Spotify per the product decision (musicLeagueClone.md §8).
  const [provider, setProvider] = useState<MusicProviderId>("spotify");
  const [visibility, setVisibility] = useState<LeagueVisibility>("private");
  const [maxMembers, setMaxMembers] = useState(8);
  const [roundCount, setRoundCount] = useState(8);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPublic = visibility === "public";
  const capOk = !isPublic || (maxMembers >= 2 && maxMembers <= 50);
  const roundsOk = roundCount >= 1 && roundCount <= 20;
  const canCreate = name.trim().length >= 3 && capOk && roundsOk && !busy;

  async function handleCreate() {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const league = await data.createLeague({
        name,
        musicProvider: provider,
        visibility,
        maxMembers: isPublic ? maxMembers : undefined,
        roundCount,
      });
      navigate(`/leagues/${league.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the league.");
      setBusy(false);
    }
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

        <label className="field">
          <span className="field-label">Number of rounds</span>
          <input
            className="field-input"
            type="number"
            min={1}
            max={20}
            value={roundCount}
            onChange={(e) => setRoundCount(Number(e.target.value))}
          />
          <span className="field-hint">How many rounds this league will run. Between 1 and 20 — you'll set each round's theme later.</span>
        </label>

        <label className="field">
          <span className="field-label">Visibility</span>
          <select
            className="field-input"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as LeagueVisibility)}
          >
            <option value="private">Private — invite code only</option>
            <option value="public">Public — anyone can find and join</option>
          </select>
          <span className="field-hint">
            {isPublic
              ? "Your league appears in Discover so players can claim an open spot."
              : "Only people you share the invite code with can join."}
          </span>
        </label>

        {isPublic && (
          <label className="field">
            <span className="field-label">Max players</span>
            <input
              className="field-input"
              type="number"
              min={2}
              max={50}
              value={maxMembers}
              onChange={(e) => setMaxMembers(Number(e.target.value))}
            />
            <span className="field-hint">Sets the open slots players can claim. Between 2 and 50.</span>
          </label>
        )}

        {error && <span className="field-error">{error}</span>}

        <button className="btn btn-primary create-btn" disabled={!canCreate} onClick={handleCreate}>
          {busy ? "Creating…" : "Create league →"}
        </button>
      </div>
    </div>
  );
}
