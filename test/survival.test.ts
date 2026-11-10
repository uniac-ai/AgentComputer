// However one computer ends, the service and every other computer carry on, and a computer's
// browser lives as long as the computer does, whatever its clients do. The computers that end
// have a real browser: with no isolation the one AGENTCOMPUTER_BROWSER_PATH names, never the Chrome
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

type Sdk = typeof import("../src/sdk.ts");
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "dist");
const CLI = join(dist, "agentcomputer.js");
const BROWSER = process.env.AGENTCOMPUTER_BROWSER_PATH;
const IMAGE = process.env.AGENTCOMPUTER_TEST_IMAGE;
const docker = promisify(execFile);
const ISOLATIONS: [string, string[] | undefined][] = [
  ["none", BROWSER ? ["--browser-name", "chromium", "--browser-path", BROWSER] : undefined],
  ["container", IMAGE ? ["--isolation", "container", "--image", IMAGE] : undefined],
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
    [CLI, "serve", "--listen", "127.0.0.1:0", "--data", data, ...extra],
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

for (const [isolation, given] of ISOLATIONS) {
  const options = {
    timeout: 120_000,
    skip:
      !given &&
      (isolation === "none"
        ? "needs AGENTCOMPUTER_BROWSER_PATH"
        : "needs AGENTCOMPUTER_TEST_IMAGE"),
  };
  const extra = given ?? [];

  test(
    `isolation ${isolation}: killing a browser computer once its client has gone`,
    options,
    async (t) => {
      const { Computer, to, workspace, connect, survived } = await setup(t, extra);
      const other = await Computer.create({ ...to, access: "files", workspace });
      t.after(() => other.close());
      const computer = await Computer.create({ ...to, access: "none", browser: true });
      const client = await connect(computer.getMcpUrl("browser"), computer.getMcpToken());
      await client.close();
      await computer.kill();
      await survived(other);
      assert.ok(!(await Computer.list(to)).some((one) => one.computerID === computer.computerID));
    },
  );

  test(
    `isolation ${isolation}: killing a browser computer with a client still connected`,
    options,
    async (t) => {
      const { Computer, to, workspace, connect, survived } = await setup(t, extra);
      const other = await Computer.create({ ...to, access: "files", workspace });
      t.after(() => other.close());
      const computer = await Computer.create({ ...to, access: "terminal", browser: true });
      await connect(computer.getMcpUrl("browser"), computer.getMcpToken());
      await connect(computer.getMcpUrl(), computer.getMcpToken());
      await computer.kill();
      await survived(other);
    },
  );

  test(
    `isolation ${isolation}: a browser computer reaching its timeout with a client connected`,
    options,
    async (t) => {
      const { Computer, to, workspace, connect, survived } = await setup(t, extra);
      const other = await Computer.create({ ...to, access: "files", workspace });
      t.after(() => other.close());
      const computer = await Computer.create({ ...to, access: "terminal", browser: true });
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

for (const [isolation, given] of ISOLATIONS)
  test(`isolation ${isolation}: its browser outlives its clients, and isn't theirs to close`, {
    timeout: 180_000,
    skip:
      !given &&
      (isolation === "none"
        ? "needs AGENTCOMPUTER_BROWSER_PATH"
        : "needs AGENTCOMPUTER_TEST_IMAGE"),
  }, async (t) => {
    const { Computer, to, workspace } = await setup(t, given ?? []);
    const computer = await Computer.create({
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
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const result = (await client.callTool({ name, arguments: args })) as {
          content: { text?: string }[];
          isError?: boolean;
        };
        return {
          text: result.content.map((b) => b.text ?? "").join(""),
          isError: !!result.isError,
        };
      };
      return { client, transport, call };
    };
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
    await first.transport.terminateSession();
    await first.client.close();
    await settle();
    const second = await stillThere();

    // Its only client goes without a word, as an app does that is restarted: after a few
    // seconds unanswered its session is closed for it.
    await second.client.close();
    await new Promise((done) => setTimeout(done, 12_000));
    const third = await stillThere();

    // The tool that closes the browser is refused: the browser is the computer's.
    const closing = await third.call("browser_close");
    assert.equal(closing.isError, true);
    assert.match(closing.text, /cannot be closed/);
    await settle();
    assert.equal((await third.call("browser_snapshot")).isError, false);
    assert.equal((await computer.getInfo()).state, "running");

    // When its browser does stop, here by the agent's own code at terminal access, what can be
    // opened live says so.
    await third.call("browser_run_code_unsafe", {
      code: "async (page) => { await page.context().close(); }",
    });
    await settle();
    const stopped = await computer.getInfo();
    assert.equal(stopped.state, "failed");
    const browser = stopped.surfaces.find((one) => one.surface === "browser");
    assert.match(browser?.unavailable ?? "", /has stopped/);
    await assert.rejects(computer.liveSession("browser"), /has stopped/);
    await third.client.close().catch(() => {});
  });

test("isolation container: a container dying with a client connected", {
  skip: !IMAGE && "needs AGENTCOMPUTER_TEST_IMAGE",
  timeout: 120_000,
}, async (t) => {
  const { Computer, to, workspace, connect, survived } = await setup(t, [
    "--isolation",
    "container",
    "--image",
    IMAGE as string,
  ]);
  const other = await Computer.create({ ...to, access: "files", workspace });
  t.after(() => other.close());
  const computer = await Computer.create({ ...to, access: "terminal", browser: true });
  await connect(computer.getMcpUrl("browser"), computer.getMcpToken());
  await docker("docker", ["kill", `agentcomputer-${computer.computerID}`]);
  await survived(other);
  const dead = await computer.getInfo();
  assert.equal(dead.state, "failed");
  assert.ok(dead.surfaces.length > 0);
  for (const one of dead.surfaces) assert.match(one.unavailable ?? "", /container has stopped/);
});
