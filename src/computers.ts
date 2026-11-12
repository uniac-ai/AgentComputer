// Computers: each one a working folder, AgentExec at a chosen level, and a browser if asked for.
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import type { components } from "./generated/schema.js";
import type { LiveMode, Surface } from "./live.ts";
import { ApiError, type Endpoint, type Isolation, type Running, type Runtime } from "./runtime.ts";
import { digestOf, newToken, privateFolder, sameToken, writePrivate } from "./store.ts";

type Schemas = components["schemas"];
type Access = Schemas["Access"];
type ComputerState = Schemas["ComputerState"];
const READ = ["about", "read", "list", "search"];
const FILES = [...READ, "edit"];
const TOOLS: Record<Exclude<Access, "none">, string[]> = {
  read: READ,
  files: FILES,
  terminal: [...FILES, "exec_command", "write_stdin", "list_sessions"],
};
const MAX_LOG = 256 * 1024;
/** The longest a timer can wait; past this a computer simply doesn't expire. */
const MAX_TIMER_S = 2_000_000;

interface Stored {
  id: string;
  name: string;
  access: Access;
  /** How it is isolated, for as long as it exists. */
  isolation: Isolation;
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

/** How long a live session's ticket can wait to be opened. */
const TICKET_MS = 60_000;

interface Ticket {
  computerID: string;
  surface: Surface;
  mode: LiveMode;
  expiresAt: number;
}

const expiry = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** Why it didn't start, as the service answers it. */
const refusalOf = (error: unknown) =>
  error instanceof ApiError ? error : new ApiError(500, messageOf(error));

export class Computers {
  readonly #data: string;
  readonly #base: () => string;
  readonly #runtimes: Record<Isolation, Runtime>;
  /** The isolation of a computer made without saying which. */
  readonly isolation: Isolation;
  readonly #stored = new Map<string, Stored>();
  readonly #live = new Map<string, Live>();
  readonly #tickets = new Map<string, Ticket>();
  readonly #file: string;

  constructor(
    data: string,
    base: () => string,
    runtimes: Record<Isolation, Runtime>,
    isolation: Isolation,
  ) {
    this.#data = data;
    this.#base = base;
    this.#runtimes = runtimes;
    this.isolation = isolation;
    this.#file = join(data, "computers.json");
    if (existsSync(this.#file))
      // One recorded before computers kept their isolation takes the service's, at this start.
      for (const entry of JSON.parse(readFileSync(this.#file, "utf8")) as Stored[])
        this.#stored.set(entry.id, { ...entry, isolation: entry.isolation ?? isolation });
  }

  /** The isolations a computer can be made in now. */
  async available() {
    const all = Object.keys(this.#runtimes) as Isolation[];
    const can = await Promise.all(all.map((one) => this.#runtimes[one].available()));
    return all.filter((_, index) => can[index]);
  }

  /** Bring back what was running when the service last stopped. */
  async resume() {
    for (const stored of this.#stored.values()) {
      if (stored.state !== "running") continue;
      if (stored.endAt && Date.parse(stored.endAt) <= Date.now()) {
        stored.state = "stopped";
        await this.#runtimes[stored.isolation]
          .stopLeftover(stored.id)
          .catch((error: unknown) =>
            this.#log(stored.id, `What it left running wasn't stopped: ${messageOf(error)}`),
          );
        continue;
      }
      await this.#start(stored).catch((error: unknown) => {
        // It shows as failed, with why in its log, until it is stopped and started again.
        const live = this.#live.get(stored.id);
        if (live) live.failed = true;
        // Its time still runs, so that it ends when it was to.
        this.#arm(stored);
        this.#log(stored.id, `It didn't start again: ${messageOf(error)}`);
      });
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
      isolation: input.isolation ?? this.isolation,
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
      await this.#runtimes[stored.isolation].remove(id).catch(() => {});
      rmSync(this.#folder(id), { recursive: true, force: true });
      throw refusalOf(error);
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
      surfaces: live?.running?.surfaces ?? [],
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
      throw refusalOf(error);
    }
    this.#save();
    return this.#describe(stored);
  }

  /** Stop everything and remove what the service made. A folder someone named stays. */
  async kill(id: string) {
    const stored = this.#found(id);
    await this.#halt(id);
    try {
      await this.#runtimes[stored.isolation].remove(id);
    } catch (error) {
      // What it left can't be removed now. It stays, stopped, to be killed when that can be done.
      stored.state = "stopped";
      this.#save();
      throw refusalOf(error);
    }
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

  /** A one-time ticket to open one of its surfaces live. */
  liveSession(id: string, surface: Surface, mode: LiveMode): Schemas["LiveSession"] {
    this.#found(id);
    const running = this.#live.get(id)?.running;
    if (!running) throw new ApiError(409, "It has stopped.");
    const info = running.surfaces.find((one) => one.surface === surface);
    if (!info) throw new ApiError(409, `This computer has no ${surface} to open.`);
    if (info.unavailable) throw new ApiError(409, info.unavailable);
    if (mode === "operate" && !info.operate)
      throw new ApiError(400, `Its ${surface} can be watched, not operated.`);
    const now = Date.now();
    for (const [key, ticket] of this.#tickets)
      if (ticket.expiresAt <= now) this.#tickets.delete(key);
    const ticket = `l_${randomBytes(24).toString("base64url")}`;
    const expiresAt = now + TICKET_MS;
    this.#tickets.set(ticket, { computerID: id, surface, mode, expiresAt });
    return {
      url: `${this.#base().replace(/^http/, "ws")}/v1/live/${ticket}`,
      protocol: info.protocol,
      surface,
      mode,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /** Open a live session by its ticket, which then can't be used again. */
  async openLive(ticket: string, request: IncomingMessage, socket: Duplex, head: Buffer) {
    const found = this.#tickets.get(ticket);
    this.#tickets.delete(ticket);
    if (!found || found.expiresAt <= Date.now())
      throw new ApiError(404, "There's no such live session: it was used, or it expired.");
    const running = this.#live.get(found.computerID)?.running;
    if (!running) throw new ApiError(409, "It has stopped.");
    this.#log(found.computerID, `live ${found.surface} ${found.mode}`);
    await running.openLive(found.surface, found.mode, request, socket, head);
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
    try {
      const file = this.#logFile(id);
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
      isolation: stored.isolation,
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
    // In the isolation it was made in, and never another.
    const runtime = this.#runtimes[stored.isolation];
    await runtime.prepare();
    live.running = await runtime.start(
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
      this.#expire(stored).catch((error: unknown) =>
        this.#log(stored.id, `It didn't stop cleanly: ${String(error)}`),
      );
    }, wait);
    live.timer.unref();
  }

  async #expire(stored: Stored) {
    this.#log(stored.id, "Its time ran out.");
    stored.state = "stopped";
    this.#save();
    await this.#halt(stored.id);
  }

  async #halt(id: string) {
    const live = this.#live.get(id);
    if (!live) return;
    this.#live.delete(id);
    clearTimeout(live.timer);
    await live.running?.stop();
  }
}
