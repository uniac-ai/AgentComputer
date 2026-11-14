// However one computer ends, the service and every other computer carry on. The computers that end
// have a real browser: on this computer the one AGENTCOMPUTER_BROWSER_PATH names, never the Chrome
// installed on this machine, and in a container the image's.
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { CONTAINER, type Kind, make, named, needs } from "./kinds.ts";

type Sdk = typeof import("../src/sdk.ts");
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "dist");
const CLI = join(dist, "agentcomputer.js");
const BROWSER = process.env.AGENTCOMPUTER_BROWSER_PATH;
const docker = promisify(execFile);
const KINDS: [Kind, string[] | undefined][] = [
  ["this", BROWSER ? ["--browser-name", "chromium", "--browser-path", BROWSER] : undefined],
  ["container", CONTAINER],
];
/** Longer than a failure on the socket to a server that has just gone takes to surface. */
const SETTLE_MS = 2500;
const settle = () => new Promise((done) => setTimeout(done, SETTLE_MS));

async function setup(t: test.TestContext, extra: string[]) {
  const root = realpathSync(
    mkdtempSync(join(process.env.AGENTCOMPUTER_TEST_ROOT ?? tmpdir(), "ac-")),
  );
  const data = join(root, "data");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const child: ChildProcess = spawn(
    process.execPath,
    [
      CLI,
      "serve",
      "--listen",
      "127.0.0.1:0",
      "--data",
      data,
      "--screen-driver",
      "/nonexistent/cua-driver",
      ...extra,
    ],
    {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        SHELL: "/bin/bash",
        ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let exited: number | string | null | undefined;
  let stderr = "";
  (child.stderr as NodeJS.ReadableStream).on("data", (chunk) => {
    stderr += String(chunk);
  });
  const url = await new Promise<string>((done, failed) => {
    child.once("exit", (code) => failed(new Error(`The service exited ${code}: ${stderr}`)));
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      const found = /^AgentComputer on (\S+),/.exec(line);
      if (found) done(found[1] as string);
    });
  });
  child.removeAllListeners("exit");
  child.once("exit", (code, signal) => {
    exited = code ?? signal;
  });
  const { Computer } = (await import(pathToFileURL(join(dist, "sdk.js")).href)) as Sdk;
  const to = { apiUrl: url, apiKey: readFileSync(join(data, "control-token"), "utf8").trim() };
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    if (exited === undefined) {
      for (const computer of await Computer.list(to).catch(() => []))
        await Computer.kill(computer.computerID, to).catch(() => {});
      const gone = once(child, "exit");
      child.kill("SIGTERM");
      await gone;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const connect = async (endpoint: string, token: string) => {
    const client = new Client({ name: "by-hand", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    await client.listTools();
    clients.push(client);
    return client;
  };
  /** The service is up, and the computer that was left alone still works. */
  const survived = async (other: Awaited<ReturnType<Sdk["Computer"]["create"]>>) => {
    await settle();
    assert.equal(exited, undefined, `The service ended: ${stderr}`);
    assert.ok((await Computer.serviceInfo(to)).version);
    assert.equal(await other.isRunning(), true);
    assert.deepEqual(await other.files.list(), []);
  };
  return { Computer, to, workspace, connect, survived };
}

for (const [kind, given] of KINDS) {
  const options = {
    timeout: 120_000,
    skip: !given && needs(kind),
  };
  const extra = given ?? [];

  test(
    `on ${named(kind)}: killing a browser computer once its client has gone`,
    options,
    async (t) => {
      const { Computer, to, workspace, connect, survived } = await setup(t, extra);
      const other = await make(Computer, kind, { ...to, access: "files", workspace });
      t.after(() => other.close());
      const computer = await make(Computer, kind, {
        ...to,
        access: "none",
        browser: true,
        workspace,
      });
      const client = await connect(computer.getMcpUrl("browser"), computer.getMcpToken());
      await client.close();
      await computer.kill();
      await survived(other);
      assert.ok(!(await Computer.list(to)).some((one) => one.computerID === computer.computerID));
    },
  );

  test(
    `on ${named(kind)}: killing a browser computer with a client still connected`,
    options,
    async (t) => {
      const { Computer, to, workspace, connect, survived } = await setup(t, extra);
      const other = await make(Computer, kind, { ...to, access: "files", workspace });
      t.after(() => other.close());
      const computer = await make(Computer, kind, {
        ...to,
        access: "terminal",
        browser: true,
        workspace,
      });
      await connect(computer.getMcpUrl("browser"), computer.getMcpToken());
      await connect(computer.getMcpUrl(), computer.getMcpToken());
      await computer.kill();
      await survived(other);
    },
  );

  test(
    `on ${named(kind)}: a browser computer reaching its timeout with a client connected`,
    options,
    async (t) => {
      const { Computer, to, workspace, connect, survived } = await setup(t, extra);
      const other = await make(Computer, kind, { ...to, access: "files", workspace });
      t.after(() => other.close());
      const computer = await make(Computer, kind, {
        ...to,
        access: "terminal",
        browser: true,
        workspace,
      });
      await connect(computer.getMcpUrl("browser"), computer.getMcpToken());
      // Timed from here, with the client connected: a timeout given at creation also counts the
      // time its browser takes to start, and can run out before a client is on it.
      await computer.setTimeout(1000);
      await settle();
      await survived(other);
      assert.equal(await computer.isRunning(), false);
    },
  );
}

test("a container dying with a client connected", {
  skip: !CONTAINER && "needs AGENTCOMPUTER_TEST_IMAGE",
  timeout: 120_000,
}, async (t) => {
  const kind = "container";
  const { Computer, to, workspace, connect, survived } = await setup(t, CONTAINER as string[]);
  const other = await make(Computer, kind, { ...to, access: "files", workspace });
  t.after(() => other.close());
  const computer = await make(Computer, kind, {
    ...to,
    access: "terminal",
    browser: true,
    workspace,
  });
  await connect(computer.getMcpUrl("browser"), computer.getMcpToken());
  await docker("docker", ["kill", `agentcomputer-${computer.computerID}`]);
  await survived(other);
  const dead = await computer.getInfo();
  assert.equal(dead.state, "failed");
  assert.ok(dead.surfaces.length > 0);
  for (const one of dead.surfaces) assert.match(one.unavailable ?? "", /container has stopped/);
});
