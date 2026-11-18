// A computer with the screen, started again while its screen can't be used, keeps its terminal and
// files: its screen's tools stay listed and say why, and work once the screen can be used, with no
// restart. As with the person's switch off, and with the screen not ready: a grant missing on
// macOS, the driver gone elsewhere. The driver stopping leaves it running too. Cua Driver is a
// stand-in: a script that answers its version and its grants, from a file, and for `mcp` runs the
// driver's MCP stand-in, noting each process that does.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

type Sdk = typeof import("@agentorg/computer-sdk");
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(root, "dist", "agentcomputer.js");
const mac = process.platform === "darwin";

/** A stand-in Cua Driver in `folder`, granted both until told otherwise. */
function standIn(folder: string) {
  const program = join(folder, "cua-driver");
  const grants = join(folder, "grants.json");
  const pids = join(folder, "mcp.pids");
  const mcp = join(root, "test", "fixtures", "driver-stand-in.mjs");
  const granted = (screen_recording: boolean) =>
    writeFileSync(grants, JSON.stringify({ accessibility: true, screen_recording }));
  granted(true);
  writeFileSync(pids, "");
  writeFileSync(
    program,
    `#!/bin/sh
case "$1" in
  --version) echo "cua-driver 0.49.7" ;;
  permissions) cat "${grants}" ;;
  mcp) echo $$ >> "${pids}"; exec "${process.execPath}" "${mcp}" "$@" ;;
esac
`,
  );
  chmodSync(program, 0o755);
  const connected = () => readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number);
  return { program, granted, connected };
}

/** The service on `data`, as a person runs it: every switch on until set. */
async function serve(t: test.TestContext, data: string, home: string, driver: string) {
  const child: ChildProcess = spawn(
    process.execPath,
    [CLI, "serve", "--listen", "127.0.0.1:0", "--data", data, "--screen-driver", driver],
    {
      env: { PATH: process.env.PATH ?? "", HOME: home, SHELL: "/bin/bash" },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const gone = once(child, "exit");
    child.kill("SIGTERM");
    await gone;
  };
  t.after(stop);
  const apiUrl = await new Promise<string>((done) =>
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      const found = /^AgentComputer on (\S+),/.exec(line);
      if (found) done(found[1] as string);
    }),
  );
  const to = { apiUrl, apiKey: readFileSync(join(data, "control-token"), "utf8").trim() };
  const setScreen = async (on: boolean) => {
    const set = await fetch(`${apiUrl}/v1/setup/screen`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${to.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ on }),
    });
    assert.equal(set.status, 200);
  };
  return { to, stop, setScreen };
}

/** An MCP endpoint of a computer, and a call to it that says its text, or its refusal. */
async function endpoint(t: test.TestContext, url: string, token: string) {
  const client = new Client({ name: "screen-again", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  t.after(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const answer = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text?: string }[];
    };
    return {
      refused: answer.isError === true,
      text: answer.content.map((one) => one.text).join("\n"),
    };
  };
  return { call, tools: async () => (await client.listTools()).tools.map((one) => one.name) };
}

async function setup(t: test.TestContext) {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "ac-screen-again-")));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const data = join(folder, "data");
  const home = join(folder, "home");
  const workspace = join(folder, "workspace");
  for (const one of [home, workspace]) mkdirSync(one);
  const driver = standIn(folder);
  const { Computer } = (await import(pathToFileURL(join(root, "dist", "sdk.js")).href)) as Sdk;
  let service = await serve(t, data, home, driver.program);
  const attached = await Computer.attach({
    ...service.to,
    access: "terminal",
    workspace,
    screen: true,
    name: "Screen again",
  });
  const token = attached.getMcpToken();
  const id = attached.computerID;
  /** The service started again, and the computer as it then is, with its two endpoints. */
  const again = async () => {
    await service.stop();
    service = await serve(t, data, home, driver.program);
    // Brought back as the service starts: starting until then.
    let info = await Computer.getInfo(id, service.to);
    for (const end = Date.now() + 20_000; info.state === "starting" && Date.now() < end; ) {
      await new Promise((done) => setTimeout(done, 100));
      info = await Computer.getInfo(id, service.to);
    }
    const computer = await endpoint(t, info.endpoints.computer as string, token);
    const screen = await endpoint(t, info.endpoints.screen as string, token);
    return { info, computer, screen };
  };
  const info = () => Computer.getInfo(id, service.to);
  const unavailable = async () =>
    (await info()).surfaces.find((one) => one.surface === "screen")?.unavailable;
  /** Until `check` holds, or 10 s have gone. */
  const until = async (check: () => Promise<boolean>) => {
    for (const end = Date.now() + 10_000; !(await check()) && Date.now() < end; )
      await new Promise((done) => setTimeout(done, 100));
  };
  return { driver, again, info, unavailable, service: () => service, Computer, folder, id, until };
}

test("started again with the screen switched off, it keeps its terminal and files, and its screen works once switched on", async (t) => {
  const { again, info, unavailable, service, Computer, id } = await setup(t);
  await service().setScreen(false);
  const { info: started, computer, screen } = await again();
  const off = `The person turned off the screen for agents on ${mac ? "this Mac" : "this machine"}.`;
  assert.deepEqual([started.state, started.reason], ["running", null]);
  // The switch is for agents: the person's own live view of the screen stays open.
  assert.equal(await unavailable(), undefined);
  // Its terminal and files answer; its screen's tools are listed, and say why.
  assert.match(
    (await computer.call("exec_command", { cmd: "echo terminal here" })).text,
    /terminal here/,
  );
  assert.equal((await computer.call("list", { path: "." })).refused, false);
  assert.deepEqual((await screen.tools()).sort(), ["act", "apps", "see"]);
  assert.deepEqual(await screen.call("apps"), { refused: true, text: off });
  // Switched on, the next call works, with no restart.
  await service().setScreen(true);
  const apps = await screen.call("apps");
  assert.equal(apps.refused, false, apps.text);
  assert.match(apps.text, /TextEdit/);
  assert.equal((await info()).state, "running");
  // Stopped, and started with the screen off, it runs too.
  await Computer.stop(id, service().to);
  await service().setScreen(false);
  const restarted = await Computer.start(id, service().to);
  assert.equal(restarted.state, "running");
});

test("started again with its screen not ready, it keeps its terminal, and its screen works once ready; a new attach starts only where grants alone are missing", async (t) => {
  const { driver, again, info, unavailable, service, Computer, folder, until } = await setup(t);
  // On macOS a grant is missing; elsewhere, where there are none, the driver is gone.
  const away = join(folder, "away");
  const notReady = () => (mac ? driver.granted(false) : renameSync(driver.program, away));
  const ready = () => (mac ? driver.granted(true) : renameSync(away, driver.program));
  const why = mac
    ? /Cua Driver is missing Screen Recording/
    : /Cua Driver isn't installed on this machine/;
  notReady();
  const { info: started, computer, screen } = await again();
  assert.deepEqual([started.state, started.reason], ["running", null]);
  assert.match((await unavailable()) ?? "", why);
  assert.match(
    (await computer.call("exec_command", { cmd: "echo still here" })).text,
    /still here/,
  );
  const refused = await screen.call("see");
  assert.equal(refused.refused, true);
  assert.match(refused.text, why);
  // Attaching another with the screen: on a Mac, where only a grant is missing, it starts as one
  // started again does, its screen's tools saying why; with the driver gone, it is refused.
  const elsewhere = join(folder, "elsewhere");
  mkdirSync(elsewhere);
  const attaching = Computer.attach({
    ...service().to,
    access: "read",
    workspace: elsewhere,
    screen: true,
  });
  if (mac) {
    const other = await attaching;
    const made = await other.getInfo();
    assert.deepEqual(
      [made.state, made.screen, made.tools.screen.sort()],
      ["running", true, ["act", "apps", "see"]],
    );
    await other.kill();
  } else
    await assert.rejects(
      attaching,
      (error: Error & { code: number }) => error.code === 409 && why.test(error.message),
    );
  // Ready, the surface says so without an agent's call, and the next call works, with no restart.
  ready();
  await until(async () => (await unavailable()) === undefined);
  assert.equal(await unavailable(), undefined);
  const apps = await screen.call("apps");
  assert.equal(apps.refused, false, apps.text);
  assert.equal((await info()).state, "running");
});

test("the driver stopping leaves the computer running, its screen connects again at its next call, and a point is aimed only after the screen is seen again", async (t) => {
  const { driver, again, info, Computer, id, service, until } = await setup(t);
  const { screen } = await again();
  assert.equal((await screen.call("apps")).refused, false);
  const [first] = driver.connected().slice(-1);
  process.kill(first as number, "SIGTERM");
  // Its connection gone, the computer runs on.
  const said = async () =>
    JSON.stringify(await Computer.getLogs(id, service().to)).includes("Cua Driver stopped.");
  await until(said);
  assert.equal(await said(), true);
  assert.equal((await info()).state, "running");
  // The next call connects again; a point isn't aimed at until the screen is seen again.
  const window = { pid: 19249, window_id: 12895 };
  const aimed = await screen.call("act", { action: "click", ...window, x: 100, y: 200 });
  assert.deepEqual(aimed, {
    refused: true,
    text: "Cua Driver was started again since the screen was last seen, as when a grant changes: see it again, then aim at its point.",
  });
  assert.notEqual(driver.connected().slice(-1)[0], first);
  assert.equal((await screen.call("see", window)).refused, false);
  const clicked = await screen.call("act", { action: "click", ...window, x: 100, y: 200 });
  assert.match(clicked.text, /Posted click/);
});
