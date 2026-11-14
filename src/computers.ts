// Computers: each one a working folder, AgentExec at a chosen level, and a browser if asked for.
// Each is made in a container, or is this computer, attached.
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { cp, lstat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import type { components } from "./generated/schema.js";
import { VERSION } from "./handlers.ts";
import type { LiveMode, Surface } from "./live.ts";
import { ApiError, type Endpoint, type Isolation, type Running, type Runtime } from "./runtime.ts";
import { SCREEN_TOOLS } from "./screen.ts";
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
  /** It is this computer, attached rather than made, with no isolation. */
  attached?: true;
  /** The version of the program it ran at its last start, where that is known. */
  version?: string;
  browser: boolean;
  /** Its agent has the machine's screen: only this computer, attached with it. */
  screen?: true;
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
/**
 * Why one made with no isolation, before that was dropped, can't start: what is left of it, and
 * what to do instead.
 */
const noLongerMade = (stored: Stored) =>
  "A computer with no isolation is no longer made. " +
  (stored.workspace
    ? `Its folder is kept at ${stored.workspace}. Attach this computer with that folder as its work folder, or make a container whose workspace starts as a copy of it.`
    : "Attach this computer, or make a container.");
/**
 * Remove a folder whole, with what is in it. A folder in it that can't be written, as a copy or an
 * agent can leave, is made writable by its owner first.
 */
function removeFolder(path: string) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    const open = (at: string) => {
      chmodSync(at, 0o700);
      for (const entry of readdirSync(at, { withFileTypes: true }))
        if (entry.isDirectory()) open(join(at, entry.name));
    };
    open(path);
    rmSync(path, { recursive: true, force: true });
  }
}

/** A folder that exists, given by its full path, or the refusal of one that doesn't. */
function folderAt(path: string) {
  let folder = false;
  try {
    folder = isAbsolute(path) && statSync(path).isDirectory();
  } catch {
    // Refused below.
  }
  if (!folder) throw new ApiError(400, `There's no folder at ${path}.`);
  return resolve(path);
}
/** Why it didn't start, as the service answers it. */
const refusalOf = (error: unknown) =>
  error instanceof ApiError ? error : new ApiError(500, messageOf(error));

export class Computers {
  readonly #data: string;
  readonly #base: () => string;
  /** This computer's way of running, as `none`, and each way of making one. */
  readonly #runtimes: Record<Isolation, Runtime>;
  /** Why this computer isn't offered here, where it isn't. */
  readonly #notHere: string | undefined;
  readonly #stored = new Map<string, Stored>();
  readonly #live = new Map<string, Live>();
  readonly #tickets = new Map<string, Ticket>();
  readonly #file: string;

  constructor(
    data: string,
    base: () => string,
    runtimes: Record<Isolation, Runtime>,
    notHere?: string,
  ) {
    this.#data = data;
    this.#base = base;
    this.#runtimes = runtimes;
    this.#notHere = notHere;
    this.#file = join(data, "computers.json");
    if (existsSync(this.#file))
      // One recorded by 0.0.14 or earlier, which kept no isolation, is taken as made with none,
      // the default then. The README says how to bring over one made in a container then.
      for (const entry of JSON.parse(readFileSync(this.#file, "utf8")) as Stored[])
        this.#stored.set(entry.id, { ...entry, isolation: entry.isolation ?? "none" });
  }

  /** What it offers: this computer, and each kind it makes, with whether it can be now. */
  async offers() {
    const offered = await this.#runtimes.none.offer();
    const thisComputer = this.#notHere
      ? { ...offered, ready: false, reason: this.#notHere }
      : offered;
    const made = await Promise.all(
      (Object.keys(this.#runtimes) as Isolation[])
        .filter((isolation) => isolation !== "none")
        .map(async (isolation) => ({ isolation, ...(await this.#runtimes[isolation].offer()) })),
    );
    return { thisComputer, made };
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
    if (input.isolation === "none")
      throw new ApiError(
        400,
        "A computer with no isolation is no longer made. Attach this computer, or make a container.",
      );
    return this.#make(input, input.isolation ?? "container");
  }

  /** This computer, attached with its work folder. Nothing is made for it. */
  attach(input: Schemas["AttachComputer"]): Promise<Schemas["CreatedComputer"]> {
    return this.#make(input, "none");
  }

  async #make(
    input: Schemas["NewComputer"] & { screen?: boolean },
    isolation: Isolation,
  ): Promise<Schemas["CreatedComputer"]> {
    const { access, name, timeout, metadata } = input;
    const browser = input.browser === true;
    if (access === "none" && !browser && !input.screen)
      throw new ApiError(
        400,
        "With no files, no commands, no browser and no screen, there's no computer.",
      );
    if (input.copyFrom !== undefined && input.workspace !== undefined)
      throw new ApiError(
        400,
        "Give workspace or copyFrom, not both: copyFrom fills a workspace the service makes.",
      );
    if (input.copyFrom !== undefined && access === "none")
      throw new ApiError(
        400,
        "With access none there is no workspace. Give access read, files or terminal, or leave out copyFrom.",
      );
    const workspace = input.workspace === undefined ? undefined : folderAt(input.workspace);
    // Where it really is: a link to a folder is copied as that folder.
    const from = input.copyFrom === undefined ? undefined : realpathSync(folderAt(input.copyFrom));
    const id = `c_${randomBytes(9).toString("hex")}`;
    const token = newToken();
    const now = new Date().toISOString();
    const stored: Stored = {
      id,
      name: name ?? id,
      access,
      isolation,
      ...(isolation === "none" ? { attached: true } : {}),
      browser,
      ...(input.screen ? { screen: true } : {}),
      ...(workspace ? { workspace } : {}),
      metadata: metadata ?? {},
      tokenDigest: digestOf(token),
      state: "running",
      createdAt: now,
      startedAt: now,
      ...(timeout === undefined ? {} : { endAt: expiry(timeout) }),
    };
    if (!workspace && access !== "none") {
      const own = join(this.#folder(id), "workspace");
      mkdirSync(own, { recursive: true, mode: 0o700 });
      stored.workspace = own;
      // Copied once, before anyone can see the computer: the folder itself is never mounted or
      // changed. Links are copied as they are, and what is neither a file, a folder nor a link,
      // such as a socket a program left, is left out.
      if (from)
        await cp(from, own, {
          recursive: true,
          verbatimSymlinks: true,
          filter: async (path) => {
            const found = await lstat(path);
            return found.isFile() || found.isDirectory() || found.isSymbolicLink();
          },
        }).catch((error: unknown) => {
          removeFolder(this.#folder(id));
          throw refusalOf(error);
        });
    }
    this.#stored.set(id, stored);
    try {
      await this.#start(stored);
    } catch (error) {
      await this.#halt(id);
      this.#stored.delete(id);
      await this.#runtimes[stored.isolation].remove(id).catch(() => {});
      try {
        removeFolder(this.#folder(id));
      } catch {
        // What it left is left; why it didn't start is what the caller is told.
      }
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
        screen: stored.screen && live?.running ? SCREEN_TOOLS : [],
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
    // Its records, logs and browser profile, and the workspace if the service made it there. One
    // made with no isolation can't start again, so its workspace is all that is left of it: that
    // stays, to be attached or made a container's.
    const folder = this.#folder(id);
    if (stored.isolation === "none" && !stored.attached && existsSync(join(folder, "workspace")))
      for (const entry of readdirSync(folder)) {
        if (entry !== "workspace") removeFolder(join(folder, entry));
      }
    else removeFolder(folder);
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
    if (endpoint === "screen" && !stored.screen)
      throw new ApiError(404, "This computer has no screen.");
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
      attached: stored.attached === true,
      version: stored.version ?? null,
      browser: stored.browser,
      screen: stored.screen === true,
      workspace: stored.workspace ?? null,
      startedAt: stored.startedAt,
      endAt: stored.endAt ?? null,
      metadata: stored.metadata,
      endpoints: {
        computer: stored.access === "none" ? null : `${path}/computer`,
        browser: stored.browser ? `${path}/browser` : null,
        screen: stored.screen ? `${path}/screen` : null,
      },
    };
  }

  async #start(stored: Stored) {
    const live: Live = {};
    this.#live.set(stored.id, live);
    if (stored.isolation === "none" && !stored.attached)
      throw new ApiError(409, noLongerMade(stored));
    if (stored.attached && this.#notHere) throw new ApiError(409, this.#notHere);
    stored.startedAt = new Date().toISOString();
    // In the isolation it was made in, and never another.
    const runtime = this.#runtimes[stored.isolation];
    await runtime.prepare();
    live.running = await runtime.start(
      {
        id: stored.id,
        name: stored.name,
        access: stored.access,
        browser: stored.browser,
        screen: stored.screen === true,
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
    // This computer runs this service's program; a container, its image's, if it says.
    const version = stored.isolation === "none" ? VERSION : live.running.version;
    if (version) stored.version = version;
    else delete stored.version;
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
