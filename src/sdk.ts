// The TypeScript SDK. Its calls to the service are typed from openapi.yaml; a computer's commands
// and files go over that computer's own MCP endpoint. Modelled on E2B's SDK.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import createClient from "openapi-fetch";
import type { components, paths } from "./generated/schema.js";
import { pieces } from "./text.ts";

type Schemas = components["schemas"];
export type ComputerInfo = Schemas["Computer"];
export type ComputerDetail = Schemas["ComputerDetail"];
export type ServiceInfo = Schemas["ServiceInfo"];
export type ComputerLog = Schemas["ComputerLogs"]["logs"][number];
export type LiveSurface = Schemas["Surface"];
export type LiveMode = Schemas["LiveMode"];
export type LiveSession = Schemas["LiveSession"];
/**
 * What happens to a terminal, as it happens: the agent's command or a person's shell. And
 * `refused`, with why, when what this connection asked wasn't done.
 */
export type TerminalEvent = Schemas["TerminalEvent"];
export interface LiveHandle {
  close(): void;
  /** Resolves when the socket closes, with why. */
  closed: Promise<{ code: number; reason: string }>;
}
/** What an operating connection can do. What can't be done comes back as a `refused` event. */
export interface TerminalsHandle extends LiveHandle {
  /** Start a shell of your own. It arrives as a `start` event, which carries its id. */
  openShell(columns: number, rows: number): void;
  /** Type into a running terminal, the agent's included: a long text as several messages. */
  sendInput(id: string, text: string): void;
  resize(id: string, columns: number, rows: number): void;
  stop(id: string): void;
}

export interface ConnectionOpts {
  /** The control token; `AGENTCOMPUTER_API_KEY` by default. */
  apiKey?: string;
  /** The service's address; `AGENTCOMPUTER_API_URL`, else `http://127.0.0.1:7878`. */
  apiUrl?: string;
}
export interface CreateOpts extends ConnectionOpts {
  access: Schemas["Access"];
  browser?: boolean;
  /** How it is isolated: a container by default, and no other is offered now. */
  isolation?: Schemas["Isolation"];
  workspace?: string;
  name?: string;
  /** How long until it stops, in milliseconds. By default it doesn't. */
  timeoutMs?: number;
  metadata?: Record<string, string>;
}
/** This computer, attached whole: its files and commands reach all of it, as the service's user. */
export interface AttachOpts extends Omit<CreateOpts, "isolation" | "workspace"> {
  /** Its work folder, where commands and relative paths start. Detaching never removes it. */
  workspace: string;
}
export interface CommandResult {
  exitCode: number;
  output: string;
  seconds: number;
}
export interface RunningCommand {
  sessionId: string;
  output: string;
}

/** The service refused, or a computer's tool failed. */
export class ComputerError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "ComputerError";
    this.code = code;
  }
}

const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

/** What making and attaching a computer both send, and where to. */
function requestOf(opts: Omit<CreateOpts, "isolation" | "workspace">) {
  const { access, browser, name, timeoutMs, metadata, apiKey, apiUrl } = opts;
  return {
    connection: { ...(apiKey ? { apiKey } : {}), ...(apiUrl ? { apiUrl } : {}) },
    body: {
      access,
      browser: browser ?? false,
      ...(name === undefined ? {} : { name }),
      ...(timeoutMs === undefined ? {} : { timeout: seconds(timeoutMs) }),
      ...(metadata === undefined ? {} : { metadata }),
    },
  };
}

function apiOf(opts: ConnectionOpts = {}) {
  const apiKey = opts.apiKey ?? process.env.AGENTCOMPUTER_API_KEY;
  if (!apiKey) throw new ComputerError(401, "Pass apiKey, or set AGENTCOMPUTER_API_KEY.");
  const baseUrl = opts.apiUrl ?? process.env.AGENTCOMPUTER_API_URL ?? "http://127.0.0.1:7878";
  return createClient<paths>({ baseUrl, headers: { Authorization: `Bearer ${apiKey}` } });
}

/** What a call returned, or the service's refusal as an error. */
function answered<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (!result.response.ok) {
    const error = result.error as { code?: number; message?: string } | undefined;
    throw new ComputerError(
      error?.code ?? result.response.status,
      error?.message ?? `The service answered ${result.response.status}.`,
    );
  }
  return result.data as T;
}

/** What the command tools answer. */
interface CommandAnswer {
  exit_code: number | null;
  seconds: number;
  session_id: string | null;
  text: string;
}

/** An MCP client for one endpoint, connected when first used. */
class Endpoint {
  readonly #url: string | null;
  readonly #token: string;
  #client: Promise<Client> | undefined;

  constructor(url: string | null, token: string) {
    this.#url = url;
    this.#token = token;
  }

  #connected() {
    const url = this.#url;
    if (!url) throw new ComputerError(404, "This computer has no files or terminal.");
    this.#client ??= (async () => {
      const client = new Client({ name: "agentcomputer-sdk", version: "0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: { Authorization: `Bearer ${this.#token}` } },
        }),
      );
      return client;
    })();
    return this.#client;
  }

  async #call(name: string, args: Record<string, unknown>) {
    const client = await this.#connected();
    const result = (await client.callTool({ name, arguments: args })) as {
      content: { text?: string }[];
      structuredContent?: unknown;
      isError?: boolean;
    };
    const text = result.content.map((block) => block.text ?? "").join("");
    if (result.isError) throw new ComputerError(400, text);
    return { text, structured: result.structuredContent };
  }

  async text(name: string, args: Record<string, unknown>) {
    return (await this.#call(name, args)).text;
  }

  async command(name: string, args: Record<string, unknown>) {
    return (await this.#call(name, args)).structured as CommandAnswer;
  }

  async close() {
    const client = await this.#client?.catch(() => undefined);
    this.#client = undefined;
    await client?.close();
  }
}

/** Open a ticket's socket, and say when it closes. */
async function openLive(session: LiveSession, onMessage: (data: string | ArrayBuffer) => void) {
  const ws = new WebSocket(session.url);
  ws.binaryType = "arraybuffer";
  const closed = new Promise<{ code: number; reason: string }>((done) => {
    ws.addEventListener("close", (event) => done({ code: event.code, reason: event.reason }));
  });
  await new Promise<void>((done, failed) => {
    ws.addEventListener("open", () => done(), { once: true });
    ws.addEventListener(
      "error",
      () => failed(new ComputerError(502, "The live session didn't open.")),
      { once: true },
    );
  });
  ws.addEventListener("message", (event) => onMessage(event.data as string | ArrayBuffer));
  return { ws, closed };
}

type Opener = (surface: LiveSurface, mode: LiveMode) => Promise<LiveSession>;
/** Every terminal on the computer: the agent's commands and a person's shells alike. */
class Terminals {
  readonly #open: Opener;

  constructor(open: Opener) {
    this.#open = open;
  }

  /**
   * Each terminal as it starts, writes and exits: those already there first, each with the end of
   * what it wrote. Operating, the default, can also open a shell and act on any of them.
   */
  async connect(opts: {
    onEvent: (event: TerminalEvent) => void;
    mode?: LiveMode;
  }): Promise<TerminalsHandle> {
    const { ws, closed } = await openLive(
      await this.#open("terminal", opts.mode ?? "operate"),
      (data) => {
        if (typeof data === "string") opts.onEvent(JSON.parse(data) as TerminalEvent);
      },
    );
    const send = (input: Schemas["TerminalInput"]) => ws.send(JSON.stringify(input));
    return {
      openShell: (columns, rows) => send({ type: "open", columns, rows }),
      sendInput: (id, text) => {
        for (const piece of pieces(text)) send({ type: "input", id, text: piece });
      },
      resize: (id, columns, rows) => send({ type: "resize", id, columns, rows }),
      stop: (id) => send({ type: "stop", id }),
      close: () => ws.close(),
      closed,
    };
  }
}

/** Commands on a computer with the terminal level. */
class Commands {
  readonly #endpoint: Endpoint;

  constructor(endpoint: Endpoint) {
    this.#endpoint = endpoint;
  }

  /** Run a command to its end. */
  async run(cmd: string, opts?: { cwd?: string }): Promise<CommandResult>;
  /** Start a command and return while it runs, unless it ends at once. */
  async run(
    cmd: string,
    opts: { cwd?: string; background: true },
  ): Promise<RunningCommand | CommandResult>;
  async run(cmd: string, opts: { cwd?: string; background?: boolean } = {}) {
    let answer = await this.#endpoint.command("exec_command", {
      cmd,
      ...(opts.cwd ? { workdir: opts.cwd } : {}),
      ...(opts.background ? { yield_time_ms: 250 } : {}),
    });
    if (opts.background && answer.session_id !== null)
      return { sessionId: answer.session_id, output: answer.text };
    let output = answer.text;
    let total = answer.seconds;
    while (answer.exit_code === null) {
      answer = await this.#endpoint.command("write_stdin", { session_id: answer.session_id });
      output += answer.text;
      total += answer.seconds;
    }
    return { exitCode: answer.exit_code, output, seconds: total };
  }

  /** Type into a running command, and return what it wrote since. */
  async sendStdin(sessionId: string, data: string) {
    return (await this.#endpoint.command("write_stdin", { session_id: sessionId, chars: data }))
      .text;
  }
}

/** Files in a computer's workspace. */
class Files {
  readonly #endpoint: Endpoint;

  constructor(endpoint: Endpoint) {
    this.#endpoint = endpoint;
  }

  /** A text file's content, whole: a line too long for the tool to return is an error. */
  async read(path: string): Promise<string> {
    const lines: string[] = [];
    let limit = 500;
    for (let offset = 1; ; ) {
      const [head = "", ...rest] = (
        await this.#endpoint.text("read", { path, offset, limit })
      ).split("\n");
      // The tool shortens long answers. Every line arriving under its own number means this didn't.
      if (rest.some((line, i) => !line.startsWith(`${offset + i}\t`))) {
        if (limit === 1) throw new ComputerError(413, `Line ${offset} of ${path} is too long.`);
        limit = Math.ceil(limit / 2);
        continue;
      }
      for (const line of rest) lines.push(line.slice(line.indexOf("\t") + 1));
      offset += rest.length;
      if (offset > Number(/ of (\d+)$/.exec(head)?.[1] ?? 0)) return lines.join("\n");
    }
  }

  /** Make a new file, or fill an empty one. */
  async write(path: string, content: string) {
    await this.#endpoint.text("edit", { path, old_text: "", new_text: content });
  }

  /** Replace exact text, and return the unified diff. */
  edit(path: string, oldText: string, newText: string, opts: { replaceAll?: boolean } = {}) {
    return this.#endpoint.text("edit", {
      path,
      old_text: oldText,
      new_text: newText,
      ...(opts.replaceAll ? { replace_all: true } : {}),
    });
  }

  /** A folder's entries, the first thousand. */
  async list(path = ".") {
    const text = await this.#endpoint.text("list", { path });
    return text
      .split("\n")
      .filter((line) => line.endsWith("/") || line.includes("\t"))
      .map((line) => {
        const [name = "", size] = line.split("\t");
        return name.endsWith("/")
          ? { name: name.slice(0, -1), type: "dir" as const }
          : { name, type: "file" as const, size: Number(size) };
      });
  }

  /** Lines matching text under a folder, as `path:line:text`. */
  async search(pattern: string, opts: { path?: string; regex?: boolean } = {}) {
    const text = await this.#endpoint.text("search", { pattern, ...opts });
    return text ? text.split("\n") : [];
  }
}

const pathOf = (computerID: string) => ({ params: { path: { computerID } } });

/** One computer. Make one with `Computer.create`. */
export class Computer {
  readonly computerID: string;
  readonly commands: Commands;
  readonly files: Files;
  readonly terminals: Terminals;
  readonly #connection: ConnectionOpts;
  readonly #token: string;
  readonly #computer: Endpoint;
  readonly #urls: ComputerInfo["endpoints"];

  private constructor(connection: ConnectionOpts, info: ComputerInfo, token: string) {
    this.#connection = connection;
    this.computerID = info.computerID;
    this.#token = token;
    this.#urls = info.endpoints;
    this.#computer = new Endpoint(info.endpoints.computer, token);
    this.commands = new Commands(this.#computer);
    this.terminals = new Terminals((surface, mode) => this.liveSession(surface, mode));
    this.files = new Files(this.#computer);
  }

  static async create(opts: CreateOpts): Promise<Computer> {
    const { isolation, workspace } = opts;
    const { connection, body } = requestOf(opts);
    const created = answered(
      await apiOf(connection).POST("/v1/computers", {
        body: {
          ...body,
          ...(isolation === undefined ? {} : { isolation }),
          ...(workspace === undefined ? {} : { workspace }),
        },
      }),
    );
    return new Computer(connection, created, created.accessToken);
  }

  /** This computer, attached whole. Killing it detaches it and removes nothing of the machine's. */
  static async attach(opts: AttachOpts): Promise<Computer> {
    const { connection, body } = requestOf(opts);
    const attached = answered(
      await apiOf(connection).POST("/v1/computers/attach", {
        body: { ...body, workspace: opts.workspace },
      }),
    );
    return new Computer(connection, attached, attached.accessToken);
  }

  /** A computer made earlier. Its token was shown when it was made, and only then. */
  static async connect(
    computerID: string,
    opts: ConnectionOpts & { accessToken: string },
  ): Promise<Computer> {
    const { accessToken, ...connection } = opts;
    return new Computer(connection, await Computer.getInfo(computerID, connection), accessToken);
  }

  static async list(
    opts: ConnectionOpts & { state?: Schemas["ComputerState"] } = {},
  ): Promise<ComputerInfo[]> {
    const { state } = opts;
    return answered(
      await apiOf(opts).GET("/v1/computers", { params: { query: state ? { state } : {} } }),
    );
  }

  static async serviceInfo(opts: ConnectionOpts = {}): Promise<ServiceInfo> {
    return answered(await apiOf(opts).GET("/v1/info"));
  }

  static async getInfo(computerID: string, opts: ConnectionOpts = {}): Promise<ComputerDetail> {
    return answered(await apiOf(opts).GET("/v1/computers/{computerID}", pathOf(computerID)));
  }

  /** It now stops this long from now, replacing any earlier timeout. */
  static async setTimeout(
    computerID: string,
    timeoutMs: number,
    opts: ConnectionOpts = {},
  ): Promise<ComputerInfo> {
    return answered(
      await apiOf(opts).POST("/v1/computers/{computerID}/timeout", {
        ...pathOf(computerID),
        body: { timeout: seconds(timeoutMs) },
      }),
    );
  }

  static async stop(computerID: string, opts: ConnectionOpts = {}): Promise<ComputerInfo> {
    return answered(await apiOf(opts).POST("/v1/computers/{computerID}/stop", pathOf(computerID)));
  }

  static async start(
    computerID: string,
    opts: ConnectionOpts & { timeoutMs?: number } = {},
  ): Promise<ComputerInfo> {
    return answered(
      await apiOf(opts).POST("/v1/computers/{computerID}/start", {
        ...pathOf(computerID),
        body: opts.timeoutMs === undefined ? {} : { timeout: seconds(opts.timeoutMs) },
      }),
    );
  }

  static async getLogs(computerID: string, opts: ConnectionOpts = {}): Promise<ComputerLog[]> {
    return answered(await apiOf(opts).GET("/v1/computers/{computerID}/logs", pathOf(computerID)))
      .logs;
  }

  /** A one-time ticket to open one of its surfaces live, within a minute. */
  static async createLiveSession(
    computerID: string,
    session: { surface: LiveSurface; mode?: LiveMode },
    opts: ConnectionOpts = {},
  ): Promise<LiveSession> {
    return answered(
      await apiOf(opts).POST("/v1/computers/{computerID}/live", {
        ...pathOf(computerID),
        body: { surface: session.surface, mode: session.mode ?? "watch" },
      }),
    );
  }

  static async kill(computerID: string, opts: ConnectionOpts = {}): Promise<void> {
    answered(await apiOf(opts).DELETE("/v1/computers/{computerID}", pathOf(computerID)));
  }

  /** The endpoint to give an MCP client. */
  getMcpUrl(endpoint: "computer" | "browser" = "computer") {
    const url = this.#urls[endpoint];
    if (!url) throw new ComputerError(404, `This computer has no ${endpoint} endpoint.`);
    return url;
  }

  /** The token for those endpoints. */
  getMcpToken() {
    return this.#token;
  }

  getInfo() {
    return Computer.getInfo(this.computerID, this.#connection);
  }

  async isRunning() {
    return (await this.getInfo()).state === "running";
  }

  setTimeout(timeoutMs: number) {
    return Computer.setTimeout(this.computerID, timeoutMs, this.#connection);
  }

  async stop() {
    await this.#computer.close();
    return Computer.stop(this.computerID, this.#connection);
  }

  start(opts: { timeoutMs?: number } = {}) {
    return Computer.start(this.computerID, { ...this.#connection, ...opts });
  }

  liveSession(surface: LiveSurface, mode: LiveMode = "watch") {
    return Computer.createLiveSession(this.computerID, { surface, mode }, this.#connection);
  }

  getLogs() {
    return Computer.getLogs(this.computerID, this.#connection);
  }

  async kill() {
    await this.#computer.close();
    await Computer.kill(this.computerID, this.#connection);
  }

  /** Close this object's connection. The computer keeps running. */
  async close() {
    await this.#computer.close();
  }
}
