// What runs inside a computer's container: the same processes as a computer with no isolation,
// behind a port only the service can use.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { VERSION } from "./handlers.ts";
import type { Surface } from "./live.ts";
import { type Access, ApiError, ProcessRuntime } from "./runtime.ts";
import { digestOf, privateFolder, sameToken } from "./store.ts";

export const INNER_PORT = 8000;
export const INNER_TOKEN_VARIABLE = "AGENTCOMPUTER_INNER_TOKEN";
/** Where the workspace is outside, and the machine's own name there: what a person reads. */
export const OUTSIDE_WORKSPACE_VARIABLE = "AGENTCOMPUTER_OUTSIDE_WORKSPACE";
export const OUTSIDE_MACHINE_VARIABLE = "AGENTCOMPUTER_OUTSIDE_MACHINE";
/** Where the image puts its browser. */
const BROWSER = "/opt/browsers/headless-shell";

export async function serveInside(options: { access: Access; browser: boolean }) {
  const token = process.env[INNER_TOKEN_VARIABLE];
  if (!token) throw new Error(`${INNER_TOKEN_VARIABLE} is not set.`);
  // What runs in here has no need of it.
  delete process.env[INNER_TOKEN_VARIABLE];
  const digest = digestOf(token);
  const running = new ProcessRuntime({ path: BROWSER, sandbox: false }, true).start(
    {
      id: "inside",
      ...options,
      ...(options.access === "none" ? {} : { workspace: "/workspace" }),
      outside: {
        workspace: process.env[OUTSIDE_WORKSPACE_VARIABLE],
        machine: process.env[OUTSIDE_MACHINE_VARIABLE],
      },
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
      const { browserTools, surfaces } = await running;
      response.writeHead(200, { "Content-Type": "application/json" });
      return void response.end(JSON.stringify({ browserTools, surfaces, version: VERSION }));
    }
    const endpoint = /^\/mcp\/(computer|browser)$/.exec(pathname)?.[1];
    if (!endpoint) return void response.writeHead(404).end();
    return (await running).handle(endpoint as "computer" | "browser", request, response);
  };
  const server = createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      if (response.headersSent) return void response.destroy();
      response.writeHead(error instanceof ApiError ? error.status : 500).end();
    });
  });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const given = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1];
    // URL.parse gives null for an address it can't read; a throw in this handler would end the
    // process.
    const url = URL.parse(request.url ?? "/", "http://localhost");
    const surface = /^\/live\/(terminal|files|browser|load)$/.exec(url?.pathname ?? "")?.[1];
    const mode = url?.searchParams.get("mode");
    if (!given || !sameToken(given, digest) || !surface || (mode !== "watch" && mode !== "operate"))
      return void socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    running
      .then((computer) => computer.openLive(surface as Surface, mode, request, socket, head))
      .catch(() => socket.destroy());
  });
  server.listen(INNER_PORT, "0.0.0.0");

  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void running.then((computer) => computer.stop()).finally(() => process.exit(0));
    });
  await running;
}
