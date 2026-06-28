// ApiClient — the real DataClient, talking to the deployed REST API
// (API Gateway + Lambda + DynamoDB) with the Cognito ID token as a bearer.
// Selected when VITE_API_URL is set (AWS mode).
//
// The league-loop endpoints are live. The round/voting endpoints don't exist on
// the backend yet (build-order steps 3-4), so those methods fall back to the
// in-memory mock for now — clearly logged — so the app stays navigable on AWS
// until those endpoints land.

import type { League } from "../domain/types";
import { auth } from "../auth/config";
import type { DataClient } from "./client";
import {
  getRoundResults as mockRoundResults,
  getVotableSubmissions as mockVotableSubmissions,
  saveVoteComments as mockSaveVoteComments,
  type CreateLeagueInput,
  type JoinResult,
  type LeagueDetail,
  type LeagueSummary,
  type RoundResult,
  type Standing,
  type VotableSubmission,
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

let warnedRoundsStub = false;
function warnRoundsStub(): void {
  if (warnedRoundsStub) return;
  warnedRoundsStub = true;
  console.warn(
    "[data] Round/voting data is still served from the mock — the backend rounds API isn't built yet (build-order steps 3-4).",
  );
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
    return request<League>("/leagues", { method: "POST", body: JSON.stringify(input) });
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

  // ---- round/voting: mock fallback until the backend rounds API exists ----
  async getVotableSubmissions(leagueId: string): Promise<VotableSubmission[]> {
    warnRoundsStub();
    return mockVotableSubmissions(leagueId);
  }
  async saveVoteComments(leagueId: string, comments: Record<string, string>): Promise<void> {
    warnRoundsStub();
    mockSaveVoteComments(leagueId, comments);
  }
  async getRoundResults(leagueId: string): Promise<RoundResult[]> {
    warnRoundsStub();
    return mockRoundResults(leagueId);
  }
}
