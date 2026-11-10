// The browser live: frames while the agent works, a person's input beside it with neither waiting
// for the other, a shown tab that is each socket's own, and dialogs, file choosers and lists the
// person answers.
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
  /** One MCP session on the browser, as one agent holds. */
  const session = async () => {
    const agent = new Client({ name: "agent", version: "1" });
    await agent.connect(
      new StreamableHTTPClientTransport(new URL(computer.getMcpUrl("browser")), {
        requestInit: { headers: { Authorization: `Bearer ${computer.getMcpToken()}` } },
      }),
    );
    clients.push(agent);
    return async (name: string, args: Record<string, unknown> = {}) => {
      const result = (await agent.callTool({ name, arguments: args })) as {
        content: { text?: string }[];
        isError?: boolean;
      };
      return { text: result.content.map((b) => b.text ?? "").join(""), isError: !!result.isError };
    };
  };
  const call = await session();
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

  /** Wait for what only asking the page can tell. */
  const becomes = async (key: string, value: unknown) => {
    const deadline = Date.now() + 20_000;
    while ((await state())[key] !== value) {
      assert.ok(Date.now() < deadline, `Waited too long for ${key} to be ${String(value)}.`);
      await new Promise((done) => setTimeout(done, 50));
    }
  };

  return {
    Computer,
    to,
    computer,
    call,
    session,
    state,
    becomes,
    centre,
    view,
    alive: () => !exited,
  };
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
    `isolation ${isolation}: a person and the agent use the browser at once, each socket shown its own tab`,
    options,
    async (t) => {
      const { computer, call, session, becomes, centre, view, alive } = await setup(
        t,
        extra as string[],
      );
      assert.ok((await computer.getInfo()).surfaces.some((one) => one.surface === "browser"));
      await call("browser_navigate", { url: "about:blank" });
      await call("browser_evaluate", {
        function: `() => { document.open(); document.write(${JSON.stringify(PAGE)}); document.close(); }`,
      });
      type Viewer = Awaited<ReturnType<typeof view>>;
      const shown = (viewer: Viewer) => viewer.last("tabs")?.shown as number | undefined;
      const ids = (viewer: Viewer) =>
        (viewer.last("tabs")?.tabs ?? []).map((tab: { id: number }) => tab.id) as number[];
      const asked = (viewer: Viewer, type: string) =>
        (viewer.last(type) as { open?: boolean } | undefined)?.open;
      // Where things are on the page, asked while the agent is on it.
      const count = await centre("#count");
      const dialogButton = await centre("#dlg");
      const fileButton = await centre("#file");
      const [sx, sy] = await centre("#sel");

      const watcher = await view("watch");
      const person = await view("operate");
      await until(() => person.frames.length > 0 && watcher.frames.length > 0, "frames");
      const frame = person.frames.at(-1) as Buffer;
      assert.deepEqual([...frame.subarray(0, 2)], [0xff, 0xd8], "a JPEG");
      await until(() => Boolean(person.last("tabs")), "the tabs");
      assert.equal(person.last("tabs")?.tabs.length, 1);

      // Nobody waits: the agent's calls run while a person has the page open and is using it.
      const before = person.frames.length;
      person.send({ type: "mouse", action: "move", x: 5, y: 5 });
      person.send({ type: "key", action: "down", key: "Shift" });
      const working = await call("browser_snapshot");
      person.send({ type: "key", action: "up", key: "Shift" });
      assert.equal(working.isError, false, working.text.slice(0, 300));
      assert.match(working.text, /button "count"/);
      await until(() => person.frames.length > before, "frames while the agent works");

      // A watcher's input is dropped; the person's lands on the page.
      await watcher.click(count);
      await person.click(count);
      await becomes("count", 1);

      // A dialog the agent opened, told to everyone on its page and answered by the person.
      const ref = /button "dialog" \[ref=(e\d+)\]/.exec((await call("browser_snapshot")).text)?.[1];
      const opened = await call("browser_click", { target: ref, element: "dialog" });
      assert.match(opened.text, /Modal state/);
      await until(() => asked(person, "dialog") === true, "the dialog");
      assert.equal((person.last("dialog") as { message?: string }).message, "sure?");
      await until(() => asked(watcher, "dialog") === true, "the watcher told of it");
      person.send({ type: "dialog", accept: true });
      await until(
        () => asked(person, "dialog") === false && asked(watcher, "dialog") === false,
        "both told it closed",
      );
      await becomes("confirmed", true);

      // A file chooser the person opened and answered, leaving every session of the agent's free
      // to go on: a second one, on the same page, as well as the first.
      const other = await session();
      assert.equal((await other("browser_snapshot")).isError, false);
      await person.click(fileButton);
      await until(() => asked(person, "file-chooser") === true, "the chooser");
      person.send({
        type: "files",
        files: [
          { name: "notes.txt", mimeType: "text/plain", data: Buffer.from("hi").toString("base64") },
        ],
      });
      await until(() => asked(person, "file-chooser") === false, "the chooser answered");
      for (const one of [call, other]) {
        const after = await one("browser_snapshot");
        assert.equal(after.isError, false, after.text.slice(0, 300));
        assert.doesNotMatch(after.text, /Modal state/);
      }
      await becomes("file", "notes.txt");

      // A list, which isn't in the frames, offered as a choice to the one who pressed it.
      person.send({ type: "mouse", action: "down", x: sx, y: sy });
      person.send({ type: "mouse", action: "up", x: sx, y: sy });
      await until(() => Boolean(person.last("choice")), "the choice");
      assert.deepEqual(
        person.last("choice")?.options.map((o: { value: string }) => o.value),
        ["a", "b"],
      );
      person.send({ type: "choice", values: ["b"] });
      await becomes("choice", "b");
      assert.equal(watcher.last("choice"), undefined);

      // A title the page changes itself reaches the tab strip.
      await call("browser_evaluate", { function: "() => { document.title = 'Renamed in place' }" });
      await until(
        () =>
          person
            .last("tabs")
            ?.tabs.some((tab: { title: string }) => tab.title === "Renamed in place"),
        "the new title",
      );

      // A tab the agent opens is shown to every socket that hasn't chosen one of its own.
      const first = shown(person) as number;
      assert.equal(shown(watcher), first);
      await call("browser_tabs", { action: "new", url: "about:blank" });
      await until(() => ids(person).length === 2 && shown(person) !== first, "following the agent");
      const second = shown(person) as number;
      await until(() => shown(watcher) === second, "the watcher following too");

      // Once a socket picks a tab, that tab is its own: the agent's next one doesn't move it.
      person.send({ type: "tab", action: "show", id: first });
      await until(() => shown(person) === first, "its own tab");
      await call("browser_tabs", { action: "new", url: "about:blank" });
      await until(
        () => ids(watcher).length === 3 && shown(watcher) !== second,
        "the watcher moving on",
      );
      const third = shown(watcher) as number;
      assert.notEqual(third, first);
      await until(() => ids(person).length === 3, "the person told of the tab");
      assert.equal(shown(person), first);

      // A socket that opens now follows too, and is sent the page as it stands though nothing on
      // it is changing.
      const late = await view("operate");
      await until(() => shown(late) === third, "a new socket shown the newest tab");
      await until(() => late.frames.length > 0, "the last frame of a page that is still");

      // The person works in its tab while the agent works in another: both land, neither moves.
      await call("browser_evaluate", { function: "() => { window.name = 'the agent tab' }" });
      await person.click(count);
      // A dialog in the person's tab is told only to those shown it, and isn't closed by the
      // agent answering, or failing to answer, one where it is.
      await person.click(dialogButton);
      await until(() => asked(person, "dialog") === true, "the dialog in its own tab");
      await call("browser_handle_dialog", { accept: true });
      const named = await call("browser_evaluate", { function: "() => window.name" });
      assert.match(named.text, /the agent tab/);
      assert.equal(asked(person, "dialog"), true);
      assert.equal(asked(watcher, "dialog"), false);
      assert.equal(asked(late, "dialog"), false);
      // A socket shown that page later is told what the page is waiting on.
      late.send({ type: "tab", action: "show", id: first });
      await until(() => shown(late) === first && asked(late, "dialog") === true, "told on show");
      person.send({ type: "dialog", accept: false });
      await until(
        () => asked(person, "dialog") === false && asked(late, "dialog") === false,
        "its dialog closed for those shown it",
      );
      assert.equal(shown(watcher), third);
      await call("browser_tabs", { action: "select", index: 0 });
      await becomes("count", 2);
      await becomes("confirmed", false);
      assert.equal(shown(person), first);
      assert.equal(shown(watcher), third);

      // A tab a socket opens is its own from then on, and the agent sees it without being moved.
      const opener = await view("operate");
      await until(() => shown(opener) === third, "the opener following at first");
      opener.send({ type: "tab", action: "open", url: "about:blank" });
      await until(() => ids(opener).length === 4 && shown(opener) !== third, "its new tab");
      const fourth = shown(opener) as number;
      await until(() => shown(watcher) === fourth, "the watcher following a person's tab too");
      const tabs = (await call("browser_tabs", { action: "list" })).text;
      assert.equal(tabs.split("\n").filter((line) => /^- \d/.test(line)).length, 4);
      assert.match(tabs, /- 0: \(current\)/);
      // What an earlier client sent to let go is ignored, and its socket carries on.
      opener.send({ type: "release" });
      await call("browser_tabs", { action: "new", url: "about:blank" });
      await until(() => ids(opener).length === 5, "the opener told of the agent's tab");
      assert.equal(shown(opener), fourth);
      assert.equal(shown(person), first);
      const fifth = shown(watcher) as number;
      assert.notEqual(fifth, fourth);

      // When a socket's page closes, it is shown the newest that is left.
      opener.send({ type: "tab", action: "close", id: fourth });
      await until(() => ids(opener).length === 4 && shown(opener) === fifth, "falling back");
      assert.equal(person.last("driver"), undefined, "no one holds the browser");

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

      // Killing it closes the viewers and nothing else.
      await computer.kill();
      await until(() => person.ws.readyState === WebSocket.CLOSED, "the socket closing");
      assert.equal(alive(), true);
    },
  );
}
