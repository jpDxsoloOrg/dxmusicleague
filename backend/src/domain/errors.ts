// Typed API errors. Handlers throw these; the HTTP adapters (Lambda + local
// server) catch them and turn them into `{ error }` JSON (see errorBody) with
// the right status. Anything else that escapes a handler becomes a 500.
//
// Isomorphic (no Node APIs): the frontend's ApiClient imports the
// already-member reader below, so both ends agree on that body's shape.

/** Machine-readable fields an error adds to its JSON body, beside `error`.
 *  Most errors have none and their body stays exactly `{ error }`. Clients
 *  branch on `code`, never on the message text (which is for people). */
export interface ApiErrorDetails {
  code: string;
  [field: string]: string | number | boolean;
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly details?: ApiErrorDetails;
  constructor(statusCode: number, message: string, details?: ApiErrorDetails) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const badRequest = (msg: string) => new ApiError(400, msg);
export const unauthorized = (msg = "Not signed in.") => new ApiError(401, msg);
export const forbidden = (msg = "You can't do that.") => new ApiError(403, msg);
export const notFound = (msg = "Not found.") => new ApiError(404, msg);
export const conflict = (msg: string, details?: ApiErrorDetails) => new ApiError(409, msg, details);

/** The JSON body both HTTP adapters send for an ApiError: `{ error }`, plus
 *  its details when it has any. `error` is spread last so a detail can never
 *  replace the message older clients show. */
export function errorBody(err: ApiError): { error: string; [field: string]: string | number | boolean } {
  return { ...err.details, error: err.message };
}

// ---- already a member (join by invite code) ----

/** `code` on joinLeague's "already a member" 409. The body also carries the
 *  `leagueId`, so a client re-opening an invite link for a league the caller
 *  is already in can open that league instead of showing a dead-end error
 *  (the caller is a member, so the id tells them nothing new). */
export const ALREADY_MEMBER_CODE = "already-member";

/** The invite path's already-member refusal. The message is unchanged from
 *  before the code existed, for clients that only read `error`. */
export function alreadyMember(league: { id: string; name: string }): ApiError {
  return conflict(`You're already a member of ${league.name}.`, { code: ALREADY_MEMBER_CODE, leagueId: league.id });
}

/** Client side: the league id an error body names when it is the
 *  already-member 409, else undefined (any other error, or a server that
 *  predates the code — the caller then shows `error` as before). */
export function alreadyMemberLeagueId(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { code, leagueId } = body as Record<string, unknown>;
  return code === ALREADY_MEMBER_CODE && typeof leagueId === "string" && leagueId ? leagueId : undefined;
}
