// Live sessions: one-time tickets, the Origin rule, and every terminal on one socket, the agent's
// commands and a person's shells alike, the same with and without isolation.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";

type Sdk = typeof import("../src/sdk.ts");
type TerminalEvent = import("../src/sdk.ts").TerminalEvent;
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "dist");
const CLI = join(dist, "agentcomputer.js");
const IMAGE = process.env.AGENTCOMPUTER_TEST_IMAGE;
const ISOLATIONS: [string, string[]][] = [
  ["none", []],
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
          ["terminal", true, null],
          ["files", true, null],
        ],
      );

      const once1 = await computer.liveSession("terminal");
      assert.equal(await attempt(once1.url), "open");
      assert.equal(await attempt(once1.url), "404");

      const fromPage = await computer.liveSession("terminal");
      assert.equal(await attempt(fromPage.url, "https://evil.example"), "403");
      assert.equal(
        await attempt(fromPage.url),
        "open",
        "a refused origin doesn't use up the ticket",
      );

      assert.equal(await attempt(`${url.replace("http", "ws")}/v1/live/l_made_up`), "404");
      assert.equal((await fetch(`${url}/v1/live/anything`)).status, 426);

      const reader = await Computer.create({ ...to, access: "files", workspace });
      assert.deepEqual(
        (await reader.getInfo()).surfaces.map((one) => one.surface),
        ["files"],
      );
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
      const heard: TerminalEvent[] = [];
      const watch = await computer.terminals.connect({
        mode: "watch",
        onEvent: (event) => heard.push(event),
      });
      await until(() => heard.some((e) => e.type === "exit"), "the earlier command");
      assert.deepEqual(
        heard.map((e) => e.type),
        ["start", "output", "exit"],
      );
      const [earlier, wrote, ended] = heard;
      assert.ok(earlier?.type === "start" && earlier.by === "agent" && !earlier.tty);
      assert.equal(earlier.cmd, "echo earlier");
      assert.ok(wrote?.type === "output" && wrote.text === "earlier\n" && !wrote.stream);
      assert.ok(ended?.type === "exit" && ended.exitCode === 0 && ended.id === earlier.id);

      const running = await computer.commands.run("echo now; sleep 1; echo later", {
        background: true,
      });
      assert.ok("sessionId" in running);
      await until(
        () =>
          heard.some(
            (e) =>
              e.type === "output" &&
              e.id === running.sessionId &&
              e.stream === "stdout" &&
              e.text.includes("later"),
          ),
        "output written after the agent's call returned",
      );
      const start = heard.find((e) => e.type === "start" && e.id === running.sessionId);
      assert.equal(
        start?.type === "start" && start.workdir,
        isolation === "none" ? workspace : "/workspace",
      );

      await computer.commands.run(`: ${"x".repeat(9_000)}`);
      const long = () => heard.find((e) => e.type === "start" && e.cmd.startsWith(": x"));
      await until(() => long() !== undefined, "the long command starting");
      const cut = long();
      assert.equal(cut?.type === "start" && cut.cmd.length, 8_000);
      watch.close();
    },
  );

  test(
    `isolation ${isolation}: a person's shell and the agent's commands, each reached by the other`,
    options,
    async (t) => {
      const { Computer, to, workspace, alive } = await setup(t, extra);
      const computer = await Computer.create({ ...to, access: "terminal", workspace });
      t.after(() => computer.close());
      const seen: TerminalEvent[] = [];
      const watched: TerminalEvent[] = [];
      const wrote = (events: TerminalEvent[], id: string) =>
        events.map((e) => (e.type === "output" && e.id === id ? e.text : "")).join("");
      const person = await computer.terminals.connect({ onEvent: (event) => seen.push(event) });
      const watcher = await computer.terminals.connect({
        mode: "watch",
        onEvent: (event) => watched.push(event),
      });

      // A watcher opens nothing; an operator's shell arrives as a start like any other.
      watcher.openShell(80, 24);
      person.openShell(80, 24);
      await until(() => seen.some((e) => e.type === "start"), "the shell starting");
      await until(() => watched.some((e) => e.type === "start"), "the watcher hearing it start");
      const shell = seen.find((e) => e.type === "start");
      assert.ok(shell?.type === "start" && shell.by === "person" && shell.tty);
      assert.equal(shell.workdir, isolation === "none" ? workspace : "/workspace");

      person.sendInput(shell.id, "echo answer-$((6*7))\n");
      await until(() => wrote(seen, shell.id).includes("answer-42"), "the shell's answer");
      await until(() => wrote(watched, shell.id).includes("answer-42"), "the watcher seeing it");

      watcher.sendInput(shell.id, "echo typed-by-watcher\n");
      person.resize(shell.id, 100, 30);
      person.sendInput(shell.id, "stty size\n");
      await until(() => wrote(seen, shell.id).includes("30 100"), "the new size");
      assert.ok(!wrote(seen, shell.id).includes("typed-by-watcher"));
      assert.equal(seen.filter((e) => e.type === "start").length, 1);

      // The agent types into the person's shell, by the id every viewer was given.
      await computer.commands.sendStdin(shell.id, "echo from-the-agent-$((1+1))\n");
      await until(() => wrote(seen, shell.id).includes("from-the-agent-2"), "the agent's typing");

      // The person types into the agent's command, and stops it.
      const cat = await computer.commands.run("cat", { background: true });
      assert.ok("sessionId" in cat);
      person.sendInput(cat.sessionId, "typed-by-a-person\n");
      await until(() => wrote(seen, cat.sessionId).includes("typed-by-a-person"), "cat's echo");
      person.sendInput(cat.sessionId, `${"long".repeat(20_000)}\n`);
      await until(() => wrote(seen, cat.sessionId).length > 80_000, "a long text, sent in parts");
      person.stop(cat.sessionId);
      const exitOf = (id: string) => seen.find((e) => e.type === "exit" && e.id === id);
      await until(() => exitOf(cat.sessionId) !== undefined, "the command stopping");

      // What can't be done is answered with why, to the one that asked, and the socket goes on.
      const refusals = (events: TerminalEvent[]) =>
        events.flatMap((e) => (e.type === "refused" ? [e.message] : []));
      person.sendInput("s_nobody", "x");
      person.resize(shell.id, 0, 30);
      person.resize(cat.sessionId, 100, 30);
      person.sendInput(cat.sessionId, "too late\n");
      person.stop("s_nobody");
      await until(() => refusals(seen).length === 5, "five refusals");
      assert.deepEqual(refusals(seen), [
        "No terminal s_nobody is here.",
        "A terminal has 1 to 1000 columns and rows.",
        "That terminal has ended.",
        "That terminal has ended.",
        "No terminal s_nobody is here.",
      ]);
      assert.deepEqual(refusals(watched), []);

      // A late socket is shown each terminal with the end of what it wrote, no message too large
      // whatever the text, and no character cut in two.
      await computer.commands.run("head -c 70000 /dev/zero");
      await computer.commands.run("yes 😀 | head -c 300000");
      const sizes: number[] = [];
      const late: TerminalEvent[] = [];
      const raw = new WebSocket((await computer.liveSession("terminal", "operate")).url);
      raw.on("message", (data: Buffer) => {
        sizes.push(data.length);
        late.push(JSON.parse(data.toString()) as TerminalEvent);
      });
      await until(() => late.filter((e) => e.type === "exit").length === 3, "the three that ended");
      assert.ok(wrote(late, shell.id).includes("answer-42"));
      const started = (cmd: string) => {
        const start = late.find((e) => e.type === "start" && e.cmd.startsWith(cmd));
        return start?.type === "start" ? start.id : "";
      };
      assert.equal(wrote(late, started("head")), "\0".repeat(65_536));
      assert.ok(wrote(late, started("yes")).length >= 65_535);
      for (const e of late)
        if (e.type === "output") assert.equal(Buffer.from(e.text).toString(), e.text);
      assert.ok(Math.max(...sizes) > 32_768, "The text that takes the most bytes was sent.");
      assert.ok(Math.max(...sizes) <= 65_536, `A message of ${Math.max(...sizes)} bytes.`);
      raw.send("not json");
      raw.send(JSON.stringify({ type: "input", id: 7, text: "x" }));
      raw.send(JSON.stringify({ type: "open", columns: "80", rows: 24 }));
      raw.send(JSON.stringify({ type: "input", id: shell.id, text: "echo still-$((2+3))\n" }));
      await until(() => wrote(late, shell.id).includes("still-5"), "the socket going on");
      assert.deepEqual(refusals(late), [
        "That isn't a terminal@1 message.",
        "That isn't a terminal@1 message.",
        "A terminal has 1 to 1000 columns and rows.",
      ]);
      assert.equal(refusals(seen).length, 5, "a refusal goes only to the socket that asked");
      assert.equal(late.filter((e) => e.type === "start").length, 4);
      const closed = once(raw, "close");
      raw.send(JSON.stringify({ type: "input", id: shell.id, text: "x".repeat(70_000) }));
      await closed;

      // A shell that exits is heard ending, and its socket stays for the others.
      person.sendInput(shell.id, "exit\n");
      await until(() => exitOf(shell.id) !== undefined, "the shell exiting");
      person.openShell(80, 24);
      await until(() => seen.filter((e) => e.type === "start").length === 5, "a second shell");

      await computer.kill();
      assert.equal((await person.closed).code > 0, true);
      await watcher.closed;
      assert.equal(alive(), true);
    },
  );
}

test("a page's origin can be allowed", { timeout: 60_000 }, async (t) => {
  const { Computer, to } = await setup(t, ["--allow-origin", "https://agents.example"]);
  const computer = await Computer.create({ ...to, access: "terminal" });
  t.after(() => computer.close());
  assert.equal(
    await attempt((await computer.liveSession("terminal")).url, "https://agents.example"),
    "open",
  );
  assert.equal(
    await attempt((await computer.liveSession("terminal")).url, "https://other.example"),
    "403",
  );
});

test("a shell that can't start is refused or heard ending, and nothing else does", {
  timeout: 60_000,
}, async (t) => {
  const { Computer, to, alive } = await setup(t, [], "/nonexistent/shell");
  const computer = await Computer.create({ ...to, access: "terminal" });
  t.after(() => computer.close());
  const heard: TerminalEvent[] = [];
  const person = await computer.terminals.connect({ onEvent: (event) => heard.push(event) });
  person.openShell(80, 24);
  // Refused at spawn on one platform, started and gone at once on another.
  await until(() => heard.some((e) => e.type === "exit" || e.type === "refused"), "its end");
  const end = heard.at(-1);
  if (end?.type === "refused") assert.match(end.message, /^The shell didn't start: /);
  else assert.ok(end?.type === "exit" && end.exitCode !== 0 && heard[0]?.type === "start");
  await new Promise((done) => setTimeout(done, 500));
  assert.equal(alive(), true);
  assert.equal(await computer.isRunning(), true);
  person.close();
});

test("where a shell can't run on a terminal device, opening one is refused with why", async (t) => {
  const { Live } = await import("../src/live.ts");
  const { createAgentExec } = await import("@agentorg/exec");
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "ac-")));
  const pty = () => {
    throw new Error("there is no device here.");
  };
  const exec = createAgentExec({ workspace, level: "terminal", pty });
  const live = new Live(exec, "terminal");
  const server = createServer().on("upgrade", (request, socket, head) =>
    live.open("terminal", "operate", request, socket, head),
  );
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    live.close();
    await exec.close();
    server.close();
    rmSync(workspace, { recursive: true, force: true });
  });
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const heard: TerminalEvent[] = [];
  ws.on("message", (data: Buffer) => heard.push(JSON.parse(data.toString()) as TerminalEvent));
  await once(ws, "open");
  ws.send(JSON.stringify({ type: "open", columns: 80, rows: 24 }));
  await until(() => heard.length === 1, "the refusal");
  assert.deepEqual(heard, [
    { type: "refused", message: "The shell didn't start: there is no device here." },
  ]);
  ws.close();
});

test("a viewer more than 4 MiB behind is closed, and one that opens is shown all", async (t) => {
  const { Live } = await import("../src/live.ts");
  type Exec = import("@agentorg/exec").AgentExec;
  type Heard = Parameters<Parameters<Exec["onCommand"]>[0]>[0];
  const at = new Date().toISOString();
  const kept = { id: "s_1", by: "agent", cmd: "yes", workdir: "/", tty: false, at } as const;
  let hear: (event: Heard) => void = () => {};
  const exec = {
    onCommand: (listener: typeof hear) => {
      hear = listener;
    },
    terminals: { list: () => [{ ...kept, output: "y\n".repeat(32_768) }] },
  } as unknown as Exec;
  const live = new Live(exec, "terminal");
  const server = createServer().on("upgrade", (request, socket, head) =>
    live.open("terminal", "watch", request, socket, head),
  );
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => {
    live.close();
    server.close();
  });
  const view = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const heard: TerminalEvent[] = [];
    ws.on("message", (data: Buffer) => heard.push(JSON.parse(data.toString()) as TerminalEvent));
    await once(ws, "open");
    return { ws, heard };
  };

  // All of this is written before the viewer can read any of it: 64 MB, then the end.
  const behind = await view();
  let code: number | undefined;
  behind.ws.on("close", (closed: number) => {
    code = closed;
  });
  for (let sent = 0; sent < 64; sent += 1)
    hear({ type: "output", id: "s_1", stream: "stdout", text: "y\n".repeat(524_288) });
  hear({ type: "exit", id: "s_1", exitCode: 0, at });
  await until(() => code !== undefined, "the viewer being closed");
  assert.equal(code, 1006);
  assert.ok(!behind.heard.some((e) => e.type === "exit"));

  const fresh = await view();
  t.after(() => fresh.ws.close());
  await until(() => fresh.heard.length === 8, "what a new viewer is first sent");
  assert.deepEqual(fresh.heard[0], { type: "start", ...kept });
  assert.equal(fresh.heard.map((e) => (e.type === "output" ? e.text : "")).join("").length, 65_536);
});
