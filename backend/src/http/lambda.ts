// Lambda adapter — the production front door. API Gateway (REST, proxy
// integration) invokes this with the Cognito-authorized request; it runs the
// same route table the local server does, but against the DynamoRepository.
// The caller id is the JWT `sub` the Cognito authorizer puts on the request
// context — never read from the body (docs/data-model-and-api.md §Principles).

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ApiError } from "../domain/errors.ts";
import { DynamoRepository } from "../data/dynamo.ts";
import { CognitoUserDirectory } from "../data/users.ts";
import { buildRoutes, matchRoute } from "./routes.ts";

// Built once per cold start and reused across invocations.
const deps = {
  repo: new DynamoRepository(process.env.TABLE_NAME ?? "MusicLeague"),
  users: new CognitoUserDirectory(),
};
const routes = buildRoutes(deps);

const json = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    // Browser clients call this cross-origin; the API GW preflight (OPTIONS) is
    // handled by CORS config, but the actual responses must carry the header too.
    "Access-Control-Allow-Origin": "*",
  },
  body: JSON.stringify(body),
});

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod;
  const path = event.path;

  const match = matchRoute(routes, method, path);
  if (!match) return json(404, { error: `No route for ${method} ${path}` });

  // Cognito authorizer surfaces the JWT claims here. `sub` is the stable user id.
  const caller = event.requestContext?.authorizer?.claims?.sub as string | undefined;
  if (!caller) return json(401, { error: "Not signed in." });

  let body: unknown;
  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch {
      return json(400, { error: "Request body is not valid JSON." });
    }
  }

  try {
    const result = await match.route.handler({
      caller,
      params: match.params,
      query: (event.queryStringParameters ?? {}) as Record<string, string>,
      body,
    });
    return json(200, result ?? null);
  } catch (err) {
    if (err instanceof ApiError) return json(err.statusCode, { error: err.message });
    console.error("Unhandled error:", err);
    return json(500, { error: "Something went wrong." });
  }
}
