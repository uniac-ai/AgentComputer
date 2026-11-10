// A computer's live surfaces, where its processes run: its terminals, the agent's commands and a
// person's shells alike, its files, which files-live.ts holds, and its browser, which
// browser-live.ts holds. Each is a WebSocket in a small protocol of its own.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { AgentExec, CommandEvent } from "@agentorg/exec";
import { type WebSocket, WebSocketServer } from "ws";
import type { BrowserLive } from "./browser-live.ts";
import { FilesLive, MAX_PART, reason } from "./files-live.ts";
import type { components } from "./generated/schema.js";
import { pieces } from "./text.ts";

type Schemas = components["schemas"];
export type Surface = Schemas["Surface"];
export type LiveMode = Schemas["LiveMode"];
export type SurfaceInfo = Schemas["SurfaceInfo"];
type TerminalEvent = Schemas["TerminalEvent"];
export const PROTOCOLS: Record<Surface, string> = {
  terminal: "terminal@1",
  files: "files@1",
  browser: "screencast@1",
};

/** No terminal@1 message is larger, either way. A larger one closes its socket. */
const MAX_MESSAGE = 64 * 1024;
/**
 * A viewer with more than this still to be sent to it has fallen too far behind, and is closed.
 * What it missed can't be left out as a frame can, so it opens again and is shown each terminal
 * afresh. It is cut off and not told: a close frame would wait behind what it hasn't read. What a
 * new viewer is first sent isn't held to this: it is every terminal's start, output and exit,
 * which can be more. The next event is.
 */
const MAX_BUFFERED = 4 * 1024 * 1024;
const deliver = (ws: WebSocket, message: TerminalEvent) => {
  if (ws.bufferedAmount > MAX_BUFFERED) ws.terminate();
  else ws.send(JSON.stringify(message));
};
/** The most of its command and of its folder that a terminal's start carries. */
const MAX_CMD = 8_000;
const MAX_WORKDIR = 2_000;

/** A files@1 message is a part of a file at most; a larger one closes its socket, as there. */
const SERVERS: Record<Surface, WebSocketServer> = {
  terminal: new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE }),
  files: new WebSocketServer({ noServer: true, maxPayload: MAX_PART }),
  browser: new WebSocketServer({ noServer: true }),
};

const MALFORMED = "That isn't a terminal@1 message.";

const first = (text: string, most: number) => {
  const [head = ""] = pieces(text, most);
  return head;
};
/** One event as terminal@1 messages: what a terminal wrote is as many as its text needs. */
function* messages(event: CommandEvent): Generator<TerminalEvent> {
  if (event.type === "start")
    yield { ...event, cmd: first(event.cmd, MAX_CMD), workdir: first(event.workdir, MAX_WORKDIR) };
  else if (event.type === "exit") yield event;
  else for (const text of pieces(event.text)) yield { ...event, text };
}

export class Live {
  readonly #terminals: AgentExec["terminals"] | undefined;
  readonly #viewers = new Set<WebSocket>();

  readonly #browser: BrowserLive | undefined;
  readonly #files: FilesLive | undefined;
  /** Whether a person may write files here: not where the agent can only read them. */
  readonly #writes: boolean;

  constructor(exec: AgentExec | undefined, access: Schemas["Access"], browser?: BrowserLive) {
    if (exec && access === "terminal") {
      this.#terminals = exec.terminals;
      exec.onCommand((event) => {
        for (const message of messages(event)) for (const ws of this.#viewers) deliver(ws, message);
      });
    }
    this.#files = exec && new FilesLive(exec.files);
    this.#writes = access !== "read";
    this.#browser = browser;
  }

  surfaces(): SurfaceInfo[] {
    const surfaces: SurfaceInfo[] = [];
    if (this.#terminals)
      surfaces.push({ surface: "terminal", protocol: PROTOCOLS.terminal, operate: true });
    if (this.#files)
      surfaces.push({ surface: "files", protocol: PROTOCOLS.files, operate: this.#writes });
    if (this.#browser)
      surfaces.push({ surface: "browser", protocol: PROTOCOLS.browser, operate: true });
    return surfaces;
  }

  /** Take an upgraded request as a socket on one surface. */
  open(surface: Surface, mode: LiveMode, request: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on("error", () => socket.destroy());
    SERVERS[surface].handleUpgrade(request, socket, head, (ws) => {
      ws.on("error", () => ws.terminate());
      if (surface === "terminal" && this.#terminals) this.#view(ws, mode, this.#terminals);
      else if (surface === "files" && this.#files) this.#files.open(ws, mode);
      else if (surface === "browser" && this.#browser) this.#browser.open(ws, mode);
      else ws.close(1011, `There's no ${surface} here.`);
    });
  }

  /** The terminals themselves end with the AgentExec that runs them. */
  close() {
    void this.#browser?.close();
    this.#files?.close();
    for (const ws of this.#viewers) ws.close(1001, "It stopped.");
  }

  /**
   * terminal@1: every terminal on one socket. Those already here come first, each with the end of
   * what it wrote, and then each event as it happens. Listing and joining are one step, so nothing
   * falls between them.
   */
  #view(ws: WebSocket, mode: LiveMode, terminals: AgentExec["terminals"]) {
    for (const { id, by, cmd, workdir, tty, at, output, exitCode, endedAt } of terminals.list()) {
      const events: CommandEvent[] = [{ type: "start", id, by, cmd, workdir, tty, at }];
      if (output) events.push({ type: "output", id, text: output });
      if (exitCode !== undefined && endedAt)
        events.push({ type: "exit", id, exitCode, at: endedAt });
      // Not through deliver: this is sent whole, however much it is.
      for (const event of events)
        for (const message of messages(event)) ws.send(JSON.stringify(message));
    }
    this.#viewers.add(ws);
    ws.on("close", () => this.#viewers.delete(ws));
    if (mode !== "operate") return;
    // What can't be done is answered to the socket that asked, with why.
    const refuse = (why: unknown) => deliver(ws, { type: "refused", message: reason(why) });
    ws.on("message", (data: Buffer) => {
      try {
        // The terminals take their types as given, and check a size themselves: the rest is
        // checked here.
        const sent = (JSON.parse(data.toString()) ?? {}) as Record<string, unknown>;
        const { type, id, text } = sent;
        const [columns, rows] = [sent.columns as number, sent.rows as number];
        if (type === "open") terminals.open({ columns, rows });
        else if (typeof id !== "string") throw new Error(MALFORMED);
        else if (type === "input" && typeof text === "string") terminals.write(id, text);
        else if (type === "resize") terminals.resize(id, columns, rows);
        else if (type === "stop") terminals.stop(id).catch(refuse);
        else throw new Error(MALFORMED);
      } catch (error) {
        refuse(error instanceof SyntaxError ? MALFORMED : error);
      }
    });
  }
}
