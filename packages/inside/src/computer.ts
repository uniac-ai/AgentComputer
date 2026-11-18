// One computer put together where it runs: its files and terminal from AgentExec, its browser, its
// screen, their live views, who is acting on it and its load, behind its three endpoints. This
// computer puts one together with the machine's own, through `hooks`: the person's switches, the
// screen's checks, the person's own browser and the machine's board. Inside a container there are
// none.
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
import type { components } from "@agentorg/computer-contract/schema";
import { type DriverAt, Screen } from "@agentorg/computer-screen/screen";
import { ScreenLive } from "@agentorg/computer-screen/screen-live";
import { type AgentExec, createAgentExec, type PtySpawn } from "@agentorg/exec";
import { aboutTool } from "./about.ts";
import { FilesLive } from "./files-live.ts";
import { Live, type LiveMode, type Surface, type SurfaceInfo } from "./live.ts";
import { LoadLive } from "./load-live.ts";
import { type Board, Presence } from "./presence.ts";

type Schemas = components["schemas"];
/** One of the parts the person can switch off on this machine. */
export type Part = Schemas["Switch"];
export type Endpoint = "computer" | "browser" | "screen";

/** What one computer is to be, as the kind that runs it says. */
export interface ComputerSpec {
  id: string;
  /** What its agent is called, as a person is shown it. */
  name: string;
  access: Schemas["Access"];
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

export interface ComputerEvents {
  log(line: string): void;
  /** It stopped working without being asked to. */
  failed(reason: string): void;
}

/** One computer, running: what it offers, and its endpoints and live sockets. */
export interface Computer {
  /** The tools its browser offers, read once it is up. */
  readonly browserTools: string[];
  /** What it can open live. */
  readonly surfaces: SurfaceInfo[];
  /** Who is acting on it now. */
  acting(): Schemas["Acting"][];
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

/** The machine's screen as this computer finds it when a computer with it starts. */
export interface ScreenNow {
  /** Why the screen can't be used now, where it can't. */
  why: string | undefined;
  /** Whether that refuses a new computer: it is switched off, or it lacks more than grants. */
  strict: boolean;
  /** Where the driver is now: found again at each connection. */
  at(): DriverAt;
  /** Why an agent's screen call is refused now. */
  refused(): Promise<string | undefined>;
  /** Whether the machine is lent, where the agent acts only in the background. */
  lends: boolean;
  /** Why the screen can't be opened live now. */
  unavailable(): string | undefined;
}

/** What the machine adds to a computer of its own. Inside a container, nothing. */
export interface Hooks {
  /** Who acts on the machine's files and screen, shared by the computers attached to it. */
  board?: Board | undefined;
  /** Why the person has switched one of their parts off, where they have switches. */
  refused?: ((part: Part) => string | undefined) | undefined;
  /** The person's own browser, found now: where it is reached, or why it can't be. */
  ownBrowser?:
    | (() => Promise<
        { ready: true; endpoint: string; name: string } | { ready: false; reason: string }
      >)
    | undefined;
  /** The machine's screen, checked afresh. */
  screen?: (() => Promise<ScreenNow>) | undefined;
}

export interface ComputerOptions {
  browser: BrowserConfig;
  /** Inside a container: its files and load are its own, and its files stay in its workspace. */
  contained: boolean;
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
const TOOL_SWITCH: Record<string, Part> = {
  ...Object.fromEntries([...FILE_TOOLS].map((tool) => [tool, "files" as const])),
  exec_command: "terminal",
  write_stdin: "terminal",
  list_sessions: "terminal",
  browser_run_code_unsafe: "terminal",
};

/** The most an agent's request to its computer may be, as AgentExec itself takes it. */
const MAX_CALL = 4 * 1024 * 1024;
/** Put one computer together, its private folder being `folder`. */
export async function startComputer(
  spec: ComputerSpec,
  folder: string,
  events: ComputerEvents,
  options: ComputerOptions,
  hooks: Hooks = {},
): Promise<Computer> {
  /** Why the agent can't call this tool now: the person switched off what it reaches. */
  const toolRefused = (tool: string) => {
    const which = TOOL_SWITCH[tool];
    return which && hooks.refused?.(which);
  };
  const load = new LoadLive(spec.workspace ?? folder, options.contained);
  // One with no files of its own has no part in the machine's.
  const presence = new Presence(
    spec.id,
    spec.name,
    spec.access === "none" && !spec.screen ? undefined : hooks.board,
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
        contained: options.contained,
      },
      load,
      presence,
    );
    exec = createAgentExec({
      workspace,
      level: spec.access,
      reach: options.contained ? "workspace" : "machine",
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
      const refused = hooks.refused?.("browser");
      const found = refused
        ? { ready: false as const, reason: refused }
        : await (hooks.ownBrowser as NonNullable<Hooks["ownBrowser"]>)();
      if (!found.ready) {
        await exec?.close();
        throw new ApiError(409, found.reason);
      }
      ({ endpoint: connect, name } = found);
      events.log(`Its browser is the person's own: ${name}.`);
    }
    browser = new Browser(
      { ...options.browser, connect },
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
  let screenNow: ScreenNow | undefined;
  let screen: Screen | undefined;
  let screenLive: ScreenLive | undefined;
  if (spec.screen) {
    // Asked afresh, not as last seen: a new one rests on it.
    screenNow = await (hooks.screen as NonNullable<Hooks["screen"]>)();
    const { why } = screenNow;
    // One started again keeps its terminal, files and browser: its screen's tools say why
    // they can't be used, and work once the screen can be, with no restart. So does a new one
    // whose screen lacks only macOS's grants, which the person gives from the app's setup.
    if (why && !spec.again && screenNow.strict) {
      await Promise.all([exec?.close(), browser?.stop()]);
      throw new ApiError(409, why);
    }
    // Found again at each connection: one installed or moved meanwhile is reached.
    const { at } = screenNow;
    screen = new Screen(
      at,
      events.log,
      () => presence.agentCalled({ capability: "screen" }),
      screenNow.refused,
      // On a lent machine the agent acts only in the background.
      screenNow.lends,
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
      (spec.browser === "own" ? hooks.refused?.("browser") : undefined) ??
      toolRefused(tool) ??
      ("paths" in args || "filename" in args ? hooks.refused?.("files") : undefined);
  }
  const files =
    exec &&
    new FilesLive(exec.files, basename(spec.outside?.workspace ?? (spec.workspace as string)), () =>
      presence.acted("person", { capability: "files" }),
    );
  const live = new Live(exec, spec.access, load, presence, files, browserLive, screenLive);
  const unavailableNow = () => screenNow?.unavailable();
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
        if (!hooks.refused || request.method !== "POST") return agentExec.handle(request, response);
        const read = await readRequest(request, response, MAX_CALL);
        if (!read) return;
        const { message } = read;
        if (!message) return refuseBody(response);
        const refusal =
          message?.method === "tools/call" && toolRefused(String(message.params?.name));
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
