// A computer as a container of its own: the service's image, the workspace and its home mounted,
// a port on the machine's loopback that takes a token only the service holds. A stopped
// computer's container stays, and starts again as it was, unless it was made from another image
// than the service's: then it is made again, which keeps the two folders that are mounted.
import { execFile, spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
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

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const nameOf = (id: string) => `agentcomputer-${id}`;
/** Its home in there, which is a folder of the machine's, in the computer's own. */
const HOME = "/home/computer";
const homeOf = (folder: string) => join(folder, "home");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

interface Ready {
  browserTools: string[];
  surfaces: SurfaceInfo[];
  /** The program's version inside, which one made before 0.0.17 doesn't say. */
  version?: string;
}

interface Inspected {
  /** The id of the image it was made from. */
  Image: string;
  Mounts: { Destination: string }[];
  State: { Running: boolean; StartedAt: string };
  NetworkSettings: { Ports: Record<string, { HostPort: string }[] | null> };
}

export class ContainerRuntime implements Runtime {
  readonly #image: string;
  /** The id of that image, as it is now on this machine. */
  #imageId: string | undefined;

  constructor(image: string) {
    this.#image = image;
  }

  /** Whether Docker answers, asked for no longer than this. */
  async #answers(ms: number) {
    try {
      await run("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: ms });
      return true;
    } catch {
      return false;
    }
  }

  // Asked each time the service says what it can make, so it doesn't wait on a Docker that hangs.
  available() {
    return this.#answers(1_000);
  }

  /** Docker, or the refusal of what can't be done without it. */
  async #docker() {
    if (!(await this.#answers(10_000)))
      throw new ApiError(409, "A container needs Docker, which isn't answering on this machine.");
  }

  async prepare() {
    await this.#docker();
    const id = () => docker(["image", "inspect", "--format", "{{.Id}}", this.#image]);
    try {
      this.#imageId = await id();
    } catch {
      process.stdout.write(`Pulling ${this.#image}\n`);
      await docker(["pull", this.#image]);
      this.#imageId = await id();
    }
  }

  async #inspect(name: string): Promise<Inspected | undefined> {
    try {
      return (JSON.parse(await docker(["inspect", name])) as Inspected[])[0];
    } catch {
      return undefined;
    }
  }

  /**
   * Remove a container made from another image, for it to be made again. What it keeps is outside
   * it: its workspace, and its home. One made before its home was outside has its home copied out
   * first, and if that can't be done it is kept as it is, to try again at its next start.
   */
  async #remake(name: string, made: Inspected, folder: string, events: RuntimeEvents) {
    if (!made.Mounts.some((mount) => mount.Destination === HOME)) {
      const home = homeOf(folder);
      const copying = `${home}.copying`;
      rmSync(copying, { recursive: true, force: true });
      try {
        // With no user of its own given, it runs as the image's, so its files keep their owner.
        const owners = process.getuid?.() ? [] : ["--archive"];
        await docker(["cp", ...owners, `${name}:${HOME}`, copying]);
        // Its home is the container's until the container goes: what is here is an earlier try.
        rmSync(home, { recursive: true, force: true });
        renameSync(copying, home);
      } catch (error) {
        rmSync(copying, { recursive: true, force: true });
        events.log(
          `Its home couldn't be copied out of its container (${messageOf(error)}), so the ` +
            "container is kept and started as it was made. " +
            "The copy is tried again at its next start.",
        );
        return;
      }
      events.log("Its home was copied out of its container, to keep.");
    }
    await docker(["rm", "--force", name]);
    events.log(
      `Its container was made from another image, so it is made again from ${this.#image}.`,
    );
  }

  async #create(name: string, spec: ComputerSpec, token: string, folder: string) {
    // Writable by whoever it runs as, as the image's own home is. Only the service's user can
    // reach the computer's folder it is in.
    const home = homeOf(folder);
    mkdirSync(home, { recursive: true });
    chmodSync(home, 0o1777);
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
        "--mount",
        `type=bind,source=${home},target=${HOME}`,
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
    const made = await this.#inspect(name);
    // One made from another image, as after an update, is made again from this one.
    if (made && this.#imageId && made.Image !== this.#imageId)
      await this.#remake(name, made, folder, events);
    if (!(await this.#inspect(name))) await this.#create(name, spec, token, folder);
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
      version: ready.version,
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

  // Neither is said to be done where Docker doesn't answer: the container would be left as it is.
  async stopLeftover(id: string) {
    await this.#docker();
    await docker(["stop", "--time", STOP_SECONDS, nameOf(id)]).catch(() => {});
  }

  async remove(id: string) {
    await this.#docker();
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
