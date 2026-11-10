// biome-ignore-all lint/suspicious/noExplicitAny: each surface answers JSON the scenario checks.
// One scenario, run through each way of reaching the service, and every operation in openapi.yaml
// has to be reached by each.
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
import { Ajv2020 } from "ajv/dist/2020.js";
import { OPENAPI, OPERATIONS, type Operation } from "../src/generated/operations.ts";

type Sdk = typeof import("../src/sdk.ts");
type Input = Record<string, any>;
type Answer = { value: any } | { code?: number; message: string };
type Surface = (operationId: string, input: Input) => Promise<Answer>;

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "dist");
const CLI = join(dist, "agentcomputer.js");
const STAND_IN = join(here, "..", "..", "test", "fixtures", "playwright.js");
const run = promisify(execFile);
/** Every operation but opening a live session, which is a WebSocket and has its own tests. */
const TOOLS = OPERATIONS.filter((one) => one.tool);
const IMAGE = process.env.AGENTCOMPUTER_TEST_IMAGE;
const ISOLATIONS: [string, string[]][] = [
  ["none", ["--playwright-cli", STAND_IN]],
  ...(IMAGE
    ? ([["container", ["--isolation", "container", "--image", IMAGE]]] as [string, string[]][])
    : []),
];

function http(url: string, token: string): Surface {
  return async (operationId, input) => {
    const operation = OPERATIONS.find((one) => one.operationId === operationId) as Operation;
    const rest = { ...input };
    let path = operation.path;
    for (const name of operation.pathParameters) {
      path = path.replace(`{${name}}`, encodeURIComponent(rest[name]));
      delete rest[name];
    }
    const query = new URLSearchParams();
    for (const name of operation.queryParameters) {
      if (rest[name] !== undefined) query.set(name, rest[name]);
      delete rest[name];
    }
    const response = await fetch(`${url}${path}?${query}`, {
      method: operation.method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(operation.hasBody ? { body: JSON.stringify(rest) } : {}),
    });
    const text = await response.text();
    if (response.ok) return { value: text ? JSON.parse(text) : undefined };
    return JSON.parse(text);
  };
}

function mcp(client: Client): Surface {
  return async (operationId, input) => {
    const { tool } = OPERATIONS.find((one) => one.operationId === operationId) as Operation;
    const result = (await client.callTool({ name: tool as string, arguments: input })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    const text = result.content[0]?.text ?? "";
    if (!result.isError) return { value: text === "{}" ? undefined : JSON.parse(text) };
    try {
      return JSON.parse(text);
    } catch {
      return { message: text };
    }
  };
}

function sdk({ Computer }: Sdk, apiUrl: string, apiKey: string): Surface {
  const to = { apiUrl, apiKey };
  const operations: Record<string, (input: Input) => Promise<unknown>> = {
    getInfo: () => Computer.serviceInfo(to),
    listComputers: ({ state }) => Computer.list({ ...to, ...(state ? { state } : {}) }),
    createComputer: async ({ timeout, ...input }) => {
      const computer = await Computer.create({
        ...to,
        ...(input as { access: "read" }),
        ...(timeout ? { timeoutMs: timeout * 1000 } : {}),
      });
      return { ...(await computer.getInfo()), accessToken: computer.getMcpToken() };
    },
    getComputer: ({ computerID }) => Computer.getInfo(computerID, to),
    setComputerTimeout: ({ computerID, timeout }) =>
      Computer.setTimeout(computerID, timeout * 1000, to),
    stopComputer: ({ computerID }) => Computer.stop(computerID, to),
    startComputer: ({ computerID }) => Computer.start(computerID, to),
    getComputerLogs: async ({ computerID }) => ({ logs: await Computer.getLogs(computerID, to) }),
    createLiveSession: ({ computerID, surface, mode }) =>
      Computer.createLiveSession(computerID, { surface, ...(mode ? { mode } : {}) }, to),
    killComputer: ({ computerID }) => Computer.kill(computerID, to),
  };
  return async (operationId, input) => {
    try {
      return { value: await (operations[operationId] as (i: Input) => unknown)(input) };
    } catch (error) {
      const { code, message } = error as { code: number; message: string };
      return { code, message };
    }
  };
}

function cli(data: string): Surface {
  const operations: Record<string, (input: Input) => string[]> = {
    getInfo: () => ["info"],
    listComputers: ({ state }) => ["list", ...(state ? ["--state", state] : [])],
    createComputer: ({ access, name, workspace, timeout, metadata }) => [
      "create",
      "--access",
      access,
      ...(name ? ["--name", name] : []),
      ...(workspace ? ["--workspace", workspace] : []),
      ...(timeout ? ["--timeout", String(timeout)] : []),
      ...Object.entries(metadata ?? {}).flatMap(([key, value]) => [
        "--metadata",
        `${key}=${value}`,
      ]),
    ],
    getComputer: ({ computerID }) => ["get", computerID],
    setComputerTimeout: ({ computerID, timeout }) => ["timeout", computerID, String(timeout)],
    stopComputer: ({ computerID }) => ["stop", computerID],
    startComputer: ({ computerID }) => ["start", computerID],
    getComputerLogs: ({ computerID }) => ["logs", computerID],
    createLiveSession: ({ computerID, surface, mode }) => [
      "live",
      computerID,
      "--surface",
      surface,
      ...(mode ? ["--mode", mode] : []),
    ],
    killComputer: ({ computerID }) => ["kill", computerID],
  };
  return async (operationId, input) => {
    const args = (operations[operationId] as (i: Input) => string[])(input);
    try {
      const { stdout } = await run(process.execPath, [CLI, ...args, "--data", data]);
      return { value: stdout ? JSON.parse(stdout) : undefined };
    } catch (error) {
      return { message: (error as { stderr: string }).stderr.trim() };
    }
  };
}

const ajv = new Ajv2020({ strict: false, validateFormats: false });

/** Run one operation, and check a success against what openapi.yaml says it returns. */
function checked(surface: Surface, reached: Set<string>) {
  return async (operationId: string, input: Input = {}) => {
    reached.add(operationId);
    const answer = await surface(operationId, input);
    if ("value" in answer) {
      const { output } = OPERATIONS.find((one) => one.operationId === operationId) as Operation;
      if (output) {
        const valid = ajv.validate(output, answer.value);
        assert.ok(valid, `${operationId}: ${ajv.errorsText()}`);
      } else assert.equal(answer.value, undefined);
    }
    return answer as any;
  };
}

async function scenario(surface: Surface, workspace: string, isolation: string) {
  const reached = new Set<string>();
  const call = checked(surface, reached);

  const info = (await call("getInfo")).value;
  assert.equal(info.isolation, isolation);

  const made = (
    await call("createComputer", {
      access: "terminal",
      name: "Conformance",
      workspace,
      timeout: 600,
      metadata: { purpose: "test" },
    })
  ).value;
  const computerID = made.computerID;
  assert.equal(made.state, "running");
  assert.equal(made.name, "Conformance");
  assert.deepEqual(made.metadata, { purpose: "test" });
  assert.ok(made.accessToken);
  assert.ok(Date.parse(made.endAt) > Date.now() + 500_000);

  const ids = async (state?: string) =>
    (await call("listComputers", state ? { state } : {})).value.map(
      (one: { computerID: string }) => one.computerID,
    );
  assert.ok((await ids()).includes(computerID));
  assert.ok((await ids("running")).includes(computerID));
  assert.ok(!(await ids("stopped")).includes(computerID));

  const detail = (await call("getComputer", { computerID })).value;
  assert.deepEqual([...detail.tools.computer].sort().at(0), "edit");
  assert.ok(!("accessToken" in detail));

  const longer = (await call("setComputerTimeout", { computerID, timeout: 9000 })).value;
  assert.ok(Date.parse(longer.endAt) > Date.now() + 8_000_000);

  assert.ok(Array.isArray((await call("getComputerLogs", { computerID })).value.logs));

  assert.deepEqual(
    detail.surfaces.map((one: { surface: string }) => one.surface),
    ["commands", "terminal"],
  );
  const ticket = (await call("createLiveSession", { computerID, surface: "commands" })).value;
  assert.match(ticket.url, /^wss?:\/\/[^/]+\/v1\/live\/l_/);
  assert.equal(ticket.protocol, "commands@1");
  assert.equal(ticket.mode, "watch");
  const operated = await call("createLiveSession", {
    computerID,
    surface: "commands",
    mode: "operate",
  });
  assert.match(operated.message, /watched, not operated/);

  const stopped = (await call("stopComputer", { computerID })).value;
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.endAt, null);
  assert.ok((await ids("stopped")).includes(computerID));

  assert.equal((await call("startComputer", { computerID })).value.state, "running");

  assert.equal((await call("killComputer", { computerID })).value, undefined);

  const missing = await call("getComputer", { computerID });
  assert.equal(missing.message, `There's no computer ${computerID}.`);
  if (missing.code !== undefined) assert.equal(missing.code, 404);
  const refused = await call("createComputer", { access: "everything" });
  assert.ok(refused.message);
  if (refused.code !== undefined) assert.equal(refused.code, 400);

  assert.deepEqual(
    [...reached].sort(),
    TOOLS.map((one) => one.operationId).sort(),
    "every operation is reached",
  );
}

async function service(t: test.TestContext, extra: string[] = ["--playwright-cli", STAND_IN]) {
  const root = realpathSync(
    mkdtempSync(join(process.env.AGENTCOMPUTER_TEST_ROOT ?? tmpdir(), "agentcomputer-")),
  );
  const data = join(root, "data");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const child: ChildProcess = spawn(
    process.execPath,
    [CLI, "serve", "--listen", "127.0.0.1:0", "--data", data, ...extra],
    {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        SHELL: "/bin/bash",
        ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const url = await new Promise<string>((done, failed) => {
    child.once("exit", (code) => failed(new Error(`The service exited ${code}.`)));
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      const found = /^AgentComputer on (\S+),/.exec(line);
      if (found) done(found[1] as string);
    });
  });
  t.after(async () => {
    child.removeAllListeners("exit");
    const gone = once(child, "exit");
    child.kill("SIGTERM");
    await gone;
    rmSync(root, { recursive: true, force: true });
  });
  return { url, data, workspace, token: readFileSync(join(data, "control-token"), "utf8").trim() };
}

const loadSdk = () => import(pathToFileURL(join(dist, "sdk.js")).href) as Promise<Sdk>;

for (const [isolation, extra] of ISOLATIONS)
  test(`with isolation ${isolation}, the operations are the same through HTTP, MCP, the SDK and the CLI`, {
    timeout: 240_000,
  }, async (t) => {
    const { url, data, workspace, token } = await service(t, extra);
    await t.test("HTTP", () => scenario(http(url, token), workspace, isolation));
    await t.test("MCP", async (inner) => {
      const client = new Client({ name: "conformance", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${url}/v1/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      inner.after(() => client.close());
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), TOOLS.map((one) => one.tool).sort());
      await scenario(mcp(client), workspace, isolation);
    });
    await t.test("SDK", async () =>
      scenario(sdk(await loadSdk(), url, token), workspace, isolation),
    );
    await t.test("CLI", () => scenario(cli(data), workspace, isolation));
  });

test("the service publishes the file it was built from, to anyone", async (t) => {
  const { url } = await service(t);
  assert.deepEqual(await (await fetch(`${url}/openapi.json`)).json(), OPENAPI);
});

for (const [isolation, extra] of ISOLATIONS)
  test(`with isolation ${isolation}, a computer's commands and files through the SDK`, {
    timeout: 120_000,
  }, async (t) => {
    const { url, workspace, token } = await service(t, extra);
    const { Computer, ComputerError } = await loadSdk();
    const opts = { apiUrl: url, apiKey: token };
    const computer = await Computer.create({ ...opts, access: "terminal", workspace });
    t.after(() => computer.close());

    const ran = await computer.commands.run("echo out; exit 3");
    assert.equal(ran.exitCode, 3);
    assert.equal(ran.output.trim(), "out");
    const slow = await computer.commands.run("sleep 0.5; echo done");
    assert.equal(slow.exitCode, 0);
    assert.equal(slow.output.trim(), "done");

    const started = await computer.commands.run("cat", { background: true });
    assert.ok("sessionId" in started);
    assert.match(await computer.commands.sendStdin(started.sessionId, "typed\n"), /typed/);
    await computer.commands.sendStdin(started.sessionId, "\u0004");

    await computer.files.write("n.txt", "one\ntwo\n");
    assert.equal(readFileSync(join(workspace, "n.txt"), "utf8"), "one\ntwo\n");
    assert.equal(await computer.files.read("n.txt"), "one\ntwo\n");
    await computer.files.edit("n.txt", "two", "three");
    assert.equal(await computer.files.read("n.txt"), "one\nthree\n");
    assert.deepEqual(await computer.files.search("three"), ["n.txt:2:three"]);
    mkdirSync(join(workspace, "sub"));
    assert.deepEqual(await computer.files.list(), [
      { name: "sub", type: "dir" },
      { name: "n.txt", type: "file", size: 10 },
    ]);

    // Whole or not at all, across the pages and past the tool's limit on one answer.
    const long = Array.from({ length: 1200 }, (_, i) => `${i}${"x".repeat(500)}`).join("\n");
    writeFileSync(join(workspace, "long.txt"), long);
    assert.equal(await computer.files.read("long.txt"), long);
    writeFileSync(join(workspace, "wide.txt"), "y".repeat(3000));
    await assert.rejects(computer.files.read("wide.txt"), ComputerError);

    const again = await Computer.connect(computer.computerID, {
      ...opts,
      accessToken: computer.getMcpToken(),
    });
    t.after(() => again.close());
    assert.equal((await again.commands.run("echo back")).output.trim(), "back");
    assert.equal(await again.isRunning(), true);
    assert.equal(again.getMcpUrl(), computer.getMcpUrl());
    assert.throws(() => again.getMcpUrl("browser"), ComputerError);
    await computer.kill();
  });

test("the SDK takes its key and address from the environment, and refuses without one", async (t) => {
  const { url, token } = await service(t);
  const { Computer, ComputerError } = await loadSdk();
  delete process.env.AGENTCOMPUTER_API_KEY;
  await assert.rejects(Computer.list(), ComputerError);
  process.env.AGENTCOMPUTER_API_KEY = token;
  process.env.AGENTCOMPUTER_API_URL = url;
  t.after(() => {
    delete process.env.AGENTCOMPUTER_API_KEY;
    delete process.env.AGENTCOMPUTER_API_URL;
  });
  assert.deepEqual(await Computer.list(), []);
});
