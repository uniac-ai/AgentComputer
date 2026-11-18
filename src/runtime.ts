// How a computer runs. This computer is processes of the service's user, reaching the whole
// machine; `container.ts` is the other way. Inside a container the same processes run, through
// this file, kept to its workspace.
import { chmodSync, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { ApiError } from "@agentorg/computer-base/error";
import { readRequest, refuseBody, refuseCall } from "@agentorg/computer-base/http";
import { privateFolder } from "@agentorg/computer-base/store";
import { Browser, type BrowserConfig } from "@agentorg/computer-browser/browser";
import { BrowserLive } from "@agentorg/computer-browser/browser-live";
import { ownBrowser } from "@agentorg/computer-browser/own-browser";
import { channelProgram, DEFAULT_CHANNEL, playwright } from "@agentorg/computer-browser/playwright";
import type { components } from "@agentorg/computer-contract/schema";
import {
  type DriverAt,
  findDriver,
  onlyGrantsMissing,
  Screen,
  screenCheck,
} from "@agentorg/computer-screen/screen";
import { ScreenLive } from "@agentorg/computer-screen/screen-live";
import { type AgentExec, createAgentExec, type PtySpawn } from "@agentorg/exec";
import { aboutTool } from "./about.ts";
import { FilesLive } from "./files-live.ts";
import { Live, type LiveMode, type Surface, type SurfaceInfo } from "./live.ts";
import { LoadLive } from "./load-live.ts";
import { Board, Presence } from "./presence.ts";
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

export interface ComputerSpec {
  id: string;
  /** What its agent is called, as a person is shown it. */
  name: string;
  access: Access;
  /** A headless browser of its own, or the person's own. */
  browser: boolean | "own";
  /** Whether its agent has the machine's screen, which only this computer can. */
  screen?: boolean | undefined;
  /**
   * Whether it is started again, as when the service starts or it is started after a stop, rather
   * than made or attached: one started again keeps its terminal, files and browser where its screen
   * can't be used now.
   */
  again?: boolean | undefined;
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
/**
 * The switch each tool answers to by its name: the computer's own, and the browser's that runs
 * code on the machine. A browser call that names files, by `paths` or `filename`, answers to the
 * files' switch as well. `about` and the rest of the browser's answer to none.
 */
const TOOL_SWITCH: Record<string, Switch> = {
  ...Object.fromEntries([...FILE_TOOLS].map((tool) => [tool, "files" as const])),
  exec_command: "terminal",
  write_stdin: "terminal",
  list_sessions: "terminal",
  browser_run_code_unsafe: "terminal",
};

/** The most an agent's request to its computer may be, as AgentExec itself takes it. */
const MAX_CALL = 4 * 1024 * 1024;
/**
 * How long `info` waits for a new check of the screen, well short of the seconds a client gives it.
 */
const SCREEN_WAIT_MS = 1_000;

export class ProcessRuntime implements Runtime {
  readonly #config: BrowserConfig;
  readonly #contained: boolean;
  /** Cua Driver as it was named, if it was; otherwise it is looked for. */
  readonly #screenDriver: Partial<DriverAt>;
  /** The person's browser's user data folder, where named; otherwise Chrome's, then Edge's. */
  readonly #ownBrowserData: string | undefined;
  /** The person's switches for this machine; inside a container there are none. */
  readonly #switches: Switches | undefined;
  /**
   * Whether the screen can be reached, as last checked. It is checked when the service starts,
   * again when it is more than 10 s old and someone asks, and afresh at every start of a computer
   * with the screen. Asking the driver can take seconds: `info` waits up to `SCREEN_WAIT_MS` for
   * the new check, so that a reading more than 10 s old isn't answered as it was, and otherwise
   * answers the last one.
   */
  #screen: { ready: boolean; reason?: string; at: number } = {
    ready: false,
    reason: "Cua Driver is being looked for.",
    at: 0,
  };
  #checking: ReturnType<typeof screenCheck> | undefined;
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
    screenDriver: Partial<DriverAt> = {},
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
    this.#checking ??= screenCheck(this.#screenDriver).then((checked) => {
      this.#screen = { ...checked.readiness, at: Date.now() };
      this.#checking = undefined;
      return checked;
    });
    return this.#checking;
  }

  /** The screen's readiness: checked again where the last is old, waiting a little for that. */
  async #screenNow() {
    if (Date.now() - this.#screen.at > 10_000) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        this.#checkScreen(),
        new Promise((done) => {
          timer = setTimeout(done, SCREEN_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    const { at: _, ...ready } = this.#screen;
    return ready;
  }

  /**
   * Why an agent's screen call is refused now: the person switched it off, or the screen wasn't
   * ready at the last check. While it isn't, each call checks it afresh, so that a grant given is
   * used at the next call; while it is, calls aren't held up by checks.
   */
  async #screenRefused(): Promise<string | undefined> {
    const off = this.#switches?.refused("screen");
    if (off) return off;
    if (this.#screen.ready) return undefined;
    const { readiness: now } = await this.#checkScreen();
    return now.ready ? undefined : (now.reason ?? "The screen isn't ready.");
  }

  /**
   * Why the screen can't be opened live now: it isn't ready, as the last check says, which is
   * checked again meanwhile, for the next to read. The person's switch is for agents, and leaves
   * the person's own live view alone.
   */
  #screenUnavailable(): string | undefined {
    if (this.#screen.ready) return undefined;
    void this.#checkScreen();
    return this.#screen.reason ?? "The screen isn't ready.";
  }

  /** Cua Driver as it is found now: where it was named or found, or where it was to be. */
  #driverNow(): DriverAt {
    return (
      findDriver(this.#screenDriver) ?? {
        ...this.#screenDriver,
        program: this.#screenDriver.program ?? "cua-driver",
      }
    );
  }

  /** Why the agent can't call this tool now: the person switched off what it reaches. */
  #toolRefused(tool: string) {
    const which = TOOL_SWITCH[tool];
    return which && this.#switches?.refused(which);
  }

  async offer(): Promise<Offer> {
    // A part the person switched off isn't ready, whatever else is.
    const unless = (which: Switch, ready: Schemas["Readiness"]): Schemas["Readiness"] => {
      const reason = this.#switches?.refused(which);
      return reason ? { ready: false, reason } : ready;
    };
    // The screen's check, where it is waited for, while the person's browser is read. One the
    // person switched off isn't checked.
    const [screen, own] = await Promise.all([
      this.#switches?.refused("screen") ? { ready: false } : this.#screenNow(),
      this.#contained ? undefined : ownBrowser(this.#ownBrowserData),
    ]);
    return {
      ready: true,
      capabilities: [
        { capability: "about", ready: true },
        { capability: "terminal", ...unless("terminal", { ready: true }) },
        { capability: "files", ...unless("files", { ready: true }) },
        { capability: "screen", ...unless("screen", screen) },
      ],
      browsers: [
        { kind: "headless", ...browserProgram(this.#config) },
        // The person's own, which only this computer has.
        ...(own === undefined
          ? []
          : [{ kind: "own" as const, ...unless("browser", readiness(own)) }]),
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
          // nobody. Waiting on its output, with nothing typed, adds nothing: a command the agent
          // started is acting until it ends either way.
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
        const refused = this.#switches?.refused("browser");
        const found = refused
          ? { ready: false as const, reason: refused }
          : await ownBrowser(this.#ownBrowserData);
        if (!found.ready) {
          await exec?.close();
          throw new ApiError(409, found.reason);
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
    if (spec.screen) {
      // Asked afresh, not as last seen: a new one rests on it.
      const checked = await this.#checkScreen();
      const { readiness: ready, driver } = checked;
      const off = this.#switches?.refused("screen");
      const why =
        off ?? (ready.ready && driver ? undefined : (ready.reason ?? "The screen isn't ready."));
      // One started again keeps its terminal, files and browser: its screen's tools say why
      // they can't be used, and work once the screen can be, with no restart. So does a new one
      // whose screen lacks only macOS's grants, which the person gives from the app's setup.
      if (why && !spec.again && (off !== undefined || !onlyGrantsMissing(checked))) {
        await Promise.all([exec?.close(), browser?.stop()]);
        throw new ApiError(409, why);
      }
      // Found again at each connection: one installed or moved meanwhile is reached.
      const at = () => this.#driverNow();
      screen = new Screen(
        at,
        events.log,
        () => presence.agentCalled({ capability: "screen" }),
        () => this.#screenRefused(),
        // On a lent machine the agent acts only in the background.
        this.#switches?.lends ?? false,
      );
      if (why) events.log(`It started without its screen, which its tools say: ${why}`);
      else
        try {
          await screen.ready();
        } catch (error) {
          if (!spec.again) {
            await Promise.all([exec?.close(), browser?.stop(), screen.stop()]);
            throw error;
          }
          events.log(`Its screen connects at its next call: ${(error as Error).message}`);
        }
      // The person's live view of it reaches the driver through a connection of its own.
      screenLive = new ScreenLive(
        at,
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
      // The browser's switch is for the person's own; any browser's calls that reach the machine
      // answer to its terminal's and files' switches.
      browser.refused = (tool, args) =>
        (spec.browser === "own" ? this.#switches?.refused("browser") : undefined) ??
        this.#toolRefused(tool) ??
        ("paths" in args || "filename" in args ? this.#switches?.refused("files") : undefined);
    }
    const files =
      exec &&
      new FilesLive(
        exec.files,
        basename(spec.outside?.workspace ?? (spec.workspace as string)),
        () => presence.acted("person", { capability: "files" }),
      );
    const live = new Live(exec, spec.access, load, presence, files, browserLive, screenLive);
    const unavailableNow = () => this.#screenUnavailable();
    const surfaces = live.surfaces();
    return {
      browserTools: browser?.tools ?? [],
      /**
       * As they are now: a browser that has stopped can't be opened, and says so; nor can the
       * screen while it can't be used, as its tools say.
       */
      get surfaces() {
        const screenWhy = screen && unavailableNow();
        return surfaces.map((one) =>
          one.surface === "browser" && browserDown
            ? {
                ...one,
                unavailable: "Its browser has stopped. Stop the computer and start it again.",
              }
            : one.surface === "screen" && screenWhy
              ? { ...one, unavailable: screenWhy }
              : one,
        );
      },
      acting: () => presence.acting(),
      openLive: async (surface, mode, request, socket, head) =>
        live.open(surface, mode, request, socket, head),
      handle: async (endpoint, request, response) => {
        if (endpoint === "computer") {
          const agentExec = exec as AgentExec;
          // Where the person has switches, each call is read whole and checked as it comes, so
          // one sent slowly is checked as the switches are when it arrives.
          if (!this.#switches || request.method !== "POST")
            return agentExec.handle(request, response);
          const read = await readRequest(request, response, MAX_CALL);
          if (!read) return;
          const { message } = read;
          if (!message) return refuseBody(response);
          const refusal =
            message?.method === "tools/call" && this.#toolRefused(String(message.params?.name));
          if (refusal) return refuseCall(response, message.id, refusal);
          return agentExec.handle(request, response, message);
        }
        if (endpoint === "screen") return (screen as Screen).handle(request, response);
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
