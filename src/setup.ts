// The setup of this machine for its computer: for each part an agent can use (its terminal, its
// files, its screen and the person's own browser), the person's switch, and what that part still
// needs before it works. Asking for what a part needs takes the steps on this machine, so a
// window, wherever it is drawn, only shows them. The terminal and the files need nothing: on
// macOS the Mac asks folder by folder. The screen needs Cua Driver's Screen Recording and
// Accessibility; the browser needs remote debugging on. Only macOS asks.
import { execFile, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { components } from "./generated/schema.js";
import { browsers, here, reachedAt, type Where } from "./own-browser.ts";
import { ApiError } from "./runtime.ts";
import {
  type DriverFound,
  type DriverGiven,
  driverGrants,
  findDriver,
  quiet,
  screenCheck,
} from "./screen.ts";
import { SWITCHES, type Switch, type Switches } from "./switches.ts";

type Schemas = components["schemas"];
type Need = Schemas["Need"];
type NeedName = Schemas["NeedName"];
type Granted = "granted" | "not-granted" | "unknown";

/**
 * What the setup opens and starts on the machine, and where it looks for browsers: this one's,
 * except where a test stands in.
 */
export interface Machine extends Where {
  /** Run a program to its end; it fails with what the program said. */
  run(program: string, args: string[]): Promise<void>;
  /** Start a program, and let it run on by itself. */
  start(program: string, args: string[], env: NodeJS.ProcessEnv): Promise<void>;
}

const exec = promisify(execFile);
const thisMachine = (): Machine => ({
  ...here(),
  run: async (program, args) => {
    try {
      await exec(program, args, { timeout: 30_000 });
    } catch (error) {
      const { stderr, message } = error as { stderr?: string; message: string };
      throw new Error(stderr?.trim() || message);
    }
  },
  start: (program, args, env) =>
    new Promise((done, failed) => {
      const child = spawn(program, args, { stdio: "ignore", detached: true, env });
      child.once("error", failed);
      child.once("spawn", () => {
        child.unref();
        done();
      });
    }),
});

/**
 * The outermost app the driver is inside, which the Mac holds its grants under, and, where the
 * driver is that app's own program, as CuaDriver's is, its place there.
 */
const IN_APP = /^(.*?\/[^/]+\.app)\/Contents\/(MacOS\/[^/]+$)?/;
/** How long the driver's app has to start answering before its grant runs anyway. */
const APP_MS = 10_000;

/**
 * The app the driver is inside, where it is in one: its name as System Settings lists the grants,
 * its own program, and whether the driver is that program.
 */
async function driverApp(program: string) {
  const found = IN_APP.exec(realpathSync(program));
  if (!found) return undefined;
  const app = found[1] as string;
  const own = found[2] !== undefined;
  let info: { CFBundleDisplayName?: string; CFBundleName?: string; CFBundleExecutable?: string } =
    {};
  try {
    const plist = join(app, "Contents", "Info.plist");
    const { stdout } = await exec("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist]);
    info = JSON.parse(stdout);
  } catch {
    // Named, and its program found, as an app's usually are.
  }
  const named = basename(app, ".app");
  return {
    app,
    name: info.CFBundleDisplayName ?? info.CFBundleName ?? named,
    program: join(app, "Contents", "MacOS", info.CFBundleExecutable ?? named),
    own,
  };
}

const grant = (value: boolean | undefined): Granted =>
  value === undefined ? "unknown" : value ? "granted" : "not-granted";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** Each grant's own pane in System Settings. */
const PANE: Partial<Record<NeedName, string>> = {
  "screen-recording":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};

/** A part: whether it has all it needs, and each thing it needs. */
type Part = { ready: boolean; needs: Need[] };
/** The terminal's and the files': nothing. */
const NOTHING: Part = { ready: true, needs: [] };

export class Setup {
  readonly #switches: Switches;
  readonly #driver: DriverGiven;
  readonly #browserData: string | undefined;
  readonly #machine: Machine;

  /** `driver` and `browserData` are as `serve` names them: Cua Driver, and the browser's folder. */
  constructor(
    switches: Switches,
    driver: DriverGiven = {},
    browserData?: string,
    machine: Machine = thisMachine(),
  ) {
    this.#switches = switches;
    this.#driver = driver;
    this.#browserData = browserData;
    this.#machine = machine;
  }

  /** Each part, its switch, whether it has all it needs, and each thing it needs. */
  async capabilities(): Promise<Schemas["Setup"]> {
    const parts = await this.#parts();
    return {
      capabilities: SWITCHES.map((capability) => ({
        capability,
        on: this.#switches.on(capability),
        ...parts[capability],
      })),
    };
  }

  async #parts(): Promise<Record<Switch, Part>> {
    const [screen, browser] = await Promise.all([this.#screen(), this.#browser()]);
    return { terminal: NOTHING, files: NOTHING, screen, browser };
  }

  /**
   * The screen: ready as the computer's readiness says, and what it needs, Cua Driver and on macOS
   * its two grants, which System Settings lists under the outermost app the driver is inside.
   */
  async #screen(): Promise<Part> {
    const { readiness, driver, grants } = await screenCheck(this.#driver, this.#machine.platform);
    if (!driver) return { ready: false, needs: [{ need: "install", state: "missing" }] };
    if (!grants) return { ready: readiness.ready, needs: [] };
    const app = await driverApp(driver.program);
    const holder = app && { holder: app.name };
    return {
      ready: readiness.ready,
      needs: [
        { need: "screen-recording", ...holder, state: grant(grants.screen_recording) },
        { need: "accessibility", ...holder, state: grant(grants.accessibility) },
      ],
    };
  }

  /** The person's browser: ready with one on, that is, open with remote debugging on. */
  async #browser(): Promise<Part> {
    const needs = await Promise.all(
      browsers(this.#browserData, this.#machine).map(
        async ({ browser, name, folder, installed }): Promise<Need> => ({
          need: browser,
          name,
          state: !installed ? "missing" : (await reachedAt(folder)) ? "on" : "off",
        }),
      ),
    );
    return { ready: needs.some((one) => one.state === "on"), needs };
  }

  /**
   * Set a part's switch. Turning it on, or on again, asks for everything it is missing; the switch
   * stays on whether or not that could be started.
   */
  async set(capability: Switch, on: boolean): Promise<Schemas["Setup"]> {
    this.#switches.set(capability, on);
    if (on)
      try {
        await this.#ask(capability);
      } catch (error) {
        throw new ApiError(
          409,
          `The ${capability} is on, but asking for what it needs didn't start: ${(error as Error).message}`,
        );
      }
    return this.capabilities();
  }

  /** Ask for one thing a part needs, or, with none named, for everything it is missing. */
  async ask(capability: Switch, need?: NeedName): Promise<Schemas["Setup"]> {
    try {
      await this.#ask(capability, need);
    } catch (error) {
      throw new ApiError(409, (error as Error).message);
    }
    return this.capabilities();
  }

  /** Only macOS asks: elsewhere there is nothing to ask the person for. */
  async #ask(capability: Switch, need?: NeedName) {
    const { needs } = (await this.#parts())[capability];
    if (need && !needs.some((one) => one.need === need))
      throw new Error(`There's no "${need}" for ${capability} here.`);
    if (this.#machine.platform !== "darwin") return;
    if (capability === "screen") {
      const driver = findDriver(this.#driver);
      if (!driver) throw new Error("Cua Driver isn't installed on this machine.");
      const missing = needs.filter((one) => one.state !== "granted").map((one) => one.need);
      const asked = need ? [need] : missing;
      if (driver.socket) await this.#askHost(driver, asked);
      else if (missing.length > 0) await this.#askScreen(driver);
      const pane = need && PANE[need];
      if (pane) await this.#machine.run("/usr/bin/open", [pane]);
    }
    if (capability === "browser" && (need || !needs.some((one) => one.state === "on")))
      await this.#askBrowser(need);
  }

  /**
   * Cua Driver's own grant, with its app running first, started through the system so that the
   * Mac names CuaDriver in what it asks, not whatever started the service. It asks in its own
   * order, Accessibility first. Neither sends telemetry.
   */
  async #askScreen(driver: DriverFound) {
    const answers = async () => (await driverGrants(driver)).accessibility !== undefined;
    // Started through the system, where the driver is its app's own program.
    const app = await driverApp(driver.program);
    if (app?.own && !(await answers())) {
      await this.#machine.run("/usr/bin/open", [
        "-g",
        "-a",
        app.app,
        "--env",
        "DO_NOT_TRACK=1",
        "--args",
        "serve",
      ]);
      for (const end = Date.now() + APP_MS; Date.now() < end && !(await answers()); )
        await sleep(500);
    }
    await this.#machine.start(driver.program, ["permissions", "grant"], quiet());
  }

  /**
   * The grants of the app hosting the driver, which the driver can't ask for: that app's own
   * program asks, `grant` and each grant to ask for, in turn.
   */
  async #askHost(driver: DriverFound, asked: NeedName[]) {
    if (asked.length === 0) return;
    const host = await driverApp(driver.program);
    if (!host)
      throw new Error(
        "The app running Cua Driver can't be told from here: the driver isn't inside it.",
      );
    await this.#machine.start(host.program, ["grant", ...asked], quiet());
  }

  /**
   * The browser asked for, or else the first this can open, Chrome before Edge, opened at its
   * inspect page, where remote debugging is switched on. One the service was given only the folder
   * of, the person opens themselves.
   */
  async #askBrowser(need?: NeedName) {
    const each = browsers(this.#browserData, this.#machine);
    const one = each.find((kind) => (need ? kind.browser === need : kind.at));
    if (!one) {
      if (each.some((kind) => kind.installed)) return;
      throw new Error("Neither Chrome nor Edge is installed on this machine.");
    }
    if (!one.installed) throw new Error(`${one.name} isn't installed on this machine.`);
    if (!one.at)
      throw new Error(
        `Open ${one.name} yourself, and switch on remote debugging at its inspect page, ${one.page}.`,
      );
    await this.#machine.run("/usr/bin/open", ["-a", one.at, one.page]);
  }
}
