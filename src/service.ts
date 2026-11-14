// The service: the HTTP API and the MCP control tools, both driven by the table generated from
// openapi.yaml and answered by the same handlers, and each computer's endpoints, on one address.
import { readFileSync, rmSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
  STATUS_CODES,
} from "node:http";
import { createServer as createTlsServer } from "node:https";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { Computers } from "./computers.ts";
import { OPENAPI, OPERATIONS, type Operation } from "./generated/operations.ts";
import { createHandlers, VERSION } from "./handlers.ts";
import { recordOf, running } from "./running.ts";
import { ApiError, type Isolation, type Runtime } from "./runtime.ts";
import { controlToken, digestOf, privateFolder, sameToken, writePrivate } from "./store.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const WILDCARD = new Set(["0.0.0.0", "::"]);
const MAX_BODY = 64 * 1024;

export interface ServeOptions {
  listen: string;
  data: string;
  /** How this computer is run, as `none`, and how a computer is made in each isolation. */
  runtimes: Record<Isolation, Runtime>;
  /** Files holding the certificate and its key, to terminate TLS here. */
  tls?: { cert: string; key: string } | undefined;
  /** A proxy in front of the service terminates TLS, so it may listen in the clear. */
  tlsProxy?: boolean | undefined;
  /** The address clients reach it at, when that isn't the one it listens on. */
  publicUrl?: string | undefined;
  /** Browser origins a live session may be opened from. None by default. */
  allowOrigins?: string[] | undefined;
}

/** Why a service that other machines can reach doesn't offer this computer. */
export const NOT_HERE =
  "This service can be reached from other machines, so it doesn't offer the machine it runs on. Make a computer in a container, or attach this computer through a service that only this machine reaches.";

/**
 * Whether only this machine reaches the service: it listens on loopback, with no proxy in front
 * and no other address given out. Only such a service offers this computer: one that other
 * machines reach is a server, and its machine no one's to attach.
 */
export const onlyThisMachine = (
  host: string,
  options: Pick<ServeOptions, "tlsProxy" | "publicUrl">,
) => LOOPBACK.has(host) && !options.tlsProxy && !options.publicUrl;

/** Refuse what would send tokens in the clear or give clients an address they can't use. */
function checkExposure(host: string, options: ServeOptions) {
  const { tls, tlsProxy, publicUrl } = options;
  if (tls && tlsProxy) throw new Error("--tls-cert and --tls-proxy are alternatives.");
  if (!LOOPBACK.has(host) && !tls && !tlsProxy)
    throw new Error(
      "Anywhere but loopback it needs TLS: --tls-cert and --tls-key, or --tls-proxy if a proxy in front of it does that.",
    );
  if (!publicUrl && tlsProxy) throw new Error("--tls-proxy needs --public-url.");
  if (!publicUrl && WILDCARD.has(host))
    throw new Error(`Listening on ${host} needs --public-url, the address clients reach it at.`);
  if (publicUrl && !LOOPBACK.has(host) && new URL(publicUrl).protocol !== "https:")
    throw new Error("--public-url has to be https when it listens beyond loopback.");
}

/** `host:port`, or `[v6]:port`. */
function parseListen(listen: string) {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(listen);
  if (!match) throw new Error("--listen takes host:port.");
  return { host: (match[1] ?? match[2]) as string, port: Number(match[3]) };
}

const bearerOf = (request: IncomingMessage) =>
  /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1];

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of request) {
    text += String(chunk);
    if (text.length > MAX_BODY) throw new ApiError(413, "That request is too large.");
  }
  try {
    const parsed: unknown = JSON.parse(text || "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // Refused below.
  }
  throw new ApiError(400, "The body is a JSON object.");
}

const send = (response: ServerResponse, status: number, body: unknown) => {
  if (body === undefined) return void response.writeHead(status).end();
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(`${JSON.stringify(body)}\n`);
};
const failure = (error: ApiError) => ({ code: error.status, message: error.message });

export async function serve(options: ServeOptions) {
  const { host, port } = parseListen(options.listen);
  checkExposure(host, options);
  const data = privateFolder(options.data);
  const control = digestOf(controlToken(data));
  // Two services would each take the one folder's computers for their own.
  const live = await running(data);
  if (live)
    throw new Error(`A service is already running with its data in ${data}, at ${live.url}.`);
  let base = "";
  const computers = new Computers(
    data,
    () => base,
    options.runtimes,
    onlyThisMachine(host, options) ? undefined : NOT_HERE,
  );
  const handlers = createHandlers(computers) as unknown as Record<
    string,
    (input: unknown) => Promise<unknown>
  >;
  const routes = OPERATIONS.map((operation) => ({
    operation,
    pattern: new RegExp(`^${operation.path.replace(/\{[^}]+\}/g, "([^/]+)")}$`),
    check: fromJsonSchema(operation.input as never),
  }));

  /** One operation, however it arrived: its input is checked, then its handler answers. */
  const run = async (route: (typeof routes)[number], input: Record<string, unknown>) => {
    const checked = await route.check["~standard"].validate(input);
    if (checked.issues)
      throw new ApiError(400, checked.issues.map((issue) => issue.message).join("; "));
    return handlers[(route.operation as Operation).operationId]?.(input);
  };

  /** The control operations as MCP tools, one server per request, as the stateless form is. */
  const controlMcp = async (request: IncomingMessage, response: ServerResponse) => {
    const server = new McpServer({ name: "agentcomputer", version: VERSION });
    for (const route of routes)
      if (route.operation.tool)
        server.registerTool(
          route.operation.tool,
          { description: route.operation.summary, inputSchema: route.check },
          async (input: unknown) => {
            try {
              const output = (await run(route, input as Record<string, unknown>)) ?? {};
              return { content: [{ type: "text", text: JSON.stringify(output) }] };
            } catch (error) {
              if (!(error instanceof ApiError)) throw error;
              return {
                isError: true,
                content: [{ type: "text", text: JSON.stringify(failure(error)) }],
              };
            }
          },
        );
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.once("close", () => {
      Promise.all([transport.close(), server.close()]).catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(request, response);
  };

  const route = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const { pathname } = url;
    if (pathname === "/openapi.json") return send(response, 200, OPENAPI);
    if (pathname.startsWith("/v1/live/")) throw new ApiError(426, "Open it as a WebSocket.");
    // A computer's own endpoints take its own token and nothing else.
    const endpoint = /^\/v1\/computers\/([^/]+)\/mcp\/(computer|browser)$/.exec(pathname);
    if (endpoint)
      return computers.serve(
        endpoint[1] as string,
        endpoint[2] as "computer" | "browser",
        bearerOf(request),
        request,
        response,
      );
    const token = bearerOf(request);
    if (!token || !sameToken(token, control))
      return void response.writeHead(401, { "WWW-Authenticate": "Bearer" }).end();
    if (pathname === "/v1/mcp") return controlMcp(request, response);
    let pathMatched = false;
    for (const candidate of routes) {
      const match = candidate.pattern.exec(pathname);
      if (!match) continue;
      pathMatched = true;
      if (candidate.operation.method !== request.method) continue;
      const { operation } = candidate;
      const input: Record<string, unknown> = operation.hasBody ? await jsonBody(request) : {};
      operation.pathParameters.forEach((name, i) => {
        input[name] = decodeURIComponent(match[i + 1] as string);
      });
      for (const name of operation.queryParameters) {
        const value = url.searchParams.get(name);
        if (value !== null) input[name] = value;
      }
      return send(response, operation.status, await run(candidate, input));
    }
    throw pathMatched ? new ApiError(405, "Not allowed.") : new ApiError(404, "Not found.");
  };

  const listener: RequestListener = (request, response) => {
    route(request, response).catch((error: unknown) => {
      if (response.headersSent) return void response.destroy();
      if (error instanceof ApiError) return send(response, error.status, failure(error));
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      send(response, 500, { code: 500, message: "That didn't work." });
    });
  };
  const server = options.tls
    ? createTlsServer(
        { cert: readFileSync(options.tls.cert), key: readFileSync(options.tls.key) },
        listener,
      )
    : createServer(listener);
  const allowed = new Set(options.allowOrigins ?? []);
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const refuse = (status: number, message: string) =>
      socket.end(
        `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${JSON.stringify({ code: status, message })}\n`,
      );
    // URL.parse, not new URL: a throw in this handler ends the service. A ticket is base64url,
    // so it is looked up as it comes, not decoded.
    const pathname = URL.parse(request.url ?? "/", "http://localhost")?.pathname ?? "";
    const ticket = /^\/v1\/live\/([^/]+)$/.exec(pathname)?.[1];
    if (!ticket) return refuse(404, "Not found.");
    // A browser doesn't keep a page's WebSockets to its own origin, so the origin is checked here.
    const origin = request.headers.origin;
    if (origin !== undefined && !allowed.has(origin))
      return refuse(403, `A live session isn't opened from ${origin.slice(0, 200)}.`);
    computers.openLive(ticket, request, socket, head).catch((error: unknown) => {
      if (error instanceof ApiError) refuse(error.status, error.message);
      else socket.destroy();
    });
  });
  await new Promise<void>((done, failed) => {
    server.once("error", failed);
    server.listen(port, host, done);
  });
  const bound = server.address() as AddressInfo;
  const scheme = options.tls ? "https" : "http";
  base =
    options.publicUrl?.replace(/\/+$/, "") ??
    `${scheme}://${bound.family === "IPv6" ? `[${bound.address}]` : bound.address}:${bound.port}`;
  // What one that crashed left names nothing, and at this address would be taken for this one.
  const record = recordOf(data);
  rmSync(record, { force: true });
  await computers.resume();
  writePrivate(record, JSON.stringify({ url: base, pid: process.pid }));
  process.stdout.write(`AgentComputer on ${base}, data in ${data}\n`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await computers.close().catch((error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
    });
    rmSync(record, { force: true });
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void stop());
}
