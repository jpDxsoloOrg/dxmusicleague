// The route table — transport-agnostic. Maps METHOD + path pattern to a
// handler that takes a normalized request and returns a plain value (serialized
// as JSON by whichever adapter is in front: Lambda or the local dev server).
// Adding an endpoint = one entry here; both adapters pick it up for free.

import type { Deps } from "../handlers/leagues.ts";
import * as leagues from "../handlers/leagues.ts";

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
      method: "GET",
      pattern: "/leagues/:leagueId",
      handler: (req) => leagues.getLeagueDetail(deps, req.caller, req.params.leagueId!),
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
