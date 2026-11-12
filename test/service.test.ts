// The built service, run as a person runs it, used by a hand-run MCP client.
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "..", "dist", "agentcomputer.js");
const realBrowser = process.env.AGENTCOMPUTER_BROWSER_PATH;
/** The headless shell, never the Chrome installed on this machine. */
const BROWSER_ARGS = realBrowser
  ? ["--browser-name", "chromium", "--browser-path", realBrowser]
  : [];
const withBrowser = { skip: !realBrowser && "needs AGENTCOMPUTER_BROWSER_PATH" };
const run = promisify(execFile);

interface Created {
  computerID: string;
  state: string;
  accessToken: string;
  workspace: string | null;
  endpoints: { computer: string | null; browser: string | null };
}

async function setup(t: test.TestContext, extra: string[] = BROWSER_ARGS) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentcomputer-")));
  const data = join(root, "data");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  let child: ChildProcess;
  let url = "";
  const start = async () => {
    child = spawn(
      process.execPath,
      [CLI, "serve", "--listen", "127.0.0.1:0", "--data", data, ...extra],
      {
        env: { PATH: process.env.PATH ?? "", HOME: root, SHELL: "/bin/bash" },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    url = await new Promise<string>((done, failed) => {
      child.once("exit", (code) => failed(new Error(`The service exited ${code}.`)));
      createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
        const found = /^AgentComputer on (\S+),/.exec(line);
        if (found) done(found[1] as string);
      });
    });
  };
  const stop = async () => {
    child.removeAllListeners("exit");
    const gone = once(child, "exit");
    child.kill("SIGTERM");
    await gone;
  };
  await start();
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    await stop();
    rmSync(root, { recursive: true, force: true });
  });
  const cli = async (...args: string[]) =>
    (await run(process.execPath, [CLI, ...args, "--data", data])).stdout;
  const create = async (...args: string[]) => JSON.parse(await cli("create", ...args)) as Created;
  const control = readFileSync(join(data, "control-token"), "utf8").trim();
  const api = (path: string, init: RequestInit = {}, token = control) =>
    fetch(`${url}/v1/computers${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
  const mcp = async (endpoint: string, token: string) => {
    const client = new Client({ name: "by-hand", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    clients.push(client);
    const names = async () => (await client.listTools()).tools.map((tool) => tool.name).sort();
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const { content, isError } = (await client.callTool({ name, arguments: args })) as {
        content: { type: string; text?: string; mimeType?: string; data?: string }[];
        isError?: boolean;
      };
      return {
        text: content.map((b) => b.text ?? "").join(""),
        isError: !!isError,
        images: content.filter((b) => b.type === "image"),
      };
    };
    return { names, call };
  };
  const restart = async () => {
    await stop();
    await start();
  };
  return { root, data, workspace, cli, create, control, api, mcp, restart, url: () => url };
}

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "x", version: "1" },
  },
});
const raw = (endpoint: string, token: string) =>
  fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: initialize,
  });

test("agentcomputer create gives endpoints a hand-run MCP client uses", withBrowser, async (t) => {
  const { create, mcp, workspace } = await setup(t);
  const made = await create("--access", "terminal", "--browser", "--workspace", workspace);
  assert.equal(made.state, "running");
  const computer = await mcp(made.endpoints.computer as string, made.accessToken);
  const ran = await computer.call("exec_command", { cmd: "pwd" });
  assert.equal(ran.isError, false);
  assert.match(ran.text, /^exit_code: 0\n/);
  assert.ok(ran.text.includes(workspace));
  const edited = await computer.call("edit", { path: "n.txt", old_text: "", new_text: "hi\n" });
  assert.equal(edited.isError, false);
  assert.equal(readFileSync(join(workspace, "n.txt"), "utf8"), "hi\n");
  const started = await computer.call("exec_command", { cmd: "cat", yield_time_ms: 250 });
  const session_id = /session_id: (\S+)/.exec(started.text)?.[1] as string;
  const typed = await computer.call("write_stdin", {
    session_id,
    chars: "x\n",
    yield_time_ms: 2000,
  });
  assert.match(typed.text, /text:\nx\n$/);
  await computer.call("write_stdin", { session_id, chars: "\u0004", yield_time_ms: 5000 });

  const browser = await mcp(made.endpoints.browser as string, made.accessToken);
  assert.ok((await browser.names()).includes("browser_navigate"));
  assert.equal((await browser.call("browser_navigate", { url: "about:blank" })).isError, false);

  // A screenshot of its browser comes back as a picture, and a picture in its folder is read as
  // one, by its bytes and not its name: both are what a client passes on to a model.
  const shots = (await browser.call("browser_take_screenshot")).images;
  assert.deepEqual(
    shots.map((shot) => shot.mimeType),
    ["image/png"],
  );
  writeFileSync(join(workspace, "shot"), Buffer.from(shots[0]?.data ?? "", "base64"));
  const read = await computer.call("read", { path: "shot" });
  assert.equal(read.text, "shot: image/png");
  assert.deepEqual(read.images, shots);
});

test("the control token and each computer's token reach only their own", async (t) => {
  const { create, api, control, workspace, data, url } = await setup(t);
  const one = await create("--access", "read", "--workspace", workspace);
  const two = await create("--access", "read", "--workspace", workspace);
  const endpoint = one.endpoints.computer as string;
  assert.equal((await raw(endpoint, one.accessToken)).status, 200);
  assert.equal((await raw(endpoint, two.accessToken)).status, 401);
  assert.equal((await raw(endpoint, control)).status, 401);
  assert.equal((await raw(endpoint, "wrong")).status, 401);
  assert.equal((await fetch(endpoint, { method: "POST", body: initialize })).status, 401);

  assert.equal((await api("")).status, 200);
  assert.equal((await api("", {}, one.accessToken)).status, 401);
  assert.equal((await api(`/${one.computerID}`, {}, one.accessToken)).status, 401);
  assert.equal(
    (await api(`/${one.computerID}`, { method: "DELETE" }, one.accessToken)).status,
    401,
  );
  assert.equal((await api("", {}, "wrong")).status, 401);
  assert.equal((await raw(`${url()}/v1/mcp`, control)).status, 200);
  assert.equal((await raw(`${url()}/v1/mcp`, one.accessToken)).status, 401);

  // A token is shown once and kept only as a digest.
  const listed = JSON.stringify(await (await api("")).json());
  assert.ok(!listed.includes(one.accessToken));
  assert.ok(!readFileSync(join(data, "computers.json"), "utf8").includes(one.accessToken));
  for (const file of ["control-token", "computers.json", "server.json"])
    assert.equal(statSync(join(data, file)).mode & 0o777, 0o600, file);
  assert.equal(statSync(data).mode & 0o777, 0o700);
});

for (const [access, tools] of [
  ["read", ["about", "list", "read", "search"]],
  ["files", ["about", "edit", "list", "read", "search"]],
  [
    "terminal",
    ["about", "edit", "exec_command", "list", "list_sessions", "read", "search", "write_stdin"],
  ],
] as const)
  test(`at ${access} the service lists only its tools`, async (t) => {
    const { create, mcp, workspace, api } = await setup(t);
    const made = await create("--access", access, "--workspace", workspace);
    assert.deepEqual(
      await (await mcp(made.endpoints.computer as string, made.accessToken)).names(),
      tools,
    );
    const got = (await (await api(`/${made.computerID}`)).json()) as {
      tools: { computer: string[] };
    };
    assert.deepEqual([...got.tools.computer].sort(), tools);
  });

test("about tells the agent what a person reads of its computer", async (t) => {
  const { create, mcp, workspace } = await setup(t);
  const made = await create("--access", "files", "--workspace", workspace);
  const computer = await mcp(made.endpoints.computer as string, made.accessToken);
  const { text, isError } = await computer.call("about");
  assert.equal(isError, false);
  const { rows } = JSON.parse(text) as { rows: Record<string, unknown>[] };
  assert.deepEqual(rows.slice(0, 4), [
    { label: "Where", value: hostname() },
    { label: "Folder", value: workspace, path: true },
    { label: "Reaches", value: "Files" },
    { label: "Isolation", value: "None: it acts as you", caution: true },
  ]);
  const [cpu, memory, disk] = rows.slice(4).map((row) => `${row.label}: ${row.value}`);
  assert.match(cpu ?? "", /^CPU: \d+%$/);
  assert.match(memory ?? "", /^Memory: [\d.]+ of [\d.]+ GB$/);
  assert.match(disk ?? "", /^Disk: \d+ of \d+ GB$/);
  assert.equal(rows.length, 7);
});

test(
  "below terminal the tool that runs code is hidden and refused, at terminal it's there",
  withBrowser,
  async (t) => {
    const { create, mcp, workspace } = await setup(t);
    const below = await create("--access", "files", "--browser", "--workspace", workspace);
    const browser = await mcp(below.endpoints.browser as string, below.accessToken);
    const names = await browser.names();
    assert.ok(names.includes("browser_navigate"));
    assert.ok(!names.includes("browser_run_code_unsafe"));
    await assert.rejects(browser.call("browser_run_code_unsafe"), /Unknown tool/);
    const full = await create("--access", "terminal", "--browser", "--workspace", workspace);
    assert.ok(
      (await (await mcp(full.endpoints.browser as string, full.accessToken)).names()).includes(
        "browser_run_code_unsafe",
      ),
    );
    // What each reaches is told to its agent as a person reads it.
    for (const [made, reaches] of [
      [below, "Files, Browser"],
      [full, "Files and terminal, Browser"],
    ] as const) {
      const computer = await mcp(made.endpoints.computer as string, made.accessToken);
      const { rows } = JSON.parse((await computer.call("about")).text) as { rows: unknown[] };
      assert.deepEqual(rows[2], { label: "Reaches", value: reaches });
    }
  },
);

test("a computer has only what it was asked for", withBrowser, async (t) => {
  const { create, api, workspace, url } = await setup(t);
  const plain = await create("--access", "read", "--workspace", workspace);
  assert.equal(plain.endpoints.browser, null);
  assert.equal(
    (await raw(`${url()}/v1/computers/${plain.computerID}/mcp/browser`, plain.accessToken)).status,
    404,
  );
  const only = await create("--access", "none", "--browser");
  assert.equal(only.endpoints.computer, null);
  assert.ok(only.endpoints.browser);
  const refuse = async (body: object) =>
    (await api("", { method: "POST", body: JSON.stringify(body) })).status;
  assert.equal(await refuse({ access: "none" }), 400);
  assert.equal(await refuse({ access: "everything" }), 400);
  assert.equal(await refuse({ access: "read", workspace: "relative" }), 400);
  assert.equal(await refuse({ access: "read", workspace: join(workspace, "nope") }), 400);
  assert.equal(await refuse({ access: "read", timeout: -1 }), 400);
});

test("kill removes what the service made, and never a folder someone named", async (t) => {
  const { create, cli, workspace, data, api } = await setup(t);
  const named = await create("--access", "files", "--workspace", workspace);
  await cli("kill", named.computerID);
  assert.ok(existsSync(workspace));
  assert.equal((await api(`/${named.computerID}`)).status, 404);
  assert.equal((await raw(named.endpoints.computer as string, named.accessToken)).status, 401);

  const own = await create("--access", "files");
  assert.ok(own.workspace?.startsWith(data));
  assert.ok(existsSync(own.workspace as string));
  await cli("kill", own.computerID);
  assert.equal(existsSync(own.workspace as string), false);
});

test("a computer stops at its timeout, its folder stays, and a running one can be extended", async (t) => {
  const { create, cli, api, workspace } = await setup(t);
  const short = await create("--access", "read", "--workspace", workspace, "--timeout", "1");
  const kept = await create("--access", "read", "--workspace", workspace, "--timeout", "1");
  const extended = JSON.parse(await cli("timeout", kept.computerID, "600")) as { endAt: string };
  assert.ok(Date.parse(extended.endAt) > Date.now() + 500_000);
  await new Promise((done) => setTimeout(done, 1500));
  const stopped = (await (await api(`/${short.computerID}`)).json()) as { state: string };
  assert.equal(stopped.state, "stopped");
  assert.equal((await raw(short.endpoints.computer as string, short.accessToken)).status, 409);
  assert.ok(existsSync(workspace));
  assert.equal((await raw(kept.endpoints.computer as string, kept.accessToken)).status, 200);
  assert.equal(
    (await api(`/${short.computerID}/timeout`, { method: "POST", body: '{"timeout":60}' })).status,
    409,
  );
});

test(
  "computers and tokens come back when the service restarts, and logs say what happened",
  withBrowser,
  async (t) => {
    const { create, restart, cli, url, workspace } = await setup(t);
    const made = await create("--access", "read", "--browser", "--workspace", workspace);
    const before = new URL(made.endpoints.computer as string).pathname;
    await restart();
    assert.equal((await raw(`${url()}${before}`, made.accessToken)).status, 200);
    assert.match(await cli("logs", made.computerID), /POST mcp\/computer/);
    const listed = JSON.parse(await cli("list")) as { computerID: string; state: string }[];
    assert.deepEqual(
      listed.map((one) => [one.computerID, one.state]),
      [[made.computerID, "running"]],
    );
  },
);

for (const [why, args] of [
  ["another address without TLS", ["--listen", "0.0.0.0:0"]],
  ["an isolation it doesn't have", ["--listen", "127.0.0.1:0", "--isolation", "vm"]],
] as const)
  test(`serve refuses ${why}`, async (t) => {
    const data = mkdtempSync(join(tmpdir(), "agentcomputer-"));
    t.after(() => rmSync(data, { recursive: true, force: true }));
    await assert.rejects(run(process.execPath, [CLI, "serve", ...args, "--data", data]));
  });

test("a command with no service running says how to start one", async () => {
  const data = mkdtempSync(join(tmpdir(), "agentcomputer-"));
  await assert.rejects(
    run(process.execPath, [CLI, "list", "--data", data]),
    (error: Error & { stderr: string }) => /agentcomputer serve/.test(error.stderr),
  );
  rmSync(data, { recursive: true, force: true });
});

test("real: Playwright MCP opens and reads a page through the proxy", {
  skip: !realBrowser,
}, async (t) => {
  const site = createServer((_, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<!doctype html><title>Checkout</title><button>Pay now</button>");
  }).listen(0, "127.0.0.1");
  await once(site, "listening");
  t.after(() => site.close());
  const page = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
  const { create, mcp, workspace } = await setup(t, [
    "--browser-name",
    "chromium",
    "--browser-path",
    realBrowser as string,
  ]);
  const made = await create("--access", "read", "--browser", "--workspace", workspace);
  const browser = await mcp(made.endpoints.browser as string, made.accessToken);
  const names = await browser.names();
  assert.ok(names.includes("browser_snapshot"));
  assert.ok(!names.includes("browser_run_code_unsafe"));
  assert.match(
    (await browser.call("browser_navigate", { url: page })).text,
    /- Page Title: Checkout/,
  );
  assert.match((await browser.call("browser_snapshot")).text, /button "Pay now"/);
});
