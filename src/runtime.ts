// How a computer runs. Without isolation it's processes of the service's user; `container.ts` is
// the other way. Inside a container the same processes run, through this file.
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
import { privateFolder } from "./store.ts";

export type Access = components["schemas"]["Access"];
export type Isolation = components["schemas"]["Isolation"];
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
  /** Whether a computer can be made this way now. */
  available(): Promise<boolean>;
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

export class ProcessRuntime implements Runtime {
  readonly #config: BrowserConfig;
  readonly #contained: boolean;

  /** `contained` is for inside a container, where the computer and its load are its own. */
  constructor(config: BrowserConfig, contained = false) {
    this.#config = config;
    this.#contained = contained;
  }

  async available() {
    return true;
  }

  async prepare() {}

  async stopLeftover() {}

  async remove() {}

  async start(spec: ComputerSpec, folder: string, events: RuntimeEvents): Promise<Running> {
    const load = new LoadLive(spec.workspace ?? folder, this.#contained);
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
      );
      exec = createAgentExec({
        workspace,
        level: spec.access,
        pty: await loadPty(),
        extraTools: [about],
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
      browserLive = new BrowserLive(browser.endpoint);
      browser.gate = browserLive;
    }
    const files =
      exec &&
      new FilesLive(exec.files, basename(spec.outside?.workspace ?? (spec.workspace as string)));
    const live = new Live(exec, spec.access, load, files, browserLive);
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
        await Promise.all([exec?.close(), browser?.stop()]);
      },
    };
  }
}
