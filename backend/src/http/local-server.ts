// Local dev server — runs the exact same routes the Lambda will, but over a
// plain Node http listener against the in-memory MemoryRepository. No AWS, no
// Cognito: the caller id is stubbed from an `x-dev-user` header (default
// "u-me", the seed "current user"), so you can develop the whole app offline.
//
//   cd backend && npm run dev      → http://127.0.0.1:8787
//
// Point the frontend's API client at this base URL during local development.

import { createServer } from "node:http";
import { ApiError } from "../domain/errors.ts";
import { MemoryRepository, MemoryUserDirectory } from "../data/memory.ts";
import { buildRoutes, matchRoute } from "./routes.ts";

const PORT = Number(process.env.PORT ?? 8787);
const DEFAULT_DEV_USER = "u-me";

const deps = { repo: new MemoryRepository(), users: new MemoryUserDirectory() };
const routes = buildRoutes(deps);

function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ApiError(400, "Request body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  // CORS so the Vite dev server (a different port) can call us.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-dev-user");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  try {
    const match = matchRoute(routes, req.method ?? "GET", url.pathname);
    if (!match) return send(404, { error: `No route for ${req.method} ${url.pathname}` });

    const caller = (req.headers["x-dev-user"] as string) || DEFAULT_DEV_USER;
    const query = Object.fromEntries(url.searchParams.entries());
    const body = await readBody(req);

    const result = await match.route.handler({ caller, params: match.params, query, body });
    send(200, result ?? null);
  } catch (err) {
    if (err instanceof ApiError) return send(err.statusCode, { error: err.message });
    console.error("Unhandled error:", err);
    send(500, { error: "Something went wrong." });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`DX Music League API (local, in-memory) → http://127.0.0.1:${PORT}`);
  console.log(`Dev auth: send 'x-dev-user: <id>' to act as another seed user (default ${DEFAULT_DEV_USER}).`);
});
