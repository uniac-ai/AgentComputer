// The setup of this machine for its computer: for each part an agent can use (its terminal, its
// files, its screen and the person's own browser), the person's switch, and what that part still
// needs before it works. Asking for what a part needs takes the steps on this machine, so a
// window, wherever it is drawn, only shows them. The terminal needs nothing, nor do the files off
// macOS. On macOS the Mac asks folder by folder for the folders it protects, so the files list
// them as one need, asked for on one click: each is read once then. The screen needs Cua Driver,
// and Screen Recording and
// Accessibility for the app whose grants it uses, its own or the app hosting it; the browser needs
// remote debugging on. Only macOS asks. Nothing that shows an alert or a window comes from a
// switch: each comes from asking for that one need, on the person's click.
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { release } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ApiError } from "@agentorg/computer-base/error";
import { writePrivate } from "@agentorg/computer-base/store";
import { browsers, debuggingOn, here, type Where } from "@agentorg/computer-browser/own-browser";
import type { components } from "@agentorg/computer-contract/schema";
import { driverApp, infoValue } from "@agentorg/computer-screen/driver-app";
import {
  type DriverAt,
  driverGrants,
  findDriver,
  QUIET,
  quiet,
  screenCheck,
} from "@agentorg/computer-screen/screen";
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
  /** The kernel's release, as `uname -r` gives it: on a Mac, Darwin's, 25 for macOS 26. */
  release: string;
  /** Run a program to its end; it fails with what the program said. */
  run(program: string, args: string[]): Promise<void>;
  /** Start a program, and let it run on by itself. */
  start(program: string, args: string[], env: NodeJS.ProcessEnv): Promise<void>;
  /**
   * Read a folder's names once, as the service: on a Mac, macOS asks for a folder it protects then,
   * the first time, and waits for the person's answer. `refused` where macOS refuses it, `gone`
   * where it isn't there or can't be read for another reason.
   */
  touch(folder: string): Promise<"read" | "refused" | "gone">;
  /** The names in a folder that macOS doesn't protect; none where it can't be read. */
  entries(folder: string): Promise<string[]>;
}

const exec = promisify(execFile);
const thisMachine = (): Machine => ({
  ...here(),
  release: release(),
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
  touch: async (folder) => {
    try {
      await readdir(folder);
      return "read";
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      return code === "EPERM" || code === "EACCES" ? "refused" : "gone";
    }
  },
  entries: (folder) => readdir(folder).catch(() => []),
});

/** How long the driver's app has to start answering before its grant runs anyway. */
const APP_MS = 10_000;
/**
 * How long after an app's request its grant's pane opens: the app is started through the system,
 * makes the request, and macOS writes its row in the pane some 40 ms later.
 */
const PANE_MS = 1_000;
/** Darwin's release from which Screen Recording's request draws nothing: macOS 26. */
const SILENT_FROM = 25;

const grant = (value: boolean | undefined): Granted =>
  value === undefined ? "unknown" : value ? "granted" : "not-granted";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** Each grant's own pane in System Settings. */
const PANE: Partial<Record<NeedName, string>> = {
  "screen-recording":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  folders: "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders",
};
/** Where a Mac mounts its other volumes. */
const VOLUMES = "/Volumes";

/**
 * The macOS requests made through an app hosting the driver, for each grant whose request may draw
 * an alert, by the app's bundle identifier, kept in the service's folder beside the switches. macOS
 * draws that alert until the person has answered it once; a new identity is a new key.
 */
class Made {
  readonly #file: string;
  readonly #made: Record<string, string[]>;

  constructor(folder: string) {
    this.#file = join(folder, "requests.json");
    this.#made = {};
    try {
      const read: unknown = existsSync(this.#file)
        ? JSON.parse(readFileSync(this.#file, "utf8"))
        : {};
      if (read && typeof read === "object" && !Array.isArray(read))
        for (const [app, needs] of Object.entries(read))
          if (Array.isArray(needs) && needs.every((need) => typeof need === "string"))
            this.#made[app] = needs;
    } catch {
      // Unreadable, it is empty: a first request again is the request alone.
    }
  }

  has(app: string, need: NeedName) {
    return this.#made[app]?.includes(need) ?? false;
  }

  add(app: string, need: NeedName) {
    if (this.has(app, need)) return;
    this.#made[app] = [...(this.#made[app] ?? []), need];
    try {
      writePrivate(this.#file, JSON.stringify(this.#made));
    } catch {
      // Kept until the service stops: after a restart, its next request is taken as its first.
    }
  }
}

/**
 * The folders macOS protects, as the files' one need on a Mac: whether they were asked for, and
 * which the person refused, kept in the service's folder beside the switches. macOS gives no way to
 * read a folder's grant without asking for it, so until the person's click it is `unknown`, and
 * after it, what that click's answers were.
 */
class Folders {
  readonly #file: string;
  #refused: string[] | undefined;
  #asking = false;

  constructor(folder: string) {
    this.#file = join(folder, "folders.json");
    try {
      const read: unknown = existsSync(this.#file)
        ? JSON.parse(readFileSync(this.#file, "utf8"))
        : undefined;
      const refused = (read as { refused?: unknown } | undefined)?.refused;
      if (Array.isArray(refused) && refused.every((name) => typeof name === "string"))
        this.#refused = refused;
    } catch {
      // Unreadable, they are taken as never asked for.
    }
  }

  need(): Need {
    if (this.#asking || !this.#refused) return { need: "folders", state: "unknown" };
    return this.#refused.length
      ? { need: "folders", state: "not-granted", refused: this.#refused }
      : { need: "folders", state: "granted" };
  }

  /**
   * Read each folder once, one after another, as macOS asks for each and waits for the answer; a
   * second click while that goes on asks for nothing more. It answers at once.
   */
  ask(folders: () => Promise<[name: string, path: string][]>, touch: Machine["touch"]) {
    if (this.#asking) return;
    this.#asking = true;
    void (async () => {
      const refused: string[] = [];
      for (const [name, path] of await folders())
        if ((await touch(path)) === "refused") refused.push(name);
      this.#refused = refused;
      try {
        writePrivate(this.#file, JSON.stringify({ refused }));
      } catch {
        // Kept until the service stops.
      }
    })()
      .catch(() => {
        // Nothing is recorded: the next click asks again.
      })
      .finally(() => {
        this.#asking = false;
      });
  }
}

/** A part: whether it has all it needs, and each thing it needs. */
type Part = { ready: boolean; needs: Need[] };
/** The terminal's, and the files' off macOS: nothing. */
const NOTHING: Part = { ready: true, needs: [] };

export class Setup {
  readonly #switches: Switches;
  readonly #driver: Partial<DriverAt>;
  readonly #browserData: string | undefined;
  readonly #machine: Machine;
  readonly #made: Made;
  readonly #folders: Folders;

  /** `driver` and `browserData` are as `serve` names them: Cua Driver, and the browser's folder. */
  constructor(
    switches: Switches,
    driver: Partial<DriverAt> = {},
    browserData?: string,
    machine: Machine = thisMachine(),
  ) {
    this.#switches = switches;
    this.#driver = driver;
    this.#browserData = browserData;
    this.#machine = machine;
    this.#made = new Made(switches.folder);
    this.#folders = new Folders(switches.folder);
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
    return { terminal: NOTHING, files: this.#files(), screen, browser };
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

  /**
   * The files: ready, as the Mac asks folder by folder whatever is asked for here; on a Mac, the
   * folders it protects, as one need.
   */
  #files(): Part {
    if (this.#machine.platform !== "darwin") return NOTHING;
    return { ready: true, needs: [this.#folders.need()] };
  }

  /**
   * The folders macOS protects that are here: Desktop, Documents and Downloads, iCloud Drive, each
   * cloud drive's folder, and each mounted volume, of which macOS asks once for each kind.
   */
  async #protected(): Promise<[name: string, path: string][]> {
    const { home } = this.#machine;
    const shown = (names: string[]) => names.filter((name) => !name.startsWith("."));
    const clouds = join(home, "Library", "CloudStorage");
    return [
      ["Desktop", join(home, "Desktop")],
      ["Documents", join(home, "Documents")],
      ["Downloads", join(home, "Downloads")],
      ["iCloud Drive", join(home, "Library", "Mobile Documents", "com~apple~CloudDocs")],
      ...shown(await this.#machine.entries(clouds)).map((name): [string, string] => [
        name,
        join(clouds, name),
      ]),
      ...shown(await this.#machine.entries(VOLUMES)).map((name): [string, string] => [
        name,
        join(VOLUMES, name),
      ]),
    ];
  }

  /** The person's browser: ready with one on, that is, open with remote debugging on. */
  async #browser(): Promise<Part> {
    const needs = await Promise.all(
      browsers(this.#browserData, this.#machine).map(
        async ({ browser, name, folder, installed }): Promise<Need> => ({
          need: browser,
          name,
          state: !installed ? "missing" : (await debuggingOn(folder)) ? "on" : "off",
        }),
      ),
    );
    return { ready: needs.some((one) => one.state === "on"), needs };
  }

  /**
   * Set a part's switch. Turning it on, or on again, makes only the requests that show nothing; the
   * switch stays on whether or not they could be started.
   */
  async set(capability: Switch, on: boolean): Promise<Schemas["Setup"]> {
    this.#switches.set(capability, on);
    if (on)
      try {
        await this.#quietly(capability);
      } catch (error) {
        throw new ApiError(
          409,
          `The ${capability} is on, but asking for what it needs didn't start: ${(error as Error).message}`,
        );
      }
    return this.capabilities();
  }

  /**
   * Ask for one thing a part needs, on the person's click; with none named, only what turning the
   * part on makes.
   */
  async ask(capability: Switch, need?: NeedName): Promise<Schemas["Setup"]> {
    try {
      await (need ? this.#ask(capability, need) : this.#quietly(capability));
    } catch (error) {
      throw new ApiError(409, (error as Error).message);
    }
    return this.capabilities();
  }

  /**
   * Open the pane of System Settings for one thing a part needs, whether it is missing or not: for
   * the person's own choice, as only this and asking, each on their click, open one.
   */
  async settings(capability: Switch, need: NeedName): Promise<Schemas["Setup"]> {
    try {
      await this.#needs(capability, need);
      const pane = PANE[need];
      if (!pane) throw new Error(`"${need}" has no pane of System Settings.`);
      await this.#machine.run("/usr/bin/open", [pane]);
    } catch (error) {
      throw new ApiError(409, (error as Error).message);
    }
    return this.capabilities();
  }

  /** What a part needs, where it needs the one named. */
  async #needs(capability: Switch, need?: NeedName) {
    const { needs } = (await this.#parts())[capability];
    if (need && !needs.some((one) => one.need === need))
      throw new Error(`There's no "${need}" for ${capability} here.`);
    return needs;
  }

  /**
   * Whether macOS's request for a grant draws nothing: Screen Recording's, from macOS 26, where it
   * only lists the app in its pane. Before 26 it is commonly seen to draw an alert, so it is taken
   * as one; that is untested.
   */
  #silent(need: NeedName) {
    return need === "screen-recording" && Number.parseInt(this.#machine.release, 10) >= SILENT_FROM;
  }

  /**
   * What turning a part on asks for: only the requests that show nothing, so that nothing appears
   * at a switch. For an app hosting the driver, Screen Recording's while it is missing, where its
   * request draws nothing. Accessibility's alert, Cua Driver's own grant window and a browser's
   * inspect page each wait for the person's click on that need. Only macOS asks.
   */
  async #quietly(capability: Switch) {
    if (capability !== "screen" || this.#machine.platform !== "darwin") return;
    const driver = findDriver(this.#driver);
    if (!driver?.socket || !this.#silent("screen-recording")) return;
    const needs = await this.#needs(capability);
    if (needs.some((one) => one.need === "screen-recording" && one.state !== "granted"))
      await this.#request(driver, "screen-recording");
  }

  /** Ask for one thing a part needs, on the person's click. Only macOS asks. */
  async #ask(capability: Switch, need: NeedName) {
    const needs = await this.#needs(capability, need);
    if (this.#machine.platform !== "darwin") return;
    if (capability === "screen") {
      const driver = findDriver(this.#driver);
      if (!driver) throw new Error("Cua Driver isn't installed on this machine.");
      // A grant already given is only shown.
      if (needs.some((one) => one.need === need && one.state === "granted")) return;
      await (driver.socket ? this.#askHost(driver, need) : this.#askScreen(driver));
    }
    if (capability === "browser") await this.#askBrowser(need);
    if (capability === "files") this.#folders.ask(() => this.#protected(), this.#machine.touch);
  }

  /**
   * Cua Driver's own grant, with its app running first, started through the system so that the
   * Mac names CuaDriver in what it asks, not whatever started the service. It asks in its own
   * order, Accessibility first. Neither sends telemetry nor checks for updates.
   */
  async #askScreen(driver: DriverAt) {
    const answers = async () => (await driverGrants(driver)).accessibility !== undefined;
    // Started through the system, where the driver is its app's own program.
    const app = await driverApp(driver.program);
    if (app?.own && !(await answers())) {
      await this.#machine.run("/usr/bin/open", [
        "-g",
        "-a",
        app.app,
        ...Object.entries(QUIET).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
        "--args",
        "serve",
      ]);
      for (const end = Date.now() + APP_MS; Date.now() < end && !(await answers()); )
        await sleep(500);
    }
    await this.#machine.start(driver.program, ["permissions", "grant"], quiet());
  }

  /**
   * A grant of the app hosting the driver, which the driver can't ask for, on the person's click.
   * The app makes macOS's request each time, so macOS asks again whenever it would, such as after a
   * reset of the app's privacy entries. The grant's pane opens as well, once the app's row is
   * written there, except at the first request of one whose request may draw an alert: macOS draws
   * it until the person has answered it once, and its own button opens the pane.
   */
  async #askHost(driver: DriverAt, need: NeedName) {
    const host = await this.#request(driver, need);
    if (!this.#silent(need)) {
      const app = (await infoValue(host.app, "CFBundleIdentifier")) ?? host.app;
      const first = !this.#made.has(app, need);
      this.#made.add(app, need);
      if (first) return;
    }
    await this.#pane(need);
  }

  /** A grant's pane, once the request just made has had its row written there. */
  async #pane(need: NeedName) {
    const pane = PANE[need];
    if (!pane) return;
    await sleep(PANE_MS);
    try {
      await this.#machine.run("/usr/bin/open", [pane]);
    } catch (error) {
      throw new Error(
        `macOS's request was made, but its pane didn't open: ${(error as Error).message}`,
      );
    }
  }

  /**
   * macOS's request for a grant of the app hosting the driver: the app makes it, opened through the
   * system so that it is the app's own, whatever started the service, with `grant` and the grant.
   */
  async #request(driver: DriverAt, need: NeedName) {
    const host = await driverApp(driver.program);
    if (!host)
      throw new Error(
        "The app running Cua Driver can't be told from here: the driver isn't inside it.",
      );
    await this.#machine.run("/usr/bin/open", ["-n", "-g", "-a", host.app, "--args", "grant", need]);
    return host;
  }

  /**
   * The browser asked for, opened at its inspect page, where remote debugging is switched on. One
   * the service was given only the folder of, the person opens themselves.
   */
  async #askBrowser(need: NeedName) {
    const one = browsers(this.#browserData, this.#machine).find((kind) => kind.browser === need);
    if (!one) return;
    if (!one.installed) throw new Error(`${one.name} isn't installed on this machine.`);
    if (!one.at)
      throw new Error(
        `Open ${one.name} yourself, and switch on remote debugging at its inspect page, ${one.page}.`,
      );
    await this.#machine.run("/usr/bin/open", ["-a", one.at, one.page]);
  }
}
