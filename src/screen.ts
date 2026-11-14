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

/** The driver's environment: what this starts of it sends no telemetry. */
const quiet = (): NodeJS.ProcessEnv => ({ ...process.env, DO_NOT_TRACK: "1" });

const program = (path: string) => {
  try {
    const found = statSync(path);
    return found.isFile() && (found.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

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

/** Whether the screen can be reached through Cua Driver here, and if not, what to do. */
export async function screenReadiness(given?: string): Promise<Readiness> {
  const found = driverProgram(given);
  if (!found)
    return {
      ready: false,
      reason: `Cua Driver isn't installed on this machine. ${INSTALL}, then grant it Screen Recording and Accessibility.`,
    };
  const doesntRun = { ready: false, reason: `Cua Driver doesn't run. ${INSTALL} again.` };
  try {
    const { stdout } = await run(found, ["--version"], { timeout: 5_000, env: quiet() });
    const version = /(\d+\.\d+\.\d+)/.exec(stdout)?.[1];
    if (!version) return doesntRun;
    if (older(version, DRIVER_VERSION))
      return {
        ready: false,
        reason: `Cua Driver ${version} is older than ${DRIVER_VERSION}. ${INSTALL} to update it.`,
      };
  } catch {
    return doesntRun;
  }
  // Only macOS asks for grants, and the driver answers for its own app, not for whoever asks.
  if (process.platform !== "darwin") return { ready: true };
  const unknown = "Can't tell whether Cua Driver is granted Screen Recording and Accessibility";
  try {
    const { stdout } = await run(found, ["permissions", "status", "--json"], {
      timeout: 15_000,
      env: quiet(),
    });
    const status = JSON.parse(stdout) as {
      accessibility?: boolean;
      screen_recording?: boolean;
      reason?: string;
    };
    if (status.accessibility === undefined || status.screen_recording === undefined)
      return {
        ready: false,
        reason: status.reason ? `${unknown}: ${status.reason}` : `${unknown}.`,
      };
    const missing = [
      ...(status.screen_recording ? [] : ["Screen Recording"]),
      ...(status.accessibility ? [] : ["Accessibility"]),
    ];
    if (missing.length === 0) return { ready: true };
    return {
      ready: false,
      reason: `Cua Driver needs Screen Recording and Accessibility, and is missing ${missing.join(" and ")}. Grant it in System Settings, under Privacy & Security.`,
    };
  } catch {
    return { ready: false, reason: `${unknown}.` };
  }
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
type Act = z.infer<typeof Act>;

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

  /** `program` is Cua Driver; `log` hears what it writes, and `exited` that it stopped by itself. */
  constructor(program: string, log: (line: string) => void, exited: () => void) {
    this.#transport = new StdioClientTransport({
      command: program,
      args: ["mcp"],
      env: quiet() as Record<string, string>,
      stderr: "pipe",
    });
    this.#transport.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n"))
        if (line.trim()) {
          this.#said = line.trim();
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

/** The agent's screen: a connection of its own to the driver, and its three tools. */
export class Screen extends Driver {
  readonly #noted: () => string | undefined;

  /** `noted` gives the line to add to each answer: who else acted on the screen. */
  constructor(
    program: string,
    log: (line: string) => void,
    exited: () => void,
    noted: () => string | undefined,
  ) {
    super(program, log, exited);
    this.#noted = noted;
  }

  /** The agent's three tools, each answered with what the driver answers, and the line after it. */
  #server() {
    const server = new McpServer({ name: "agentcomputer-screen", version: "1" });
    const answered = async (work: () => Promise<Answer>) => {
      const line = this.#noted();
      let answer: Answer;
      try {
        answer = await work();
      } catch (error) {
        answer = {
          content: [text(error instanceof Error ? error.message : String(error))],
          isError: true,
        };
      }
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
        description:
          "Returns the whole screen as a picture, with its windows. With pid and window_id from apps, returns that window's elements, each with an element_token, and a picture of it.",
        inputSchema: Seen,
      },
      ({ pid, window_id }) =>
        answered(async () => {
          if (pid === undefined && window_id === undefined)
            return this.call("get_desktop_state", {});
          if (pid === undefined || window_id === undefined)
            throw new ApiError(400, "A window is its pid and its window_id, from apps: give both.");
          return this.call("get_window_state", { pid, window_id });
        }),
    );
    server.registerTool(
      "act",
      {
        description:
          "Does one thing on the screen. click, double_click, right_click: an element_token, or x and y. drag: x and y, where it starts, and to_x and to_y. scroll: direction, and amount if not 3, at an element_token or x and y. type: text. key: key, such as enter. hotkey: keys pressed together. Aim at an element_token from see, or at x and y in pixels of the picture see gave last: a window's, with its pid and window_id, or the whole screen's, with neither. type, key and hotkey need a window or an element. See again after anything changes. If a call is refused because it can't be done in the background, repeat it with delivery_mode foreground, which takes the person's focus.",
        inputSchema: Act,
      },
      (input) =>
        answered(() => {
          const [tool, args] = driverCall(input);
          return this.call(tool, args);
        }),
    );
    server.registerTool(
      "apps",
      {
        description:
          "Lists the running apps and their windows, each window with its pid and window_id. With a pid and window_id, it first brings that window forward, in front of what the person sees.",
        inputSchema: Seen,
      },
      ({ pid, window_id }) =>
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
          return {
            content: [...(apps.content ?? []), ...(windows.content ?? [])],
            ...(windows.isError ? { isError: true } : {}),
          };
        }),
    );
    return server;
  }

  /** Answer one MCP request, as the stateless transport does. */
  async handle(request: IncomingMessage, response: ServerResponse) {
    await this.ready();
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
