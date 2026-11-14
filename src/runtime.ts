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
import { Browser, type BrowserConfig } from "./browser.ts";
import { BrowserLive } from "./browser-live.ts";
import { FilesLive } from "./files-live.ts";
import type { components } from "./generated/schema.js";
import { Live, type LiveMode, type Surface, type SurfaceInfo } from "./live.ts";
import { LoadLive } from "./load-live.ts";
import { channelProgram, DEFAULT_CHANNEL, playwright } from "./playwright.ts";
import { Board, Presence } from "./presence.ts";
import { privateFolder } from "./store.ts";

type Schemas = components["schemas"];
export type Access = Schemas["Access"];
export type Isolation = Schemas["Isolation"];
/** What a computer run one way offers, and whether one can be run that way now. */
export type Offer = Schemas["Offer"];
export type Endpoint = "computer" | "browser";

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
  browser: boolean;
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
  /** Check what it needs, before a computer is started this way. */
  prepare(): Promise<void>;
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

export class ProcessRuntime implements Runtime {
  readonly #config: BrowserConfig;
  readonly #contained: boolean;
  /** This computer's own: who acts on what of it that every computer attached to it shares. */
  readonly #machine: Board | undefined;

  /**
   * Outside a container it is this computer, its files reaching the whole machine. `contained` is
   * for inside one, where the computer and its load are its own and its files stay in its
   * workspace.
   */
  constructor(config: BrowserConfig, contained = false) {
    this.#config = config;
    this.#contained = contained;
    this.#machine = contained ? undefined : new Board();
  }

  async offer(): Promise<Offer> {
    return {
      ready: true,
      capabilities: [
        { capability: "about", ready: true },
        { capability: "terminal", ready: true },
        { capability: "files", ready: true },
        { capability: "screen", ready: false, reason: "This service can't reach the screen yet." },
      ],
      browsers: [{ kind: "headless", ...browserProgram(this.#config) }],
    };
  }

  async prepare() {}

  async stopLeftover() {}

  async remove() {}

  async start(spec: ComputerSpec, folder: string, events: RuntimeEvents): Promise<Running> {
    const load = new LoadLive(spec.workspace ?? folder, this.#contained);
    const presence = new Presence(spec.id, spec.name, this.#machine);
    let exec: AgentExec | undefined;
    if (spec.access !== "none") {
      const workspace = spec.workspace as string;
      const about = aboutTool(
        {
          machine: spec.outside?.machine ?? hostname(),
          workspace: { outside: spec.outside?.workspace ?? workspace, inside: workspace },
          access: spec.access,
          browser: spec.browser,
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
      browser = new Browser(
        this.#config,
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
        throw error;
      }
    }
    let browserLive: BrowserLive | undefined;
    if (browser) {
      browserLive = new BrowserLive(browser.endpoint, () =>
        presence.acted("person", { capability: "browser" }),
      );
      browser.gate = browserLive;
      browser.noted = () => presence.agentCalled({ capability: "browser" });
    }
    const files =
      exec &&
      new FilesLive(
        exec.files,
        basename(spec.outside?.workspace ?? (spec.workspace as string)),
        () => presence.acted("person", { capability: "files" }),
      );
    const live = new Live(exec, spec.access, load, presence, files, browserLive);
    const surfaces = live.surfaces();
    return {
      browserTools: browser?.tools ?? [],
      /** As they are now: a browser that has stopped can't be opened, and says so. */
      get surfaces() {
        return surfaces.map((one) =>
          one.surface === "browser" && browserDown
            ? {
                ...one,
                unavailable: "Its browser has stopped. Stop the computer and start it again.",
              }
            : one,
        );
      },
      openLive: async (surface, mode, request, socket, head) =>
        live.open(surface, mode, request, socket, head),
      handle: async (endpoint, request, response) => {
        if (endpoint === "computer") return (exec as AgentExec).handle(request, response);
        if (browserDown) throw new ApiError(502, "Its browser has stopped.");
        return (browser as Browser).handle(request, response);
      },
      stop: async () => {
        live.close();
        presence.close();
        await Promise.all([exec?.close(), browser?.stop()]);
      },
    };
  }
}
