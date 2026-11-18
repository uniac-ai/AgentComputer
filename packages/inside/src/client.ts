// The client of what runs inside a computer's container: how the service reaches it on its port,
// with the token only the two of them hold. The server is `inside.ts`.
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";
import { ApiError } from "@agentorg/computer-base/error";
import { sendAnswer } from "@agentorg/computer-base/http";
import type { components } from "@agentorg/computer-contract/schema";

type SurfaceInfo = components["schemas"]["SurfaceInfo"];

export const INNER_PORT = 8000;
export const INNER_TOKEN_VARIABLE = "AGENTCOMPUTER_INNER_TOKEN";
/** Where the workspace is outside, and the machine's own name there: what a person reads. */
export const OUTSIDE_WORKSPACE_VARIABLE = "AGENTCOMPUTER_OUTSIDE_WORKSPACE";
export const OUTSIDE_MACHINE_VARIABLE = "AGENTCOMPUTER_OUTSIDE_MACHINE";

/** Not passed on: they describe this hop, or carry the client's token. */
const NOT_FORWARDED = new Set([
  "authorization",
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
]);

const UPGRADE_HEADERS = [
  "upgrade",
  "connection",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
];

/** What it answers once it is up. */
export interface Ready {
  browserTools: string[];
  surfaces: SurfaceInfo[];
  /** The program's version inside, which one made before 0.0.17 doesn't say. */
  version?: string;
}

/** Whether it is up: its answer once it is, or nothing while it isn't, within `ms`. */
export async function askReady(
  origin: string,
  authorization: string,
  ms: number,
): Promise<Ready | undefined> {
  const answer = await fetch(`${origin}/ready`, {
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(ms),
  });
  if (answer.ok) return (await answer.json()) as Ready;
}

/** Pass a WebSocket upgrade to what's inside, then the bytes both ways. */
export async function pipeUpgrade(
  port: number,
  authorization: string,
  surface: string,
  mode: string,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) {
  const upstream = connect(port, "127.0.0.1");
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
  socket.on("close", () => upstream.destroy());
  const lines = [
    `GET /live/${surface}?mode=${mode} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    `Authorization: ${authorization}`,
  ];
  for (const name of UPGRADE_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string") lines.push(`${name}: ${value}`);
  }
  upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
  if (head.length > 0) upstream.write(head);
  upstream.pipe(socket);
  socket.pipe(upstream);
}

export async function forward(
  origin: string,
  endpoint: string,
  authorization: string,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const headers = new Headers({ authorization });
  for (const [name, value] of Object.entries(request.headers))
    if (typeof value === "string" && !NOT_FORWARDED.has(name)) headers.set(name, value);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const aborted = new AbortController();
  response.once("close", () => aborted.abort());
  let upstream: Response;
  try {
    upstream = await fetch(`${origin}/mcp/${endpoint}`, {
      method: request.method as string,
      headers,
      signal: aborted.signal,
      ...(hasBody ? { body: Readable.toWeb(request) as never, duplex: "half" as const } : {}),
    } as RequestInit);
  } catch {
    throw new ApiError(502, "It has stopped working.");
  }
  sendAnswer(upstream, response);
}
