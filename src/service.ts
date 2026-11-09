// The service: the HTTP API and the MCP control tools, both driven by the table generated from
// openapi.yaml and answered by the same handlers, and each computer's endpoints, on one address.
import { rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { Computers } from "./computers.ts";
import { OPENAPI, OPERATIONS, type Operation } from "./generated/operations.ts";
import { createHandlers, VERSION } from "./handlers.ts";
import { ApiError, type Runtime } from "./runtime.ts";
import { controlToken, digestOf, privateFolder, sameToken, writePrivate } from "./store.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const MAX_BODY = 64 * 1024;

export interface ServeOptions {
  listen: string;
  data: string;
  runtime: Runtime;
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
  if (!LOOPBACK.has(host))
    throw new Error(
      "It listens on loopback only: anywhere else needs TLS, which this version lacks.",
    );
  const data = privateFolder(options.data);
  const control = digestOf(controlToken(data));
  let base = "";
  await options.runtime.prepare();
  const computers = new Computers(data, () => base, options.runtime);
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
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response);
  };

  const route = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const { pathname } = url;
    if (pathname === "/openapi.json") return send(response, 200, OPENAPI);
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

  const server = createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      if (response.headersSent) return void response.destroy();
      if (error instanceof ApiError) return send(response, error.status, failure(error));
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      send(response, 500, { code: 500, message: "That didn't work." });
    });
  });
  await new Promise<void>((done, failed) => {
    server.once("error", failed);
    server.listen(port, host, done);
  });
  const bound = server.address() as AddressInfo;
  base = `http://${bound.family === "IPv6" ? `[${bound.address}]` : bound.address}:${bound.port}`;
  await computers.resume();
  const record = join(data, "server.json");
  writePrivate(
    record,
    JSON.stringify({ url: base, pid: process.pid, isolation: options.runtime.isolation }),
  );
  process.stdout.write(`AgentComputer on ${base}, data in ${data}\n`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await computers.close();
    rmSync(record, { force: true });
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void stop());
}
