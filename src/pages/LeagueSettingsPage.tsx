import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { data } from "../data";
import { leagueFormat } from "../domain/types";
import { useAsync } from "../lib/useAsync";
import { useAuth } from "../auth/AuthContext";
import { Avatar } from "../components/Avatar";
import "./LeagueSettingsPage.css";

// Owner-only screen to edit a league's voting rules and delete the league.
// Design generated with Google Stitch (Sonic Syndicate system), built to the
// app's existing CSS conventions.
//
// Head-to-head leagues (HTH-09): the format shows as a read-only badge (it is
// fixed at creation), and the rules the format forces — one song per player,
// no anti-votes — show as locked values instead of controls (the server
// rejects any other value anyway, HTH-01). The points-pool rules don't apply
// to a winner-pick ballot, so they aren't offered either, which leaves
// nothing to save: the Save button is hidden. Standard leagues are unchanged.
//
// There is no self-voting option (BUG-17): no league allows it, and the
// server stores false whatever it is sent, so nothing here reads or sends
// `allowSelfVote`.
export function LeagueSettingsPage() {
  const { leagueId = "" } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data: detail, loading, reload } = useAsync(() => data.getLeagueDetail(leagueId), [leagueId]);

  const [votePoolSize, setVotePoolSize] = useState(10);
  const [maxPointsPerSong, setMaxPointsPerSong] = useState(5);
  const [submissionsPerPlayer, setSubmissionsPerPlayer] = useState(1);
  const [downvotePoolSize, setDownvotePoolSize] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Seed the form once the league loads.
  useEffect(() => {
    if (detail) {
      setVotePoolSize(detail.league.settings.votePoolSize);
      setMaxPointsPerSong(detail.league.settings.maxPointsPerSong);
      setSubmissionsPerPlayer(detail.league.settings.submissionsPerPlayer || 1);
      setDownvotePoolSize(detail.league.settings.downvotePoolSize ?? 0);
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

  const headToHead = leagueFormat(league) === "headToHead";
  // A head-to-head season locks when round 1 opens (the server freezes the
  // field then — HTH-03): from that point nobody can join, and a removed
  // player can't come back (HTH-14) — their remaining matchups go to their
  // opponents as walkovers.
  const seasonLocked = headToHead && detail.rounds.some((r) => r.index === 1 && r.status !== "draft");
  const poolInvalid = votePoolSize < 1;
  const capInvalid = maxPointsPerSong < 1 || maxPointsPerSong > votePoolSize;
  const canSave = !poolInvalid && !capInvalid && !busy;

  async function handleSave() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await data.updateLeagueSettings(league.id, {
        votePoolSize,
        maxPointsPerSong,
        submissionsPerPlayer,
        downvotePoolSize,
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save settings.");
    } finally {
      setBusy(false);
    }
  }

  async function handleKick(userId: string, displayName: string) {
    // In a locked head-to-head season a kick is permanent (HTH-14) — there's
    // no undoing an accidental one, so the confirmation says so plainly.
    const prompt = seasonLocked
      ? `Remove ${displayName} from ${league.name}? This head-to-head season is locked, so they won't be able to rejoin it${
          detail?.finished ? "" : ", and their remaining matchups go to their opponents as walkovers"
        }. This can't be undone.`
      : `Remove ${displayName} from ${league.name}? They can rejoin with the invite code.`;
    if (!window.confirm(prompt)) return;
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

      {headToHead ? (
        <>
          <section className="settings-card">
            <h3 className="settings-card-title">Format</h3>
            <div className="setting-row">
              <div className="setting-text">
                <span className="setting-label">Scoring format</span>
                <span className="field-hint">
                  1v1 matchups each round — most votes wins, ranked by W–L record. Chosen when the
                  league was created; it can't be changed.
                </span>
              </div>
              <span className="format-badge">Head-to-Head</span>
            </div>
          </section>

          <section className="settings-card">
            <h3 className="settings-card-title">Head-to-head rules</h3>
            <LockedSetting
              label="Songs per player"
              hint="Each matchup is one song against one song, so every player brings exactly one."
              value="1"
            />
            <LockedSetting
              label="Anti-votes"
              hint="Not used — every ballot picks a winner in each matchup instead of spending points."
              value="Off"
            />
          </section>

          {/* Nothing to save here; kick / invite errors still surface. */}
          {error && <span className="field-error">{error}</span>}
        </>
      ) : (
        <>
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

            <Stepper
              label="Anti-votes per player"
              hint="Each anti-vote subtracts a point from a song. 0 turns them off; spending them is optional. Scores can go negative."
              value={downvotePoolSize}
              min={0}
              max={2}
              onChange={setDownvotePoolSize}
            />
          </section>

          {error && <span className="field-error">{error}</span>}
          {saved && !error && <span className="settings-saved">Settings saved ✓</span>}

          <button className="btn btn-primary settings-save" disabled={!canSave} onClick={handleSave}>
            {busy ? "Saving…" : "Save changes"}
          </button>
        </>
      )}

      <section className="settings-card">
        <h3 className="settings-card-title">Invite code</h3>
        {/* A locked head-to-head season admits nobody (HTH-14), so its code
            is shown for reference only: no "Generate new code" — retiring a
            code that lets nobody in does nothing, and its note would read as
            if the current one still did. */}
        <div className="setting-row">
          <div className="setting-text">
            <span className="invite-code-value">{league.inviteCode}</span>
            <span className="field-hint">
              {seasonLocked
                ? "Season locked — this code no longer lets anyone in: the league can't take new players, and nobody who leaves can rejoin."
                : "Share this code (or the invite link) to bring players in."}
            </span>
          </div>
          {!seasonLocked && (
            <button type="button" className="btn" onClick={handleRegenerateInvite}>
              Generate new code
            </button>
          )}
        </div>
        {!seasonLocked && (
          <p className="field-hint">
            Generating a new code retires the old one — anyone holding the old code or link can no
            longer join with it.
          </p>
        )}
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
          Removed players keep their name on past results but drop off the leaderboard.{" "}
          {seasonLocked
            ? "This head-to-head season is locked, so they can't rejoin it."
            : "They can rejoin with the invite code."}
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

/** A setting the league's format fixes: shown with its value, not editable. */
function LockedSetting({ label, hint, value }: { label: string; hint: string; value: string }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <span className="setting-label">{label}</span>
        <span className="field-hint">{hint}</span>
      </div>
      <span className="setting-locked" title="Locked by the head-to-head format">
        <span aria-hidden>🔒</span> {value}
      </span>
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
      <div className="num-stepper">
        <button type="button" className="num-stepper-btn" onClick={dec} disabled={value <= min} aria-label={`Decrease ${label}`}>–</button>
        <span className="num-stepper-value">{value}</span>
        <button type="button" className="num-stepper-btn" onClick={inc} disabled={max != null && value >= max} aria-label={`Increase ${label}`}>+</button>
      </div>
    </div>
  );
}
