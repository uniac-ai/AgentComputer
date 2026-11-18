// Answering HTTP for the service's pieces: a refusal an agent reads as a tool's answer, a body
// that isn't one request refused, an answer passed on from the server it came from, and a
// request read whole as one JSON-RPC request.
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline, Readable } from "node:stream";

const ONE_REQUEST =
  "A body is one JSON-RPC request, as a JSON object: send each request in its own POST.";

/**
 * Answer a tool's call with a refusal the agent reads, as the tool's own answer; a call sent as a
 * notification is answered with nothing, as one that runs is.
 */
export function refuseCall(response: ServerResponse, id: unknown, words: string) {
  if (id === undefined) return void response.writeHead(202).end();
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: id ?? null,
      result: { content: [{ type: "text", text: words }], isError: true },
    }),
  );
}

/** Refuse a body that isn't one JSON-RPC request, as a JSON object. */
export function refuseBody(response: ServerResponse) {
  response.writeHead(400, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: ONE_REQUEST } }),
  );
}

/** Give a client what the server answered, however it ends. */
export function sendAnswer(upstream: Response, response: ServerResponse) {
  const answer: Record<string, string> = {};
  for (const name of ["content-type", "mcp-session-id", "cache-control"]) {
    const value = upstream.headers.get(name);
    if (value) answer[name] = value;
  }
  response.writeHead(upstream.status, answer);
  if (!upstream.body) return void response.end();
  pipeline(Readable.fromWeb(upstream.body as never), response, () => {});
}

/** One JSON-RPC request, as far as what refuses it reads it. */
export type Message = {
  id?: unknown;
  method?: string;
  params?: { name?: unknown; arguments?: Record<string, unknown> };
};

/**
 * Read an MCP request's body whole, as one request: the request in it, none for an empty body.
 * One too large, or that isn't one request, is answered here, and gives nothing: a batch, or a
 * body a server can read and this can't, would carry a call past every check made on it.
 */
export async function readRequest(
  request: IncomingMessage,
  response: ServerResponse,
  max: number,
): Promise<{ message?: Message } | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > max) return void response.writeHead(413).end();
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);
  if (body.length === 0) return {};
  try {
    const read: unknown = JSON.parse(body.toString("utf8"));
    if (typeof read === "object" && read !== null && !Array.isArray(read)) return { message: read };
  } catch {
    // Refused below, with whatever else isn't one request.
  }
  refuseBody(response);
}
