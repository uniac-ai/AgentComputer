// A computer's browser lives as long as the computer does, whatever its clients do: one that ends
// its session, one that goes without a word, and an agent that asks to close it. On this computer
// the browser is the one AGENTCOMPUTER_BROWSER_PATH names, and in a container the image's.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { CONTAINER, type Kind, make, named, needs } from "./kinds.ts";

type Sdk = typeof import("../src/sdk.ts");
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "dist");
const CLI = join(dist, "agentcomputer.js");
const BROWSER = process.env.AGENTCOMPUTER_BROWSER_PATH;
const KINDS: [Kind, string[] | undefined][] = [
  ["this", BROWSER ? ["--browser-name", "chromium", "--browser-path", BROWSER] : undefined],
  ["container", CONTAINER],
];

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until(check: () => Promise<boolean>, what: string) {
  const deadline = Date.now() + 60_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `Waited too long for ${what}.`);
    await sleep(250);
  }
}

async function setup(t: test.TestContext, kind: Kind, extra: string[]) {
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
  child.removeAllListeners("exit");
  const { Computer } = (await import(pathToFileURL(join(dist, "sdk.js")).href)) as Sdk;
  const to = { apiUrl: url, apiKey: readFileSync(join(data, "control-token"), "utf8").trim() };
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    for (const computer of await Computer.list(to).catch(() => []))
      await Computer.kill(computer.computerID, to).catch(() => {});
    const gone = once(child, "exit");
    child.kill("SIGTERM");
    await gone;
    rmSync(root, { recursive: true, force: true });
  });
  const computer = await make(Computer, kind, {
    ...to,
    access: "terminal",
    browser: true,
    workspace,
  });
  /** One session on the browser, as one client holds. */
  const session = async () => {
    const transport = new StreamableHTTPClientTransport(new URL(computer.getMcpUrl("browser")), {
      requestInit: { headers: { Authorization: `Bearer ${computer.getMcpToken()}` } },
    });
    const client = new Client({ name: "by-hand", version: "1" });
    await client.connect(transport);
    clients.push(client);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as {
        content: { text?: string }[];
        isError?: boolean;
      };
      return { text: result.content.map((b) => b.text ?? "").join(""), isError: !!result.isError };
    };
    return { client, transport, call };
  };
  /** Whether a session the service was given earlier is still known to the browser's server. */
  const known = async (sessionId: string) => {
    const answer = await fetch(computer.getMcpUrl("browser"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${computer.getMcpToken()}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    await answer.arrayBuffer();
    return answer.status !== 404;
  };
  return { computer, session, known };
}

for (const [kind, extra] of KINDS)
  test(`on ${named(kind)}: its browser outlives its clients, and isn't theirs to close`, {
    timeout: 180_000,
    skip: !extra && needs(kind),
  }, async (t) => {
    const { computer, session, known } = await setup(t, kind, extra as string[]);
    /** The computer runs, and a new client finds the page where it was left. */
    const stillThere = async () => {
      assert.equal((await computer.getInfo()).state, "running");
      const next = await session();
      const page = await next.call("browser_snapshot");
      assert.equal(page.isError, false, page.text.slice(0, 300));
      assert.match(page.text, /Page Title: kept/);
      return next;
    };

    // Its only client ends its session, as a client does that closes well.
    const first = await session();
    await first.call("browser_navigate", { url: "data:text/html,<title>kept</title>here" });
    const ended = first.transport.sessionId as string;
    await first.transport.terminateSession();
    await first.client.close();
    assert.equal(await known(ended), false);
    // Longer than a browser took to stop when this closed it.
    await sleep(1500);
    const second = await stillThere();

    // Its only client goes without a word, as an app does that is restarted: after a few seconds
    // unanswered its session is closed for it, which is waited for here.
    const silent = second.transport.sessionId as string;
    await second.client.close();
    assert.equal(await known(silent), true);
    await until(async () => !(await known(silent)), "the silent session to be closed");
    await sleep(1500);
    const third = await stillThere();

    // The tool that closes the browser is refused: the browser is the computer's.
    const closing = await third.call("browser_close");
    assert.equal(closing.isError, true);
    assert.match(closing.text, /cannot be closed/);
    assert.equal((await third.call("browser_snapshot")).isError, false);
    assert.equal((await computer.getInfo()).state, "running");

    // When its browser does stop, here by the agent's own code at terminal access, what can be
    // opened live says so. The tool's answer may not get back out of a container that ends with
    // its browser.
    await third
      .call("browser_run_code_unsafe", {
        code: "async (page) => { await page.context().close(); }",
      })
      .catch(() => {});
    await until(async () => (await computer.getInfo()).state === "failed", "the computer to fail");
    const browser = (await computer.getInfo()).surfaces.find((one) => one.surface === "browser");
    assert.match(browser?.unavailable ?? "", /has stopped/);
    await assert.rejects(computer.liveSession("browser"), /has stopped/);
  });
