// Who is acting on a computer now, shown both ways: to the person on a presence@1 socket, and to
// the agent in about and in a line on the answer to its next call on what the person acted on.
// The same on this computer and in a container.
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
import WebSocket from "ws";
import { CONTAINER, type Kind, make, named, needs } from "./kinds.ts";

type Sdk = typeof import("../src/sdk.ts");
type Acting = import("../src/generated/schema.js").components["schemas"]["Acting"];
const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist");
const KINDS: [Kind, string[]][] = [
  ["this", []],
  ...(CONTAINER ? [["container", CONTAINER] as [Kind, string[]]] : []),
];
const BROWSER = process.env.AGENTCOMPUTER_BROWSER_PATH;
/** With a browser: this computer's the headless shell, never the Chrome installed here. */
const WITH_BROWSER: [Kind, string[] | undefined][] = [
  ["this", BROWSER ? ["--browser-name", "chromium", "--browser-path", BROWSER] : undefined],
  ["container", CONTAINER],
];

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
      join(dist, "agentcomputer.js"),
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
  const sockets: WebSocket[] = [];
  const clients: Client[] = [];
  t.after(async () => {
    for (const ws of sockets) ws.close();
    for (const client of clients) await client.close().catch(() => {});
    for (const computer of await Computer.list(to).catch(() => []))
      await Computer.kill(computer.computerID, to).catch(() => {});
    const gone = once(child, "exit");
    child.kill("SIGTERM");
    await gone;
    rmSync(root, { recursive: true, force: true });
  });
  /** A socket, and each JSON message it is sent, as it comes. */
  const open = async (target: string) => {
    const ws = new WebSocket(target);
    sockets.push(ws);
    const heard: Record<string, unknown>[] = [];
    ws.on("message", (data: Buffer, binary: boolean) => {
      if (!binary) heard.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    await once(ws, "open");
    return { ws, heard };
  };
  /** The agent's own client, which gives each answer's texts. */
  const agent = async (endpoint: string, token: string) => {
    const client = new Client({ name: "agent", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    clients.push(client);
    return async (name: string, args: Record<string, unknown> = {}) => {
      const { content } = (await client.callTool({ name, arguments: args })) as {
        content: { text?: string }[];
      };
      return content.map((one) => one.text ?? "");
    };
  };
  return { Computer, to, workspace, open, agent };
}

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `Waited too long for ${what}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

/** Who, by what name, on what: an Acting without its time. */
const shape = ({ who, name, capability, terminal }: Acting) => ({
  who,
  name,
  capability,
  terminal,
});

for (const [kind, extra] of KINDS)
  test(`on ${named(kind)}: the person sees who acts, and the agent is told what the person did`, {
    timeout: 120_000,
  }, async (t) => {
    const { Computer, to, workspace, open, agent } = await setup(t, extra);
    const computer = await make(Computer, kind, {
      ...to,
      access: "terminal",
      workspace,
      name: "Scout",
    });
    const call = await agent(computer.getMcpUrl(), computer.getMcpToken());
    await assert.rejects(computer.liveSession("presence", "operate"), /watched, not operated/);
    const presence = await open((await computer.liveSession("presence")).url);
    const latest = () => ((presence.heard.at(-1)?.acting ?? []) as Acting[]).map(shape);
    await until(() => presence.heard.length > 0, "who acts, at first");
    assert.deepEqual(presence.heard[0], { type: "presence", acting: [] });

    // The agent starts a command, and is seen acting on its terminal by its name.
    const [started = ""] = await call("exec_command", { cmd: "cat", yield_time_ms: 250 });
    const id = /session_id: (\S+)/.exec(started)?.[1] as string;
    const agentOnIt = { who: "agent", name: "Scout", capability: "terminal", terminal: id };
    await until(() => latest().length > 0, "the agent acting");
    assert.deepEqual(latest(), [agentOnIt]);

    // A person opens a shell of their own: that is the person's, not the agent's.
    const terminals = await open((await computer.liveSession("terminal", "operate")).url);
    terminals.ws.send(JSON.stringify({ type: "open", columns: 80, rows: 24 }));
    await until(() => latest().some((one) => one.who === "person"), "the person's shell");
    const shell = latest().find((one) => one.who === "person")?.terminal;
    assert.notEqual(shell, id);
    assert.deepEqual(
      latest()
        .filter((one) => one.terminal === shell)
        .map((one) => one.who),
      ["person"],
    );

    // A person types into the agent's. The agent's next call on it is told, the one after isn't.
    terminals.ws.send(JSON.stringify({ type: "input", id, text: "hi\n" }));
    await until(
      () => latest().some((one) => one.who === "person" && one.terminal === id),
      "the person typing",
    );
    const type = () => call("write_stdin", { session_id: id, chars: "a", yield_time_ms: 250 });
    assert.match((await type()).at(-1) ?? "", /^The person used this terminal \d+ s ago\.$/);
    assert.equal((await type()).length, 1);
    const [about = "{}"] = await call("about");
    const { rows } = JSON.parse(about) as { rows: { label: string; value: string }[] };
    assert.deepEqual(
      rows.find((row) => row.label === "Acting now"),
      { label: "Acting now", value: `The person: terminal ${id}, terminal ${shell}` },
    );

    // A person writes a file. The agent's next call on the files is told.
    // A write that is refused is not acting; one that is written is.
    const files = await open((await computer.liveSession("files", "operate")).url);
    const write = { type: "write", id: "w", path: "note.txt", offset: 0, length: 2, last: true };
    files.ws.send(JSON.stringify({ ...write, id: "out", path: "../outside.txt" }));
    files.ws.send(Buffer.from("hi"));
    await until(() => files.heard.some((one) => one.id === "out"), "the refusal");
    assert.equal(files.heard.find((one) => one.id === "out")?.type, "refused");
    assert.ok(!latest().some((one) => one.capability === "files"));
    files.ws.send(JSON.stringify(write));
    files.ws.send(Buffer.from("hi"));
    await until(
      () => latest().some((one) => one.who === "person" && one.capability === "files"),
      "the person on the files",
    );
    const read = await call("read", { path: "note.txt" });
    assert.match(read.at(-1) ?? "", /^The person wrote a file here \d+ s ago\.$/);
  });

for (const [kind, extra] of WITH_BROWSER)
  test(`on ${named(kind)}: the agent is told the person used the browser`, {
    timeout: 120_000,
    skip: !extra && needs(kind),
  }, async (t) => {
    const { Computer, to, workspace, open, agent } = await setup(t, extra as string[]);
    const computer = await make(Computer, kind, {
      ...to,
      access: "read",
      browser: true,
      workspace,
      name: "Scout",
    });
    const call = await agent(computer.getMcpUrl("browser"), computer.getMcpToken());
    assert.equal((await call("browser_navigate", { url: "about:blank" })).length, 1);
    const presence = await open((await computer.liveSession("presence")).url);
    const person = () =>
      ((presence.heard.at(-1)?.acting ?? []) as Acting[]).some(
        (one) => one.who === "person" && one.capability === "browser",
      );
    // Moving the pointer over it is not acting; pressing a key is.
    const screen = await open((await computer.liveSession("browser", "operate")).url);
    await until(() => screen.heard.length > 0, "the page shown");
    screen.ws.send(JSON.stringify({ type: "mouse", action: "move", x: 1, y: 1 }));
    screen.ws.send(JSON.stringify({ type: "key", action: "down", key: "Shift" }));
    screen.ws.send(JSON.stringify({ type: "key", action: "up", key: "Shift" }));
    await until(person, "the person in the browser");
    const told = await call("browser_snapshot");
    assert.match(told.at(-1) ?? "", /^The person used the browser \d+ s ago\.$/);
  });

test("two computers attached to this computer each see the other on its files", {
  timeout: 60_000,
}, async (t) => {
  const { Computer, to, workspace, open, agent } = await setup(t, []);
  const attach = (name: string) => Computer.attach({ ...to, access: "files", workspace, name });
  const [scout, helper] = [await attach("Scout"), await attach("Helper")];
  const presence = await open((await helper.liveSession("presence")).url);
  const scoutCalls = await agent(scout.getMcpUrl(), scout.getMcpToken());
  const helperCalls = await agent(helper.getMcpUrl(), helper.getMcpToken());
  await scoutCalls("list");
  await until(
    () =>
      ((presence.heard.at(-1)?.acting ?? []) as Acting[]).some(
        (one) => one.who === "agent" && one.name === "Scout" && one.capability === "files",
      ),
    "Scout on the files",
  );
  const listed = await helperCalls("list");
  assert.match(listed.at(-1) ?? "", /^Scout used the files here \d+ s ago\.$/);
  const [about = "{}"] = await helperCalls("about");
  const { rows } = JSON.parse(about) as { rows: { label: string; value: string }[] };
  assert.equal(rows.find((row) => row.label === "Acting now")?.value, "Scout: the files");
});

test("acting now lasts 10 s, and each start and stop is heard", async (t) => {
  // The clock is the test's: it moves only by tick, from 0.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { Presence } = await import("../src/presence.ts");
  const presence = new Presence("c_scout", "Scout");
  let changes = 0;
  presence.onChange(() => changes++);
  presence.acted("person", { capability: "files" });
  presence.acted("person", { capability: "files" });
  assert.equal(changes, 1, "acting again on the same thing is no change");
  assert.equal(presence.othersForAbout(), "The person: the files");
  t.mock.timers.tick(4_000);
  // Told only of the same thing: not of the files, on a call on the browser.
  assert.equal(presence.agentCalled({ capability: "browser" }), undefined);
  // A moment later, so that the files are the more recent.
  t.mock.timers.tick(1);
  const told = presence.agentCalled({ capability: "files" });
  assert.equal(told, "The person wrote a file here 4 s ago.");
  assert.equal(presence.agentCalled({ capability: "files" }), undefined, "told once");
  // At 10 s the person stops acting; the agent, which acted at 4 s, still is.
  t.mock.timers.tick(6_000);
  assert.equal(presence.othersForAbout(), "Nobody else");
  assert.deepEqual(presence.acting().map(shape), [
    { who: "agent", name: "Scout", capability: "files", terminal: undefined },
    { who: "agent", name: "Scout", capability: "browser", terminal: undefined },
  ]);
  assert.equal(changes, 4, "the person stopping, and the agent starting on two things");
  // At 14 s nobody is.
  t.mock.timers.tick(4_000);
  assert.deepEqual(presence.acting(), []);
  assert.equal(changes, 6);
  // Each terminal is its own: typing in one tells nothing of another, and waiting isn't acting.
  presence.acted("person", { capability: "terminal", terminal: "s_a" });
  const waiting = (terminal: string) =>
    presence.agentCalled({ capability: "terminal", terminal }, false);
  assert.equal(waiting("s_b"), undefined);
  assert.match(waiting("s_a") ?? "", /^The person used this terminal/);
  assert.deepEqual(presence.acting().map(shape), [
    { who: "person", name: undefined, capability: "terminal", terminal: "s_a" },
  ]);
  presence.close();
});

/** Two computers attached to one machine, on a clock that moves only by tick, from 0. */
async function twoOnOneMachine(t: test.TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { Board, Presence } = await import("../src/presence.ts");
  const machine = new Board();
  const scout = new Presence("c_1", "Scout", machine);
  const helper = new Presence("c_2", "Helper", machine);
  t.after(() => {
    for (const one of [scout, helper, machine]) one.close();
  });
  return { Presence, machine, scout, helper };
}

test("one attached computer's agent on the files is shown to another, and heard", async (t) => {
  const { scout, helper } = await twoOnOneMachine(t);
  let heard = 0;
  const stop = helper.onChange(() => heard++);
  scout.agentCalled({ capability: "files" });
  assert.equal(heard, 1);
  assert.deepEqual(helper.acting().map(shape), [
    { who: "agent", name: "Scout", capability: "files", terminal: undefined },
  ]);
  assert.equal(helper.othersForAbout(), "Scout: the files");
  assert.equal(scout.othersForAbout(), "Nobody else", "not itself");
  // Once it stops listening, it hears nothing more.
  stop();
  scout.acted("person", { capability: "files" });
  assert.equal(heard, 1);
});

test("each is told of everyone else on the files since its last call, the most recent first", async (t) => {
  const { scout, helper } = await twoOnOneMachine(t);
  scout.agentCalled({ capability: "files" });
  // 2 s later Helper calls: told of Scout.
  t.mock.timers.tick(2_000);
  assert.equal(helper.agentCalled({ capability: "files" }), "Scout used the files here 2 s ago.");
  // 1 ms after that, the person writes through Scout; 1 s later each calls.
  t.mock.timers.tick(1);
  scout.acted("person", { capability: "files" });
  t.mock.timers.tick(1_000);
  assert.equal(
    scout.agentCalled({ capability: "files" }),
    "The person wrote a file here 1 s ago. Helper used the files here 1 s ago.",
  );
  assert.equal(
    helper.agentCalled({ capability: "files" }),
    "Scout used the files here 1 s ago. The person wrote a file here 1 s ago.",
  );
  assert.equal(helper.othersForAbout(), "Scout: the files; The person: the files");
});

test("terminals and the browser stay each computer's own, and both boards are shown as one", async (t) => {
  const { scout, helper } = await twoOnOneMachine(t);
  scout.agentCalled({ capability: "files" });
  t.mock.timers.tick(1);
  scout.acted("person", { capability: "terminal", terminal: "s_1" });
  t.mock.timers.tick(1);
  scout.agentCalled({ capability: "browser" });
  assert.deepEqual(helper.acting().map(shape), [
    { who: "agent", name: "Scout", capability: "files", terminal: undefined },
  ]);
  // Its own and the machine's, the most recent first across both.
  assert.deepEqual(
    scout.acting().map((one) => [one.who, one.capability]),
    [
      ["agent", "browser"],
      ["person", "terminal"],
      ["agent", "files"],
    ],
  );
});

test("one that stops leaves its acting on the files to end in its own time", async (t) => {
  const { Presence, machine, scout, helper } = await twoOnOneMachine(t);
  let heard = 0;
  helper.onChange(() => heard++);
  scout.agentCalled({ capability: "files" });
  scout.close();
  assert.equal(helper.othersForAbout(), "Scout: the files");
  // 10 s later it ends, and that is heard.
  t.mock.timers.tick(10_000);
  assert.equal(helper.othersForAbout(), "Nobody else");
  assert.equal(heard, 2);
  // Two of one name are two agents all the same.
  const twin = new Presence("c_3", "Helper", machine);
  twin.agentCalled({ capability: "files" });
  assert.equal(helper.othersForAbout(), "Helper: the files");
  twin.close();
});
