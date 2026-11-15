// This computer's screen, for its agent: three tools, see, act and apps, served over MCP and done
// through Cua Driver, which the person installs and grants once. None of the driver's other tools
// is ever offered: not its perception extension, its scripts, its clipboard or its recording. The
// person's live view of it, in screen-live.ts, reaches the driver the same way.
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { driverApp } from "./driver-app.ts";
import type { components } from "./generated/schema.js";
import { ApiError } from "./runtime.ts";

type Readiness = components["schemas"]["Readiness"];
const run = promisify(execFile);

/** The oldest Cua Driver this is built and tested against. */
export const DRIVER_VERSION = "0.49.7";
/** The agent's screen tools. */
export const SCREEN_TOOLS = ["see", "act", "apps"];
/** The driver's tools the three are done with, and every one it must have. */
const DRIVER_TOOLS = [
  "get_desktop_state",
  "get_window_state",
  "click",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "hotkey",
  "list_apps",
  "list_windows",
  "bring_to_front",
];
const INSTALL = "Install the signed app from cua.ai/download";

/** What every Cua Driver this starts is told: to send no telemetry, and to check for no updates. */
export const QUIET = { DO_NOT_TRACK: "1", CUA_DRIVER_RS_UPDATE_CHECK: "false" };

/** The driver's environment. */
export const quiet = (): NodeJS.ProcessEnv => ({ ...process.env, ...QUIET });

const program = (path: string) => {
  try {
    const found = statSync(path);
    return found.isFile() && (found.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

/**
 * Where Cua Driver is: its program, and, for one an app hosts, the socket that app runs it on,
 * embedded, as the driver's embedding guide has a host do. Through that socket the driver is the
 * host app's, and so are its grants.
 */
export interface DriverAt {
  program: string;
  socket?: string | undefined;
}
/** Cua Driver at what `serve` named of it, or, with no program named, wherever it is found. */
export function findDriver(given: Partial<DriverAt> = {}): DriverAt | undefined {
  const program = driverProgram(given.program);
  return program ? { program, socket: given.socket } : undefined;
}

/**
 * Where Cua Driver is: the program given, or else the one on the path, where its installer links
 * it, or inside its app.
 */
export function driverProgram(given?: string): string | undefined {
  if (given) return program(given) ? given : undefined;
  return [
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter((dir) => isAbsolute(dir))
      .map((dir) => join(dir, "cua-driver")),
    join(homedir(), ".local", "bin", "cua-driver"),
    "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
  ].find(program);
}

const older = (version: string, than: string) => {
  const [a = [], b = []] = [version, than].map((one) => one.split(".").map(Number));
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
};

/**
 * The one place that decides whether the screen can be reached here through Cua Driver: its
 * readiness, saying what to do where it isn't, the driver found, and on macOS the two grants as
 * the driver read them.
 */
export async function screenCheck(
  given?: Partial<DriverAt>,
  platform = process.platform,
): Promise<{ readiness: Readiness; driver?: DriverAt; grants?: Grants }> {
  const driver = findDriver(given);
  // A driver an app hosts is the app's to install and to update, not the person's.
  const hosted = given?.socket !== undefined;
  const install = hosted ? "Install the app that runs it" : INSTALL;
  if (!driver)
    return {
      readiness: {
        ready: false,
        reason: `Cua Driver isn't installed on this machine. ${install}, then grant it Screen Recording and Accessibility.`,
      },
    };
  const doesntRun = { ready: false, reason: `Cua Driver doesn't run. ${install} again.` };
  try {
    const { stdout } = await run(driver.program, ["--version"], { timeout: 5_000, env: quiet() });
    const version = /(\d+\.\d+\.\d+)/.exec(stdout)?.[1];
    if (!version) return { readiness: doesntRun, driver };
    if (older(version, DRIVER_VERSION))
      return {
        readiness: {
          ready: false,
          reason: `Cua Driver ${version} is older than ${DRIVER_VERSION}. ${install} to update it.`,
        },
        driver,
      };
  } catch {
    return { readiness: doesntRun, driver };
  }
  // Only macOS asks for grants, and the driver answers for the app whose grants it uses, its own
  // or its host's, not for whoever asks.
  if (platform !== "darwin") return { readiness: { ready: true }, driver };
  const grants = await driverGrants(driver);
  const missing = [
    ...(grants.screen_recording ? [] : ["Screen Recording"]),
    ...(grants.accessibility ? [] : ["Accessibility"]),
  ];
  if (missing.length === 0) return { readiness: { ready: true }, driver, grants };
  const who = hosted ? "the app running Cua Driver" : "Cua Driver";
  if (grants.accessibility === undefined || grants.screen_recording === undefined) {
    const unknown = `Can't tell whether ${who} is granted Screen Recording and Accessibility`;
    const reason = grants.reason ? `${unknown}: ${grants.reason}` : `${unknown}.`;
    return { readiness: { ready: false, reason }, driver, grants };
  }
  // An app that hosts the driver asks for its grants itself, from its own setup: System Settings
  // lists nothing for it until then, so the person is sent to the app, by its name.
  const host = hosted ? await hostName(driver.program) : undefined;
  const where = !hosted
    ? "Grant it in System Settings, under Privacy & Security."
    : host
      ? `Set it up in ${host}.`
      : "Set it up in that app.";
  const reason = `Screen Recording and Accessibility are needed, and ${host ?? who} is missing ${missing.join(" and ")}. ${where}`;
  return { readiness: { ready: false, reason }, driver, grants };
}

/** The name of each hosted driver's app, read once: it is wanted each time a grant is missing. */
const hostNames = new Map<string, string | undefined>();
async function hostName(program: string) {
  if (!hostNames.has(program)) hostNames.set(program, (await driverApp(program))?.name);
  return hostNames.get(program);
}

/** Cua Driver's two grants, as it reads them for the app whose grants it uses, and why where it can't. */
export interface Grants {
  accessibility?: boolean;
  screen_recording?: boolean;
  reason?: string;
}

/**
 * A line of the driver's, as a person or an agent is told it: the socket an app runs it on is said
 * in words, as a path in the app's folder is of no use to them.
 */
export function unpathed(line: string, socket: string | undefined): string {
  return socket ? line.split(socket).join("the app's socket") : line;
}

/**
 * Whether Cua Driver has its two grants on macOS, as it says for the app whose grants it uses: its
 * own, or, embedded, its host's, which only the driver its host runs can say, and says are the
 * host's. A grant it can't read, as when its app isn't running, is left out, with why where it
 * says.
 */
export async function driverGrants({ program, socket }: DriverAt): Promise<Grants> {
  const ask = socket
    ? ["call", "check_permissions", JSON.stringify({ prompt: false }), "--socket", socket]
    : ["permissions", "status", "--json"];
  let said: (Grants & { source?: { attribution?: string } }) | undefined;
  try {
    const { stdout } = await run(program, ask, { timeout: 15_000, env: quiet() });
    said = JSON.parse(stdout);
  } catch (error) {
    const why = String((error as { stderr?: string }).stderr ?? "").trim();
    return why ? { reason: unpathed(why.split("\n")[0] ?? "", socket) } : {};
  }
  if (!said || typeof said !== "object") return {};
  if (socket && said.source?.attribution !== "host")
    return { reason: "the driver on the app's socket doesn't run inside that app" };
  return said;
}

export type Answer = { content?: unknown[]; structuredContent?: unknown; isError?: boolean };
type Args = Record<string, unknown>;
/** Only what was given: the driver reads a key left out as its own default. */
const given = (args: Args) =>
  Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
const text = (value: string) => ({ type: "text" as const, text: value });
/** The whole screen, as the driver names it. */
export const DESKTOP = { kind: "desktop", display_id: "primary" };

const Window = {
  pid: z.number().int().optional().describe("The app's process id, from apps."),
  window_id: z.number().int().optional().describe("The window's id, from apps."),
};
const Act = z
  .object({
    action: z.enum([
      "click",
      "double_click",
      "right_click",
      "drag",
      "scroll",
      "type",
      "key",
      "hotkey",
    ]),
    ...Window,
    element_token: z.string().optional().describe("An element's reference, from see."),
    x: z.number().optional().describe("A point's x, in pixels of the picture see gave last."),
    y: z.number().optional().describe("A point's y, in pixels of that picture."),
    to_x: z.number().optional().describe("Where a drag ends: x."),
    to_y: z.number().optional().describe("Where a drag ends: y."),
    text: z.string().optional().describe("What to type."),
    key: z.string().optional().describe("The key to press, such as enter."),
    keys: z
      .array(z.string())
      .optional()
      .describe('The keys to press together, such as ["ctrl","c"].'),
    direction: z.enum(["up", "down", "left", "right"]).optional().describe("Which way to scroll."),
    amount: z.number().int().positive().optional().describe("How many steps to scroll."),
    delivery_mode: z
      .enum(["background", "foreground"])
      .optional()
      .describe(
        "Leave it out. Only if a call is refused because it can't be done in the background, repeat it with foreground, which brings the window forward and takes the person's focus.",
      ),
  })
  .strict();
/** On a lent machine: no way of delivery to choose, since it is always the background. */
const BackgroundAct = Act.omit({ delivery_mode: true });
type Act = z.infer<typeof Act>;

/** One window as the driver lists it, of which the agent is given what it can aim with. */
type Listed = {
  app_name: string;
  title: string;
  pid: number;
  window_id: number;
  bounds: { x: number; y: number; width: number; height: number };
  z_index: number | null;
};

/** What the agent is told on a lent machine in place of the driver's advice to use the foreground. */
const BACKGROUND = {
  done: "It was sent in the background, with the person's pointer left where it is: see the window to check that it took effect.",
  refused:
    "It can't be done in the background in that window, and on this machine it isn't done in the foreground either: try an element_token from see, or leave it to the person.",
  desktop:
    "On this machine the agent acts in a window, not at a point of the whole screen, which would move the person's pointer there and leave it: find the window that holds it in apps, see that window, and find it again in that window's picture to aim at.",
};

/** What can be aimed at a point of the whole screen, which the driver does by moving the pointer. */
const POINTED = new Set(["click", "double_click", "right_click", "drag", "scroll"]);

/**
 * Whether the driver refused a click in the background before sending anything, saying the
 * foreground would do it: only then is it made in the foreground, so that nothing is ever sent
 * twice. Its refusals say so with `effect: "refused"`, but for an app whose toolkit reads the real
 * pointer, which it refuses before sending and without an effect.
 */
export function foregroundWouldDo(answer: Answer): boolean {
  const said = answer.structuredContent as
    | { code?: unknown; effect?: unknown; reason?: unknown; escalation?: { recommended?: unknown } }
    | undefined;
  return (
    answer.isError === true &&
    said?.code === "background_unavailable" &&
    said.escalation?.recommended === "foreground" &&
    (said.effect === "refused" ||
      (said.effect === undefined && said.reason === "pointer_reading_toolkit"))
  );
}

type Point = { x: number; y: number };

/** An answer's words, its text parts joined. */
const saidIn = (answer: Answer) =>
  (answer.content ?? []).map((part) => (part as { text?: string }).text ?? "").join("\n");

/**
 * How much smaller than the screen a picture of the whole of it is, as the driver keeps it for the
 * connection that took it and reads that connection's later points in the whole screen against it.
 * A picture that doesn't say is the screen's own size.
 */
export function desktopScale(answer: Answer): Point {
  const said = (answer.structuredContent ?? {}) as Record<string, unknown>;
  const axis = (delivered: string, original: string) => {
    const [d, o] = [said[delivered], said[original]];
    return typeof d === "number" && typeof o === "number" && d > 0 && o > 0 ? o / d : 1;
  };
  return answer.isError
    ? { x: 1, y: 1 }
    : {
        x: axis("screenshot_width", "screenshot_original_width"),
        y: axis("screenshot_height", "screenshot_original_height"),
      };
}

/** The foreground inputs made on this machine's screen, one after another. */
let foregroundTurn: Promise<unknown> = Promise.resolve();

/**
 * `work`, once every foreground input before it on this machine's screen is done, the agents'
 * clicks and the person's in the live view alike, so that no put-back reads a pointer another input
 * moved.
 */
export function inForegroundTurn<T>(work: () => Promise<T>): Promise<T> {
  const turn = foregroundTurn.then(work);
  foregroundTurn = turn.catch(() => undefined);
  return turn;
}

/** The screen point a foreground click says it was made at, in the screen's points. */
export function clickedAt(said: string): Point | undefined {
  const found = /screen[-_]point\W*\((-?[\d.]+),\s*(-?[\d.]+)\)/.exec(said);
  return found ? { x: Number(found[1]), y: Number(found[2]) } : undefined;
}

/**
 * Where the person's pointer goes back to after a foreground click: where it was, moved as far as
 * the person moved it since the click put it at `clicked`. Where that point isn't known, where it was.
 * The driver says the click's point rounded and reads the pointer cut down, so a point's difference
 * is no motion.
 */
export function putBackAt(before: Point, after: Point, clicked: Point | undefined): Point {
  const moved = (now: number, then: number) => (Math.abs(now - then) <= 1 ? 0 : now - then);
  return clicked
    ? { x: before.x + moved(after.x, clicked.x), y: before.y + moved(after.y, clicked.y) }
    : before;
}

/** What the agent is told of a click made in the foreground, by whether the pointer came back. */
const FOREGROUND = {
  done: "It couldn't be done in the background in that window, so it was clicked in the foreground, which brings the window forward",
  refused:
    "It couldn't be done in the background in that window, and Cua Driver refused to click it in the foreground too, so the person's pointer was left as it is.",
  off: "The screen was switched off before it could be clicked in the foreground.",
  unknown:
    "It couldn't be done in the background in that window, and Cua Driver's answer to clicking it in the foreground was an error, so whether it was clicked isn't known: see the window before trying again",
  back: "the person's pointer was put back where it was",
  backMoved: "the person's pointer was put back where it was, and has moved since",
  stayed: "the person's pointer is where it was",
  notBack: "the person's pointer couldn't be put back where it was, and is where the click left it",
  elsewhere: "the person's pointer was moved, but not back to where it was",
  unread:
    "It can't be done in the background in that window, and where the person's pointer is couldn't be read, so it wasn't clicked in the foreground either, which would have left the pointer where the click put it: try an element_token from see, or leave it to the person.",
};

/** A call that failed, answered as a refusal in its own words. */
const failed = (error: unknown): Answer => ({
  content: [text(error instanceof Error ? error.message : String(error))],
  isError: true,
});

type Call = (tool: string, args: Args) => Promise<Answer>;

/**
 * What became of the real pointer around one input made in the foreground. unmoved: the driver
 * refused it outright, as it says when nothing was sent, so it moved nothing. unread: where the
 * pointer was couldn't be read first, so it wasn't put back. stayed: it is where it was, never
 * moved or already back. back: moved back where it was, as far as the person moved it meanwhile;
 * backMoved: and the person has moved it again since. notBack: it couldn't be moved back, and is
 * where the input left it. elsewhere: it was moved, but not back to where it was.
 */
export type PointerOutcome =
  | "unmoved"
  | "unread"
  | "stayed"
  | "back"
  | "backMoved"
  | "notBack"
  | "elsewhere";

/**
 * Where an input made in the foreground left the pointer: a point of the screen, in its points, as
 * a click in a window says, or of the whole screen's last picture on that connection, in its pixels,
 * as the live view aims.
 */
export type Ended = { screen: Point } | { picture: Point };

const near = (a: Point, b: Point) => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;

/**
 * The real pointer, read and put back on one connection to Cua Driver. `desktop` is how much
 * smaller than the screen that connection's last picture of the whole screen was: the driver reads
 * a point in the whole screen, as the put-back's is, against that picture. A Mac's driver moves the
 * pointer only when told to.
 */
export class RealPointer {
  readonly #call: Call;
  readonly #platform: NodeJS.Platform;
  readonly #desktop: () => Point;

  constructor(call: Call, platform: NodeJS.Platform, desktop: () => Point) {
    this.#call = call;
    this.#platform = platform;
    this.#desktop = desktop;
  }

  /** Where it is, in the screen's points; none where the driver can't say. */
  async read(): Promise<Point | undefined> {
    const answer = await this.#call("get_cursor_position", {}).catch(failed);
    const { x, y, source } = (answer.structuredContent ?? {}) as {
      x?: unknown;
      y?: unknown;
      source?: unknown;
    };
    // Where the driver can only say where it last moved the pointer itself, it isn't read.
    return !answer.isError &&
      source !== "synthetic" &&
      typeof x === "number" &&
      typeof y === "number"
      ? { x, y }
      : undefined;
  }

  /**
   * One input made in the foreground, once, with the pointer put back: read where it is, let the
   * driver make it, which moves the pointer to its point, then move it back once, as far as the
   * person moved it meanwhile. Where the pointer can't be read first, `unread` says whether the
   * input is made all the same: if not, nothing is sent and there is no answer. `ended` says where
   * an input the driver answered without an error left the pointer.
   */
  async foreground(
    tool: string,
    args: Args,
    ended: (done: Answer) => Ended | undefined,
    unread: "skip" | "make",
  ): Promise<{ done?: Answer; pointer: PointerOutcome }> {
    const before = await this.read();
    if (!before && unread === "skip") return { pointer: "unread" };
    const done = await this.#call(tool, { ...args, delivery_mode: "foreground" }).catch(failed);
    // Refused outright, as the driver says when nothing was sent, it moved nothing: whatever moved
    // the pointer meanwhile was the person, and it is left as it is. Any other error may have
    // come after the pointer moved or the input was made.
    if (
      done.isError &&
      (done.structuredContent as { effect?: unknown } | undefined)?.effect === "refused"
    )
      return { done, pointer: "unmoved" };
    if (!before) return { done, pointer: "unread" };
    return { done, pointer: await this.#putBack(before, done.isError ? undefined : ended(done)) };
  }

  /**
   * The pointer, put back once after an input that left it at `ended`: where it was, as far as the
   * person moved it since. Where that point isn't known, or the pointer can't be read after the
   * input, back where it was. Whether it came back is what the move answers.
   */
  async #putBack(before: Point, ended: Ended | undefined): Promise<PointerOutcome> {
    const after = await this.read();
    if (after && near(after, before)) return "stayed";
    // The driver moves it in pixels of the whole screen's picture at full size, which on a Mac is
    // its points times the screen's scale, read from the last picture this connection took.
    let k = 1;
    if (this.#platform === "darwin") {
      const size = await this.#call("get_screen_size", {}).catch(failed);
      const scale = (size.structuredContent as { scale_factor?: unknown } | undefined)
        ?.scale_factor;
      if (size.isError || typeof scale !== "number" || scale <= 0) return "notBack";
      k = scale;
    }
    const desktop = this.#desktop();
    const end =
      ended && "picture" in ended
        ? { x: (ended.picture.x * desktop.x) / k, y: (ended.picture.y * desktop.y) / k }
        : ended?.screen;
    const at = after ? putBackAt(before, after, end) : before;
    const moved = await this.#call("move_cursor", {
      scope: "desktop",
      x: (at.x * k) / desktop.x,
      y: (at.y * k) / desktop.y,
      // A Mac's driver moves the person's pointer over another app's window only when told to.
      ...(this.#platform === "darwin" ? { delivery_mode: "foreground" } : {}),
    }).catch(failed);
    // Moved once: never tried again.
    if (moved.isError) return "notBack";
    // Where the driver says it moved it, in the screen's points.
    const to = /moved the real desktop pointer to \((-?[\d.]+),\s*(-?[\d.]+)\)/i.exec(
      saidIn(moved),
    );
    if (to && !near({ x: Number(to[1]), y: Number(to[2]) }, at)) return "elsewhere";
    const now = await this.read();
    return !now || near(now, at) ? "back" : "backMoved";
  }
}

/** The driver's answer without its hints and suggested next calls, which can name its own tools. */
function forAgent(answer: Answer): Answer {
  if (!answer.structuredContent) return answer;
  const {
    hint: _,
    next_call: __,
    summary: ___,
    ...structured
  } = answer.structuredContent as Record<string, unknown>;
  return { ...answer, structuredContent: structured };
}

/** Each action, as the driver's tool that does it and the arguments it takes. */
export function driverCall(input: Act): [string, Args] {
  const { action, pid, window_id, element_token, x, y } = input;
  if ((pid === undefined) !== (window_id === undefined))
    throw new ApiError(400, "A window is its pid and its window_id, from apps: give both.");
  const window = pid === undefined ? undefined : { kind: "window", pid, window_id };
  const keyed = action === "type" || action === "key" || action === "hotkey";
  // Keys go to a window or an element, never to whatever the person happens to have focused.
  if (keyed && !window && element_token === undefined)
    throw new ApiError(400, `${action} needs a window, by pid and window_id, or an element_token.`);
  if (!keyed && element_token === undefined && (x === undefined || y === undefined))
    throw new ApiError(400, `${action} needs an element_token, or x and y.`);
  const common = given({
    element_token,
    // A point with no window is in the whole screen's picture.
    target: window ?? (element_token === undefined ? DESKTOP : undefined),
    delivery_mode: input.delivery_mode ?? "background",
  });
  const at = { ...common, ...given({ x, y }) };
  switch (action) {
    // One click tool for all three: the driver's own double and right click take no target.
    case "click":
      return ["click", at];
    case "double_click":
      return ["click", { ...at, count: 2 }];
    case "right_click":
      return ["click", { ...at, button: "right" }];
    case "drag":
      if (input.to_x === undefined || input.to_y === undefined)
        throw new ApiError(400, "drag needs x and y, where it starts, and to_x and to_y.");
      return ["drag", { ...common, from_x: x, from_y: y, to_x: input.to_x, to_y: input.to_y }];
    case "scroll":
      if (!input.direction) throw new ApiError(400, "scroll needs a direction.");
      return ["scroll", { ...at, ...given({ direction: input.direction, amount: input.amount }) }];
    case "type":
      if (!input.text) throw new ApiError(400, "type needs text.");
      return ["type_text", { ...at, text: input.text }];
    case "key":
      if (!input.key) throw new ApiError(400, "key needs the key to press.");
      return ["press_key", { ...at, key: input.key }];
    case "hotkey":
      if (!input.keys?.length) throw new ApiError(400, "hotkey needs the keys to press together.");
      return ["hotkey", { ...common, keys: input.keys }];
  }
}

/** A connection to Cua Driver, with every tool it needs. */
export class Driver {
  readonly #client = new Client({ name: "agentcomputer", version: "1" });
  readonly #transport: StdioClientTransport;
  readonly #started: Promise<void>;
  /** The driver's last words, to say why it didn't start. */
  #said = "";
  #stopping = false;

  /**
   * `driver` is Cua Driver, reached through its own runtime, or its host's embedded one; `log` hears
   * what it writes, and `exited` that it stopped by itself.
   */
  constructor({ program, socket }: DriverAt, log: (line: string) => void, exited: () => void) {
    this.#transport = new StdioClientTransport({
      command: program,
      args: socket ? ["mcp", "--embedded", "--socket", socket] : ["mcp"],
      env: quiet() as Record<string, string>,
      stderr: "pipe",
    });
    this.#transport.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n"))
        if (line.trim()) {
          // Its own words go to the log as they are, and to whoever it refuses without the path.
          this.#said = unpathed(line.trim(), socket);
          log(line);
        }
    });
    this.#transport.onclose = () => {
      if (this.#stopping) return;
      log("Cua Driver stopped.");
      exited();
    };
    this.#started = this.#client.connect(this.#transport).then(async () => {
      // A driver without one of them would answer the agent with its own refusal: none is better.
      const offered = new Set((await this.#client.listTools()).tools.map((tool) => tool.name));
      const lacking = DRIVER_TOOLS.filter((tool) => !offered.has(tool));
      if (lacking.length > 0) throw new Error(`it has no ${lacking.join(", ")}.`);
    });
  }

  /** Wait until the driver answers with every tool it needs, or say why it didn't. */
  async ready() {
    try {
      await this.#started;
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new ApiError(409, `Cua Driver didn't start: ${this.#said || why}`);
    }
  }

  async stop() {
    this.#stopping = true;
    await this.#client.close().catch(() => {});
  }

  async call(tool: string, args: Args): Promise<Answer> {
    return (await this.#client.callTool({ name: tool, arguments: args })) as Answer;
  }
}

/**
 * The agent's screen: its three tools, and a connection of its own to the driver, made at the first
 * call that needs it and made again after the driver stopped, as when it is started again to read
 * a grant the person gave. While the screen can't be used, its tools say why, and nothing more.
 */
export class Screen {
  /** Cua Driver as it is found at each connection. */
  readonly #at: () => DriverAt;
  readonly #log: (line: string) => void;
  readonly #noted: () => string | undefined;
  readonly #refused: () => Promise<string | undefined>;
  /** The driver's connection, while there is one. */
  #driver: Driver | undefined;
  #stopped = false;
  /** How many connections it has made, and whether the screen was seen on the one there is. */
  #connections = 0;
  #seen = false;

  /** On a lent machine: the agent acts only in the background, leaving the person's pointer. */
  readonly #onlyBackground: boolean;
  /**
   * How much smaller than the screen the whole screen's last picture on this connection was: the
   * driver reads a point in the whole screen, as the put-back's is, against that picture.
   */
  #desktop: Point = { x: 1, y: 1 };
  /** The real pointer, read and put back on this screen's connection. */
  readonly #pointer: RealPointer;

  /**
   * `noted` gives the line to add to each answer: who else acted on the screen. `refused` says why
   * no call is answered now: the person has it switched off, or it isn't ready. `onlyBackground`:
   * whether the agent acts only in the background, as on a lent machine.
   */
  constructor(
    driver: () => DriverAt,
    log: (line: string) => void,
    noted: () => string | undefined,
    refused: () => Promise<string | undefined>,
    onlyBackground: boolean,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.#at = driver;
    this.#log = log;
    this.#noted = noted;
    this.#refused = refused;
    this.#onlyBackground = onlyBackground;
    this.#pointer = new RealPointer(
      (tool, args) => this.call(tool, args),
      platform,
      () => this.#desktop,
    );
  }

  /**
   * A click the background can't make, made in the foreground once, with the person's pointer put
   * back, after every foreground input before it on this machine's screen.
   */
  #inForeground(tool: string, args: Args): Promise<Answer> {
    return inForegroundTurn(() => this.#foregroundOnce(tool, args));
  }

  async #foregroundOnce(tool: string, args: Args): Promise<Answer> {
    // Waited for, it may since have been switched off or stopped being ready.
    if (await this.#refused()) return { content: [text(FOREGROUND.off)], isError: true };
    const { done, pointer } = await this.#pointer.foreground(
      tool,
      args,
      (answer) => {
        const at = clickedAt(saidIn(answer));
        return at && { screen: at };
      },
      // Where the pointer can't be read, it couldn't be put back: the click isn't made.
      "skip",
    );
    if (!done || pointer === "unread") return { content: [text(FOREGROUND.unread)], isError: true };
    if (pointer === "unmoved") {
      this.#log("The agent's click couldn't be made in the background, nor in the foreground.");
      return { content: [text(FOREGROUND.refused)], isError: true };
    }
    const words = FOREGROUND[pointer];
    this.#log(
      `The agent's click couldn't be made in the background, so it was made in the foreground; ${words}.`,
    );
    return done.isError
      ? { content: [text(`${FOREGROUND.unknown}; ${words}.`)], isError: true }
      : {
          content: [
            text(`${FOREGROUND.done}; ${words}. See the window to check that it took effect.`),
          ],
          structuredContent: {
            delivery: "foreground",
            pointer_back: pointer === "stayed" || pointer === "back" || pointer === "backMoved",
          },
        };
  }

  /** The driver's connection: the one there is, or a new one, once it answers. */
  async #connected() {
    if (this.#stopped) throw new ApiError(409, "It has stopped.");
    if (!this.#driver) {
      const made: Driver = new Driver(this.#at(), this.#log, () => {
        // Stopped by itself: the next call connects again.
        if (this.#driver === made) this.#driver = undefined;
      });
      this.#driver = made;
      this.#connections += 1;
      this.#seen = false;
      this.#desktop = { x: 1, y: 1 };
    }
    const driver = this.#driver;
    try {
      await driver.ready();
    } catch (error) {
      if (this.#driver === driver) this.#driver = undefined;
      void driver.stop();
      throw error;
    }
    return driver;
  }

  /** Connect now, and wait until the driver answers, or say why it didn't. */
  async ready() {
    await this.#connected();
  }

  async call(tool: string, args: Args): Promise<Answer> {
    return (await this.#connected()).call(tool, args);
  }

  /**
   * Why a call aimed at a point is refused now: the driver reads a point against the last picture
   * its connection took, and a connection made again, as when the driver is started again for a
   * grant, has taken none. Seen again, it aims as it should.
   */
  async #unseen(input: Act): Promise<Answer | undefined> {
    if (input.element_token !== undefined || input.x === undefined) return undefined;
    await this.#connected();
    if (this.#connections === 1 || this.#seen) return undefined;
    return {
      content: [
        text(
          "Cua Driver was started again since the screen was last seen, as when a grant changes: see it again, then aim at its point.",
        ),
      ],
      isError: true,
    };
  }

  async stop() {
    this.#stopped = true;
    await this.#driver?.stop();
  }

  /** The agent's three tools, each answered with what the driver answers, and the line after it. */
  #server() {
    const server = new McpServer({ name: "agentcomputer-screen", version: "1" });
    const answered = async (work: () => Promise<Answer>) => {
      const refusal = await this.#refused();
      if (refusal) return { content: [text(refusal)], isError: true };
      const line = this.#noted();
      const answer = forAgent(await work().catch(failed));
      return {
        content: [...(answer.content ?? []), ...(line ? [text(line)] : [])],
        ...(answer.structuredContent ? { structuredContent: answer.structuredContent } : {}),
        ...(answer.isError ? { isError: true } : {}),
      } as { content: { type: "text"; text: string }[]; isError?: boolean };
    };
    const Seen = z.object(Window).strict();
    server.registerTool(
      "see",
      {
        description: `Returns the whole screen as a picture; apps lists its windows. With pid and window_id from apps, returns that window's elements, each with an element_token, and a picture of it.${
          this.#onlyBackground
            ? " On this machine the whole screen's picture is for finding a window: act aims in a window's picture."
            : ""
        }`,
        inputSchema: Seen,
      },
      ({ pid, window_id }) =>
        answered(async () => {
          if ((pid === undefined) !== (window_id === undefined))
            throw new ApiError(400, "A window is its pid and its window_id, from apps: give both.");
          const seen = await (pid === undefined
            ? this.call("get_desktop_state", {})
            : this.call("get_window_state", { pid, window_id }));
          if (!seen.isError) this.#seen = true;
          // As the driver keeps it: from a whole screen's picture it took, not from one it couldn't.
          if (pid === undefined && !seen.isError) this.#desktop = desktopScale(seen);
          return seen;
        }),
    );
    server.registerTool(
      "act",
      {
        description: `Does one thing on the screen. click, double_click, right_click: an element_token, or x and y. drag: x and y, where it starts, and to_x and to_y. scroll: direction, and amount if not 3, at an element_token or x and y. type: text. key: key, such as enter. hotkey: keys pressed together. Aim at an element_token from see, or at x and y in pixels of the picture see gave last: ${
          this.#onlyBackground
            ? "a window's, with its pid and window_id"
            : "a window's, with its pid and window_id, or the whole screen's, with neither"
        }. Click an element that can't be pressed, such as a text area, by its point. type, key and hotkey need a window or an element. See again after anything changes. ${
          this.#onlyBackground
            ? "It is done in the background, with the person's pointer left where it is; a click that can't be is made in the foreground, which brings the window forward, and the person's pointer is put back. A point of the whole screen's picture is refused here: find the window in apps, see it, and aim in its picture."
            : "If a call is refused because it can't be done in the background, repeat it with delivery_mode foreground, which takes the person's focus."
        }`,
        inputSchema: this.#onlyBackground ? BackgroundAct : Act,
      },
      (input: Act) =>
        answered(async () => {
          const [tool, args] = driverCall(input);
          // On a lent machine a point of the whole screen is refused before anything is sent: the
          // driver does it by moving the person's pointer there, and leaves it, and the front app.
          if (
            this.#onlyBackground &&
            POINTED.has(input.action) &&
            input.pid === undefined &&
            input.element_token === undefined
          )
            return { content: [text(BACKGROUND.desktop)], isError: true };
          const unseen = await this.#unseen(input);
          if (unseen) return unseen;
          const answer = await this.call(tool, args).catch(failed);
          // On a lent machine a click the background can't make, and that was sent nowhere, is
          // made in the foreground, with the person's pointer put back.
          if (
            this.#onlyBackground &&
            input.action.endsWith("click") &&
            input.pid !== undefined &&
            foregroundWouldDo(answer)
          )
            return this.#inForeground(tool, args);
          const said = (answer.content ?? [])
            .map((part) => (part as { text?: string }).text ?? "")
            .join("\n");
          // On a lent machine the driver's advice to use the foreground is said in plain words.
          if (this.#onlyBackground && /delivery_mode\W*foreground/i.test(said))
            return {
              ...answer,
              content: [text(BACKGROUND[answer.isError ? "refused" : "done"])],
            };
          // An element click the driver couldn't press: the agent is told to aim at its point.
          if (
            answer.isError &&
            input.action.endsWith("click") &&
            /AXUIElementPerformAction/.test(said)
          )
            return {
              ...answer,
              content: [
                text(
                  "That element can't be clicked by its reference. Aim at its point in the window's picture instead: x and y, with the window's pid and window_id. What the driver said:",
                ),
                ...(answer.content ?? []),
              ],
            };
          return answer;
        }),
    );
    server.registerTool(
      "apps",
      {
        description: `Lists the running apps and their windows, each window with its pid and window_id, and, as fields, each window's app_name, title, pid, window_id, z_index (higher in front) and bounds, in the screen's points rather than the pixels act aims in: to aim at a window, see it and use its picture. ${
          this.#onlyBackground
            ? "It brings no window forward itself: see and act work on a window where it is."
            : "With a pid and window_id, it first brings that window forward, in front of what the person sees."
        }`,
        // On a lent machine bringing a window forward would take the person's front app, and their typing with it.
        inputSchema: this.#onlyBackground ? z.object({}).strict() : Seen,
      },
      ({ pid, window_id }: z.infer<typeof Seen>) =>
        answered(async () => {
          if ((pid === undefined) !== (window_id === undefined))
            throw new ApiError(400, "A window is its pid and its window_id, from apps: give both.");
          if (pid !== undefined) {
            const brought = await this.call("bring_to_front", { pid, window_id });
            if (brought.isError) return brought;
          }
          const apps = await this.call("list_apps", {});
          if (apps.isError) return apps;
          const windows = await this.call("list_windows", { on_screen_only: true });
          const found = (windows.structuredContent as { windows?: unknown } | undefined)?.windows;
          const listed = Array.isArray(found) ? (found as Listed[]) : undefined;
          return {
            content: [...(apps.content ?? []), ...(windows.content ?? [])],
            ...(listed
              ? {
                  structuredContent: {
                    windows: listed.map(({ app_name, title, pid, window_id, bounds, z_index }) => ({
                      app_name,
                      title,
                      pid,
                      window_id,
                      bounds,
                      z_index,
                    })),
                  },
                }
              : {}),
            ...(windows.isError ? { isError: true } : {}),
          };
        }),
    );
    return server;
  }

  /** Answer one MCP request, as the stateless transport does. Its tools are listed with no driver. */
  async handle(request: IncomingMessage, response: ServerResponse) {
    const server = this.#server();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.once("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response);
  }
}
