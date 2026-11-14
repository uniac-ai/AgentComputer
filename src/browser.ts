// A computer's browser: a host process that starts it and shares it on a Unix socket, and
// Playwright MCP attached to that socket and serving on a second Unix socket, proxied under the
// computer's path, so one address and one token cover both of its endpoints.
import { type ChildProcess, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { request as ask, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { pipeline, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { CONNECT_VARIABLE } from "./browser-host.ts";
import { DEFAULT_CHANNEL } from "./playwright.ts";

/** Its own README calls this equivalent to remote code execution. */
const RUNS_CODE = "browser_run_code_unsafe";
const SCREENSHOT = "browser_take_screenshot";
const MIB = 1024 * 1024;
const MAX_BODY = 8 * MIB;
// The most a screenshot may be and still be passed on: what `read` takes for a picture.
const MAX_PICTURE = 3 * MIB;
const START_MS = 30_000;
/** The person's own browser waits on them to allow the connection. */
const OWN_START_MS = 120_000;
const STOP_MS = 2_000;
const ONE_REQUEST =
  "A body is one JSON-RPC request, as a JSON object: send each request in its own POST.";
/** What passes between a client and the browser's server, in both directions. */
const FORWARDED = [
  "accept",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
];

export interface BrowserConfig {
  /** Playwright's browser channel when no program is named: by default the person's Chrome. */
  browser?: string | undefined;
  /** A browser program to use in place of an installed one. */
  path?: string | undefined;
  /** False where the browser can't have its own sandbox, as in a container without privileges. */
  sandbox?: boolean | undefined;
  /** Where the person's own browser is reached: it is theirs, connected to, never started here. */
  connect?: string | undefined;
}

/** What the proxy asks of the live view, where a person may answer what a page asks. */
export interface BrowserGate {
  /** Whether this session of the agent's may still wait on a file chooser a person answered. */
  takeAnsweredChooser(session: string): boolean;
  /** The agent answered a file chooser itself. */
  agentAnsweredChooser(): void;
  /** A session of the agent's has ended. */
  sessionEnded(session: string): void;
}

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

/**
 * `fetch`, to a server on a Unix socket: the browser's MCP server, which has no port. Only the
 * URL's path and query are used. Its body is text or bytes, the only kinds sent to it. It answers
 * once the headers come, with the body streamed; it follows no redirect and has no time limit.
 */
export function socketFetch(socket: string) {
  return (url: string | URL, init: RequestInit = {}) =>
    new Promise<Response>((done, failed) => {
      const { body } = init;
      if (body != null && typeof body !== "string" && !(body instanceof Uint8Array))
        return failed(new TypeError("A body to the browser's server is text or bytes."));
      const { pathname, search } = new URL(url);
      const headers = Object.fromEntries(new Headers(init.headers));
      if (body != null) headers["content-length"] = String(Buffer.byteLength(body));
      const sent = ask(
        {
          socketPath: socket,
          path: pathname + search,
          method: init.method ?? "GET",
          headers,
          signal: init.signal ?? undefined,
        },
        (answer) => {
          const answered = new Headers();
          for (const [name, value] of Object.entries(answer.headers))
            for (const one of [value ?? []].flat()) answered.append(name, one);
          const status = answer.statusCode ?? 502;
          // A Response can't be given a body with one of these.
          const none = [204, 205, 304].includes(status);
          if (none) answer.resume();
          done(
            new Response(none ? null : (Readable.toWeb(answer) as ReadableStream), {
              status,
              headers: answered,
            }),
          );
        },
      );
      sent.on("error", failed);
      sent.end(body ?? undefined);
    });
}

/** The browser's MCP server, as its socket is asked for it. */
const MCP = "http://localhost/mcp";

/** This program, which also runs the browser host and the browser's MCP server. */
const self = fileURLToPath(import.meta.url);

type Message = { id?: unknown; method?: string; params?: { name?: unknown } };

type Answer = {
  result?: {
    tools?: { name: string }[];
    content?: { type: string; data?: string; text?: string }[];
    isError?: boolean;
  };
};

/** Change each message of an answer, whichever way it was sent. */
export function changed(text: string, change: (message: Answer) => void): string {
  const one = (json: string) => {
    const message = JSON.parse(json) as Answer;
    change(message);
    return JSON.stringify(message);
  };
  if (text.trimStart().startsWith("{")) return one(text);
  return text.replace(/^data: (\{[^\n\r]*\})$/gm, (_, json: string) => `data: ${one(json)}`);
}

/** Drop the hidden tools from a `tools/list` answer. */
const withoutHidden = (hidden: ReadonlySet<string>) => (message: Answer) => {
  if (message.result?.tools)
    message.result.tools = message.result.tools.filter((tool) => !hidden.has(tool.name));
};

/**
 * In place of a screenshot too large to pass on, say how to take a smaller one. The most is in
 * bytes, the same as for a picture that `read` answers; nothing here looks at its width or height.
 */
export function withoutLarge(message: Answer) {
  const sizes = (message.result?.content ?? []).map((block) =>
    block.type === "image" ? Buffer.byteLength(block.data ?? "", "base64") : 0,
  );
  const size = Math.max(0, ...sizes);
  if (size <= MAX_PICTURE) return;
  // Rounded up, so that one just over the most never reads as being it.
  const text =
    `The screenshot is ${(Math.ceil((size / MIB) * 10) / 10).toFixed(1)} MiB, and the most a ` +
    `screenshot may be is ${MAX_PICTURE / MIB} MiB. Take it again without fullPage for what is ` +
    "on screen, or with element and target for one part of the page.";
  message.result = { isError: true, content: [{ type: "text", text }] };
}

/** Ask a process to stop, then make it. */
async function end(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), STOP_MS);
  await gone;
  clearTimeout(timer);
}

export class Browser {
  readonly #host: ChildProcess;
  #mcp: ChildProcess | undefined;
  /** Where its server answers, by way of its Unix socket. */
  readonly #served: Promise<ReturnType<typeof socketFetch>>;
  /** The folder its server made for its socket. */
  #socketFolder: string | undefined;
  /** The bound browser's socket, for the live viewer. */
  readonly endpoint: Promise<string>;
  readonly #hidden: ReadonlySet<string>;
  readonly #startMs: number;
  #stopping = false;
  /** The tools it offers, read once it is up. */
  tools: string[] = [];
  gate: BrowserGate | undefined;
  /**
   * The line to add to the answer to each of the agent's calls, asked as an answer that can carry
   * it comes: one that fails leaves it for the next.
   */
  noted: (() => string | undefined) | undefined;
  /** Why a tool isn't answered now: the person has switched off what it uses. */
  refused: ((tool: string) => string | undefined) | undefined;

  constructor(
    config: BrowserConfig,
    folder: string,
    cwd: string,
    terminal: boolean,
    log: (line: string) => void,
    exited: () => void,
  ) {
    this.#hidden = new Set(terminal ? [] : [RUNS_CODE]);
    this.#startMs = config.connect ? OWN_START_MS : START_MS;
    const ended = (what: string) => (code: number | null) => {
      if (!this.#stopping) {
        log(`${what} exited with ${code}.`);
        exited();
      }
    };
    this.#host = spawn(
      process.execPath,
      [
        self,
        "browser-host",
        "--profile",
        join(folder, "profile"),
        ...(config.path
          ? ["--executable", config.path]
          : ["--channel", config.browser ?? DEFAULT_CHANNEL]),
        ...(config.sandbox === false ? ["--no-sandbox"] : []),
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: config.connect ? { ...process.env, [CONNECT_VARIABLE]: config.connect } : process.env,
      },
    );
    this.endpoint = new Promise((done, failed) => {
      this.#host.on("error", failed);
      this.#host.once("exit", (code) => failed(new Error(`The browser exited with ${code}.`)));
      this.#host.once("exit", ended("The browser"));
      createInterface({ input: this.#host.stdout as NodeJS.ReadableStream }).on("line", (line) => {
        try {
          const { endpoint } = JSON.parse(line) as { endpoint: string };
          log(`The browser is shared on ${endpoint}.`);
          done(endpoint);
        } catch {
          log(line);
        }
      });
      createInterface({ input: this.#host.stderr as NodeJS.ReadableStream }).on("line", log);
    });
    this.endpoint.catch(() => {});
    this.#served = this.endpoint.then(
      (endpoint) =>
        new Promise<ReturnType<typeof socketFetch>>((done, failed) => {
          if (this.#stopping) return failed(new Error("It stopped."));
          const mcp = spawn(
            process.execPath,
            [
              self,
              "browser-mcp",
              "--endpoint",
              endpoint,
              "--output",
              join(folder, "output"),
              ...(config.connect ? ["--own"] : []),
            ],
            // Its own limit on which files it touches is the folder it starts in. For the person's
            // browser, no setting of theirs for Playwright MCP reaches it: one could route or
            // script every tab they have.
            {
              cwd,
              stdio: ["ignore", "pipe", "pipe"],
              env: config.connect
                ? Object.fromEntries(
                    Object.entries(process.env).filter(
                      ([name]) => !name.startsWith("PLAYWRIGHT_MCP_"),
                    ),
                  )
                : process.env,
            },
          );
          this.#mcp = mcp;
          mcp.on("error", failed);
          mcp.once("exit", (code) =>
            failed(new Error(`The browser's server exited with ${code}.`)),
          );
          mcp.once("exit", ended("The browser's server"));
          createInterface({ input: mcp.stdout as NodeJS.ReadableStream }).on("line", (line) => {
            try {
              const { socket } = JSON.parse(line) as { socket: string };
              log(`The browser's server is on ${socket}.`);
              this.#socketFolder = dirname(socket);
              done(socketFetch(socket));
            } catch {
              log(line);
            }
          });
          createInterface({ input: mcp.stderr as NodeJS.ReadableStream }).on("line", log);
        }),
    );
    this.#served.catch(() => {});
  }

  /** Wait until it answers, and read its tools. */
  async ready() {
    const served = await Promise.race([
      this.#served,
      new Promise<never>((_, failed) =>
        setTimeout(() => failed(new Error("The browser's server didn't start.")), this.#startMs),
      ),
    ]);
    const client = new Client({ name: "agentcomputer", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(MCP), { fetch: served }));
    const { tools } = await client.listTools();
    await client.close();
    this.tools = tools.map((tool) => tool.name).filter((name) => !this.#hidden.has(name));
  }

  /** Answer one MCP request by passing it on, enforcing what this computer may not do. */
  async handle(request: IncomingMessage, response: ServerResponse) {
    const served = await this.#served;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) return void response.writeHead(413).end();
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);
    // Only what is read here as one request is passed on, and as it was read. A batch, or a body
    // the browser's server can read and this can't, would carry a call by every check made below.
    let message: Message | undefined;
    try {
      const read: unknown = body.length > 0 ? JSON.parse(body.toString("utf8")) : undefined;
      if (typeof read === "object" && read !== null && !Array.isArray(read)) message = read;
    } catch {
      // Refused with whatever else isn't one request.
    }
    if (body.length > 0 && !message) return refuseBody(response);
    const tool = message?.method === "tools/call" ? String(message.params?.name) : undefined;
    const refusal = tool ? this.refused?.(tool) : undefined;
    if (refusal) return refuseCall(response, message?.id, refusal);
    if (tool && this.#hidden.has(tool)) {
      response.writeHead(200, { "Content-Type": "application/json" });
      return void response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message?.id ?? null,
          error: { code: -32602, message: `Unknown tool: ${tool}` },
        }),
      );
    }
    const headers: Record<string, string> = {};
    for (const name of FORWARDED) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const session = headers["mcp-session-id"] ?? "";
    if (request.method === "DELETE") this.gate?.sessionEnded(session);
    // A person answered a file chooser the agent's session may still wait on: close it there
    // first, which leaves what the person chose in place. Not before a call that answers a chooser
    // itself, which may be one of the agent's own.
    if (tool && this.gate?.takeAnsweredChooser(session) && tool !== "browser_file_upload")
      await served(MCP, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "agentcomputer-answered",
          method: "tools/call",
          params: { name: "browser_file_upload", arguments: {} },
        }),
      })
        .then((answer) => answer.text())
        .catch(() => {});
    if (tool === "browser_file_upload") this.gate?.agentAnsweredChooser();
    if (message) headers["content-type"] = "application/json";
    const upstream = await served(MCP, {
      method: request.method as string,
      headers,
      ...(message ? { body: JSON.stringify(message) } : {}),
    });
    let change: ((answer: Answer) => void) | undefined;
    if (message?.method === "tools/list" && this.#hidden.size > 0)
      change = withoutHidden(this.#hidden);
    else if (tool === SCREENSHOT) change = withoutLarge;
    const { noted } = this;
    if (tool && noted) {
      const before = change;
      change = (answer) => {
        before?.(answer);
        const content = answer.result?.content;
        const line = content && noted();
        if (line) content.push({ type: "text", text: line });
      };
    }
    // Every other answer goes on as it comes; these are read whole first.
    if (!change) return sendAnswer(upstream, response);
    sendAnswer(new Response(changed(await upstream.text(), change), upstream), response);
  }

  async stop() {
    this.#stopping = true;
    await Promise.all([this.#mcp, this.#host].map((child) => (child ? end(child) : undefined)));
    // Its server removes it as it exits, unless it had to be killed first.
    if (this.#socketFolder) rmSync(this.#socketFolder, { recursive: true, force: true });
  }
}
