import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { data } from "../data";
import type { League, Round, RoundStatus } from "../domain/types";
import { getProvider } from "../music";
import { useAsync } from "../lib/useAsync";
import { useAuth } from "../auth/AuthContext";
import { formatCountdown } from "../lib/time";
import { Avatar } from "../components/Avatar";
import { TrackArt } from "../components/TrackArt";
import "./RoundOverviewPage.css";

const STATUS_LABEL: Record<RoundStatus, string> = {
  draft: "Draft",
  submitting: "Submitting",
  previewing: "Listening",
  voting: "Voting",
  revealed: "Revealed",
  complete: "Complete",
};

// What the active round's primary button does, by status. `previewing` has no
// action — players just listen until voting opens.
function primaryAction(
  leagueId: string,
  round: Round,
  hasSubmission: boolean,
): { label: string; to: string } | undefined {
  switch (round.status) {
    case "submitting":
      return {
        label: hasSubmission ? "Change your song" : "Submit your song",
        to: `/leagues/${leagueId}/submit`,
      };
    case "previewing":
      return undefined;
    case "voting":
      return { label: "Vote now", to: `/leagues/${leagueId}/vote` };
    case "revealed":
    case "complete":
      return { label: "View results", to: `/leagues/${leagueId}/reveal` };
    default:
      // draft (and any future status): players wait for the owner — no action.
      return undefined;
  }
}

export function RoundOverviewPage() {
  const { leagueId = "" } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: detail, loading, reload } = useAsync(() => data.getLeagueDetail(leagueId), [leagueId]);
  // The caller's own pick for the active round, so they can see it while waiting.
  const activeRoundId = detail?.currentRound?.id;
  const { data: mySubmission } = useAsync(
    () => (activeRoundId ? data.getMySubmission(activeRoundId) : Promise.resolve(null)),
    [activeRoundId],
  );

  if (loading) {
    return <div className="round-overview"><p className="page-loading">Loading league…</p></div>;
  }

  if (!detail) {
    return (
      <div className="round-overview">
        <h2>League not found</h2>
        <Link to="/" className="link-muted">← Back to dashboard</Link>
      </div>
    );
  }

  const { league, rounds, currentRound, totalRounds, standings, activity } = detail;
  const providerName = getProvider(league.musicProvider).info.name;
  const isOwner = league.ownerId === user?.id;
  // A capped (public) league is full once every slot is taken; uncapped never is.
  const isFull = Boolean(league.maxMembers && league.memberIds.length >= league.maxMembers);

  async function handleLeave() {
    if (!window.confirm(`Leave ${league.name}? You can rejoin later with the invite code.`)) return;
    try {
      await data.leaveLeague(league.id);
      navigate("/");
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Couldn't leave the league.");
    }
  }
  const deadline = currentRound?.status === "voting"
    ? currentRound?.voteDeadline
    : currentRound?.submissionDeadline;
  const countdown = formatCountdown(deadline);
  const action = currentRound ? primaryAction(league.id, currentRound, Boolean(mySubmission)) : undefined;
  // Show the player's own pick while a round is live (submitting → voting).
  const showMyPick =
    mySubmission &&
    (currentRound?.status === "submitting" ||
      currentRound?.status === "previewing" ||
      currentRound?.status === "voting");

  // Build the stepper: one node per round index up to totalRounds.
  const steps = Array.from({ length: totalRounds }, (_, i) => {
    const idx = i + 1;
    const round = rounds.find((r) => r.index === idx);
    const status: RoundStatus | "upcoming" = round?.status ?? "upcoming";
    const isCurrent = currentRound?.index === idx;
    return { idx, status, isCurrent };
  });

  return (
    <div className="round-overview">
      <div className="ro-grid">
        {/* main column */}
        <div className="ro-main">
          <header className="ro-head">
            <div>
              <Link to="/" className="link-muted ro-back">← Leagues</Link>
              <h1>{league.name}</h1>
            </div>
            <div className="ro-head-actions">
              {isOwner ? (
                <Link to={`/leagues/${league.id}/settings`} className="ro-settings-link">⚙ Settings</Link>
              ) : (
                <button className="ro-leave-link" onClick={handleLeave}>Leave league</button>
              )}
              <span className="provider-badge">via {providerName}</span>
            </div>
          </header>

          {isOwner && (
            <OwnerRoundControl league={league} currentRound={currentRound} onChange={reload} />
          )}

          {/* Invite others — hidden once a capped league is full. */}
          {league.inviteCode && !isFull && <InvitePanel code={league.inviteCode} />}

          {/* round stepper */}
          <div className="stepper">
            {steps.map((s) => (
              <div key={s.idx} className={`step step-${s.status}${s.isCurrent ? " current" : ""}`}>
                <span className="step-dot">
                  {s.status === "complete" || s.status === "revealed" ? "✓" : s.idx}
                </span>
                <span className="step-label">R{s.idx}</span>
              </div>
            ))}
          </div>

          {/* active round hero */}
          {currentRound ? (
            <section className="hero-round">
              <div className="hero-round-top">
                <span className="round-tag">Round {currentRound.index} · Active</span>
                <span className={`pill pill-${currentRound.status}`}>
                  {STATUS_LABEL[currentRound.status]}
                </span>
              </div>
              <h2 className="hero-theme">{currentRound.theme}</h2>
              {currentRound.description && <p className="hero-desc">{currentRound.description}</p>}

              {currentRound.status === "previewing" && (
                <p className="hero-desc">🎧 Submissions are in — give the songs a listen. Voting opens shortly.</p>
              )}

              {currentRound.status === "draft" && league.ownerId !== user?.id && (
                <p className="hero-desc">⏳ Waiting on the league owner to start this round.</p>
              )}

              {showMyPick && mySubmission && (
                <div className="my-pick">
                  <span className="my-pick-label">
                    Your pick{currentRound.status === "submitting" ? " — waiting for the other players" : ""}
                  </span>
                  <div className="my-pick-card">
                    <TrackArt track={mySubmission.track} size={48} />
                    <div className="my-pick-info">
                      <strong>{mySubmission.track.title}</strong>
                      <span>{mySubmission.track.artists.join(", ")}</span>
                    </div>
                  </div>
                </div>
              )}

              <div className="hero-footer">
                {countdown && (
                  <span className="countdown">
                    <span className="clock" aria-hidden /> {countdown} left
                  </span>
                )}
                {currentRound.playlistUrl &&
                  (currentRound.status === "previewing" || currentRound.status === "voting") && (
                    <a
                      className="btn hero-cta"
                      href={currentRound.playlistUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      🎧 Open playlist
                    </a>
                  )}
                {action && (
                  <Link to={action.to} className="btn btn-primary hero-cta">
                    {action.label} →
                  </Link>
                )}
              </div>
            </section>
          ) : (
            <section className="hero-round empty">
              <h2 className="hero-theme">No active round yet</h2>
              <p className="hero-desc">The league owner hasn't started the next round.</p>
            </section>
          )}

          {/* activity */}
          <section className="activity">
            <h3>Recent Activity</h3>
            <ul>
              {activity.map((a) => (
                <li key={a.id}>
                  <Avatar name={a.user.displayName} size={32} />
                  <span className="activity-text">
                    <strong>{a.user.displayName}</strong> {a.text}
                  </span>
                  <span className="activity-time">{a.timeAgo}</span>
                </li>
              ))}
              {activity.length === 0 && <li className="muted">No activity yet.</li>}
            </ul>
          </section>
        </div>

        {/* standings sidebar */}
        <aside className="standings">
          <div className="standings-head">
            <h3>Overall Leaderboard</h3>
            <Link to={`/leagues/${league.id}/reveal`} className="link-muted">Full</Link>
          </div>
          <ol>
            {standings.map((s) => (
              <li key={s.user.id} className={s.rank <= 3 ? `top top-${s.rank}` : ""}>
                <span className="rank">{s.rank}</span>
                <Avatar name={s.user.displayName} size={34} />
                <span className="standing-info">
                  <strong>{s.user.displayName}</strong>
                  {s.note && <span className="standing-note">{s.note}</span>}
                </span>
                <span className="standing-pts">{s.points}</span>
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </div>
  );
}

// Invite strip — shows the league's shareable code and a ready-to-send join
// link, each with a copy button. Any member can invite a friend.
function InvitePanel({ code }: { code: string }) {
  const joinUrl = `${window.location.origin}/leagues/join?code=${encodeURIComponent(code)}`;
  const [copied, setCopied] = useState<"code" | "link" | null>(null);

  const copy = async (what: "code" | "link", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied((c) => (c === what ? null : c)), 1800);
    } catch {
      // Clipboard blocked (e.g. insecure context) — leave the value on screen to copy by hand.
    }
  };

  return (
    <div className="invite-panel">
      <div className="invite-info">
        <span className="invite-label">Invite code</span>
        <code className="invite-code">{code}</code>
      </div>
      <div className="invite-actions">
        <button className="btn invite-btn" onClick={() => copy("code", code)}>
          {copied === "code" ? "Copied ✓" : "Copy code"}
        </button>
        <button className="btn invite-btn" onClick={() => copy("link", joinUrl)}>
          {copied === "link" ? "Copied ✓" : "Copy invite link"}
        </button>
      </div>
    </div>
  );
}

// Owner-only panel that drives the round lifecycle: create the next round, then
// advance draft -> submitting -> voting. (Reveal lives on the Results page.)
function OwnerRoundControl({
  league,
  currentRound,
  onChange,
}: {
  league: League;
  currentRound?: Round;
  onChange: () => void;
}) {
  const [theme, setTheme] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const status = currentRound?.status;
  const needsNewRound = !currentRound || status === "revealed" || status === "complete";

  return (
    <div className="owner-control">
      <span className="owner-tag">Owner controls</span>
      {needsNewRound ? (
        <div className="owner-create">
          <input
            className="owner-input"
            placeholder="Theme for the next round…"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
          />
          <button
            className="btn btn-primary"
            disabled={busy || theme.trim().length < 2}
            onClick={() => run(async () => { await data.createRound(league.id, { theme }); setTheme(""); })}
          >
            {busy ? "Creating…" : "Create round"}
          </button>
        </div>
      ) : status === "draft" ? (
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() => run(() => data.advanceRound(league.id, currentRound!.id, "submitting"))}
        >
          {busy ? "Opening…" : "Open for submissions →"}
        </button>
      ) : status === "submitting" ? (
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() => run(() => data.advanceRound(league.id, currentRound!.id, "previewing"))}
        >
          {busy ? "Closing…" : "Close submissions & reveal songs →"}
        </button>
      ) : status === "previewing" ? (
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() => run(() => data.advanceRound(league.id, currentRound!.id, "voting"))}
        >
          {busy ? "Opening…" : "Open voting →"}
        </button>
      ) : status === "voting" ? (
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() => run(() => data.revealRound(currentRound!.id))}
        >
          {busy ? "Revealing…" : "Close voting & reveal results →"}
        </button>
      ) : (
        <span className="owner-hint">This round is complete.</span>
      )}
      {error && <span className="page-error">{error}</span>}
    </div>
  );
}
