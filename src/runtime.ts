// How a computer runs. This computer is processes of the service's user, reaching the whole
// machine; `container.ts` is the other way. Inside a container the same processes run, through
// this file, kept to its workspace.
import { chmodSync, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { type AgentExec, createAgentExec, type PtySpawn } from "@agentorg/exec";
import { aboutTool } from "./about.ts";
import { Browser, type BrowserConfig, refuseCall } from "./browser.ts";
import { BrowserLive } from "./browser-live.ts";
import { FilesLive } from "./files-live.ts";
import type { components } from "./generated/schema.js";
import { Live, type LiveMode, type Surface, type SurfaceInfo } from "./live.ts";
import { LoadLive } from "./load-live.ts";
import { ownBrowser } from "./own-browser.ts";
import { channelProgram, DEFAULT_CHANNEL, playwright } from "./playwright.ts";
import { Board, Presence } from "./presence.ts";
import { driverProgram, Screen, screenReadiness } from "./screen.ts";
import { ScreenLive } from "./screen-live.ts";
import { privateFolder } from "./store.ts";
import type { Switch, Switches } from "./switches.ts";

type Schemas = components["schemas"];
/** What a computer that is starting waits on, and how far that has come where it counts. */
export interface Starting {
  reason: string;
  progress: Schemas["Progress"] | null;
}
export type Access = Schemas["Access"];
export type Isolation = Schemas["Isolation"];
/** What a computer run one way offers, and whether one can be run that way now. */
export type Offer = Schemas["Offer"];
export type Endpoint = "computer" | "browser" | "screen";

/** A refusal of the request, with the HTTP status that says so. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ComputerSpec {
  id: string;
  /** What its agent is called, as a person is shown it. */
  name: string;
  access: Access;
  /** A headless browser of its own, or the person's own. */
  browser: boolean | "own";
  /** Whether its agent has the machine's screen, which only this computer can. */
  screen?: boolean | undefined;
  workspace?: string | undefined;
  /** Its workspace and its machine as they are outside, where this is inside a container. */
  outside?: { workspace?: string | undefined; machine?: string | undefined } | undefined;
}

export interface RuntimeEvents {
  log(line: string): void;
  /** It stopped working without being asked to. */
  failed(reason: string): void;
}

export interface Running {
  /** The tools its browser offers, read once it is up. */
  readonly browserTools: string[];
  /** The version of the program it runs, where the runtime says. */
  readonly version?: string | undefined;
  /** What it can open live. */
  readonly surfaces: SurfaceInfo[];
  /** Who is acting on it now, where the runtime keeps that itself. */
  acting?(): Schemas["Acting"][];
  handle(endpoint: Endpoint, request: IncomingMessage, response: ServerResponse): Promise<void>;
  /** Take an upgraded request as a live socket on one surface. */
  openLive(
    surface: Surface,
    mode: LiveMode,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void>;
  stop(): Promise<void>;
}

export interface Runtime {
  /** What a computer run this way offers, and whether one can be now. */
  offer(): Promise<Offer>;
  /** Check what it needs, before a computer is started this way, and fetch what it lacks. */
  prepare(): Promise<void>;
  /** What a computer starting this way is waiting on, and how far it has come where that counts. */
  starting(): Starting;
  /** Start one, or start it again, its private folder being `folder`. */
  start(spec: ComputerSpec, folder: string, events: RuntimeEvents): Promise<Running>;
  /** Stop one left going by a service that ended without stopping it, or say why not. */
  stopLeftover(id: string): Promise<void>;
  /** Remove what running it left behind, apart from its folder, or say why that can't be done. */
  remove(id: string): Promise<void>;
}

/**
 * What a person's shell runs on: node-pty's spawn. Where node-pty can't be used, one that fails
 * saying why, so the shell is refused and the agent's commands are as they are.
 */
let pty: Promise<PtySpawn> | undefined;
const loadPty = () => {
  pty ??= (async () => {
    const fails =
      (why: string): PtySpawn =>
      () => {
        throw new Error(why);
      };
    const require = createRequire(import.meta.url);
    let loaded: typeof import("node-pty");
    try {
      loaded = require("node-pty") as typeof import("node-pty");
    } catch {
      return fails("node-pty isn't installed with this service.");
    }
    // Its prebuilt helper is packed without its execute bit, and npm doesn't restore it.
    const root = dirname(require.resolve("node-pty/package.json"));
    for (const helper of [
      join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
      join(root, "build", "Release", "spawn-helper"),
    ])
      try {
        if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
      } catch {
        return fails(`${helper} has to be executable, and it isn't.`);
      }
    return loaded.spawn;
  })();
  return pty;
};

/** Whether the browser it starts is on this machine, and if it isn't, why not. */
/** What `info` says of a browser: ready, or why not. */
const readiness = (found: { ready: boolean; reason?: string }): Schemas["Readiness"] =>
  found.ready ? { ready: true } : { ready: false, reason: found.reason as string };

function browserProgram(config: BrowserConfig): Schemas["Readiness"] {
  const channel = config.browser ?? DEFAULT_CHANNEL;
  let path: string | undefined;
  try {
    // The service's image for a server has no Playwright beside it, and so no browser.
    playwright();
    path = config.path ?? channelProgram(channel);
  } catch {
    return { ready: false, reason: "Playwright isn't installed with this service." };
  }
  if (path && existsSync(path)) return { ready: true };
  return {
    ready: false,
    reason: config.path
      ? `There's no browser at ${config.path}. Start the service with a --browser-path that exists.`
      : `The browser ${channel} isn't installed on this machine. Install it, or start the service with --browser-name or --browser-path.`,
  };
}

/**
 * The agent's tools that act on its files, for presence. A command it starts is heard as it
 * starts, and one it types into by `write_stdin`; reading its sessions, or what the computer is,
 * acts on nothing.
 */
const FILE_TOOLS = new Set(["read", "list", "search", "edit"]);
/** The switch each of the computer's own tools answers to; `about` answers to none. */
const TOOL_SWITCH: Record<string, Switch> = {
  read: "files",
  list: "files",
  search: "files",
  edit: "files",
  exec_command: "terminal",
  write_stdin: "terminal",
  list_sessions: "terminal",
};

/** The most an agent's request to the computer may be. */
const MAX_CALL = 8 * 1024 * 1024;
/** One MCP request, read whole: its body as parsed, and the tool it calls, if it calls one. */
async function readCall(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_CALL) throw new ApiError(413, "That request is too large.");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    return { body: undefined };
  }
  const message = body as
    | { method?: string; id?: unknown; params?: { name?: unknown } }
    | undefined;
  return {
    body,
    id: message?.id,
    tool: message?.method === "tools/call" ? String(message.params?.name) : undefined,
  };
}

export class ProcessRuntime implements Runtime {
  readonly #config: BrowserConfig;
  readonly #contained: boolean;
  /** Cua Driver, where it was named; otherwise it is looked for. */
  readonly #screenDriver: string | undefined;
  /** The person's browser's user data folder, where named; otherwise Chrome's, then Edge's. */
  readonly #ownBrowserData: string | undefined;
  /** The person's switches for this machine; inside a container there are none. */
  readonly #switches: Switches | undefined;
  /**
   * Whether the screen can be reached, as last checked. Asking the driver can take seconds, which
   * `info` doesn't wait for: it is checked when the service starts, again when it is more than 10 s
   * old and someone asks, and afresh at every start of a computer with the screen.
   */
  #screen: { ready: boolean; reason?: string; at: number } = {
    ready: false,
    reason: "Cua Driver is being looked for.",
    at: 0,
  };
  #checking: Promise<{ ready: boolean; reason?: string }> | undefined;
  /** Who acts on this machine's files: shared by the computers attached to it. */
  readonly #machine: Board | undefined;

  /**
   * Outside a container it is this computer, its files reaching the whole machine. `contained` is
   * for inside one, where the computer and its load are its own and its files stay in its
   * workspace.
   */
  constructor(
    config: BrowserConfig,
    contained = false,
    screenDriver?: string,
    ownBrowserData?: string,
    switches?: Switches,
  ) {
    this.#ownBrowserData = ownBrowserData;
    this.#switches = switches;
    this.#config = config;
    this.#contained = contained;
    this.#screenDriver = screenDriver;
    if (!contained) void this.#checkScreen();
    this.#machine = contained ? undefined : new Board();
  }

  #checkScreen() {
    this.#checking ??= screenReadiness(this.#screenDriver).then((ready) => {
      this.#screen = { ...ready, at: Date.now() };
      this.#checking = undefined;
      return ready;
    });
    return this.#checking;
  }

  /** The screen's readiness as last checked, starting another check where that is old. */
  #screenNow() {
    if (Date.now() - this.#screen.at > 10_000) void this.#checkScreen();
    const { at: _, ...ready } = this.#screen;
    return ready;
  }

  async offer(): Promise<Offer> {
    // A part the person switched off isn't ready, whatever else is.
    const unless = (which: Switch, ready: Schemas["Readiness"]): Schemas["Readiness"] => {
      const reason = this.#switches?.refused(which);
      return reason ? { ready: false, reason } : ready;
    };
    return {
      ready: true,
      capabilities: [
        { capability: "about", ready: true },
        { capability: "terminal", ...unless("terminal", { ready: true }) },
        { capability: "files", ...unless("files", { ready: true }) },
        { capability: "screen", ...unless("screen", this.#screenNow()) },
      ],
      browsers: [
        { kind: "headless", ...browserProgram(this.#config) },
        // The person's own, which only this computer has.
        ...(this.#contained
          ? []
          : [
              {
                kind: "own" as const,
                ...unless("browser", readiness(await ownBrowser(this.#ownBrowserData))),
              },
            ]),
      ],
    };
  }

  async prepare() {}

  starting() {
    return { reason: "It is being started.", progress: null };
  }

  async stopLeftover() {}

  async remove() {}

  async start(spec: ComputerSpec, folder: string, events: RuntimeEvents): Promise<Running> {
    const load = new LoadLive(spec.workspace ?? folder, this.#contained);
    // One with no files of its own has no part in the machine's.
    const presence = new Presence(
      spec.id,
      spec.name,
      spec.access === "none" && !spec.screen ? undefined : this.#machine,
    );
    let exec: AgentExec | undefined;
    if (spec.access !== "none") {
      const workspace = spec.workspace as string;
      const about = aboutTool(
        {
          machine: spec.outside?.machine ?? hostname(),
          workspace: { outside: spec.outside?.workspace ?? workspace, inside: workspace },
          access: spec.access,
          browser: spec.browser,
          screen: spec.screen === true,
          contained: this.#contained,
        },
        load,
        presence,
      );
      exec = createAgentExec({
        workspace,
        level: spec.access,
        reach: this.#contained ? "workspace" : "machine",
        pty: await loadPty(),
        extraTools: [about],
        note: (tool, input) => {
          if (FILE_TOOLS.has(tool)) return presence.agentCalled({ capability: "files" });
          // Only a terminal that is there and running: one refused, or ended, is acted on by
          // nobody. Waiting on its output, with nothing typed, isn't acting on it either.
          const id = input.session_id;
          if (
            tool !== "write_stdin" ||
            !exec?.terminals.list().some((one) => one.id === id && one.exitCode === undefined)
          )
            return undefined;
          return presence.agentCalled(
            { capability: "terminal", terminal: id as string },
            typeof input.chars === "string" && input.chars !== "",
          );
        },
      });
    }
    let browser: Browser | undefined;
    let browserDown = false;
    if (spec.browser) {
      const own = privateFolder(join(folder, "browser"));
      // The person's own browser, where it is reached now, asked afresh.
      let connect: string | undefined;
      let name = "";
      if (spec.browser === "own") {
        const found = await ownBrowser(this.#ownBrowserData);
        const refused =
          this.#switches?.refused("browser") ?? (found.ready ? undefined : found.reason);
        if (refused || !found.ready) {
          await exec?.close();
          throw new ApiError(409, refused ?? "The browser isn't ready.");
        }
        ({ endpoint: connect, name } = found);
        events.log(`Its browser is the person's own: ${name}.`);
      }
      browser = new Browser(
        { ...this.#config, connect },
        own,
        spec.workspace ?? own,
        spec.access === "terminal",
        events.log,
        () => {
          browserDown = true;
          events.failed("Its browser stopped.");
        },
      );
      try {
        await browser.ready();
      } catch (error) {
        await Promise.all([exec?.close(), browser.stop()]);
        // Most likely the person didn't allow it, or wasn't there to.
        if (connect) {
          const Name = name[0]?.toUpperCase() + name.slice(1);
          throw new ApiError(
            409,
            `${Name} didn't allow the connection, or nobody answered it within 2 minutes. Allow it when ${name} asks, on this machine.`,
          );
        }
        throw error;
      }
    }
    // The screen is the machine's, through Cua Driver, which the person installed and granted.
    let screen: Screen | undefined;
    let screenLive: ScreenLive | undefined;
    let screenDown = false;
    if (spec.screen) {
      // Asked afresh, not as last seen: it is what this start rests on.
      const ready = await this.#checkScreen();
      const refused = this.#switches?.refused("screen");
      const program = driverProgram(this.#screenDriver) as string;
      screen =
        ready.ready && !refused
          ? new Screen(
              program,
              events.log,
              () => {
                screenDown = true;
                events.failed("Cua Driver stopped.");
              },
              () => presence.agentCalled({ capability: "screen" }),
              () => this.#switches?.refused("screen"),
            )
          : undefined;
      try {
        if (!screen) throw new ApiError(409, refused ?? ready.reason ?? "The screen isn't ready.");
        await screen.ready();
      } catch (error) {
        await Promise.all([exec?.close(), browser?.stop(), screen?.stop()]);
        throw error;
      }
      // The person's live view of it reaches the driver through a connection of its own.
      screenLive = new ScreenLive(
        program,
        (line) => events.log(`Live view: ${line}`),
        () => presence.acted("person", { capability: "screen" }),
      );
    }
    let browserLive: BrowserLive | undefined;
    if (browser) {
      browserLive = new BrowserLive(
        browser.endpoint,
        () => presence.acted("person", { capability: "browser" }),
        spec.browser === "own",
      );
      browser.gate = browserLive;
      browser.noted = () => presence.agentCalled({ capability: "browser" });
      // The person's switch is for their own browser, not one the computer has of its own.
      if (spec.browser === "own") browser.refused = () => this.#switches?.refused("browser");
    }
    const files =
      exec &&
      new FilesLive(
        exec.files,
        basename(spec.outside?.workspace ?? (spec.workspace as string)),
        () => presence.acted("person", { capability: "files" }),
      );
    const live = new Live(exec, spec.access, load, presence, files, browserLive, screenLive);
    const surfaces = live.surfaces();
    return {
      browserTools: browser?.tools ?? [],
      /** As they are now: a browser or a driver that has stopped can't be opened, and says so. */
      get surfaces() {
        return surfaces.map((one) =>
          one.surface === "browser" && browserDown
            ? {
                ...one,
                unavailable: "Its browser has stopped. Stop the computer and start it again.",
              }
            : one.surface === "screen" && screenDown
              ? {
                  ...one,
                  unavailable: "Cua Driver has stopped. Stop the computer and start it again.",
                }
              : one,
        );
      },
      acting: () => presence.acting(),
      openLive: async (surface, mode, request, socket, head) =>
        live.open(surface, mode, request, socket, head),
      handle: async (endpoint, request, response) => {
        if (endpoint === "computer") {
          // Read whole, to refuse a terminal's or a file's tool while the person has it off.
          const { body, tool, id } = await readCall(request);
          const switched = tool ? TOOL_SWITCH[tool] : undefined;
          const refusal = switched && this.#switches?.refused(switched);
          if (refusal) return refuseCall(response, id, refusal);
          return (exec as AgentExec).handle(request, response, body);
        }
        if (endpoint === "screen") {
          if (screenDown) throw new ApiError(502, "Cua Driver has stopped.");
          return (screen as Screen).handle(request, response);
        }
        if (browserDown) throw new ApiError(502, "Its browser has stopped.");
        return (browser as Browser).handle(request, response);
      },
      stop: async () => {
        live.close();
        presence.close();
        await Promise.all([exec?.close(), browser?.stop(), screen?.stop()]);
      },
    };
  }
}
