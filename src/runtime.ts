// How a computer runs. Without isolation it's processes of the service's user; `container.ts` is
// the other way. Inside a container the same processes run, through this file.
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { type AgentExec, createAgentExec } from "@agentorg/exec";
import { Browser, type BrowserConfig } from "./browser.ts";
import type { components } from "./generated/schema.js";
import { Live, type LiveMode, type Surface, type SurfaceInfo } from "./live.ts";
import { privateFolder } from "./store.ts";

export type Access = components["schemas"]["Access"];
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
}

export interface RuntimeEvents {
  log(line: string): void;
  /** It stopped working without being asked to. */
  failed(reason: string): void;
}

export interface Running {
  /** The tools its browser offers, read once it is up. */
  readonly browserTools: string[];
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
  readonly isolation: "none" | "container";
  /** Check what it needs before the service says it's up. */
  prepare(): Promise<void>;
  /** Start one, or start it again, its private folder being `folder`. */
  start(spec: ComputerSpec, folder: string, events: RuntimeEvents): Promise<Running>;
  /** Stop one left going by a service that ended without stopping it. */
  stopLeftover(id: string): Promise<void>;
  /** Remove what running it left behind, apart from its folder. */
  remove(id: string): Promise<void>;
}

export class ProcessRuntime implements Runtime {
  readonly isolation = "none";
  readonly #config: BrowserConfig;

  constructor(config: BrowserConfig) {
    this.#config = config;
  }

  async prepare() {}

  async stopLeftover() {}

  async remove() {}

  async start(spec: ComputerSpec, folder: string, events: RuntimeEvents): Promise<Running> {
    let exec: AgentExec | undefined;
    if (spec.access !== "none")
      exec = createAgentExec({ workspace: spec.workspace as string, level: spec.access });
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
    const live = new Live(exec, spec.workspace, spec.access === "terminal");
    return {
      browserTools: browser?.tools ?? [],
      surfaces: await live.surfaces(),
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
