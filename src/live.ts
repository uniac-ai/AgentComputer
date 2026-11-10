// A computer's live surfaces, where its processes run: the agent's commands as they happen, and a
// shell of the person's own. Each is a WebSocket in a small protocol of its own.

import { chmodSync, existsSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import type { AgentExec, CommandEvent } from "@agentorg/exec";
import type { IPty } from "node-pty";
import { type WebSocket, WebSocketServer } from "ws";
import type { components } from "./generated/schema.js";

type Schemas = components["schemas"];
export type Surface = Schemas["Surface"];
export type LiveMode = Schemas["LiveMode"];
export type SurfaceInfo = Schemas["SurfaceInfo"];
export const PROTOCOLS: Record<Surface, string> = { commands: "commands@1", terminal: "pty@1" };

/** What a new watcher is shown of commands that came before it. */
const MAX_EVENTS = 2_000;
const MAX_SCROLLBACK = 64 * 1024;
/** pty@1, after ttyd: one byte of type, then the payload. */
const OUTPUT = 0x30;
const INPUT = 0x30;
const RESIZE = 0x31;

const sockets = new WebSocketServer({ noServer: true });

/** node-pty, or why the terminal can't be offered here. */
let pty: Promise<typeof import("node-pty") | string> | undefined;
const loadPty = () => {
  pty ??= (async () => {
    const require = createRequire(import.meta.url);
    let loaded: typeof import("node-pty");
    try {
      loaded = require("node-pty") as typeof import("node-pty");
    } catch {
      return "The terminal needs node-pty, which isn't installed with this service.";
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
        return `The terminal needs ${helper} to be executable, and it isn't.`;
      }
    return loaded;
  })();
  return pty;
};

export class Live {
  readonly #workspace: string | undefined;
  readonly #terminal: boolean;
  readonly #events: CommandEvent[] = [];
  readonly #watchers = new Set<WebSocket>();
  readonly #shells = new Map<WebSocket, LiveMode>();
  #shell: IPty | undefined;
  #scrollback = "";

  constructor(exec: AgentExec | undefined, workspace: string | undefined, terminal: boolean) {
    this.#workspace = workspace;
    this.#terminal = terminal && exec !== undefined;
    exec?.onCommand((event) => this.#heard(event));
  }

  async surfaces(): Promise<SurfaceInfo[]> {
    if (!this.#terminal) return [];
    const loaded = await loadPty();
    return [
      { surface: "commands", protocol: PROTOCOLS.commands, operate: false },
      {
        surface: "terminal",
        protocol: PROTOCOLS.terminal,
        operate: true,
        ...(typeof loaded === "string" ? { unavailable: loaded } : {}),
      },
    ];
  }

  /** Take an upgraded request as a socket on one surface. */
  open(surface: Surface, mode: LiveMode, request: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on("error", () => socket.destroy());
    sockets.handleUpgrade(request, socket, head, (ws) => {
      ws.on("error", () => ws.terminate());
      if (surface === "commands") this.#watch(ws);
      else this.#attach(ws, mode).catch(() => ws.terminate());
    });
  }

  close() {
    for (const ws of [...this.#watchers, ...this.#shells.keys()]) ws.close(1001, "It stopped.");
    this.#shell?.kill();
    this.#shell = undefined;
  }

  #heard(event: CommandEvent) {
    this.#events.push(event);
    if (this.#events.length > MAX_EVENTS) this.#events.splice(0, this.#events.length - MAX_EVENTS);
    const message = JSON.stringify(event);
    for (const ws of this.#watchers) ws.send(message);
  }

  /** commands@1: each event as a JSON message, those before it first. Nothing comes back. */
  #watch(ws: WebSocket) {
    for (const event of this.#events) ws.send(JSON.stringify(event));
    this.#watchers.add(ws);
    ws.on("close", () => this.#watchers.delete(ws));
  }

  /** pty@1: one shell for the computer, shared by every socket on it. */
  async #attach(ws: WebSocket, mode: LiveMode) {
    const loaded = await loadPty();
    if (typeof loaded === "string") return ws.close(1011, loaded);
    if (!this.#shell) {
      this.#scrollback = "";
      let shell: IPty;
      try {
        shell = loaded.spawn(process.env.SHELL || "/bin/bash", ["-l"], {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: this.#workspace,
          env: process.env as Record<string, string>,
        });
      } catch (error) {
        return ws.close(1011, `The shell didn't start: ${String(error)}`.slice(0, 120));
      }
      shell.onData((data) => {
        this.#scrollback = (this.#scrollback + data).slice(-MAX_SCROLLBACK);
        const frame = Buffer.concat([Buffer.from([OUTPUT]), Buffer.from(data)]);
        for (const client of this.#shells.keys()) client.send(frame);
      });
      shell.onExit(() => {
        if (this.#shell !== shell) return;
        this.#shell = undefined;
        for (const client of this.#shells.keys()) client.close(1000, "The shell exited.");
      });
      this.#shell = shell;
    }
    if (this.#scrollback)
      ws.send(Buffer.concat([Buffer.from([OUTPUT]), Buffer.from(this.#scrollback)]));
    this.#shells.set(ws, mode);
    ws.on("close", () => this.#shells.delete(ws));
    ws.on("message", (data: Buffer, binary: boolean) => {
      const frame = binary ? data : Buffer.from(data);
      if (mode !== "operate" || frame.length === 0 || !this.#shell) return;
      if (frame[0] === INPUT) this.#shell.write(frame.subarray(1).toString());
      else if (frame[0] === RESIZE)
        try {
          const { columns, rows } = JSON.parse(frame.subarray(1).toString()) as {
            columns: number;
            rows: number;
          };
          if (columns > 0 && rows > 0) this.#shell.resize(Math.floor(columns), Math.floor(rows));
        } catch {
          // Not a size: ignored.
        }
    });
  }
}
