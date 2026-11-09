// What runs inside a computer's container: the same processes as a computer with no isolation,
// behind a port only the service can use.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Access, ApiError, ProcessRuntime } from "./runtime.ts";
import { digestOf, privateFolder, sameToken } from "./store.ts";

export const INNER_PORT = 8000;
export const INNER_TOKEN_VARIABLE = "AGENTCOMPUTER_INNER_TOKEN";
/** Where the image puts its browser. */
const BROWSER = "/opt/browsers/headless-shell";

export async function serveInside(options: { access: Access; browser: boolean }) {
  const token = process.env[INNER_TOKEN_VARIABLE];
  if (!token) throw new Error(`${INNER_TOKEN_VARIABLE} is not set.`);
  // What runs in here has no need of it.
  delete process.env[INNER_TOKEN_VARIABLE];
  const digest = digestOf(token);
  const running = new ProcessRuntime({ path: BROWSER, sandbox: false }).start(
    {
      id: "inside",
      ...options,
      ...(options.access === "none" ? {} : { workspace: "/workspace" }),
    },
    privateFolder(join(homedir(), ".agentcomputer")),
    {
      log: (line) => process.stdout.write(`${line}\n`),
      // The service sees the container end, and shows the computer as failed.
      failed: (reason) => {
        process.stderr.write(`${reason}\n`);
        process.exit(1);
      },
    },
  );

  const route = async (request: IncomingMessage, response: ServerResponse) => {
    const given = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1];
    if (!given || !sameToken(given, digest)) return void response.writeHead(401).end();
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (pathname === "/ready") {
      const { browserTools } = await running;
      response.writeHead(200, { "Content-Type": "application/json" });
      return void response.end(JSON.stringify({ browserTools }));
    }
    const endpoint = /^\/mcp\/(computer|browser)$/.exec(pathname)?.[1];
    if (!endpoint) return void response.writeHead(404).end();
    return (await running).handle(endpoint as "computer" | "browser", request, response);
  };
  createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      if (response.headersSent) return void response.destroy();
      response.writeHead(error instanceof ApiError ? error.status : 500).end();
    });
  }).listen(INNER_PORT, "0.0.0.0");

  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void running.then((computer) => computer.stop()).finally(() => process.exit(0));
    });
  await running;
}
