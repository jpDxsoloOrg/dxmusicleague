import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { data } from "../data";
import { useAsync } from "../lib/useAsync";
import { useAuth } from "../auth/AuthContext";
import { Avatar } from "../components/Avatar";
import "./LeagueSettingsPage.css";

// Owner-only screen to edit a league's voting rules and delete the league.
// Design generated with Google Stitch (Sonic Syndicate system), built to the
// app's existing CSS conventions.
export function LeagueSettingsPage() {
  const { leagueId = "" } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data: detail, loading, reload } = useAsync(() => data.getLeagueDetail(leagueId), [leagueId]);

  const [votePoolSize, setVotePoolSize] = useState(10);
  const [maxPointsPerSong, setMaxPointsPerSong] = useState(5);
  const [allowSelfVote, setAllowSelfVote] = useState(false);
  const [submissionsPerPlayer, setSubmissionsPerPlayer] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Seed the form once the league loads.
  useEffect(() => {
    if (detail) {
      setVotePoolSize(detail.league.settings.votePoolSize);
      setMaxPointsPerSong(detail.league.settings.maxPointsPerSong);
      setAllowSelfVote(detail.league.settings.allowSelfVote);
      setSubmissionsPerPlayer(detail.league.settings.submissionsPerPlayer || 1);
    }
  }, [detail]);

  if (loading) {
    return <div className="settings-page"><p className="page-loading">Loading…</p></div>;
  }
  if (!detail) {
    return (
      <div className="settings-page">
        <h2>League not found</h2>
        <Link to="/" className="link-muted">← Back to dashboard</Link>
      </div>
    );
  }

  const { league } = detail;
  if (league.ownerId !== user?.id) {
    return (
      <div className="settings-page">
        <h2>Owner only</h2>
        <p className="field-hint">Only the league owner can change settings.</p>
        <Link to={`/leagues/${league.id}`} className="link-muted">← Back to league</Link>
      </div>
    );
  }

  const poolInvalid = votePoolSize < 1;
  const capInvalid = maxPointsPerSong < 1 || maxPointsPerSong > votePoolSize;
  const canSave = !poolInvalid && !capInvalid && !busy;

  async function handleSave() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await data.updateLeagueSettings(league.id, { votePoolSize, maxPointsPerSong, allowSelfVote, submissionsPerPlayer });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save settings.");
    } finally {
      setBusy(false);
    }
  }

  async function handleKick(userId: string, displayName: string) {
    if (!window.confirm(`Remove ${displayName} from ${league.name}? They can rejoin with the invite code.`)) return;
    setError(null);
    try {
      await data.kickMember(league.id, userId);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't remove that player.");
    }
  }

  async function handleRegenerateInvite() {
    if (!window.confirm("Generate a new invite code? The current code and any shared invite links will stop working.")) return;
    setError(null);
    try {
      await data.regenerateInvite(league.id);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't regenerate the invite code.");
    }
  }

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      await data.deleteLeague(league.id);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete the league.");
      setBusy(false);
    }
  }

  return (
    <div className="settings-page">
      <Link to={`/leagues/${league.id}`} className="link-muted">← {league.name}</Link>
      <h1 className="settings-title">League settings</h1>

      <section className="settings-card">
        <h3 className="settings-card-title">Submissions</h3>
        <Stepper
          label="Songs per player"
          hint="How many songs each player submits per round. More than one helps small leagues fill a playlist out."
          value={submissionsPerPlayer}
          min={1}
          max={5}
          onChange={setSubmissionsPerPlayer}
        />
      </section>

      <section className="settings-card">
        <h3 className="settings-card-title">Voting rules</h3>

        <Stepper
          label="Points to spend"
          hint="Total points each player spreads across songs every round."
          value={votePoolSize}
          min={1}
          onChange={setVotePoolSize}
        />
        <Stepper
          label="Max points per song"
          hint="The most points a player can place on any single song."
          value={maxPointsPerSong}
          min={1}
          max={votePoolSize}
          onChange={setMaxPointsPerSong}
        />
        {capInvalid && (
          <span className="field-error">Max points per song must be between 1 and the vote pool ({votePoolSize}).</span>
        )}

        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-label">Allow self-voting</span>
            <span className="field-hint">Let players put points on their own submission.</span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={allowSelfVote}
            className={`toggle${allowSelfVote ? " on" : ""}`}
            onClick={() => setAllowSelfVote((v) => !v)}
          >
            <span className="toggle-knob" />
          </button>
        </div>
      </section>

      {error && <span className="field-error">{error}</span>}
      {saved && !error && <span className="settings-saved">Settings saved ✓</span>}

      <button className="btn btn-primary settings-save" disabled={!canSave} onClick={handleSave}>
        {busy ? "Saving…" : "Save changes"}
      </button>

      <section className="settings-card">
        <h3 className="settings-card-title">Invite code</h3>
        <div className="setting-row">
          <div className="setting-text">
            <span className="invite-code-value">{league.inviteCode}</span>
            <span className="field-hint">Share this code (or the invite link) to bring players in.</span>
          </div>
          <button type="button" className="btn" onClick={handleRegenerateInvite}>
            Generate new code
          </button>
        </div>
        <p className="field-hint">
          Generating a new code retires the old one — anyone holding the old code or link can no
          longer join with it.
        </p>
      </section>

      <section className="settings-card">
        <h3 className="settings-card-title">Members</h3>
        {detail.standings.map((s) => (
          <div key={s.user.id} className="member-row">
            <Avatar name={s.user.displayName} size={30} />
            <span className="member-name">{s.user.displayName}</span>
            {s.user.id === league.ownerId ? (
              <span className="member-owner-tag">Owner</span>
            ) : (
              <button
                type="button"
                className="btn btn-danger member-kick"
                onClick={() => handleKick(s.user.id, s.user.displayName)}
              >
                Remove
              </button>
            )}
          </div>
        ))}
        <p className="field-hint">
          Removed players keep their name on past results but drop off the leaderboard. They can
          rejoin with the invite code.
        </p>
      </section>

      <section className="settings-card danger">
        <h3 className="settings-card-title danger-title">⚠ Danger zone</h3>
        <p className="field-hint">
          Permanently deletes this league, its rounds, songs, and votes. This can't be undone.
        </p>
        {confirmingDelete ? (
          <div className="danger-confirm">
            <span className="setting-label">Delete “{league.name}” for everyone?</span>
            <div className="danger-actions">
              <button className="btn" disabled={busy} onClick={() => setConfirmingDelete(false)}>Cancel</button>
              <button className="btn btn-danger" disabled={busy} onClick={handleDelete}>
                {busy ? "Deleting…" : "Yes, delete league"}
              </button>
            </div>
          </div>
        ) : (
          <button className="btn btn-danger danger-btn" onClick={() => setConfirmingDelete(true)}>
            Delete league
          </button>
        )}
      </section>
    </div>
  );
}

function Stepper({
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max?: number;
  onChange: (v: number) => void;
}) {
  const dec = () => onChange(Math.max(min, value - 1));
  const inc = () => onChange(max != null ? Math.min(max, value + 1) : value + 1);
  return (
    <div className="setting-row">
      <div className="setting-text">
        <span className="setting-label">{label}</span>
        <span className="field-hint">{hint}</span>
      </div>
      <div className="stepper">
        <button type="button" className="stepper-btn" onClick={dec} disabled={value <= min} aria-label={`Decrease ${label}`}>–</button>
        <span className="stepper-value">{value}</span>
        <button type="button" className="stepper-btn" onClick={inc} disabled={max != null && value >= max} aria-label={`Increase ${label}`}>+</button>
      </div>
    </div>
  );
}
