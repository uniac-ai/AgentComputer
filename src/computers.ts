// Computers: each one a working folder, AgentExec at a chosen level, and a browser if asked for.
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import type { components } from "./generated/schema.js";
import { ApiError, type Endpoint, type Running, type Runtime } from "./runtime.ts";
import { digestOf, newToken, privateFolder, sameToken, writePrivate } from "./store.ts";

type Schemas = components["schemas"];
type Access = Schemas["Access"];
type ComputerState = Schemas["ComputerState"];
const TOOLS: Record<Exclude<Access, "none">, string[]> = {
  read: ["read", "list", "search"],
  files: ["read", "list", "search", "edit"],
  terminal: ["read", "list", "search", "edit", "exec_command", "write_stdin"],
};
const MAX_LOG = 256 * 1024;
/** The longest a timer can wait; past this a computer simply doesn't expire. */
const MAX_TIMER_S = 2_000_000;

interface Stored {
  id: string;
  name: string;
  access: Access;
  browser: boolean;
  workspace?: string;
  metadata: Record<string, string>;
  tokenDigest: string;
  state: "running" | "stopped";
  createdAt: string;
  startedAt: string;
  endAt?: string;
}
interface Live {
  running?: Running;
  timer?: NodeJS.Timeout;
  failed?: boolean;
}

const expiry = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

export class Computers {
  readonly #data: string;
  readonly #base: () => string;
  readonly #runtime: Runtime;
  readonly #stored = new Map<string, Stored>();
  readonly #live = new Map<string, Live>();
  readonly #file: string;

  constructor(data: string, base: () => string, runtime: Runtime) {
    this.#data = data;
    this.#base = base;
    this.#runtime = runtime;
    this.#file = join(data, "computers.json");
    if (existsSync(this.#file))
      for (const entry of JSON.parse(readFileSync(this.#file, "utf8")) as Stored[])
        this.#stored.set(entry.id, entry);
  }

  get isolation() {
    return this.#runtime.isolation;
  }

  /** Bring back what was running when the service last stopped. */
  async resume() {
    for (const stored of this.#stored.values()) {
      if (stored.state !== "running") continue;
      if (stored.endAt && Date.parse(stored.endAt) <= Date.now()) {
        stored.state = "stopped";
        await this.#runtime.stopLeftover(stored.id);
        continue;
      }
      await this.#start(stored).catch((error: unknown) =>
        this.#log(stored.id, `It didn't start again: ${String(error)}`),
      );
    }
    this.#save();
  }

  async create(input: Schemas["NewComputer"]): Promise<Schemas["CreatedComputer"]> {
    const { access, name, timeout, metadata } = input;
    const browser = input.browser === true;
    if (access === "none" && !browser)
      throw new ApiError(400, "With no files, no commands and no browser, there's no computer.");
    let workspace: string | undefined;
    if (input.workspace !== undefined) {
      let folder = false;
      try {
        folder = isAbsolute(input.workspace) && statSync(input.workspace).isDirectory();
      } catch {
        // Reported below.
      }
      if (!folder) throw new ApiError(400, `There's no folder at ${input.workspace}.`);
      workspace = resolve(input.workspace);
    }
    const id = `c_${randomBytes(9).toString("hex")}`;
    const token = newToken();
    const now = new Date().toISOString();
    const stored: Stored = {
      id,
      name: name ?? id,
      access,
      browser,
      ...(workspace ? { workspace } : {}),
      metadata: metadata ?? {},
      tokenDigest: digestOf(token),
      state: "running",
      createdAt: now,
      startedAt: now,
      ...(timeout === undefined ? {} : { endAt: expiry(timeout) }),
    };
    if (!workspace && access !== "none") {
      stored.workspace = join(this.#folder(id), "workspace");
      mkdirSync(stored.workspace, { recursive: true, mode: 0o700 });
    }
    this.#stored.set(id, stored);
    try {
      await this.#start(stored);
    } catch (error) {
      await this.#halt(id);
      this.#stored.delete(id);
      await this.#runtime.remove(id);
      rmSync(this.#folder(id), { recursive: true, force: true });
      throw new ApiError(500, error instanceof Error ? error.message : String(error));
    }
    this.#save();
    return { ...this.#describe(stored), accessToken: token };
  }

  list(state?: ComputerState): Schemas["Computer"][] {
    return [...this.#stored.values()]
      .reverse()
      .map((stored) => this.#describe(stored))
      .filter((computer) => !state || computer.state === state);
  }

  get(id: string): Schemas["ComputerDetail"] {
    const stored = this.#found(id);
    const live = this.#live.get(id);
    return {
      ...this.#describe(stored),
      uptimeSeconds:
        stored.state === "running"
          ? Math.round((Date.now() - Date.parse(stored.startedAt)) / 1000)
          : 0,
      tools: {
        computer: stored.access === "none" ? [] : TOOLS[stored.access],
        browser: live?.running?.browserTools ?? [],
      },
    };
  }

  /** It now stops this long from now, replacing any earlier timeout. */
  setTimeout(id: string, timeout: number) {
    const stored = this.#found(id);
    if (stored.state !== "running") throw new ApiError(409, "It has stopped.");
    stored.endAt = expiry(timeout);
    this.#arm(stored);
    this.#save();
    return this.#describe(stored);
  }

  /** Stop what it is running. Its folder and token stay, and it can start again. */
  async stop(id: string) {
    const stored = this.#found(id);
    await this.#halt(id);
    stored.state = "stopped";
    delete stored.endAt;
    this.#save();
    return this.#describe(stored);
  }

  /** Start a stopped computer again. One already running is left as it is, unless given a timeout. */
  async start(id: string, timeout?: number) {
    const stored = this.#found(id);
    if (stored.state === "running") {
      if (timeout === undefined) return this.#describe(stored);
      return this.setTimeout(id, timeout);
    }
    if (timeout !== undefined) stored.endAt = expiry(timeout);
    else delete stored.endAt;
    stored.state = "running";
    try {
      await this.#start(stored);
    } catch (error) {
      await this.#halt(id);
      stored.state = "stopped";
      this.#save();
      throw new ApiError(500, error instanceof Error ? error.message : String(error));
    }
    this.#save();
    return this.#describe(stored);
  }

  /** Stop everything and remove what the service made. A folder someone named stays. */
  async kill(id: string) {
    this.#found(id);
    await this.#halt(id);
    await this.#runtime.remove(id);
    this.#stored.delete(id);
    this.#save();
    // Its records, logs and browser profile, and the workspace if the service made it there.
    rmSync(this.#folder(id), { recursive: true, force: true });
  }

  logs(id: string) {
    this.#found(id);
    let text = "";
    try {
      text = readFileSync(this.#logFile(id), "utf8");
    } catch {
      // Nothing written yet.
    }
    return text
      .split("\n")
      .filter(Boolean)
      .map((entry) => ({
        timestamp: entry.slice(0, entry.indexOf(" ")),
        line: entry.slice(entry.indexOf(" ") + 1),
      }));
  }

  /** Answer an MCP request for one of a computer's endpoints, if its token is right. */
  async serve(
    id: string,
    endpoint: Endpoint,
    token: string | undefined,
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const stored = this.#stored.get(id);
    if (!stored || !token || !sameToken(token, stored.tokenDigest))
      return void response.writeHead(401, { "WWW-Authenticate": "Bearer" }).end();
    if (endpoint === "computer" && stored.access === "none")
      throw new ApiError(404, "This computer has no files or terminal.");
    if (endpoint === "browser" && !stored.browser)
      throw new ApiError(404, "This computer has no browser.");
    const running = this.#live.get(id)?.running;
    if (!running) throw new ApiError(409, "It has stopped.");
    this.#log(id, `${request.method} mcp/${endpoint}`);
    return running.handle(endpoint, request, response);
  }

  /** Stop every computer, leaving their records to resume at the next start. */
  async close() {
    await Promise.all([...this.#live.keys()].map((id) => this.#halt(id)));
  }

  #found(id: string): Stored {
    const stored = this.#stored.get(id);
    if (!stored) throw new ApiError(404, `There's no computer ${id.slice(0, 64)}.`);
    return stored;
  }

  #folder(id: string) {
    return privateFolder(join(this.#data, "computers", id));
  }

  #logFile(id: string) {
    return join(this.#folder(id), "log");
  }

  #log(id: string, line: string) {
    if (!this.#stored.has(id)) return;
    const file = this.#logFile(id);
    try {
      if (existsSync(file) && statSync(file).size > MAX_LOG)
        writePrivate(file, readFileSync(file, "utf8").slice(-MAX_LOG / 2));
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {
      // A log that can't be written doesn't stop the computer.
    }
  }

  #save() {
    writePrivate(this.#file, JSON.stringify([...this.#stored.values()]));
  }

  #describe(stored: Stored): Schemas["Computer"] {
    const path = `${this.#base()}/v1/computers/${stored.id}/mcp`;
    const down = this.#live.get(stored.id)?.failed === true;
    return {
      computerID: stored.id,
      name: stored.name,
      state: stored.state === "running" && down ? "failed" : stored.state,
      access: stored.access,
      browser: stored.browser,
      workspace: stored.workspace ?? null,
      startedAt: stored.startedAt,
      endAt: stored.endAt ?? null,
      metadata: stored.metadata,
      endpoints: {
        computer: stored.access === "none" ? null : `${path}/computer`,
        browser: stored.browser ? `${path}/browser` : null,
      },
    };
  }

  async #start(stored: Stored) {
    const live: Live = {};
    this.#live.set(stored.id, live);
    stored.startedAt = new Date().toISOString();
    live.running = await this.#runtime.start(
      {
        id: stored.id,
        access: stored.access,
        browser: stored.browser,
        workspace: stored.workspace,
      },
      this.#folder(stored.id),
      {
        log: (line) => this.#log(stored.id, line),
        failed: (reason) => {
          live.failed = true;
          this.#log(stored.id, reason);
        },
      },
    );
    this.#arm(stored);
  }

  #arm(stored: Stored) {
    const live = this.#live.get(stored.id);
    if (!live) return;
    clearTimeout(live.timer);
    delete live.timer;
    if (!stored.endAt) return;
    const wait = Date.parse(stored.endAt) - Date.now();
    if (wait > MAX_TIMER_S * 1000) return;
    live.timer = setTimeout(() => {
      this.#log(stored.id, "Its time ran out.");
      stored.state = "stopped";
      this.#save();
      void this.#halt(stored.id);
    }, wait);
    live.timer.unref();
  }

  async #halt(id: string) {
    const live = this.#live.get(id);
    if (!live) return;
    this.#live.delete(id);
    clearTimeout(live.timer);
    await live.running?.stop();
  }
}
