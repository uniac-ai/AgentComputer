// A computer as a container of its own: the service's image, the workspace mounted, a port on the
// machine's loopback that takes a token only the service holds. A stopped computer's container
// stays, so what was installed in it is there when it starts again.
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type Duplex, Readable } from "node:stream";
import { promisify } from "node:util";
import { sendAnswer } from "./browser.ts";
import {
  INNER_PORT,
  INNER_TOKEN_VARIABLE,
  OUTSIDE_MACHINE_VARIABLE,
  OUTSIDE_WORKSPACE_VARIABLE,
} from "./inside.ts";
import type { SurfaceInfo } from "./live.ts";
import {
  ApiError,
  type ComputerSpec,
  type Running,
  type Runtime,
  type RuntimeEvents,
} from "./runtime.ts";
import { newToken, writePrivate } from "./store.ts";

const run = promisify(execFile);
const START_MS = 60_000;
const STOP_SECONDS = "5";
/** Not passed on: they describe this hop, or carry the client's token. */
const NOT_FORWARDED = new Set([
  "authorization",
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
]);

async function docker(args: string[], env: NodeJS.ProcessEnv = process.env) {
  try {
    return (await run("docker", args, { env, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
  } catch (error) {
    const { stderr, message } = error as { stderr?: string; message: string };
    throw new Error(stderr?.trim() || message);
  }
}

const UPGRADE_HEADERS = [
  "upgrade",
  "connection",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
];

const nameOf = (id: string) => `agentcomputer-${id}`;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

interface Ready {
  browserTools: string[];
  surfaces: SurfaceInfo[];
}

interface Inspected {
  State: { Running: boolean; StartedAt: string };
  NetworkSettings: { Ports: Record<string, { HostPort: string }[] | null> };
}

export class ContainerRuntime implements Runtime {
  readonly isolation = "container";
  readonly #image: string;

  constructor(image: string) {
    this.#image = image;
  }

  async prepare() {
    try {
      await docker(["version", "--format", "{{.Server.Version}}"]);
    } catch (error) {
      throw new Error(`Container isolation needs Docker, which didn't answer: ${String(error)}`);
    }
    try {
      await docker(["image", "inspect", "--format", "{{.Id}}", this.#image]);
    } catch {
      process.stdout.write(`Pulling ${this.#image}\n`);
      await docker(["pull", this.#image]);
    }
  }

  async #inspect(name: string): Promise<Inspected | undefined> {
    try {
      return (JSON.parse(await docker(["inspect", name])) as Inspected[])[0];
    } catch {
      return undefined;
    }
  }

  async #create(name: string, spec: ComputerSpec, token: string) {
    const uid = process.getuid?.();
    // What the program inside is told: its token, and what its workspace and its machine are
    // outside, which in there are only /workspace and the container.
    const told = {
      [INNER_TOKEN_VARIABLE]: token,
      ...(spec.workspace
        ? { [OUTSIDE_WORKSPACE_VARIABLE]: spec.workspace, [OUTSIDE_MACHINE_VARIABLE]: hostname() }
        : {}),
    };
    await docker(
      [
        "create",
        "--name",
        name,
        "--label",
        `agentcomputer.computer=${spec.id}`,
        "--init",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--publish",
        `127.0.0.1::${INNER_PORT}`,
        // By name, so the values stay out of the command line other users can see.
        ...Object.keys(told).flatMap((name) => ["--env", name]),
        // Files it writes in the workspace belong to whoever runs the service.
        ...(uid ? ["--user", `${uid}:${process.getgid?.()}`] : []),
        ...(spec.workspace
          ? [
              "--mount",
              `type=bind,source=${spec.workspace},target=/workspace${spec.access === "read" ? ",readonly" : ""}`,
            ]
          : []),
        this.#image,
        "inside",
        "--access",
        spec.access,
        ...(spec.browser ? ["--browser"] : []),
      ],
      { ...process.env, ...told },
    );
  }

  /** The token between the service and this container, which a restart has to find again. */
  #tokenIn(folder: string) {
    const file = join(folder, "inner-token");
    try {
      return readFileSync(file, "utf8");
    } catch {
      const token = newToken();
      writePrivate(file, token);
      return token;
    }
  }

  async start(spec: ComputerSpec, folder: string, events: RuntimeEvents): Promise<Running> {
    const name = nameOf(spec.id);
    const token = this.#tokenIn(folder);
    if (!(await this.#inspect(name))) await this.#create(name, spec, token);
    await docker(["start", name]);
    const inspected = await this.#inspect(name);
    const port = inspected?.NetworkSettings.Ports[`${INNER_PORT}/tcp`]?.[0]?.HostPort;
    if (!inspected || !port) throw new Error("Its container has no port.");
    const origin = `http://127.0.0.1:${port}`;

    let stopping = false;
    let ended = false;
    const follower = spawn(
      "docker",
      ["logs", "--follow", "--since", inspected.State.StartedAt, name],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    follower.on("error", (error) => events.log(`Its logs can't be followed: ${String(error)}`));
    for (const stream of [follower.stdout, follower.stderr])
      createInterface({ input: stream }).on("line", events.log);
    follower.once("close", () => {
      void this.#inspect(name).then((now) => {
        ended = !now?.State.Running;
        if (ended && !stopping) events.failed("Its container stopped by itself.");
      });
    });

    const stop = async () => {
      stopping = true;
      await docker(["stop", "--time", STOP_SECONDS, name]);
      follower.kill();
    };
    const authorization = `Bearer ${token}`;
    let ready: Ready;
    try {
      ready = await this.#ready(origin, authorization, () => ended);
    } catch (error) {
      await stop();
      throw error;
    }

    return {
      browserTools: ready.browserTools,
      /** As they are now: nothing of a container that has stopped can be opened. */
      get surfaces() {
        return ready.surfaces.map((one) =>
          ended
            ? {
                ...one,
                unavailable: "Its container has stopped. Stop the computer and start it again.",
              }
            : one,
        );
      },
      stop,
      openLive: async (surface, mode, request, socket, head) =>
        pipeUpgrade(
          Number(port),
          authorization,
          `/live/${surface}?mode=${mode}`,
          request,
          socket,
          head,
        ),
      handle: async (endpoint, request, response) =>
        forward(`${origin}/mcp/${endpoint}`, authorization, request, response),
    };
  }

  /** Wait for what's inside to answer, which is once its browser's server is up. */
  async #ready(origin: string, authorization: string, ended: () => boolean) {
    const deadline = Date.now() + START_MS;
    while (Date.now() < deadline && !ended()) {
      try {
        const answer = await fetch(`${origin}/ready`, {
          headers: { Authorization: authorization },
          signal: AbortSignal.timeout(START_MS),
        });
        if (answer.ok) return (await answer.json()) as Ready;
      } catch {
        // Not listening yet.
      }
      await sleep(100);
    }
    throw new Error("Its container didn't start. Its logs say why.");
  }

  async stopLeftover(id: string) {
    await docker(["stop", "--time", STOP_SECONDS, nameOf(id)]).catch(() => {});
  }

  async remove(id: string) {
    await docker(["rm", "--force", nameOf(id)]).catch(() => {});
  }
}

/** Pass a WebSocket upgrade to what's inside, then the bytes both ways. */
async function pipeUpgrade(
  port: number,
  authorization: string,
  path: string,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) {
  const upstream = connect(port, "127.0.0.1");
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
  socket.on("close", () => upstream.destroy());
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    `Authorization: ${authorization}`,
  ];
  for (const name of UPGRADE_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string") lines.push(`${name}: ${value}`);
  }
  upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
  if (head.length > 0) upstream.write(head);
  upstream.pipe(socket);
  socket.pipe(upstream);
}

async function forward(
  url: string,
  authorization: string,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const headers = new Headers({ authorization });
  for (const [name, value] of Object.entries(request.headers))
    if (typeof value === "string" && !NOT_FORWARDED.has(name)) headers.set(name, value);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const aborted = new AbortController();
  response.once("close", () => aborted.abort());
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: request.method as string,
      headers,
      signal: aborted.signal,
      ...(hasBody ? { body: Readable.toWeb(request) as never, duplex: "half" as const } : {}),
    } as RequestInit);
  } catch {
    throw new ApiError(502, "It has stopped working.");
  }
  sendAnswer(upstream, response);
}
