// Typed API errors. Handlers throw these; the HTTP adapters (Lambda + local
// server) catch them and turn them into `{ error }` JSON with the right status.
// Anything else that escapes a handler becomes a 500.

export class ApiError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
  }
}

export const badRequest = (msg: string) => new ApiError(400, msg);
export const unauthorized = (msg = "Not signed in.") => new ApiError(401, msg);
export const forbidden = (msg = "You can't do that.") => new ApiError(403, msg);
export const notFound = (msg = "Not found.") => new ApiError(404, msg);
export const conflict = (msg: string) => new ApiError(409, msg);
