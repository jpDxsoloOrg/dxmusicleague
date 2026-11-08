import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { data } from "../data";
import type { LeagueDetail } from "../data";
import { getProvider, formatDuration } from "../music";
import type { Track } from "../music";
import { useAsync } from "../lib/useAsync";
import { useAuth } from "../auth/AuthContext";
import { TrackArt } from "../components/TrackArt";
import { RoundStateCard } from "../components/RoundStateCard";
import "./SubmitSongPage.css";

export function SubmitSongPage() {
  const { leagueId = "" } = useParams();
  const { user } = useAuth();
  const { data: detail, loading: detailLoading } = useAsync(() => data.getLeagueDetail(leagueId), [leagueId]);

  if (detailLoading) {
    return <div className="submit-page"><p className="page-loading">Loading…</p></div>;
  }

  if (!detail) {
    return (
      <div className="submit-page">
        <h2>League not found</h2>
        <Link to="/" className="link-muted">← Back to dashboard</Link>
      </div>
    );
  }

  // Shared by both formats. The search is only for a member while the current
  // round is submitting (BUG-12); anything else — a spectator, no round yet, or
  // a round in another phase (a stale tab, a bookmark, a timed deadline that
  // passed as the league loaded) — gets a state card instead. The gate sits
  // here, outside the form, so the form's member-only read (my-submissions)
  // and its provider searches never run otherwise. It reads the detail loaded
  // at mount, which isn't reloaded, so the "Song submitted!" card still shows
  // after a submit that closes the round (a timed league's last song).
  const isMember = Boolean(user && detail.league.memberIds.includes(user.id));
  if (!isMember || detail.currentRound?.status !== "submitting") {
    return (
      <div className="submit-page">
        <RoundStateCard page="submit" detail={detail} spectator={!isMember} />
      </div>
    );
  }
  return <SubmitForm detail={detail} />;
}

/** The search + submission form, for a member while the round is submitting. */
function SubmitForm({ detail }: { detail: LeagueDetail }) {
  // The caller's existing picks — drives the slot count and the remove list.
  const activeRoundId = detail.currentRound?.id;
  const { data: mySubs, reload: reloadMySubs } = useAsync(
    () => (activeRoundId ? data.getMySubmissions(activeRoundId) : Promise.resolve([])),
    [activeRoundId],
  );

  // Resolve the league's chosen music service. The page never names Spotify.
  const provider = useMemo(() => getProvider(detail.league.musicProvider), [detail]);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Track[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Track | null>(null);
  const [comment, setComment] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  // Two errors, each shown as a compact line beside the action that failed
  // (BUG-21): a failed submit under the Submit button, a failed ✕ remove
  // under the picks list. Separate so a remove failure is visible whatever the
  // card below shows (slots full, nothing selected) and never surfaces under
  // the Submit button as if the submit had failed.
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const submitErrorRef = useRef<HTMLParagraphElement>(null);
  const removeErrorRef = useRef<HTMLParagraphElement>(null);
  // The selected track's id, readable from an in-flight submit (its handler
  // only sees the track it started with). The Select buttons stay live while
  // a submit is pending, so a late failure is dropped if another track has
  // been selected meanwhile, rather than shown under a song it isn't about.
  const selectedId = useRef<string | null>(null);

  // Picking a different track drops a submit error about the previous one
  // (e.g. "already submitted"), so it isn't left under a song it isn't about.
  function selectTrack(track: Track) {
    if (track.id !== selected?.id) setSubmitError(null);
    selectedId.current = track.id;
    setSelected(track);
  }

  // Bring a new error line into view. On a phone the Submit button is often
  // tapped just above the fixed bottom nav, so the line under it would land
  // behind the nav. `nearest` scrolls only as far as needed (not at all when
  // the line is already visible), and the line's scroll-margin-bottom in the
  // CSS stops it clear of the nav.
  useEffect(() => {
    if (submitError) submitErrorRef.current?.scrollIntoView({ block: "nearest" });
  }, [submitError]);
  useEffect(() => {
    if (removeError) removeErrorRef.current?.scrollIntoView({ block: "nearest" });
  }, [removeError]);

  // Debounced search through the provider abstraction.
  useEffect(() => {
    let active = true;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const tracks = await provider.searchTracks(query, { limit: 8, market: "US" });
        if (active) setResults(tracks);
      } finally {
        if (active) setLoading(false);
      }
    }, 250);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [provider, query]);

  const { league, currentRound } = detail;
  const theme = currentRound?.theme ?? "Current round";
  const allowance = league.settings.submissionsPerPlayer || 1;
  const picks = mySubs ?? [];
  const multi = allowance > 1;
  // With one slot a re-submit replaces the pick, so the form never locks;
  // with several, the form locks once every slot is used.
  const slotsFull = multi && picks.length >= allowance;

  if (submitted && selected) {
    const remaining = allowance - picks.length;
    return (
      <div className="submit-page">
        <div className="submitted-card">
          <div className="submitted-check">✓</div>
          <h2>Song submitted!</h2>
          <p>
            <strong>{selected.title}</strong> by {selected.artists.join(", ")} is locked in for
            “{theme}”.
          </p>
          {multi && remaining > 0 && (
            <p className="field-hint">
              {picks.length} of {allowance} picks in — you can add {remaining} more.
            </p>
          )}
          <div className="submitted-actions">
            {multi && remaining > 0 && (
              <button
                className="btn"
                onClick={() => {
                  // Back to a fresh form for the next slot: nothing selected,
                  // no comment, an idle Submit button and no leftover error.
                  setSelected(null);
                  selectedId.current = null;
                  setComment("");
                  setSubmitted(false);
                  setBusy(false);
                  setSubmitError(null);
                  setRemoveError(null);
                }}
              >
                Add another song
              </button>
            )}
            <Link to={`/leagues/${league.id}`} className="btn btn-primary">Back to league</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="submit-page">
      <header className="submit-head">
        <Link to={`/leagues/${league.id}`} className="link-muted">← {league.name}</Link>
        <span className="provider-badge">via {provider.info.name}</span>
      </header>

      <div className="submit-grid">
        {/* search column */}
        <div className="search-col">
          <p className="theme-eyebrow">Submitting for</p>
          <h1 className="theme-title">{theme}</h1>

          <div className="track-search">
            <span className="search-icon" aria-hidden />
            <input
              autoFocus
              placeholder="Search for a song…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="results">
            {loading && results.length === 0 && <p className="muted">Searching…</p>}
            {!loading && results.length === 0 && <p className="muted">No tracks found.</p>}
            {results.map((track) => {
              const isSel = selected?.id === track.id;
              return (
                <div key={track.id} className={`result-row${isSel ? " selected" : ""}`}>
                  <TrackArt track={track} size={48} />
                  <div className="result-info">
                    <strong>{track.title}</strong>
                    <span>{track.artists.join(", ")}{track.album ? ` · ${track.album}` : ""}</span>
                  </div>
                  <span className="result-dur">{formatDuration(track.durationMs)}</span>
                  <button
                    className={isSel ? "btn select-btn is-selected" : "btn select-btn"}
                    onClick={() => selectTrack(track)}
                  >
                    {isSel ? "Selected" : "Select"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* submission column */}
        <aside className="submission-col">
          {/* Existing picks — only interesting once a league allows several. */}
          {multi && picks.length > 0 && (
            <div className="my-picks">
              <h3>Your picks ({picks.length} of {allowance})</h3>
              {picks.map((pick) => (
                <div key={pick.id} className="my-picks-row">
                  <TrackArt track={pick.track} size={40} />
                  <div className="my-picks-info">
                    <strong>{pick.track.title}</strong>
                    <span>{pick.track.artists.join(", ")}</span>
                  </div>
                  <button
                    type="button"
                    className="my-picks-remove"
                    aria-label={`Remove ${pick.track.title}`}
                    onClick={async () => {
                      if (!currentRound) return;
                      setRemoveError(null);
                      try {
                        await data.removeSubmission(currentRound.id, pick.id);
                        reloadMySubs();
                      } catch (err) {
                        setRemoveError(err instanceof Error ? err.message : "Couldn't remove that pick.");
                      }
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {removeError && (
                <p ref={removeErrorRef} className="submit-error" role="alert">{removeError}</p>
              )}
            </div>
          )}

          <h3>{multi ? "Add a song" : "Your submission"}</h3>
          {slotsFull ? (
            <div className="submission-empty">
              <p>
                All {allowance} of your picks are in for this round. Remove one above if you want
                to swap it for something else.
              </p>
            </div>
          ) : selected ? (
            <div className="submission-card">
              <TrackArt track={selected} size={220} />
              <div className="submission-meta">
                <strong>{selected.title}</strong>
                <span>{selected.artists.join(", ")}</span>
              </div>
              <PreviewButton track={selected} />

              <label className="comment-label">Add an optional comment</label>
              <textarea
                className="comment-input"
                placeholder="Tell the league why you're submitting this track…"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={3}
              />

              <button
                className="btn btn-primary submit-btn"
                disabled={busy || !currentRound}
                onClick={async () => {
                  if (!currentRound) return;
                  setBusy(true);
                  setSubmitError(null);
                  try {
                    await data.submitSong(currentRound.id, selected, comment.trim() || undefined);
                    reloadMySubs();
                    setSubmitted(true);
                  } catch (err) {
                    if (selectedId.current === selected.id) {
                      setSubmitError(err instanceof Error ? err.message : "Couldn't submit your song.");
                    }
                  } finally {
                    // Success too: in a multi-song league "Add another song"
                    // brings this form back, and it must not still be busy.
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Submitting…" : "Submit song →"}
              </button>
              {submitError && (
                <p ref={submitErrorRef} className="submit-error" role="alert">{submitError}</p>
              )}
              <p className="submit-note">
                {multi
                  ? `You can submit up to ${allowance} songs and swap them until the round closes.`
                  : "You can change your pick until the round closes."}
              </p>
            </div>
          ) : (
            <div className="submission-empty">
              <div className="submission-empty-art" aria-hidden />
              <p>Pick a track from the search to see it here.</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

// Plays the provider's preview clip if there is one; otherwise stays informative.
function PreviewButton({ track }: { track: Track }) {
  const [playing, setPlaying] = useState(false);
  const audio = useMemo(
    () => (track.previewUrl ? new Audio(track.previewUrl) : null),
    [track.previewUrl],
  );

  useEffect(() => {
    if (!audio) return;
    const onEnd = () => setPlaying(false);
    audio.addEventListener("ended", onEnd);
    return () => {
      audio.pause();
      audio.removeEventListener("ended", onEnd);
    };
  }, [audio]);

  if (!audio) {
    return <div className="preview-row muted">No preview available in demo</div>;
  }
  const toggle = () => {
    if (playing) audio.pause();
    else void audio.play();
    setPlaying(!playing);
  };
  return (
    <button className="preview-btn" onClick={toggle}>
      <span className={playing ? "ic-pause" : "ic-play"} aria-hidden /> {playing ? "Pause" : "Preview"}
    </button>
  );
}
