// The browser live: frames while the agent works, a person's input on the same page, the driver
// lock the agent's calls wait on, and dialogs, file choosers and lists the person answers.
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import WebSocket from "ws";

type Sdk = typeof import("../src/sdk.ts");
// biome-ignore lint/suspicious/noExplicitAny: each event is JSON the test reads.
type Event = { type: string; [key: string]: any };
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

const PAGE = `<!doctype html><title>Live</title>
<button id=count onclick="s.count++" style="width:200px;height:40px">count</button>
<button id=dlg onclick="s.confirmed=confirm('sure?')">dialog</button>
<input id=file type=file onchange="s.file=this.files[0]&&this.files[0].name">
<select id=sel onchange="s.choice=this.value"><option value=a>A</option><option value=b>B</option></select>
<div id=tick></div>
<script>window.s={count:0};let n=0;(function f(){tick.textContent=++n;requestAnimationFrame(f)})()</script>`;

async function until(check: () => boolean, what: string, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, `Waited too long for ${what}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

async function setup(t: test.TestContext, extra: string[]) {
  const root = realpathSync(
    mkdtempSync(join(process.env.AGENTCOMPUTER_TEST_ROOT ?? tmpdir(), "ac-")),
  );
  const data = join(root, "data");
  mkdirSync(join(root, "workspace"));
  const child: ChildProcess = spawn(
    process.execPath,
    [CLI, "serve", "--listen", "127.0.0.1:0", "--data", data, ...extra],
    {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        SHELL: "/bin/bash",
        // As a person's shell has it: on macOS a long per-user folder.
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
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
  const clients: Client[] = [];
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    for (const client of clients) await client.close().catch(() => {});
    for (const computer of await Computer.list(to).catch(() => []))
      await Computer.kill(computer.computerID, to).catch(() => {});
    if (!exited) {
      const gone = once(child, "exit");
      child.kill("SIGTERM");
      await gone;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const computer = await Computer.create({
    ...to,
    access: "terminal",
    browser: true,
    workspace: join(root, "workspace"),
  });
  const agent = new Client({ name: "agent", version: "1" });
  await agent.connect(
    new StreamableHTTPClientTransport(new URL(computer.getMcpUrl("browser")), {
      requestInit: { headers: { Authorization: `Bearer ${computer.getMcpToken()}` } },
    }),
  );
  clients.push(agent);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await agent.callTool({ name, arguments: args })) as {
      content: { text?: string }[];
      isError?: boolean;
    };
    return { text: result.content.map((b) => b.text ?? "").join(""), isError: !!result.isError };
  };
  const state = async () =>
    JSON.parse(
      JSON.parse(
        /### Result\n([\s\S]*?)(\n###|$)/.exec(
          (await call("browser_evaluate", { function: "() => JSON.stringify(window.s)" })).text,
        )?.[1] ?? '"{}"',
      ),
    ) as Record<string, unknown>;
  const centre = async (selector: string) => {
    const text = (
      await call("browser_evaluate", {
        function: `() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; }`,
      })
    ).text;
    return JSON.parse(/### Result\n([\s\S]*?)(\n###|$)/.exec(text)?.[1] ?? "[0,0]") as [
      number,
      number,
    ];
  };

  /** A viewer on the browser surface, as a page's script would hold one. */
  const view = async (mode: "watch" | "operate") => {
    const ticket = await computer.liveSession("browser", mode);
    assert.equal(ticket.protocol, "screencast@1");
    const ws = new WebSocket(ticket.url);
    sockets.push(ws);
    const frames: Buffer[] = [];
    const events: Event[] = [];
    ws.on("message", (data: Buffer, binary: boolean) => {
      if (binary) frames.push(data);
      else events.push(JSON.parse(data.toString()) as Event);
    });
    await once(ws, "open");
    const send = (message: Record<string, unknown>) => ws.send(JSON.stringify(message));
    const click = async ([x, y]: [number, number]) => {
      send({ type: "mouse", action: "down", x, y });
      send({ type: "mouse", action: "up", x, y });
    };
    const last = (type: string) => events.filter((event) => event.type === type).at(-1);
    return { ws, frames, events, send, click, last };
  };

  return { Computer, to, computer, call, state, centre, view, alive: () => !exited };
}

for (const [isolation, extra] of ISOLATIONS) {
  const options = {
    timeout: 180_000,
    skip:
      !extra &&
      (isolation === "none"
        ? "needs AGENTCOMPUTER_BROWSER_PATH"
        : "needs AGENTCOMPUTER_TEST_IMAGE"),
  };

  test(
    `isolation ${isolation}: a person watches and operates the page the agent works on`,
    options,
    async (t) => {
      const { computer, call, state, centre, view, alive } = await setup(t, extra as string[]);
      assert.ok((await computer.getInfo()).surfaces.some((one) => one.surface === "browser"));
      await call("browser_navigate", { url: "about:blank" });
      await call("browser_evaluate", {
        function: `() => { document.open(); document.write(${JSON.stringify(PAGE)}); document.close(); }`,
      });

      const watcher = await view("watch");
      const person = await view("operate");

      // Opening to operate takes the browser at once: the agent's call waits until it's let go.
      await until(() => person.last("driver")?.you === true, "holding it on open");
      const held = Date.now();
      const blocked = call("browser_snapshot");
      await until(() => person.last("driver")?.agentWaiting === true, "the agent waiting on open");
      person.send({ type: "release" });
      const firstAnswer = await blocked;
      assert.equal(firstAnswer.isError, true);
      assert.match(firstAnswer.text, /A person used the browser/);
      assert.ok(Date.now() - held < 20_000);
      await until(() => person.frames.length > 0 && watcher.frames.length > 0, "frames");
      const frame = person.frames.at(-1) as Buffer;
      assert.deepEqual([...frame.subarray(0, 2)], [0xff, 0xd8], "a JPEG");
      await until(() => Boolean(person.last("tabs")), "the tabs");
      assert.equal(person.last("tabs")?.tabs.length, 1);

      // The agent works while frames arrive.
      const before = person.frames.length;
      assert.equal((await call("browser_snapshot")).isError, false);
      await until(() => person.frames.length > before, "frames while the agent works");

      // A watcher's input is dropped; the person's lands on the agent's page.
      const count = await centre("#count");
      await watcher.click(count);
      await person.click(count);
      person.send({ type: "release" });
      await until(() => Boolean(person.last("driver")), "the driver");
      await new Promise((done) => setTimeout(done, 300));
      assert.equal((await state()).count, 1);

      // While the person drives, the agent's call waits, then says what happened.
      person.send({ type: "mouse", action: "move", x: 5, y: 5 });
      await until(() => (person.last("driver") as { you?: boolean })?.you === true, "holding it");
      const started = Date.now();
      const waiting = call("browser_snapshot");
      await until(
        () => (person.last("driver") as { agentWaiting?: boolean })?.agentWaiting === true,
        "the agent waiting",
      );
      await new Promise((done) => setTimeout(done, 500));
      person.send({ type: "release" });
      const answered = await waiting;
      assert.equal(answered.isError, true);
      assert.match(answered.text, /A person used the browser/);
      assert.ok(Date.now() - started >= 500);
      assert.equal((await call("browser_snapshot")).isError, false);

      // A dialog the agent opened, answered by the person.
      const ref = /button "dialog" \[ref=(e\d+)\]/.exec((await call("browser_snapshot")).text)?.[1];
      const opened = await call("browser_click", { target: ref, element: "dialog" });
      assert.match(opened.text, /Modal state/);
      await until(() => (person.last("dialog") as { open?: boolean })?.open === true, "the dialog");
      assert.equal((person.last("dialog") as { message?: string }).message, "sure?");
      person.send({ type: "dialog", accept: true });
      person.send({ type: "release" });
      await new Promise((done) => setTimeout(done, 300));
      assert.equal((await state()).confirmed, true);

      // A file chooser the person opened and answered, leaving the agent free to go on.
      await person.click(await centre("#file"));
      await until(
        () => (person.last("file-chooser") as { open?: boolean })?.open === true,
        "the chooser",
      );
      person.send({
        type: "files",
        files: [
          { name: "notes.txt", mimeType: "text/plain", data: Buffer.from("hi").toString("base64") },
        ],
      });
      person.send({ type: "release" });
      await new Promise((done) => setTimeout(done, 300));
      const after = await call("browser_snapshot");
      assert.equal(after.isError, false, after.text.slice(0, 300));
      assert.equal((await state()).file, "notes.txt");

      // A list, which isn't in the frames, offered as a choice.
      const [sx, sy] = await centre("#sel");
      person.send({ type: "mouse", action: "down", x: sx, y: sy });
      person.send({ type: "mouse", action: "up", x: sx, y: sy });
      await until(() => Boolean(person.last("choice")), "the choice");
      assert.deepEqual(
        person.last("choice")?.options.map((o: { value: string }) => o.value),
        ["a", "b"],
      );
      person.send({ type: "choice", values: ["b"] });
      person.send({ type: "release" });
      await new Promise((done) => setTimeout(done, 300));
      assert.equal((await state()).choice, "b");

      // A title the page changes itself reaches the tab strip.
      await call("browser_evaluate", { function: "() => { document.title = 'Renamed in place' }" });
      await until(
        () =>
          person
            .last("tabs")
            ?.tabs.some((tab: { title: string }) => tab.title === "Renamed in place"),
        "the new title",
      );

      // A tab the person opens is one the agent sees.
      person.send({ type: "tab", action: "open", url: "about:blank" });
      person.send({ type: "release" });
      await until(
        () => ((person.last("tabs") as { tabs?: unknown[] })?.tabs?.length ?? 0) === 2,
        "two tabs",
      );
      const tabs = (await call("browser_tabs", { action: "list" })).text;
      assert.equal(tabs.split("\n").filter((line) => /^- \d/.test(line)).length, 2);

      // Its socket is where only its user can reach it.
      const shared = (await computer.getLogs())
        .map((entry) => /The browser is shared on (\S+)\.$/.exec(entry.line)?.[1])
        .find(Boolean) as string;
      assert.ok(shared, "the log names the socket");
      const own = dirname(dirname(dirname(shared)));
      if (isolation === "none") assert.equal(statSync(own).mode & 0o777, 0o700);
      else {
        const name = `agentcomputer-${computer.computerID}`;
        const mode = (
          await docker("docker", ["exec", name, "stat", "-c", "%a", own])
        ).stdout.trim();
        assert.equal(mode, "700");
        const other = await docker("docker", [
          "exec",
          "--user",
          "4321:4321",
          name,
          "node",
          "-e",
          `require("net").connect(${JSON.stringify(shared)}).on("error", (e) => { console.log(e.code); process.exit(0) }).on("connect", () => { console.log("connected"); process.exit(0) })`,
        ]);
        assert.equal(other.stdout.trim(), "EACCES");
      }

      // Closing an operate socket lets go as well.
      const another = await view("operate");
      await until(() => another.last("driver")?.you === true, "the second one holding it");
      const waits = call("browser_snapshot");
      await until(() => another.last("driver")?.agentWaiting === true, "the agent waiting again");
      another.ws.close();
      assert.match((await waits).text, /A person used the browser/);
      assert.equal((await call("browser_snapshot")).isError, false);

      // Killing it closes the viewers and nothing else.
      await computer.kill();
      await until(() => person.ws.readyState === WebSocket.CLOSED, "the socket closing");
      assert.equal(alive(), true);
    },
  );
}
