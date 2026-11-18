// How a computer runs, and this computer: the machine the service runs on, lent whole. Its
// computers are put together by the inside with what this machine adds: the person's switches, the
// screen's checks, the person's own browser, and the board of who acts on its files and screen.
// The containers kind is the other way.
import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { VERSION } from "@agentorg/computer-base/version";
import type { BrowserConfig } from "@agentorg/computer-browser/browser";
import { ownBrowser } from "@agentorg/computer-browser/own-browser";
import { channelProgram, DEFAULT_CHANNEL, playwright } from "@agentorg/computer-browser/playwright";
import type { components } from "@agentorg/computer-contract/schema";
import { TOOLS } from "@agentorg/computer-inside/client";
import { type Computer, startComputer } from "@agentorg/computer-inside/computer";
import { Board } from "@agentorg/computer-inside/presence";
import type {
  Access,
  Brought,
  ComputerSpec,
  Offer,
  Running,
  Runtime,
  RuntimeEvents,
} from "@agentorg/computer-provider/seam";
import {
  type DriverAt,
  findDriver,
  onlyGrantsMissing,
  SCREEN_TOOLS,
  screenCheck,
} from "@agentorg/computer-screen/screen";
import { Connections } from "./connection.ts";
import { Setup } from "./setup.ts";
import type { Switch, Switches } from "./switches.ts";

type Schemas = components["schemas"];

/** Why a service that other machines can reach doesn't offer this computer. */
export const NOT_HERE =
  "This service can be reached from other machines, so it doesn't offer the machine it runs on. Make a computer in a container, or attach this computer through a service that only this machine reaches.";
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
  /** Its computers running now: who acts on them is answered here. */
  readonly #computers = new Set<Computer>();
  /** What this machine needs set up for this computer to reach all of it, where it has switches. */
  readonly #setup: Setup | undefined;
  /** Who is connected, holding a connection: known once the service says how it is reached. */
  #connections: Connections | undefined;
  /** Why this computer isn't offered here, where it isn't. */
  #notHere: string | undefined;

  readonly isolation = "none";
  readonly attaches = true;
  readonly notMade =
    "A computer with no isolation is no longer made. Attach this computer, or make a container.";

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
    this.#setup = switches && new Setup(switches, screenDriver, ownBrowserData);
    void this.#checkScreen();
  }

  reached({ onlyThisMachine, proxied }: { onlyThisMachine: boolean; proxied: boolean }) {
    this.#notHere = onlyThisMachine ? undefined : NOT_HERE;
    // Behind a proxy every client comes from it, so where one connects from tells nothing.
    this.#connections = new Connections(proxied);
  }

  refused() {
    return this.#notHere;
  }

  tools({ access }: { access: Access }) {
    return { computer: access === "none" ? [] : TOOLS[access], screen: SCREEN_TOOLS };
  }

  /** The operations this machine answers: its setup, who is connected, and who is acting. */
  get operations(): Brought {
    const setup = this.#setup;
    return {
      ...(setup && {
        getSetup: () => setup.capabilities(),
        setSetup: ({ capability, on }) => setup.set(capability, on),
        askSetup: ({ capability, need }) => setup.ask(capability, need),
        openSetupSettings: ({ capability, need }) => setup.settings(capability, need),
      }),
      getConnection: async () => (this.#connections as Connections).state(),
      getActing: async () => this.#acting(),
    };
  }

  /** A client holding a connection, as long as it holds it. */
  readonly sockets = {
    "/v1/connection": (request: IncomingMessage, socket: Duplex, head: Buffer, url: URL) =>
      (this.#connections as Connections).open(
        request,
        socket,
        head,
        url.searchParams.get("name") ?? "",
      ),
  };

  close() {
    this.#connections?.close();
  }

  /**
   * Who is acting now on every computer attached to this machine, the most recent first. Their
   * files and screen are one board, which each of them lists: those are listed once. A
   * computer's terminals and browser are its own, so theirs are listed as each has them.
   */
  #acting(): Schemas["Acting"][] {
    const shared = new Map<string, Schemas["Acting"]>();
    const own: Schemas["Acting"][] = [];
    for (const computer of this.#computers)
      for (const one of computer.acting()) {
        if (one.capability !== "files" && one.capability !== "screen") {
          own.push(one);
          continue;
        }
        const key = JSON.stringify([one.who, one.name, one.capability]);
        const known = shared.get(key);
        if (!known || known.at < one.at) shared.set(key, one);
      }
    return [...shared.values(), ...own].sort((a, b) => b.at.localeCompare(a.at));
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
    const offered: Offer = {
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
    return this.#notHere ? { ...offered, ready: false, reason: this.#notHere } : offered;
  }

  async prepare() {}

  starting() {
    return { reason: "It is being started.", progress: null };
  }

  async stopLeftover() {}

  async remove() {}

  async start(spec: ComputerSpec, folder: string, events: RuntimeEvents): Promise<Running> {
    const computer = await startComputer(
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
    this.#computers.add(computer);
    return {
      // It runs this service's own program.
      version: VERSION,
      get browserTools() {
        return computer.browserTools;
      },
      get surfaces() {
        return computer.surfaces;
      },
      handle: (endpoint, request, response) => computer.handle(endpoint, request, response),
      openLive: (surface, mode, request, socket, head) =>
        computer.openLive(surface, mode, request, socket, head),
      stop: async () => {
        this.#computers.delete(computer);
        await computer.stop();
      },
    };
  }
}
