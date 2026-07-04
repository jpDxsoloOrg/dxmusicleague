// The route table — transport-agnostic. Maps METHOD + path pattern to a
// handler that takes a normalized request and returns a plain value (serialized
// as JSON by whichever adapter is in front: Lambda or the local dev server).
// Adding an endpoint = one entry here; both adapters pick it up for free.

import type { Deps } from "../handlers/leagues.ts";
import * as leagues from "../handlers/leagues.ts";
import * as rounds from "../handlers/rounds.ts";
import * as submissions from "../handlers/submissions.ts";
import * as voting from "../handlers/voting.ts";
import * as providers from "../handlers/providers.ts";

export interface RouteRequest {
  /** The authenticated caller's user id (Cognito `sub`, or a dev stub locally). */
  caller: string;
  /** Path params, e.g. { leagueId } from `/leagues/:leagueId`. */
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

export interface Route {
  method: string;
  /** Pattern with `:name` segments, e.g. `/leagues/:leagueId`. */
  pattern: string;
  handler: (req: RouteRequest) => Promise<unknown>;
}

const asString = (v: unknown): string => (typeof v === "string" ? v : "");
const asOptString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export function buildRoutes(deps: Deps): Route[] {
  return [
    {
      method: "POST",
      pattern: "/leagues",
      handler: (req) => {
        const body = asRecord(req.body);
        return leagues.createLeague(deps, req.caller, {
          name: asString(body.name),
          musicProvider: body.musicProvider as never,
          visibility: body.visibility as never,
          maxMembers: typeof body.maxMembers === "number" ? body.maxMembers : undefined,
        });
      },
    },
    {
      method: "GET",
      pattern: "/leagues",
      handler: (req) => leagues.listMyLeagues(deps, req.caller),
    },
    {
      method: "POST",
      pattern: "/leagues/join",
      handler: (req) => leagues.joinLeague(deps, req.caller, asString(asRecord(req.body).code)),
    },
    {
      // Discover open public leagues. Literal `public` is registered before the
      // `:leagueId` param route so it wins the match.
      method: "GET",
      pattern: "/leagues/public",
      handler: (req) => leagues.listOpenPublicLeagues(deps, req.caller, Number(req.query.limit) || 12),
    },
    {
      method: "GET",
      pattern: "/leagues/:leagueId",
      handler: (req) => leagues.getLeagueDetail(deps, req.caller, req.params.leagueId!),
    },
    {
      // Non-member preview of a public league (name, first-round theme, members,
      // open slots). Private/missing leagues 404. Distinct GET shape from the
      // member detail above.
      method: "GET",
      pattern: "/leagues/:leagueId/public",
      handler: (req) => leagues.getPublicLeaguePreview(deps, req.caller, req.params.leagueId!),
    },
    {
      // Claim a spot in an open public league = create the caller's membership.
      method: "POST",
      pattern: "/leagues/:leagueId/members",
      handler: (req) => leagues.claimPublicSpot(deps, req.caller, req.params.leagueId!),
    },
    {
      method: "PATCH",
      pattern: "/leagues/:leagueId/settings",
      handler: (req) => {
        const body = asRecord(req.body);
        return leagues.updateLeagueSettings(deps, req.caller, req.params.leagueId!, {
          votePoolSize: body.votePoolSize,
          maxPointsPerSong: body.maxPointsPerSong,
          allowSelfVote: body.allowSelfVote,
        });
      },
    },
    {
      method: "DELETE",
      pattern: "/leagues/:leagueId",
      handler: (req) => leagues.deleteLeague(deps, req.caller, req.params.leagueId!),
    },
    {
      method: "POST",
      pattern: "/leagues/:leagueId/rounds",
      handler: (req) => {
        const body = asRecord(req.body);
        return rounds.createRound(deps, req.caller, req.params.leagueId!, {
          theme: asString(body.theme),
          description: asOptString(body.description),
          submissionDeadline: asOptString(body.submissionDeadline),
          voteDeadline: asOptString(body.voteDeadline),
        });
      },
    },
    {
      method: "PATCH",
      pattern: "/leagues/:leagueId/rounds/:roundId",
      handler: (req) => {
        const body = asRecord(req.body);
        return rounds.updateRound(deps, req.caller, req.params.leagueId!, req.params.roundId!, {
          status: asOptString(body.status) as never,
          theme: asOptString(body.theme),
          description: asOptString(body.description),
          submissionDeadline: asOptString(body.submissionDeadline),
          voteDeadline: asOptString(body.voteDeadline),
        });
      },
    },
    {
      method: "POST",
      pattern: "/rounds/:roundId/submission",
      handler: (req) => {
        const body = asRecord(req.body);
        return submissions.submitSong(deps, req.caller, req.params.roundId!, {
          track: body.track,
          comment: asOptString(body.comment),
        });
      },
    },
    {
      method: "GET",
      pattern: "/rounds/:roundId/submissions",
      handler: (req) => submissions.listVotableSubmissions(deps, req.caller, req.params.roundId!),
    },
    {
      method: "POST",
      pattern: "/rounds/:roundId/ballot",
      handler: (req) => {
        const body = asRecord(req.body);
        return voting.castBallot(deps, req.caller, req.params.roundId!, {
          allocations: body.allocations as Record<string, number>,
          comments: body.comments as Record<string, string> | undefined,
        });
      },
    },
    {
      method: "POST",
      pattern: "/rounds/:roundId/reveal",
      handler: (req) => voting.revealRound(deps, req.caller, req.params.roundId!),
    },
    {
      method: "GET",
      pattern: "/rounds/:roundId/results",
      handler: (req) => voting.getResults(deps, req.caller, req.params.roundId!),
    },
    {
      method: "GET",
      pattern: "/spotify/search",
      handler: (req) =>
        providers.searchSpotify(req.query.q ?? "", req.query.market ?? "", Number(req.query.limit) || 10),
    },
  ];
}

/** Match a method+path against the table, extracting path params. `/leagues/join`
 *  is registered before `/leagues/:leagueId` so the literal wins over the param. */
export function matchRoute(
  routes: Route[],
  method: string,
  path: string,
): { route: Route; params: Record<string, string> } | undefined {
  const segments = path.replace(/\/+$/, "").split("/").filter(Boolean);
  for (const route of routes) {
    if (route.method !== method) continue;
    const patternSegs = route.pattern.split("/").filter(Boolean);
    if (patternSegs.length !== segments.length) continue;

    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < patternSegs.length; i++) {
      const p = patternSegs[i]!;
      const s = segments[i]!;
      if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(s);
      else if (p !== s) { matched = false; break; }
    }
    if (matched) return { route, params };
  }
  return undefined;
}
