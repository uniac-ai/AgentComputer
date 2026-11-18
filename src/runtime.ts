// How a computer runs, and this computer: the machine the service runs on, lent whole. Its
// computers are put together by the inside with what this machine adds: the person's switches, the
// screen's checks, the person's own browser, and the board of who acts on its files and screen.
// `container.ts` is the other way.
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { BrowserConfig } from "@agentorg/computer-browser/browser";
import { ownBrowser } from "@agentorg/computer-browser/own-browser";
import { channelProgram, DEFAULT_CHANNEL, playwright } from "@agentorg/computer-browser/playwright";
import type { components } from "@agentorg/computer-contract/schema";
import { startComputer } from "@agentorg/computer-inside/computer";
import type { LiveMode, Surface, SurfaceInfo } from "@agentorg/computer-inside/live";
import { Board } from "@agentorg/computer-inside/presence";
import {
  type DriverAt,
  findDriver,
  onlyGrantsMissing,
  screenCheck,
} from "@agentorg/computer-screen/screen";
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
 * How long `info` waits for a new check of the screen, well short of the seconds a client gives it.
 */
const SCREEN_WAIT_MS = 1_000;

export class ThisComputer implements Runtime {
  readonly #config: BrowserConfig;
  /** Cua Driver as it was named, if it was; otherwise it is looked for. */
  readonly #screenDriver: Partial<DriverAt>;
  /** The person's browser's user data folder, where named; otherwise Chrome's, then Edge's. */
  readonly #ownBrowserData: string | undefined;
  /** The person's switches for this machine. */
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
  readonly #machine = new Board();

  constructor(
    config: BrowserConfig,
    screenDriver: Partial<DriverAt> = {},
    ownBrowserData?: string,
    switches?: Switches,
  ) {
    this.#ownBrowserData = ownBrowserData;
    this.#switches = switches;
    this.#config = config;
    this.#screenDriver = screenDriver;
    void this.#checkScreen();
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
      ownBrowser(this.#ownBrowserData),
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
        { kind: "own" as const, ...unless("browser", readiness(own)) },
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
    return startComputer(
      spec,
      folder,
      events,
      { browser: this.#config, contained: false },
      {
        board: this.#machine,
        refused: this.#switches ? (part) => this.#switches?.refused(part) : undefined,
        ownBrowser: () => ownBrowser(this.#ownBrowserData),
        screen: async () => {
          const checked = await this.#checkScreen();
          const { readiness: ready, driver } = checked;
          const off = this.#switches?.refused("screen");
          const why =
            off ??
            (ready.ready && driver ? undefined : (ready.reason ?? "The screen isn't ready."));
          return {
            why,
            strict: off !== undefined || !onlyGrantsMissing(checked),
            at: () => this.#driverNow(),
            refused: () => this.#screenRefused(),
            lends: this.#switches?.lends ?? false,
            unavailable: () => this.#screenUnavailable(),
          };
        },
      },
    );
  }
}
