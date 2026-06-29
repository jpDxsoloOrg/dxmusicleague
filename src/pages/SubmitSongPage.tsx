import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { data } from "../data";
import { getProvider, formatDuration } from "../music";
import type { Track } from "../music";
import { useAsync } from "../lib/useAsync";
import { TrackArt } from "../components/TrackArt";
import "./SubmitSongPage.css";

export function SubmitSongPage() {
  const { leagueId = "" } = useParams();
  const { data: detail, loading: detailLoading } = useAsync(() => data.getLeagueDetail(leagueId), [leagueId]);

  // Resolve the league's chosen music service. The page never names Spotify.
  const provider = useMemo(
    () => (detail ? getProvider(detail.league.musicProvider) : undefined),
    [detail],
  );

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Track[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Track | null>(null);
  const [comment, setComment] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Debounced search through the provider abstraction.
  useEffect(() => {
    if (!provider) return;
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

  const { league, currentRound } = detail;
  const theme = currentRound?.theme ?? "Current round";

  if (submitted && selected) {
    return (
      <div className="submit-page">
        <div className="submitted-card">
          <div className="submitted-check">✓</div>
          <h2>Song submitted!</h2>
          <p>
            <strong>{selected.title}</strong> by {selected.artists.join(", ")} is locked in for
            “{theme}”.
          </p>
          <Link to={`/leagues/${league.id}`} className="btn btn-primary">Back to league</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="submit-page">
      <header className="submit-head">
        <Link to={`/leagues/${league.id}`} className="link-muted">← {league.name}</Link>
        <span className="provider-badge">via {provider?.info.name}</span>
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
                    onClick={() => setSelected(track)}
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
          <h3>Your submission</h3>
          {selected ? (
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
                    setSubmitted(true);
                  } catch (err) {
                    setSubmitError(err instanceof Error ? err.message : "Couldn't submit your song.");
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Submitting…" : "Submit song →"}
              </button>
              {submitError && <p className="page-error">{submitError}</p>}
              <p className="submit-note">You can change your pick until the round closes.</p>
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
