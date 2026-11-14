// A service that only lends its machine, as the app that lends a Mac runs it; who is connected to
// a service; and who is acting on every computer attached to its machine.
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { WebSocket } from "ws";

type Sdk = typeof import("../src/sdk.ts");
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(root, "dist", "agentcomputer.js");
const run = promisify(execFile);
const LENDS_ONLY =
  "This service only lends this machine: it makes no computers. A container comes from a service started without --lend, at another address: one elsewhere, or one on this machine with its own --data and --listen.";

async function service(t: test.TestContext, extra: string[] = [], before?: (data: string) => void) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ac-")));
  const data = join(home, "data");
  const workspace = join(home, "workspace");
  mkdirSync(workspace);
  if (before) {
    mkdirSync(data);
    before(data);
  }
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
    { env: { PATH: process.env.PATH ?? "", HOME: home }, stdio: ["ignore", "pipe", "inherit"] },
  );
  t.after(async () => {
    const gone = once(child, "exit");
    child.kill("SIGTERM");
    await gone;
    rmSync(home, { recursive: true, force: true });
  });
  const apiUrl = await new Promise<string>((done) =>
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      const found = /^AgentComputer on (\S+),/.exec(line);
      if (found) done(found[1] as string);
    }),
  );
  const { Computer } = (await import(pathToFileURL(join(root, "dist", "sdk.js")).href)) as Sdk;
  const apiKey = readFileSync(join(data, "control-token"), "utf8").trim();
  const get = async (path: string) =>
    (await fetch(`${apiUrl}${path}`, { headers: { Authorization: `Bearer ${apiKey}` } })).json();
  return { Computer, to: { apiUrl, apiKey }, workspace, get };
}

test("a service that lends its machine makes no computers, and says where one comes from", async (t) => {
  const { Computer, to, workspace } = await service(t, ["--lend"]);
  assert.deepEqual((await Computer.serviceInfo(to)).made, []);
  await assert.rejects(Computer.create({ ...to, access: "read" }), {
    code: 409,
    message: LENDS_ONLY,
  });
  const attached = await Computer.attach({ ...to, access: "read", workspace });
  assert.equal((await attached.getInfo()).state, "running");
  await attached.kill();
});

test("a container made before can't be started or removed by a service that only lends", async (t) => {
  const { Computer, to } = await service(t, ["--lend"], (data) =>
    writeFileSync(
      join(data, "computers.json"),
      JSON.stringify([
        {
          id: "c_made",
          name: "Made",
          access: "read",
          isolation: "container",
          browser: false,
          metadata: {},
          tokenDigest: "0".repeat(64),
          state: "stopped",
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
        },
      ]),
    ),
  );
  const elsewhere = {
    code: 409,
    message:
      "This service only lends this machine, so a computer made in a container can't be started or removed here. A service started without --lend, with this data folder, can.",
  };
  await assert.rejects(Computer.start("c_made", to), elsewhere);
  await assert.rejects(Computer.kill("c_made", to), elsewhere);
  assert.equal((await Computer.getInfo("c_made", to)).state, "stopped");
});

test("a service that only lends won't start where other machines reach it", async () => {
  await assert.rejects(
    run(process.execPath, [
      CLI,
      "serve",
      "--lend",
      "--listen",
      "127.0.0.1:0",
      "--tls-proxy",
      "--public-url",
      "https://computers.example",
      "--data",
      realpathSync(mkdtempSync(join(tmpdir(), "ac-"))),
    ]),
    (error: { stderr: string }) =>
      error.stderr.startsWith(
        "--lend lends only this machine, which a service other machines reach doesn't offer: listen on loopback, with no --tls-proxy and no --public-url.",
      ),
  );
});

test("a client holding a connection is connected, by name, until it lets go", async (t) => {
  const { to, get } = await service(t, ["--lend"]);
  assert.deepEqual(await get("/v1/connection"), { connected: false, clients: [] });
  const held = new WebSocket(`${to.apiUrl.replace(/^http/, "ws")}/v1/connection?name=AgentOrg`, {
    headers: { Authorization: `Bearer ${to.apiKey}` },
  });
  await once(held, "open");
  const connected = (await get("/v1/connection")) as {
    connected: boolean;
    clients: { name: string; since: string; local: boolean }[];
  };
  assert.equal(connected.connected, true);
  assert.deepEqual(
    connected.clients.map(({ name, local }) => ({ name, local })),
    [{ name: "AgentOrg", local: true }],
  );
  assert.ok(Date.parse(connected.clients[0]?.since ?? "") <= Date.now());
  held.close();
  await once(held, "close");
  let after = connected;
  for (let i = 0; after.connected && i < 50; i++) {
    await new Promise((done) => setTimeout(done, 50));
    after = (await get("/v1/connection")) as typeof connected;
  }
  assert.deepEqual(after, { connected: false, clients: [] });
});

test("a connection without the control token is refused", async (t) => {
  const { to, get } = await service(t, ["--lend"]);
  const refused = new WebSocket(`${to.apiUrl.replace(/^http/, "ws")}/v1/connection?name=Nobody`, {
    headers: { Authorization: "Bearer not-the-token" },
  });
  const status = await new Promise<number | undefined>((done) =>
    refused
      .once("unexpected-response", (_, answer) => done(answer.statusCode))
      .once("error", () => done(undefined)),
  );
  assert.equal(status, 401);
  assert.deepEqual(await get("/v1/connection"), { connected: false, clients: [] });
});

test("who is acting is read for every computer at once, the files they share once", async (t) => {
  const { Computer, to, workspace, get } = await service(t);
  assert.deepEqual(await get("/v1/acting"), []);
  const research = await Computer.attach({ ...to, access: "read", workspace, name: "Research" });
  // Attached to the same machine, it lists the same files' board.
  await Computer.attach({ ...to, access: "read", workspace, name: "Helper" });
  const client = new Client({ name: "acting", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL((await research.getInfo()).endpoints.computer as string),
      { requestInit: { headers: { Authorization: `Bearer ${research.getMcpToken()}` } } },
    ),
  );
  await client.callTool({ name: "list", arguments: { path: "." } });
  await client.close();
  const acting = (await get("/v1/acting")) as { who: string; name?: string; capability: string }[];
  assert.deepEqual(
    acting.map(({ who, name, capability }) => ({ who, name, capability })),
    [{ who: "agent", name: "Research", capability: "files" }],
  );
});
