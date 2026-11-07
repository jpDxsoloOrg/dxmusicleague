// Head-to-head records as the UI writes them (HTH-11). One place, so every
// surface showing a W–L(–D) record (the standings table, the wrap-up hero,
// the profile page) prints it the same way.
//
// The draws number is a league-wide choice, not a per-row one: once anyone in
// the league has drawn, every record in it is written W–L–D ("2–0–0"), so a
// column of records always lines up under one key. Until then they're W–L
// ("2–0"). Callers pass `withDraws: leagueHasDraws(standings)`.

import type { Standing } from "../data";

/** The record fields of a standings row (or anything shaped like one). */
export type RecordLike = Pick<Standing, "wins" | "losses" | "draws">;

/** Whether a league's records carry the draws number: true once any row has
 *  a draw. Pass the league's whole board. */
export function leagueHasDraws(rows: readonly RecordLike[]): boolean {
  return rows.some((r) => r.draws > 0);
}

/** "3–1" (wins–losses), or "3–1–2" with draws. En dashes. `withDraws`
 *  defaults to this record's own draws > 0; pass `leagueHasDraws(...)` so a
 *  league's records all use the same shape. */
export function formatRecord({ wins, losses, draws }: RecordLike, withDraws = draws > 0): string {
  return withDraws ? `${wins}–${losses}–${draws}` : `${wins}–${losses}`;
}

/** The record spelled out ("3 wins, 1 loss, 2 draws"), for tooltips and
 *  screen readers, where "3–1–2" alone is ambiguous. Same `withDraws` rule as
 *  formatRecord. */
export function describeRecord({ wins, losses, draws }: RecordLike, withDraws = draws > 0): string {
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts = [count(wins, "win", "wins"), count(losses, "loss", "losses")];
  if (withDraws) parts.push(count(draws, "draw", "draws"));
  return parts.join(", ");
}
