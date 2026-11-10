// Live sessions: one-time tickets, the Origin rule, the agent's commands as they run, and a shell
// of the person's own, the same with and without isolation.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";

type Sdk = typeof import("../src/sdk.ts");
type CommandEvent = import("../src/sdk.ts").CommandEvent;
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "dist");
const CLI = join(dist, "agentcomputer.js");
const STAND_IN = join(here, "..", "..", "test", "fixtures", "playwright.js");
const IMAGE = process.env.AGENTCOMPUTER_TEST_IMAGE;
const ISOLATIONS: [string, string[]][] = [
  ["none", ["--playwright-cli", STAND_IN]],
  ...(IMAGE
    ? ([["container", ["--isolation", "container", "--image", IMAGE]]] as [string, string[]][])
    : []),
];

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `Waited too long for ${what}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

async function setup(t: test.TestContext, extra: string[], shell = "/bin/bash") {
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
        SHELL: shell,
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
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const { Computer } = (await import(pathToFileURL(join(dist, "sdk.js")).href)) as Sdk;
  const to = { apiUrl: url, apiKey: readFileSync(join(data, "control-token"), "utf8").trim() };
  t.after(async () => {
    for (const computer of await Computer.list(to).catch(() => []))
      await Computer.kill(computer.computerID, to).catch(() => {});
    if (!exited) {
      const gone = once(child, "exit");
      child.kill("SIGTERM");
      await gone;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { Computer, to, url, workspace, alive: () => !exited };
}

/** Open a socket as a page would, or as a server would, and say how it went. */
const attempt = (url: string, origin?: string) =>
  new Promise<string>((done) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    ws.on("open", () => {
      done("open");
      ws.close();
    });
    ws.on("unexpected-response", (_, response) => done(String(response.statusCode)));
    ws.on("error", (error) => done(`error ${error.message}`));
  });

for (const [isolation, extra] of ISOLATIONS) {
  const options = { timeout: 120_000 };

  test(
    `isolation ${isolation}: a ticket opens once, never from a page, and only what it's for`,
    options,
    async (t) => {
      const { Computer, to, url, workspace } = await setup(t, extra);
      const computer = await Computer.create({ ...to, access: "terminal", workspace });
      t.after(() => computer.close());
      const { surfaces } = await computer.getInfo();
      assert.deepEqual(
        surfaces.map((one) => [one.surface, one.operate, one.unavailable ?? null]),
        [
          ["commands", false, null],
          ["terminal", true, null],
        ],
      );

      const once1 = await computer.liveSession("commands");
      assert.equal(await attempt(once1.url), "open");
      assert.equal(await attempt(once1.url), "404");

      const fromPage = await computer.liveSession("commands");
      assert.equal(await attempt(fromPage.url, "https://evil.example"), "403");
      assert.equal(
        await attempt(fromPage.url),
        "open",
        "a refused origin doesn't use up the ticket",
      );

      assert.equal(await attempt(`${url.replace("http", "ws")}/v1/live/l_made_up`), "404");
      assert.equal((await fetch(`${url}/v1/live/anything`)).status, 426);

      const reader = await Computer.create({ ...to, access: "files", workspace });
      assert.deepEqual((await reader.getInfo()).surfaces, []);
      await assert.rejects(reader.liveSession("terminal"), /no terminal to open/);
    },
  );

  test(
    `isolation ${isolation}: the agent's commands as they run, and what came before`,
    options,
    async (t) => {
      const { Computer, to, workspace } = await setup(t, extra);
      const computer = await Computer.create({ ...to, access: "terminal", workspace });
      t.after(() => computer.close());
      await computer.commands.run("echo earlier");
      const heard: CommandEvent[] = [];
      const watch = await computer.commands.watch((event) => heard.push(event));
      await until(() => heard.some((e) => e.type === "exit"), "the earlier command");
      assert.ok(heard.some((e) => e.type === "output" && e.text === "earlier\n"));

      const running = await computer.commands.run("echo now; sleep 1; echo later", {
        background: true,
      });
      assert.ok("sessionId" in running);
      await until(
        () =>
          heard.some(
            (e) => e.type === "output" && e.id === running.sessionId && e.text.includes("later"),
          ),
        "output written after the agent's call returned",
      );
      const start = heard.find((e) => e.type === "start" && e.id === running.sessionId);
      assert.equal(
        start?.type === "start" && start.workdir,
        isolation === "none" ? workspace : "/workspace",
      );
      watch.close();
    },
  );

  test(
    `isolation ${isolation}: a shell of the person's own, shared, sized, and watched without typing`,
    options,
    async (t) => {
      const { Computer, to, workspace, alive } = await setup(t, extra);
      const computer = await Computer.create({ ...to, access: "terminal", workspace });
      t.after(() => computer.close());
      let seen = "";
      const shell = await computer.pty.connect({ onData: (data) => (seen += data) });
      let watched = "";
      const watcher = await computer.pty.connect({
        mode: "watch",
        onData: (data) => (watched += data),
      });

      shell.sendInput("pwd; echo answer-$((6*7))\n");
      await until(() => seen.includes("answer-42"), "the shell's answer");
      assert.ok(seen.includes(isolation === "none" ? workspace : "/workspace"));
      await until(() => watched.includes("answer-42"), "the watcher seeing it");

      watcher.sendInput("echo typed-by-watcher\n");
      shell.resize(100, 30);
      shell.sendInput("stty size\n");
      await until(() => seen.includes("30 100"), "the new size");
      assert.ok(!seen.includes("typed-by-watcher"));

      let late = "";
      const second = await computer.pty.connect({ onData: (data) => (late += data) });
      await until(() => late.includes("answer-42"), "what the shell wrote before, for a new tab");
      second.close();

      shell.sendInput("exit\n");
      assert.equal((await shell.closed).reason, "The shell exited.");
      await watcher.closed;
      let again = "";
      const fresh = await computer.pty.connect({ onData: (data) => (again += data) });
      fresh.sendInput("echo fresh\n");
      await until(() => again.includes("fresh"), "a new shell");

      await computer.kill();
      assert.equal((await fresh.closed).code > 0, true);
      assert.equal(alive(), true);
    },
  );
}

test("a page's origin can be allowed", { timeout: 60_000 }, async (t) => {
  const { Computer, to } = await setup(t, [
    "--playwright-cli",
    STAND_IN,
    "--allow-origin",
    "https://agents.example",
  ]);
  const computer = await Computer.create({ ...to, access: "terminal" });
  t.after(() => computer.close());
  assert.equal(
    await attempt((await computer.liveSession("commands")).url, "https://agents.example"),
    "open",
  );
  assert.equal(
    await attempt((await computer.liveSession("commands")).url, "https://other.example"),
    "403",
  );
});

test("a shell that can't start closes its socket and nothing else", {
  timeout: 60_000,
}, async (t) => {
  const { Computer, to, alive } = await setup(
    t,
    ["--playwright-cli", STAND_IN],
    "/nonexistent/shell",
  );
  const computer = await Computer.create({ ...to, access: "terminal" });
  t.after(() => computer.close());
  const shell = await computer.pty.connect({ onData: () => {} });
  // Refused at spawn on one platform, started and gone at once on another: either way it closes.
  const { reason } = await shell.closed;
  assert.match(reason, /didn't start|exited/);
  await new Promise((done) => setTimeout(done, 500));
  assert.equal(alive(), true);
  assert.equal(await computer.isRunning(), true);
});
