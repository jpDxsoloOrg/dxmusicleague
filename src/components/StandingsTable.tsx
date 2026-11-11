// The league table: one renderer for every surface that lists standings (the
// round overview sidebar, the reveal page sidebar, the leaderboard page),
// replacing three hand-copied lists (HTH-11).
//
// Format-aware. A standard ("points") league renders exactly the markup each
// surface had before the extraction: the points number, plus " pts" where
// the leaderboard showed it. A head-to-head league shows each player's
// W–L(–D) record instead, under a small "Record" column header. The draws
// number is all or nothing: once anyone has a draw, every row prints W–L–D,
// so the column lines up under its key (lib/record.ts).
//
// Rows render in the order received. The data layer already sends them in
// board order for the league's format (points desc, or wins desc → losses
// asc → name for head-to-head, HTH-04), with ranks assigned, so this never
// re-sorts.

import type { Standing } from "../data";
import type { LeagueFormat } from "../domain/types";
import { describeRecord, formatRecord, leagueHasDraws } from "../lib/record";
import { Avatar } from "./Avatar";
import "./StandingsTable.css";

interface StandingsTableProps {
  /** Rows in board order, as the data layer sends them. */
  standings: Standing[];
  /** The league's format. Pass `leagueFormat(league)`, never `league.format`. */
  format: LeagueFormat;
  avatarSize: number;
  /** Class for the `<ol>`. Each surface styles its own list. */
  className?: string;
  /** Show a row's note (e.g. "Rising Star") under the name. */
  showNotes?: boolean;
  /** Mark this user's row with a "You" tag and `.is-me` (the leaderboard). */
  meId?: string;
  /** Append " pts" to a standard league's points (the leaderboard). */
  pointsUnit?: boolean;
}

export function StandingsTable({
  standings,
  format,
  avatarSize,
  className,
  showNotes,
  meId,
  pointsUnit,
}: StandingsTableProps) {
  const headToHead = format === "headToHead";
  // W–L–D on every row once anyone has drawn, W–L until then.
  const withDraws = headToHead && leagueHasDraws(standings);

  const list = (
    <ol className={className}>
      {standings.map((s) => {
        const isMe = meId !== undefined && s.user.id === meId;
        return (
          <li key={s.user.id} className={`${s.rank <= 3 ? `top top-${s.rank}` : ""}${isMe ? " is-me" : ""}`}>
            <span className="rank">{s.rank}</span>
            <Avatar name={s.user.displayName} size={avatarSize} />
            <span className="standing-info">
              <strong>{s.user.displayName}{isMe && <span className="you-tag">You</span>}</strong>
              {showNotes && s.note && <span className="standing-note">{s.note}</span>}
            </span>
            {headToHead ? (
              <span className="standing-pts standing-record">
                <abbr title={describeRecord(s, withDraws)}>{formatRecord(s, withDraws)}</abbr>
              </span>
            ) : (
              <span className="standing-pts">{s.points}{pointsUnit && " pts"}</span>
            )}
          </li>
        );
      })}
    </ol>
  );

  if (!headToHead) return list;

  // The key says what the numbers are, in the rows' shape.
  return (
    <>
      <div className="standings-colhead">
        <span>Player</span>
        <span>
          Record <span className="standings-colhead-key">{withDraws ? "W–L–D" : "W–L"}</span>
        </span>
      </div>
      {list}
    </>
  );
}
