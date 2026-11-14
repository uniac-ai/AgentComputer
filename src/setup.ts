// The setup of this machine for its computer: for each part an agent can use (its terminal, its
// files, its screen and the person's own browser), the person's switch, and what that part still
// needs before it works. Turning a part on takes the steps that ask for what it needs, on this
// machine, so a window, wherever it is drawn, only shows them. The terminal and the files need
// nothing: on macOS the Mac asks folder by folder. The screen needs Cua Driver's Screen
// Recording and Accessibility; the browser needs its remote-debugging switch. Only macOS asks.
import { execFile, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { components } from "./generated/schema.js";
import { browsers, here, kinds, reachedAt, type Where } from "./own-browser.ts";
import { ApiError } from "./runtime.ts";
import { driverGrants, driverProgram, quiet } from "./screen.ts";
import { SWITCHES, type Switch, type Switches } from "./switches.ts";

type Schemas = components["schemas"];
type Need = Schemas["Need"];
type NeedName = Schemas["NeedName"];
type Granted = "granted" | "not-granted" | "unknown";

/** What the setup reads and runs of the machine: its own, except where a test stands in. */
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
 * and whether the driver is its own program.
 */
async function driverApp(program: string) {
  const found = IN_APP.exec(realpathSync(program));
  if (!found) return undefined;
  const app = found[1] as string;
  const own = found[2] !== undefined;
  try {
    const plist = join(app, "Contents", "Info.plist");
    const { stdout } = await exec("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist]);
    const info = JSON.parse(stdout) as { CFBundleDisplayName?: string; CFBundleName?: string };
    const name = info.CFBundleDisplayName ?? info.CFBundleName ?? basename(app, ".app");
    return { app, name, own };
  } catch {
    return { app, name: basename(app, ".app"), own };
  }
}

const grant = (value: boolean | undefined): Granted =>
  value === undefined ? "unknown" : value ? "granted" : "not-granted";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** Whether a part has all it needs: the browser one browser on; the rest, each item granted. */
const isReady = (capability: Switch, needs: Need[]) =>
  capability === "browser"
    ? needs.some((one) => one.state === "on")
    : needs.every((one) => one.state === "granted");
/** Each grant's own pane in System Settings. */
const PANE: Partial<Record<NeedName, string>> = {
  "screen-recording":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};

export class Setup {
  readonly #switches: Switches;
  readonly #driver: string | undefined;
  readonly #browserData: string | undefined;
  readonly #machine: Machine;

  /** `driver` and `browserData` are as `serve` names them: Cua Driver, and the browser's folder. */
  constructor(
    switches: Switches,
    driver?: string,
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
    const needs = await this.#needs();
    return {
      capabilities: SWITCHES.map((capability) => ({
        capability,
        on: this.#switches.on(capability),
        ready: isReady(capability, needs[capability]),
        needs: needs[capability],
      })),
    };
  }

  async #needs(): Promise<Record<Switch, Need[]>> {
    const [screen, browser] = await Promise.all([this.#screen(), this.#browser()]);
    return { terminal: [], files: [], screen, browser };
  }

  /**
   * What the screen needs: Cua Driver, and on macOS its two grants, which System Settings lists
   * under the app the driver is the program of: whatever that app is named, CuaDriver or an app
   * that bundles it.
   */
  async #screen(): Promise<Need[]> {
    const program = driverProgram(this.#driver);
    if (!program) return [{ need: "install", state: "missing" }];
    if (this.#machine.platform !== "darwin") return [];
    const [app, { screen_recording, accessibility }] = await Promise.all([
      driverApp(program),
      driverGrants(program),
    ]);
    const holder = app && { holder: app.name };
    return [
      { need: "screen-recording", ...holder, state: grant(screen_recording) },
      { need: "accessibility", ...holder, state: grant(accessibility) },
    ];
  }

  /** The person's browsers: Chrome and Edge, installed or not, or the one whose folder is named. */
  #browsers() {
    const named = this.#browserData;
    return named ? browsers(named, this.#machine) : kinds(this.#machine);
  }

  /** What the person's browser needs: one browser here with its switch on, each as it stands. */
  async #browser(): Promise<Need[]> {
    return Promise.all(
      this.#browsers().map(
        async ({ browser, name, folder, at }): Promise<Need> => ({
          need: browser,
          name,
          state: browser !== "named" && !at ? "missing" : (await reachedAt(folder)) ? "on" : "off",
        }),
      ),
    );
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
          `It is on, but asking for what it needs didn't start: ${(error as Error).message}`,
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
    const needs = (await this.#needs())[capability];
    if (need && !needs.some((one) => one.need === need))
      throw new Error(`There's no "${need}" for ${capability} here.`);
    if (this.#machine.platform !== "darwin") return;
    if (capability === "screen") {
      const program = driverProgram(this.#driver);
      if (!program) throw new Error("Cua Driver isn't installed on this machine.");
      if (!isReady("screen", needs)) await this.#askScreen(program);
      const pane = need && PANE[need];
      if (pane) await this.#machine.run("/usr/bin/open", [pane]);
    }
    if (capability === "browser" && (need || !isReady("browser", needs)))
      await this.#askBrowser(need);
  }

  /**
   * Cua Driver's own grant, with its app running first, started through the system so that the
   * Mac names CuaDriver in what it asks, not whatever started the service. It asks in its own
   * order, Accessibility first. Neither sends telemetry.
   */
  async #askScreen(program: string) {
    const answers = async () => (await driverGrants(program)).accessibility !== undefined;
    // Started through the system, where the driver is its app's own program.
    const app = await driverApp(program);
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
    await this.#machine.start(program, ["permissions", "grant"], quiet());
  }

  /**
   * The browser asked for, or else the first installed, Chrome before Edge, opened at its
   * remote-debugging switch; one the service was given only the folder of, the person opens.
   */
  async #askBrowser(need?: NeedName) {
    const one = this.#browsers().find((kind) =>
      need ? kind.browser === need : kind.at || kind.browser === "named",
    );
    if (!one) throw new Error("Neither Chrome nor Edge is installed on this machine.");
    if (one.browser === "named")
      throw new Error(`Open ${one.name} yourself, and switch on remote debugging at ${one.page}.`);
    if (!one.at) throw new Error(`${one.name} isn't installed on this machine.`);
    await this.#machine.run("/usr/bin/open", ["-a", one.at, one.page]);
  }
}
