// ApiClient — the real DataClient, talking to the deployed REST API
// (API Gateway + Lambda + DynamoDB) with the Cognito ID token as a bearer.
// Selected when VITE_API_URL is set (AWS mode). Every method is a live endpoint.

import type { League, Round, RoundStatus, Submission } from "../domain/types";
import type { Track } from "../music";
import { auth } from "../auth/config";
import type { CreateRoundInput, DataClient, EditableLeagueSettings } from "./client";
import type {
  CreateLeagueInput,
  JoinResult,
  LeagueDetail,
  LeagueSummary,
  PublicLeaguePreview,
  PublicLeagueSummary,
  RoundResult,
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
  revealRound(roundId: string): Promise<RoundResult[]> {
    return request<RoundResult[]>(`/rounds/${enc(roundId)}/reveal`, { method: "POST" });
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

  // ---- Voting + results ----
  async castBallot(roundId: string, allocations: Record<string, number>, comments?: Record<string, string>): Promise<void> {
    await request(`/rounds/${enc(roundId)}/ballot`, { method: "POST", body: JSON.stringify({ allocations, comments }) });
  }
  getResults(roundId: string): Promise<RoundResult[]> {
    return request<RoundResult[]>(`/rounds/${enc(roundId)}/results`);
  }
}
