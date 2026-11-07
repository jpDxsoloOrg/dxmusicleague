import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { data } from "../data";
import type { ByeResult, HeadToHeadResults, MatchupResult, MatchupResultSide, VoterComment } from "../data";
import { leagueFormat } from "../domain/types";
import { getProvider } from "../music";
import { useAsync } from "../lib/useAsync";
import { useAuth } from "../auth/AuthContext";
import { TrackArt } from "../components/TrackArt";
import { Avatar } from "../components/Avatar";
import { StandingsTable } from "../components/StandingsTable";
import "./RevealPage.css";

export function RevealPage() {
  const { leagueId = "" } = useParams();
  // ?round=<id> shows a past round's results; without it, the current round.
  const [params] = useSearchParams();
  const requestedRoundId = params.get("round");
  const { user } = useAuth();
  const { data: detail, loading: detailLoading, reload: reloadDetail } = useAsync(
    () => data.getLeagueDetail(leagueId),
    [leagueId],
  );

  const rounds = detail?.rounds ?? [];
  const round =
    (requestedRoundId ? rounds.find((r) => r.id === requestedRoundId) : undefined) ??
    detail?.currentRound;
  const roundId = round?.id ?? "";
  const status = round?.status;
  const revealed = status === "revealed" || status === "complete";

  // Results only exist once a round is revealed, in the league's format: a
  // standard round's ranked list, or a head-to-head round's matchups + bye.
  const { data: resultsData, reload: reloadResults } = useAsync(
    () => (roundId && revealed ? data.getResults(roundId) : Promise.resolve(null)),
    [roundId, revealed],
  );
  const results = resultsData?.format === "standard" ? resultsData.results : [];
  const matchupResults = resultsData?.format === "headToHead" ? resultsData : null;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (detailLoading) {
    return <div className="reveal-page"><p className="page-loading">Loading…</p></div>;
  }
  if (!detail) {
    return (
      <div className="reveal-page">
        <h2>League not found</h2>
        <Link to="/" className="link-muted">← Back to dashboard</Link>
      </div>
    );
  }

  const { league, standings } = detail;
  const providerName = getProvider(league.musicProvider).info.name;
  const isOwner = league.ownerId === user?.id;
  const format = leagueFormat(league);
  const headToHead = format === "headToHead";

  async function reveal() {
    setBusy(true);
    setError(null);
    try {
      await data.revealRound(roundId);
      reloadDetail();
      reloadResults();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reveal the round.");
    } finally {
      setBusy(false);
    }
  }

  // Round not revealed yet: owner can reveal; everyone else waits.
  if (!revealed) {
    return (
      <div className="reveal-page">
        <header className="reveal-head">
          <Link to={`/leagues/${league.id}`} className="link-muted">← {league.name}</Link>
          <h1>{round ? `Round ${round.index} Results` : "Round Results"}</h1>
          {round && <p className="reveal-theme">{round.theme}</p>}
        </header>
        <div className="reveal-pending">
          {isOwner && status === "voting" ? (
            <>
              <p>
                {headToHead
                  ? "Voting is open. Reveal the results to settle the matchups and update the standings."
                  : "Voting is open. Reveal the results to tally points and update the leaderboard."}
              </p>
              <button className="btn btn-primary" disabled={busy} onClick={reveal}>
                {busy ? "Revealing…" : "Reveal results"}
              </button>
            </>
          ) : (
            <p>Results will appear once the league owner reveals this round.</p>
          )}
          {error && <p className="page-error">{error}</p>}
        </div>
      </div>
    );
  }

  const winner = results[0];
  const rest = results.slice(1);
  const playlistUrl = round?.playlistUrl ?? "#";

  return (
    <div className="reveal-page">
      <div className="reveal-grid">
        <div className="reveal-main">
          <header className="reveal-head">
            <Link to={`/leagues/${league.id}`} className="link-muted">← {league.name}</Link>
            <h1>{round ? `Round ${round.index} Results` : "Round Results"}</h1>
            {round && <p className="reveal-theme">{round.theme}</p>}
          </header>

          {headToHead ? (
            // Head-to-head: one card per matchup, then the bye's exhibition
            // song. No single winner hero — each matchup has its own winner.
            matchupResults && <MatchupResultList results={matchupResults} meId={user?.id} />
          ) : (
            <>
              {/* winner */}
              {winner && (
                <div className="winner-card">
                  <div className="winner-badge">
                    🏆 Winner · {winner.points} pts
                    {winner.pointsAgainst > 0 && (
                      <span className="pts-breakdown"> (+{winner.pointsFor} / −{winner.pointsAgainst})</span>
                    )}
                  </div>
                  <div className="winner-top">
                    <TrackArt track={winner.track} size={88} />
                    <div className="winner-info">
                      <strong>{winner.track.title}</strong>
                      <span>{winner.track.artists.join(", ")}</span>
                      <span className="winner-by">
                        <Avatar name={winner.submitter.displayName} size={22} /> Submitted by {winner.submitter.displayName}
                      </span>
                    </div>
                  </div>
                  {winner.submitterComment && (
                    <p className="submitter-note">
                      “{winner.submitterComment}” — {winner.submitter.displayName}
                    </p>
                  )}
                  <CommentList comments={winner.comments} onWinner />
                </div>
              )}

              {/* the rest, ranked */}
              <div className="result-list">
                {rest.map((r) => (
                  <div key={r.track.id} className="result-item">
                    <div className="result-rank-row">
                      <span className="rank-num">{r.rank}</span>
                      <TrackArt track={r.track} size={48} />
                      <div className="rank-info">
                        <strong>{r.track.title}</strong>
                        <span>{r.track.artists.join(", ")}</span>
                      </div>
                      <span className="rank-by">
                        <Avatar name={r.submitter.displayName} size={24} /> {r.submitter.displayName}
                      </span>
                      <span className="rank-pts">
                        {r.points} pts
                        {r.pointsAgainst > 0 && (
                          <span className="pts-breakdown">+{r.pointsFor} / −{r.pointsAgainst}</span>
                        )}
                      </span>
                    </div>
                    {r.submitterComment && (
                      <p className="submitter-note">
                        “{r.submitterComment}” — {r.submitter.displayName}
                      </p>
                    )}
                    <CommentList comments={r.comments} />
                  </div>
                ))}
              </div>
            </>
          )}

          {playlistUrl !== "#" && (
            <a className="playlist-btn" href={playlistUrl} target="_blank" rel="noreferrer">
              <span className="play-ic" aria-hidden /> Open round playlist on {providerName}
            </a>
          )}
        </div>

        {/* overall leaderboard */}
        <aside className="reveal-standings">
          <h3>Overall Leaderboard</h3>
          <StandingsTable standings={standings} format={format} avatarSize={32} />
        </aside>
      </div>
    </div>
  );
}

function CommentList({ comments, onWinner }: { comments: VoterComment[]; onWinner?: boolean }) {
  if (comments.length === 0) return null;
  return (
    <div className={`comments${onWinner ? " on-winner" : ""}`}>
      {comments.map((c, i) => (
        <div key={i} className="comment">
          <Avatar name={c.voter.displayName} size={22} />
          <span className="comment-text">
            <strong>{c.voter.displayName}</strong> {c.text}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---- head-to-head reveal (HTH-11) ----
// A revealed H2H round is a list of matchup cards: both players named, their
// songs, the picks each song won and who took the pair. Draws, walkovers and
// no contests are badged. The bye player's song closes the list as an
// exhibition. Notes and comments render as on the standard reveal.

/** How one side of a revealed matchup counts on the board: a W, L or D, or
 *  nothing (a no contest; a departed player's walkover side, which banks no
 *  loss; or an outcome this build doesn't know yet). */
type SideResult = "win" | "loss" | "draw";

const RESULT_LETTER: Record<SideResult, string> = { win: "W", loss: "L", draw: "D" };
const RESULT_WORD: Record<SideResult, string> = { win: "Win", loss: "Loss", draw: "Draw" };

function sideResult(matchup: MatchupResult, side: MatchupResultSide): SideResult | null {
  const won = side.player.id === matchup.winnerUserId;
  switch (matchup.outcome) {
    case "win":
      return won ? "win" : "loss";
    case "draw":
      return "draw";
    case "walkover":
      return won ? "win" : side.departed ? null : "loss";
    default:
      return null; // noContest, or an outcome added later (the set is open)
  }
}

/** The header badge. A plain win gets none: the score says it. Anything
 *  unrecognised reads "No result", as the type's comment asks. */
function outcomeBadge(outcome: MatchupResult["outcome"]): { label: string; tone: string } | null {
  switch (outcome) {
    case "win":
      return null;
    case "draw":
      return { label: "Draw", tone: "draw" };
    case "walkover":
      return { label: "Walkover", tone: "walkover" };
    case "noContest":
      return { label: "No contest", tone: "none" };
    default:
      return { label: "No result", tone: "none" };
  }
}

function MatchupResultList({ results, meId }: { results: HeadToHeadResults; meId?: string }) {
  if (results.matchups.length === 0 && !results.bye) {
    return <p className="mr-empty">No matchups were played this round.</p>;
  }
  return (
    <div className="mr-list">
      {results.matchups.map((m, i) => (
        <MatchupResultCard key={m.matchupId} matchup={m} number={i + 1} meId={meId} />
      ))}
      {results.bye && <ExhibitionCard bye={results.bye} />}
    </div>
  );
}

function MatchupResultCard({ matchup, number, meId }: { matchup: MatchupResult; number: number; meId?: string }) {
  const { a, b, outcome } = matchup;
  // Only a played matchup (both songs in) has picks to show.
  const contested = outcome === "win" || outcome === "draw";
  const badge = outcomeBadge(outcome);
  const mine = meId !== undefined && (a.player.id === meId || b.player.id === meId);
  return (
    <article
      className={`mr-card${mine ? " mr-mine" : ""}`}
      aria-label={`Matchup ${number}: ${a.player.displayName} vs ${b.player.displayName}`}
    >
      <header className="mr-head">
        <span className="mr-title">
          Matchup {number}
          {mine && <span className="mr-you">Your matchup</span>}
        </span>
        <span className="mr-head-end">
          {badge && <span className={`mr-badge mr-badge-${badge.tone}`}>{badge.label}</span>}
          {contested && (
            <span className="mr-score">
              {a.votes}–{b.votes}
            </span>
          )}
        </span>
      </header>
      <MatchupSide side={a} result={sideResult(matchup, a)} contested={contested} />
      <div className="mr-vs" aria-hidden>vs</div>
      <MatchupSide side={b} result={sideResult(matchup, b)} contested={contested} />
    </article>
  );
}

/** One player's half of a matchup card: their song (or why there isn't
 *  one), their name, and the picks the song won. A side without a song is
 *  "No submission", or "Left the league" if they'd left (or been removed)
 *  by the reveal. */
function MatchupSide({
  side,
  result,
  contested,
}: {
  side: MatchupResultSide;
  result: SideResult | null;
  contested: boolean;
}) {
  const { player, song, votes } = side;
  // The right-hand column: picks won in a played matchup, or "Win by
  // walkover" for the side whose opponent had no song.
  const tally = contested ? `${votes} ${votes === 1 ? "vote" : "votes"}` : result === "win" ? "Win by walkover" : null;
  return (
    <div className={`mr-side${result ? ` mr-side-${result}` : ""}`}>
      <div className="mr-row">
        <ResultChip result={result} />
        {song ? <TrackArt track={song.track} size={48} /> : <span className="mr-noart" aria-hidden />}
        <div className="mr-info">
          {song ? (
            <>
              <strong>{song.track.title}</strong>
              <span>{song.track.artists.join(", ")}</span>
            </>
          ) : (
            <strong className="mr-missing">{side.departed ? "Left the league" : "No submission"}</strong>
          )}
          <span className="mr-player">
            <Avatar name={player.displayName} size={20} /> {player.displayName}
          </span>
        </div>
        {tally && <span className="mr-tally">{tally}</span>}
      </div>
      {song?.submitterComment && (
        <p className="submitter-note">
          “{song.submitterComment}” — {player.displayName}
        </p>
      )}
      {song && <CommentList comments={song.comments} />}
    </div>
  );
}

/** The bye player's song: played for fun, no matchup, no result. */
function ExhibitionCard({ bye }: { bye: ByeResult }) {
  const { player, song } = bye;
  return (
    <article className="mr-card mr-bye" aria-label={`Exhibition: ${player.displayName} had the bye`}>
      <header className="mr-head">
        <span className="mr-title">Exhibition</span>
        <span className="mr-head-end">
          <span className="mr-badge mr-badge-bye">Bye</span>
        </span>
      </header>
      <div className="mr-side">
        <div className="mr-row">
          <ResultChip result={null} />
          <TrackArt track={song.track} size={48} />
          <div className="mr-info">
            <strong>{song.track.title}</strong>
            <span>{song.track.artists.join(", ")}</span>
            <span className="mr-player">
              <Avatar name={player.displayName} size={20} /> {player.displayName}
            </span>
          </div>
          <span className="mr-tally">Not scored</span>
        </div>
        {song.submitterComment && (
          <p className="submitter-note">
            “{song.submitterComment}” — {player.displayName}
          </p>
        )}
        <CommentList comments={song.comments} />
      </div>
    </article>
  );
}

/** W / L / D square at the start of a side; a dashed "–" when the side
 *  doesn't count on the board. */
function ResultChip({ result }: { result: SideResult | null }) {
  return result ? (
    <abbr className={`mr-chip mr-chip-${result}`} title={RESULT_WORD[result]}>
      {RESULT_LETTER[result]}
    </abbr>
  ) : (
    <abbr className="mr-chip" title="Not scored">
      –
    </abbr>
  );
}
