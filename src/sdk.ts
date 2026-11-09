// The TypeScript SDK. Its calls to the service are typed from openapi.yaml. Modelled on E2B's SDK.
import createClient from "openapi-fetch";
import type { components, paths } from "./generated/schema.js";

type Schemas = components["schemas"];
export type ComputerInfo = Schemas["Computer"];
export type ComputerDetail = Schemas["ComputerDetail"];
export type ServiceInfo = Schemas["ServiceInfo"];
export type ComputerLog = Schemas["ComputerLogs"]["logs"][number];

export interface ConnectionOpts {
  /** The control token; `AGENTCOMPUTER_API_KEY` by default. */
  apiKey?: string;
  /** The service's address; `AGENTCOMPUTER_API_URL`, else `http://127.0.0.1:7878`. */
  apiUrl?: string;
}
export interface CreateOpts extends ConnectionOpts {
  access: Schemas["Access"];
  browser?: boolean;
  workspace?: string;
  name?: string;
  /** How long until it stops, in milliseconds. By default it doesn't. */
  timeoutMs?: number;
  metadata?: Record<string, string>;
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

const pathOf = (computerID: string) => ({ params: { path: { computerID } } });

/** One computer. Make one with `Computer.create`. */
export class Computer {
  readonly computerID: string;
  readonly #connection: ConnectionOpts;
  readonly #token: string;
  readonly #urls: ComputerInfo["endpoints"];

  private constructor(connection: ConnectionOpts, info: ComputerInfo, token: string) {
    this.#connection = connection;
    this.computerID = info.computerID;
    this.#token = token;
    this.#urls = info.endpoints;
  }

  static async create(opts: CreateOpts): Promise<Computer> {
    const { access, browser, workspace, name, timeoutMs, metadata, apiKey, apiUrl } = opts;
    const connection = { ...(apiKey ? { apiKey } : {}), ...(apiUrl ? { apiUrl } : {}) };
    const created = answered(
      await apiOf(connection).POST("/v1/computers", {
        body: {
          access,
          browser: browser ?? false,
          ...(workspace === undefined ? {} : { workspace }),
          ...(name === undefined ? {} : { name }),
          ...(timeoutMs === undefined ? {} : { timeout: seconds(timeoutMs) }),
          ...(metadata === undefined ? {} : { metadata }),
        },
      }),
    );
    return new Computer(connection, created, created.accessToken);
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

  stop() {
    return Computer.stop(this.computerID, this.#connection);
  }

  start(opts: { timeoutMs?: number } = {}) {
    return Computer.start(this.computerID, { ...this.#connection, ...opts });
  }

  getLogs() {
    return Computer.getLogs(this.computerID, this.#connection);
  }

  kill() {
    return Computer.kill(this.computerID, this.#connection);
  }
}
