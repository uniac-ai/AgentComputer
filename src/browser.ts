// A computer's browser: Playwright MCP on a loopback port of its own, proxied under the computer's
// path, so one address and one token cover both of its endpoints.
import { type ChildProcess, spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

/** Its own README calls this equivalent to remote code execution. */
const RUNS_CODE = "browser_run_code_unsafe";
const MAX_BODY = 8 * 1024 * 1024;
const START_MS = 30_000;
const STOP_MS = 2_000;
/** What passes between a client and the browser's server, in both directions. */
const FORWARDED = [
  "accept",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
];

export interface BrowserConfig {
  /** Playwright MCP's program; the installed dependency by default. */
  cli?: string | undefined;
  /** Which browser: Playwright's `--browser`, by default the person's Chrome. */
  browser?: string | undefined;
  /** A browser program to use in place of an installed one. */
  path?: string | undefined;
}

const defaultCli = () =>
  join(dirname(createRequire(import.meta.url).resolve("@playwright/mcp/package.json")), "cli.js");

type Message = { id?: unknown; method?: string; params?: { name?: unknown } };

/** Drop a hidden tool from a `tools/list` answer, whichever way it was sent. */
function withoutHidden(text: string, hidden: ReadonlySet<string>): string {
  const clean = (json: string) => {
    const message = JSON.parse(json) as { result?: { tools?: { name: string }[] } };
    if (message.result?.tools)
      message.result.tools = message.result.tools.filter((tool) => !hidden.has(tool.name));
    return JSON.stringify(message);
  };
  if (text.trimStart().startsWith("{")) return clean(text);
  return text.replace(/^data: (\{.*\})$/gm, (_, json: string) => `data: ${clean(json)}`);
}

export class Browser {
  readonly #child: ChildProcess;
  readonly #origin: Promise<string>;
  readonly #hidden: ReadonlySet<string>;
  #exited = false;
  #stopping = false;
  /** The tools it offers, read once it is up. */
  tools: string[] = [];

  constructor(
    config: BrowserConfig,
    folder: string,
    cwd: string,
    terminal: boolean,
    log: (line: string) => void,
    exited: () => void,
  ) {
    this.#hidden = new Set(terminal ? [] : [RUNS_CODE]);
    this.#child = spawn(
      process.execPath,
      [
        config.cli ?? defaultCli(),
        "--headless",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        ...(config.path
          ? ["--browser", config.browser ?? "chromium", "--executable-path", config.path]
          : ["--browser", config.browser ?? "chrome"]),
        "--user-data-dir",
        join(folder, "profile"),
        "--output-dir",
        join(folder, "output"),
      ],
      // Its own limit on which files it touches is the folder it starts in.
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
    this.#origin = new Promise((done, failed) => {
      this.#child.once("error", failed);
      this.#child.once("exit", (code) => {
        this.#exited = true;
        failed(new Error(`The browser's server exited with ${code}.`));
        if (!this.#stopping) exited();
      });
      for (const stream of [this.#child.stdout, this.#child.stderr])
        createInterface({ input: stream as NodeJS.ReadableStream }).on("line", (line) => {
          log(line);
          const listening = /^Listening on (http:\/\/[^/\s]+)/.exec(line);
          if (listening) done(listening[1] as string);
        });
    });
    this.#origin.catch(() => {});
  }

  /** Wait until it answers, and read its tools. */
  async ready() {
    const origin = await Promise.race([
      this.#origin,
      new Promise<never>((_, failed) =>
        setTimeout(() => failed(new Error("The browser's server didn't start.")), START_MS),
      ),
    ]);
    const client = new Client({ name: "agentcomputer", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
    const { tools } = await client.listTools();
    await client.close();
    this.tools = tools.map((tool) => tool.name).filter((name) => !this.#hidden.has(name));
  }

  /** Answer one MCP request by passing it on, enforcing what this computer may not do. */
  async handle(request: IncomingMessage, response: ServerResponse) {
    const origin = await this.#origin;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) return void response.writeHead(413).end();
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);
    let message: Message = {};
    try {
      if (body.length > 0) message = JSON.parse(body.toString("utf8")) as Message;
    } catch {
      // Not JSON: the server answers that itself.
    }
    if (message.method === "tools/call" && this.#hidden.has(String(message.params?.name))) {
      response.writeHead(200, { "Content-Type": "application/json" });
      return void response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id ?? null,
          error: { code: -32602, message: `Unknown tool: ${String(message.params?.name)}` },
        }),
      );
    }
    const headers: Record<string, string> = {};
    for (const name of FORWARDED) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const upstream = await fetch(`${origin}/mcp`, {
      method: request.method as string,
      headers,
      ...(body.length > 0 ? { body } : {}),
    });
    const answer: Record<string, string> = {};
    for (const name of ["content-type", "mcp-session-id", "cache-control"]) {
      const value = upstream.headers.get(name);
      if (value) answer[name] = value;
    }
    response.writeHead(upstream.status, answer);
    if (message.method === "tools/list" && this.#hidden.size > 0)
      return void response.end(withoutHidden(await upstream.text(), this.#hidden));
    if (!upstream.body) return void response.end();
    Readable.fromWeb(upstream.body as never).pipe(response);
  }

  async stop() {
    this.#stopping = true;
    if (this.#exited) return;
    const gone = new Promise<void>((done) => this.#child.once("exit", () => done()));
    this.#child.kill("SIGTERM");
    const timer = setTimeout(() => this.#child.kill("SIGKILL"), STOP_MS);
    await gone;
    clearTimeout(timer);
  }
}
