// The setup of this machine for its computer: for each part an agent can use (its terminal, its
// files, its screen and the person's own browser), the person's switch, and what that part still
// needs before it works. Turning a part on takes the steps that ask for what it needs, on this
// machine, so a window, wherever it is drawn, only shows them. The terminal and the files need
// nothing: on macOS the Mac asks folder by folder. The screen needs Cua Driver's Screen
// Recording and Accessibility; the browser needs its remote-debugging switch. Only macOS asks.
import { execFile, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import type { components } from "./generated/schema.js";
import { browsers, reachedAt, type Where } from "./own-browser.ts";
import { ApiError } from "./runtime.ts";
import { driverGrants, driverProgram, quiet } from "./screen.ts";
import { SWITCHES, type Switch, type Switches } from "./switches.ts";

type Schemas = components["schemas"];
type Need = Schemas["Need"];
type Granted = "granted" | "not-granted" | "unknown";

/** What the setup reads and runs of the machine: its own, except where a test stands in. */
export interface Machine extends Where {
  /** The person's own home, whatever HOME says. */
  home: string;
  /** Run a program to its end; it fails with what the program said. */
  run(program: string, args: string[]): Promise<void>;
  /** Start a program, and let it run on by itself. */
  start(program: string, args: string[], env: NodeJS.ProcessEnv): Promise<void>;
}

const exec = promisify(execFile);
const thisMachine = (): Machine => ({
  platform: process.platform,
  home: userInfo().homedir,
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

/** The app whose own program the driver is, and that app's name. */
const DRIVER_APP = /^(.*\/([^/]+)\.app)\/Contents\/MacOS\/[^/]+$/;
/** How long the driver's app has to start answering before its grant runs anyway. */
const APP_MS = 10_000;
const MISSING: Need[] = [{ need: "install", state: "missing" }];

const grant = (value: boolean | undefined): Granted =>
  value === undefined ? "unknown" : value ? "granted" : "not-granted";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** Every item while any isn't right yet; none once all are. */
const unlessAllRight = (needs: Need[]) =>
  needs.every((one) => one.state === "granted" || one.state === "on") ? [] : needs;

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

  /** Each part, its switch, and what it still needs. */
  async capabilities(): Promise<Schemas["Setup"]> {
    const [screen, browser] = await Promise.all([this.#screen(), this.#browser()]);
    const needs: Record<Switch, Need[]> = { terminal: [], files: [], screen, browser };
    return {
      capabilities: SWITCHES.map((capability) => ({
        capability,
        on: this.#switches.on(capability),
        needs: needs[capability],
      })),
    };
  }

  /**
   * What the screen still needs: Cua Driver, and its two grants, which System Settings lists under
   * the app the driver is the program of: whatever that app is named, CuaDriver or one of ours.
   */
  async #screen(): Promise<Need[]> {
    const program = driverProgram(this.#driver);
    if (!program) return MISSING;
    if (this.#machine.platform !== "darwin") return [];
    const holder = DRIVER_APP.exec(realpathSync(program))?.[2] ?? "cua-driver";
    const { screen_recording, accessibility } = await driverGrants(program);
    return unlessAllRight([
      { need: "screen-recording", holder, state: grant(screen_recording) },
      { need: "accessibility", holder, state: grant(accessibility) },
    ]);
  }

  /** What the person's browser still needs: one browser here, with its switch on. */
  async #browser(): Promise<Need[]> {
    const found = this.#browsers();
    if (found.length === 0) return MISSING;
    const needs = await Promise.all(
      found.map(
        async ({ browser, name, folder }): Promise<Need> => ({
          need: browser,
          name,
          state: (await reachedAt(folder)) ? "on" : "off",
        }),
      ),
    );
    // One on is enough: that one is used.
    return needs.some((one) => one.state === "on") ? [] : needs;
  }

  #browsers() {
    return browsers(this.#browserData, this.#machine);
  }

  /**
   * Set a part's switch. Turning it on, or on again, takes the steps that ask for what it still
   * needs; the switch stays on whether or not they could be started.
   */
  async set(capability: Switch, on: boolean): Promise<Schemas["Setup"]> {
    this.#switches.set(capability, on);
    if (on && this.#machine.platform === "darwin")
      try {
        if (capability === "screen" && (await this.#screen()).length > 0) await this.#askScreen();
        if (capability === "browser" && (await this.#browser()).length > 0)
          await this.#askBrowser();
      } catch (error) {
        throw new ApiError(
          409,
          `It is on, but asking for what it needs didn't start: ${(error as Error).message}`,
        );
      }
    return this.capabilities();
  }

  /**
   * Cua Driver's own grant, with its app running first, started through the system so that the
   * Mac names CuaDriver in what it asks, not whatever started the service. Neither sends telemetry.
   */
  async #askScreen() {
    const program = driverProgram(this.#driver);
    if (!program) throw new Error("Cua Driver isn't installed on this machine.");
    const answers = async () => (await driverGrants(program)).accessibility !== undefined;
    const app = DRIVER_APP.exec(realpathSync(program))?.[1];
    if (app && !(await answers())) {
      await this.#machine.run("/usr/bin/open", [
        "-g",
        "-a",
        app,
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

  /** The first browser here, Chrome before Edge, opened at its remote-debugging switch. */
  async #askBrowser() {
    const found = this.#browsers().find((one) => one.at);
    if (!found) throw new Error("Neither Chrome nor Edge is installed on this machine.");
    await this.#machine.run("/usr/bin/open", ["-a", found.at as string, found.page]);
  }
}
