// ApiClient — the real DataClient, talking to the deployed REST API
// (API Gateway + Lambda + DynamoDB) with the Cognito ID token as a bearer.
// Selected when VITE_API_URL is set (AWS mode). Every method is a live endpoint.

import type { League, Round, RoundStatus, Submission } from "../domain/types";
import type { Track } from "../music";
import { auth } from "../auth/config";
import type { CreateRoundInput, DataClient, EditableLeagueSettings } from "./client";
import type {
  BrowseLeagueSummary,
  CreateLeagueInput,
  HeadToHeadResults,
  JoinResult,
  LeagueDetail,
  LeagueSummary,
  MyBallot,
  PublicLeaguePreview,
  PublicLeagueSummary,
  RoundMatchups,
  RoundResult,
  RoundResults,
  Standing,
  VotableSubmission,
} from "./mock";

class ApiRequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Empty in mock mode (this module is imported but never instantiated then).
const BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

const enc = encodeURIComponent;

/** What GET results / the reveal send: a standard round's bare ranked list —
 *  unchanged since before formats existed, so older frontends keep working —
 *  or a head-to-head round's `{ format: "headToHead", matchups, bye }`.
 *  Normalized here into the client-side `RoundResults` union. */
type RoundResultsWire = RoundResult[] | HeadToHeadResults;

function toRoundResults(wire: RoundResultsWire): RoundResults {
  return Array.isArray(wire) ? { format: "standard", results: wire } : wire;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await auth.idToken();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiRequestError(res.status, body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

export class ApiClient implements DataClient {
  getMyLeagueSummaries(): Promise<LeagueSummary[]> {
    return request<LeagueSummary[]>("/leagues");
  }

  async getLeagueDetail(leagueId: string): Promise<LeagueDetail | undefined> {
    try {
      return await request<LeagueDetail>(`/leagues/${encodeURIComponent(leagueId)}`);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) return undefined;
      throw err;
    }
  }

  createLeague(input: CreateLeagueInput): Promise<League> {
    // The whole input is forwarded, `format` included (omitted → the server
    // defaults to "standard"; an unknown value is a 400).
    return request<League>("/leagues", { method: "POST", body: JSON.stringify(input) });
  }

  getPublicLeagues(): Promise<PublicLeagueSummary[]> {
    return request<PublicLeagueSummary[]>("/leagues/public");
  }

  async getPublicLeaguePreview(leagueId: string): Promise<PublicLeaguePreview | undefined> {
    try {
      return await request<PublicLeaguePreview>(`/leagues/${enc(leagueId)}/public`);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) return undefined;
      throw err;
    }
  }

  async claimSpot(leagueId: string): Promise<JoinResult> {
    try {
      const { league } = await request<{ league: League }>(`/leagues/${enc(leagueId)}/members`, { method: "POST" });
      return { ok: true, league };
    } catch (err) {
      const message = err instanceof ApiRequestError ? err.message : "Couldn't claim a spot.";
      return { ok: false, error: message };
    }
  }

  async leaveLeague(leagueId: string): Promise<void> {
    await request(`/leagues/${enc(leagueId)}/members/me`, { method: "DELETE" });
  }
  getBrowseLeagues(): Promise<BrowseLeagueSummary[]> {
    return request<BrowseLeagueSummary[]>("/leagues/browse");
  }
  async kickMember(leagueId: string, userId: string): Promise<void> {
    await request(`/leagues/${enc(leagueId)}/members/${enc(userId)}`, { method: "DELETE" });
  }
  async regenerateInvite(leagueId: string): Promise<League> {
    const res = await request<{ league: League }>(`/leagues/${enc(leagueId)}/invite`, { method: "POST" });
    return res.league;
  }

  async joinLeague(code: string): Promise<JoinResult> {
    try {
      const { league } = await request<{ league: League }>("/leagues/join", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      return { ok: true, league };
    } catch (err) {
      const message = err instanceof ApiRequestError ? err.message : "Couldn't join that league.";
      return { ok: false, error: message };
    }
  }

  async getStandings(leagueId: string): Promise<Standing[]> {
    const detail = await this.getLeagueDetail(leagueId);
    return detail?.standings ?? [];
  }

  updateLeagueSettings(leagueId: string, settings: EditableLeagueSettings): Promise<League> {
    return request<League>(`/leagues/${enc(leagueId)}/settings`, {
      method: "PATCH",
      body: JSON.stringify(settings),
    });
  }
  async deleteLeague(leagueId: string): Promise<void> {
    await request(`/leagues/${enc(leagueId)}`, { method: "DELETE" });
  }
  rematchLeague(leagueId: string): Promise<League> {
    return request<League>(`/leagues/${enc(leagueId)}/rematch`, { method: "POST" });
  }

  // ---- Rounds (owner) ----
  createRound(leagueId: string, input: CreateRoundInput): Promise<Round> {
    return request<Round>(`/leagues/${enc(leagueId)}/rounds`, { method: "POST", body: JSON.stringify(input) });
  }
  advanceRound(leagueId: string, roundId: string, status: RoundStatus): Promise<Round> {
    return request<Round>(`/leagues/${enc(leagueId)}/rounds/${enc(roundId)}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
  }
  async revealRound(roundId: string): Promise<RoundResults> {
    return toRoundResults(await request<RoundResultsWire>(`/rounds/${enc(roundId)}/reveal`, { method: "POST" }));
  }

  // ---- Submissions ----
  submitSong(roundId: string, track: Track, comment?: string): Promise<Submission> {
    return request<Submission>(`/rounds/${enc(roundId)}/submission`, {
      method: "POST",
      body: JSON.stringify({ track, comment }),
    });
  }
  getVotableSubmissions(roundId: string): Promise<VotableSubmission[]> {
    return request<VotableSubmission[]>(`/rounds/${enc(roundId)}/submissions`);
  }
  getMySubmissions(roundId: string): Promise<Submission[]> {
    return request<Submission[]>(`/rounds/${enc(roundId)}/my-submissions`);
  }
  async removeSubmission(roundId: string, submissionId: string): Promise<void> {
    await request(`/rounds/${enc(roundId)}/submissions/${enc(submissionId)}`, { method: "DELETE" });
  }

  // ---- Voting + results ----
  async castBallot(
    roundId: string,
    allocations: Record<string, number>,
    comments?: Record<string, string>,
    downvotes?: Record<string, number>,
  ): Promise<void> {
    await request(`/rounds/${enc(roundId)}/ballot`, {
      method: "POST",
      body: JSON.stringify({ allocations, comments, downvotes }),
    });
  }
  async castMatchupBallot(roundId: string, picks: Record<string, string>, comments?: Record<string, string>): Promise<void> {
    // No `allocations` key: the H2H ballot path refuses any points.
    await request(`/rounds/${enc(roundId)}/ballot`, {
      method: "POST",
      body: JSON.stringify({ picks, comments }),
    });
  }
  getMyBallot(roundId: string): Promise<MyBallot | null> {
    return request<MyBallot | null>(`/rounds/${enc(roundId)}/my-ballot`);
  }
  getMatchups(roundId: string): Promise<RoundMatchups> {
    return request<RoundMatchups>(`/rounds/${enc(roundId)}/matchups`);
  }
  async getResults(roundId: string): Promise<RoundResults> {
    return toRoundResults(await request<RoundResultsWire>(`/rounds/${enc(roundId)}/results`));
  }
}
