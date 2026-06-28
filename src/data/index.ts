// The data source the app uses. Mirrors auth/config.ts: if VITE_API_URL is set
// (AWS mode) → the real ApiClient; otherwise → the MockClient (local, no AWS).
// Pages import `data` and the view-model types from here, never from ./mock.

import type { DataClient } from "./client";
import { MockClient } from "./mockClient";
import { ApiClient } from "./apiClient";

/** True when wired to the deployed API rather than the in-memory mock. */
export const isApiMode = Boolean(import.meta.env.VITE_API_URL);

export const data: DataClient = isApiMode ? new ApiClient() : new MockClient();

export type { DataClient } from "./client";
export { trendingLeagues } from "./mock";
export type {
  ActivityItem,
  CreateLeagueInput,
  JoinResult,
  LeagueDetail,
  LeagueSummary,
  RoundResult,
  Standing,
  VotableSubmission,
  VoterComment,
} from "./mock";
