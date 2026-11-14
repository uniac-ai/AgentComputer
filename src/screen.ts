// This computer's screen, for its agent: three tools, see, act and apps, served over MCP and done
// through Cua Driver, which the person installs and grants once. None of the driver's other tools
// is ever offered: not its perception extension, its scripts, its clipboard or its recording.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { components } from "./generated/schema.js";

type Readiness = components["schemas"]["Readiness"];
const run = promisify(execFile);

/** The oldest Cua Driver this is built and tested against. */
export const DRIVER_VERSION = "0.49.7";
/** The agent's screen tools. */
export const SCREEN_TOOLS = ["see", "act", "apps"];
const INSTALL = "Install the signed app from cua.ai/download";

/**
 * Where Cua Driver is: the program given, or else the one on the path, where its installer links
 * it, or inside its app.
 */
export function driverProgram(given?: string): string | undefined {
  if (given) return existsSync(given) ? given : undefined;
  return [
    ...(process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, "cua-driver")),
    join(homedir(), ".local", "bin", "cua-driver"),
    "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
  ].find((path) => path && existsSync(path));
}

const older = (version: string, than: string) => {
  const [a, b] = [version, than].map((one) => one.split(".").map(Number));
  for (let i = 0; i < 3; i++)
    if ((a?.[i] ?? 0) !== (b?.[i] ?? 0)) return (a?.[i] ?? 0) < (b?.[i] ?? 0);
  return false;
};

/** Whether the screen can be reached through Cua Driver here, and if not, what to do. */
export async function screenReadiness(given?: string): Promise<Readiness> {
  const program = driverProgram(given);
  if (!program)
    return {
      ready: false,
      reason: `Cua Driver isn't installed on this machine. ${INSTALL}, then grant it Screen Recording and Accessibility.`,
    };
  try {
    const { stdout } = await run(program, ["--version"], { timeout: 5_000, env: quiet() });
    const version = /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? "0.0.0";
    if (older(version, DRIVER_VERSION))
      return {
        ready: false,
        reason: `Cua Driver ${version} is older than ${DRIVER_VERSION}. ${INSTALL} to update it.`,
      };
  } catch {
    return { ready: false, reason: `Cua Driver at ${program} doesn't run. ${INSTALL} again.` };
  }
  // Only macOS asks for grants, and the driver answers for its own app, not for whoever asks.
  if (process.platform !== "darwin") return { ready: true };
  try {
    const { stdout } = await run(program, ["permissions", "status", "--json"], {
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
        reason: `Can't tell whether Cua Driver is granted Screen Recording and Accessibility: ${status.reason ?? "it didn't say"}`,
      };
    const missing = [
      ...(status.screen_recording ? [] : ["Screen Recording"]),
      ...(status.accessibility ? [] : ["Accessibility"]),
    ];
    if (missing.length === 0) return { ready: true };
    return {
      ready: false,
      reason: `Cua Driver isn't granted ${missing.join(" or ")}. Grant it in System Settings, under Privacy & Security, or with cua-driver permissions grant.`,
    };
  } catch {
    return {
      ready: false,
      reason: "Can't tell whether Cua Driver is granted Screen Recording and Accessibility.",
    };
  }
}

/** The driver's own environment, with its telemetry off for what this starts. */
const quiet = () => ({ ...process.env, DO_NOT_TRACK: "1" }) as Record<string, string>;

type Answer = { content?: unknown[]; isError?: boolean };
type Args = Record<string, unknown>;
/** Only what was given: the driver reads a key left out as its own default. */
const given = (args: Args) =>
  Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));

const Window = {
  pid: z.number().int().optional().describe("The app's process id, from apps."),
  window_id: z.number().int().optional().describe("The window's id, from apps."),
};
const ACTIONS = [
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "type",
  "key",
  "hotkey",
] as const;

/** Each action, as the driver's tool that does it and the arguments it takes. */
function driverCall(input: {
  action: (typeof ACTIONS)[number];
  pid?: number | undefined;
  window_id?: number | undefined;
  element?: string | undefined;
  x?: number | undefined;
  y?: number | undefined;
  to_x?: number | undefined;
  to_y?: number | undefined;
  text?: string | undefined;
  key?: string | undefined;
  keys?: string[] | undefined;
  direction?: string | undefined;
  amount?: number | undefined;
  delivery_mode?: string | undefined;
}): [string, Args] {
  const { action, pid, window_id, element, x, y, delivery_mode } = input;
  // A point on the whole screen is in its picture's frame, which no window owns.
  const at = given({
    pid,
    window_id,
    element_token: element,
    x,
    y,
    delivery_mode,
    ...(pid === undefined && element === undefined ? { scope: "desktop" } : {}),
  });
  switch (action) {
    case "click":
    case "double_click":
    case "right_click":
      return [action, at];
    case "drag":
      return [
        "drag",
        given({
          pid,
          window_id,
          from_x: x,
          from_y: y,
          to_x: input.to_x,
          to_y: input.to_y,
          delivery_mode,
          ...(pid === undefined ? { scope: "desktop" } : {}),
        }),
      ];
    case "scroll":
      return ["scroll", { ...at, ...given({ direction: input.direction, amount: input.amount }) }];
    case "type":
      return ["type_text", { ...at, text: input.text ?? "" }];
    case "key":
      return ["press_key", { ...at, key: input.key ?? "" }];
    case "hotkey":
      return [
        "hotkey",
        given({ pid, window_id, element_token: element, keys: input.keys, delivery_mode }),
      ];
  }
}

export class Screen {
  readonly #client = new Client({ name: "agentcomputer", version: "1" });
  readonly #transport: StdioClientTransport;
  readonly #started: Promise<void>;
  /** The line to add to each answer, as the agent calls: who else acted on the screen. */
  noted: (() => string | undefined) | undefined;

  /** `program` is Cua Driver; `log` hears what it writes, and `exited` that it stopped by itself. */
  constructor(program: string, log: (line: string) => void, exited: () => void) {
    this.#transport = new StdioClientTransport({
      command: program,
      args: ["mcp"],
      env: quiet(),
      stderr: "pipe",
    });
    this.#transport.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) if (line.trim()) log(line);
    });
    let stopping = false;
    this.#transport.onclose = () => {
      if (!stopping) {
        log("Cua Driver stopped.");
        exited();
      }
    };
    this.stop = async () => {
      stopping = true;
      await this.#client.close().catch(() => {});
    };
    this.#started = this.#client.connect(this.#transport);
  }

  /** Wait until the driver answers, or say why it didn't. */
  ready() {
    return this.#started;
  }

  readonly stop: () => Promise<void>;

  async #call(tool: string, args: Args): Promise<Answer> {
    return (await this.#client.callTool({ name: tool, arguments: args })) as Answer;
  }

  /** The agent's three tools, each answered with what the driver answers, and the line after it. */
  #server() {
    const server = new McpServer({ name: "agentcomputer-screen", version: "1" });
    const answered = async (work: () => Promise<Answer>) => {
      const line = this.noted?.();
      try {
        const answer = await work();
        const content = answer.content ?? [];
        return {
          content: [...content, ...(line ? [{ type: "text" as const, text: line }] : [])],
          ...(answer.isError ? { isError: true } : {}),
        } as { content: { type: "text"; text: string }[]; isError?: boolean };
      } catch (error) {
        return {
          content: [
            { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    };
    server.registerTool(
      "see",
      {
        description:
          "Sees the screen. With no window, the whole display as a picture; with one, by pid and window_id from apps, its elements, each with a reference, and a picture of it. Act on an element by its reference, or on a point in the picture just seen.",
        inputSchema: Window,
      },
      ({ pid, window_id }) =>
        answered(() =>
          pid === undefined
            ? this.#call("get_desktop_state", {})
            : this.#call("get_window_state", given({ pid, window_id })),
        ),
    );
    server.registerTool(
      "act",
      {
        description:
          'Does one thing on the screen: click, double_click, right_click, drag (from x,y to to_x,to_y), scroll (direction, amount), type (text), key (one key, such as enter) or hotkey (keys together, such as ["ctrl","c"]). Aim it at an element by its reference from see, or at a point x,y in the picture see gave last: in a window\'s picture with its pid and window_id, or in the whole screen\'s with neither. A point in another picture is wrong.',
        inputSchema: {
          action: z.enum(ACTIONS),
          ...Window,
          element: z.string().optional().describe("An element's reference, from see."),
          x: z.number().optional(),
          y: z.number().optional(),
          to_x: z.number().optional().describe("Where a drag ends."),
          to_y: z.number().optional(),
          text: z.string().optional().describe("What to type."),
          key: z.string().optional().describe("The key to press."),
          keys: z.array(z.string()).optional().describe("The keys to press together."),
          direction: z.enum(["up", "down", "left", "right"]).optional(),
          amount: z.number().int().positive().optional().describe("How many steps to scroll."),
          delivery_mode: z
            .enum(["background", "foreground"])
            .optional()
            .describe(
              "background, the default, acts without moving the person's pointer or taking their focus. Where that can't be done it is refused, and foreground brings the window forward and acts there, taking the focus from what the person is doing.",
            ),
        },
      },
      (input) =>
        answered(() => {
          const [tool, args] = driverCall(input);
          return this.#call(tool, args);
        }),
    );
    server.registerTool(
      "apps",
      {
        description:
          "Lists the running apps and their windows on the screen, each window with its pid and window_id. With a pid, and a window_id if given, it first brings that window forward, which moves it in front of what the person sees.",
        inputSchema: Window,
      },
      ({ pid, window_id }) =>
        answered(async () => {
          if (pid !== undefined) {
            const brought = await this.#call("bring_to_front", given({ pid, window_id }));
            if (brought.isError) return brought;
          }
          const [apps, windows] = [
            await this.#call("list_apps", {}),
            await this.#call("list_windows", { on_screen_only: true }),
          ];
          return { content: [...(apps.content ?? []), ...(windows.content ?? [])] };
        }),
    );
    return server;
  }

  /** Answer one MCP request, as the stateless transport does. */
  async handle(request: IncomingMessage, response: ServerResponse) {
    await this.#started;
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
