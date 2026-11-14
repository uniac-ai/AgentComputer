// The person's switches for this machine, what each part still needs, and the steps that ask for
// it. The machine is a stand-in where a step would open something on this one: it records what
// would be run. Cua Driver is a stand-in script, and a browser a folder whose DevToolsActivePort
// names a port this test listens on.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ownBrowser } from "../src/own-browser.ts";
import { type Machine, Setup } from "../src/setup.ts";
import { Switches } from "../src/switches.ts";

type Sdk = typeof import("../src/sdk.ts");
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BROWSER = process.env.AGENTCOMPUTER_BROWSER_PATH;
const where = process.platform === "darwin" ? "this Mac" : "this machine";

const folderOf = (t: test.TestContext) => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "ac-setup-")));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
};

/** A machine that records what it would run and start; `fail` makes each run fail. */
const machine = (platform: NodeJS.Platform, home: string, onRun?: () => void, fail?: string) => {
  const ran: [string, string[]][] = [];
  const stands: Machine = {
    platform,
    home,
    // Only the home's own apps: not whatever this machine has installed.
    applications: [join(home, "Applications")],
    run: async (program, args) => {
      ran.push([program, args]);
      if (fail) throw new Error(fail);
      onRun?.();
    },
    start: async (program, args, env) => {
      assert.equal(env.DO_NOT_TRACK, "1");
      assert.equal(env.CUA_DRIVER_RS_UPDATE_CHECK, "false");
      ran.push([program, args]);
    },
  };
  return { stands, ran };
};

/**
 * A stand-in Cua Driver at `path`: with Accessibility and without Screen Recording, or, with
 * `allGranted`, with both. It answers for its grants only once `answering` exists, as the driver
 * can't read them while its app isn't running; embedded, it answers only through its host's
 * socket, at /tmp/host.sock.
 */
const driverAt = (path: string, answering: string, allGranted = false, attribution = "host") => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `#!/bin/sh
case "$1 $2" in
  "permissions status") [ -f "${answering}" ] && echo '{"accessibility":true,"screen_recording":${allGranted}}' || echo '{"status":"unknown"}' ;;
  "call check_permissions") [ "$4 $5" = "--socket /tmp/host.sock" ] && echo '{"accessibility":true,"screen_recording":${allGranted},"source":{"attribution":"${attribution}"}}' ;;
  *) echo "cua-driver 0.49.7" ;;
esac
`,
  );
  chmodSync(path, 0o755);
  return path;
};

/** A port that answers, written into a browser folder's DevToolsActivePort. */
async function debuggingOn(t: test.TestContext, folder: string) {
  const listening = createServer();
  await new Promise<void>((done) => listening.listen(0, "127.0.0.1", done));
  t.after(() => listening.close());
  mkdirSync(folder, { recursive: true });
  const { port } = listening.address() as AddressInfo;
  writeFileSync(join(folder, "DevToolsActivePort"), `${port}\n/devtools/browser/one\n`);
}

const partOf = async (setup: Setup, capability: string) =>
  (await setup.capabilities()).capabilities.find((one) => one.capability === capability);
const needsOf = async (setup: Setup, capability: string) =>
  (await partOf(setup, capability))?.needs;
const readyOf = async (setup: Setup, capability: string) =>
  (await partOf(setup, capability))?.ready;

const all = (switches: Switches) =>
  (["terminal", "files", "screen", "browser"] as const).map((one) => switches.on(one));

test("every switch is off where the service only lends, on elsewhere, and only those set are kept", (t) => {
  const folder = folderOf(t);
  const lent = new Switches(folder, true);
  assert.deepEqual(all(lent), [false, false, false, false]);
  assert.equal(lent.refused("screen"), `The person turned off the screen for agents on ${where}.`);
  lent.set("screen", true);
  assert.equal(new Switches(folder, true).refused("screen"), undefined);
  // The rest keep the default of the way it is started.
  assert.deepEqual(all(new Switches(folder, true)), [false, false, true, false]);
  lent.set("files", false);
  assert.deepEqual(all(new Switches(folder, false)), [true, false, true, true]);
});

test("switches that can't be read are every one off", (t) => {
  const folder = folderOf(t);
  for (const kept of ["{", '["terminal"]', '{"terminal":"off"}', '{"printer":true}']) {
    writeFileSync(join(folder, "switches.json"), kept);
    assert.deepEqual(all(new Switches(folder, false)), [false, false, false, false], kept);
  }
});

test("the terminal and files need nothing, and the screen needs the driver and, on macOS, its two grants", async (t) => {
  const folder = folderOf(t);
  const switches = new Switches(folder, false);
  const answering = join(folder, "answering");
  writeFileSync(answering, "");
  const app = join(folder, "Example Computer Use.app");
  const driver = driverAt(join(app, "Contents", "MacOS", "cua-driver"), answering);
  const mac = new Setup(switches, { program: driver }, undefined, machine("darwin", folder).stands);
  assert.deepEqual(await needsOf(mac, "terminal"), []);
  assert.deepEqual(await needsOf(mac, "files"), []);
  assert.equal(await readyOf(mac, "files"), true);
  assert.equal(await readyOf(mac, "screen"), false);
  // Under the app's name, as System Settings lists it.
  assert.deepEqual(await needsOf(mac, "screen"), [
    { need: "screen-recording", holder: "Example Computer Use", state: "not-granted" },
    { need: "accessibility", holder: "Example Computer Use", state: "granted" },
  ]);
  // A driver inside an app that isn't its own program, as one the app carries, is under that app.
  const carried = driverAt(
    join(folder, "Example.app", "Contents", "Resources", "cua-driver"),
    answering,
  );
  assert.deepEqual(
    await needsOf(
      new Setup(switches, { program: carried }, undefined, machine("darwin", folder).stands),
      "screen",
    ),
    [
      { need: "screen-recording", holder: "Example", state: "not-granted" },
      { need: "accessibility", holder: "Example", state: "granted" },
    ],
  );
  // A driver in no app has no app to name.
  const bare = driverAt(join(folder, "bin", "cua-driver"), answering);
  assert.deepEqual(
    await needsOf(
      new Setup(switches, { program: bare }, undefined, machine("darwin", folder).stands),
      "screen",
    ),
    [
      { need: "screen-recording", state: "not-granted" },
      { need: "accessibility", state: "granted" },
    ],
  );
  // Granted, each is still listed, and the screen is ready.
  const granted = new Setup(
    switches,
    { program: driverAt(join(folder, "granted", "cua-driver"), answering, true) },
    undefined,
    machine("darwin", folder).stands,
  );
  assert.deepEqual(await needsOf(granted, "screen"), [
    { need: "screen-recording", state: "granted" },
    { need: "accessibility", state: "granted" },
  ]);
  assert.equal(await readyOf(granted, "screen"), true);
  const linux = new Setup(
    switches,
    { program: driver },
    undefined,
    machine("linux", folder).stands,
  );
  assert.deepEqual(await needsOf(linux, "screen"), []);
  assert.equal(await readyOf(linux, "screen"), true);
  const none = new Setup(
    switches,
    { program: join(folder, "none") },
    undefined,
    machine("darwin", folder).stands,
  );
  assert.deepEqual(await needsOf(none, "screen"), [{ need: "install", state: "missing" }]);
  assert.equal(await readyOf(none, "screen"), false);
});

test("the browser lists Chrome and Edge, each as it stands, and is ready with one on", async (t) => {
  const home = folderOf(t);
  const switches = new Switches(home, false);
  mkdirSync(join(home, "Applications", "Google Chrome.app"), { recursive: true });
  mkdirSync(join(home, "Applications", "Microsoft Edge.app"), { recursive: true });
  const setup = new Setup(switches, undefined, undefined, machine("darwin", home).stands);
  assert.deepEqual(await needsOf(setup, "browser"), [
    { need: "chrome", name: "Chrome", state: "off" },
    { need: "edge", name: "Edge", state: "off" },
  ]);
  assert.equal(await readyOf(setup, "browser"), false);
  await debuggingOn(t, join(home, "Library", "Application Support", "Microsoft Edge"));
  assert.deepEqual(await needsOf(setup, "browser"), [
    { need: "chrome", name: "Chrome", state: "off" },
    { need: "edge", name: "Edge", state: "on" },
  ]);
  assert.equal(await readyOf(setup, "browser"), true);
  const none = new Setup(switches, undefined, undefined, machine("darwin", folderOf(t)).stands);
  assert.deepEqual(await needsOf(none, "browser"), [
    { need: "chrome", name: "Chrome", state: "missing" },
    { need: "edge", name: "Edge", state: "missing" },
  ]);
  const named = new Setup(switches, undefined, join(home, "named"), machine("darwin", home).stands);
  assert.deepEqual(await needsOf(named, "browser"), [
    { need: "named", name: "the browser", state: "off" },
  ]);
});

test("the browser used is the one whose switch is on, Chrome where both are", async (t) => {
  const home = folderOf(t);
  mkdirSync(join(home, "Applications", "Google Chrome.app"), { recursive: true });
  mkdirSync(join(home, "Applications", "Microsoft Edge.app"), { recursive: true });
  const darwin = { platform: "darwin" as const, home, applications: [join(home, "Applications")] };
  await debuggingOn(t, join(home, "Library", "Application Support", "Microsoft Edge"));
  const edge = await ownBrowser(undefined, darwin);
  assert.equal(edge.ready && edge.name, "Edge");
  await debuggingOn(t, join(home, "Library", "Application Support", "Google", "Chrome"));
  const both = await ownBrowser(undefined, darwin);
  assert.equal(both.ready && both.name, "Chrome");
});

test("turning the screen on starts the driver's app through the system, then its own grant", async (t) => {
  const folder = folderOf(t);
  const answering = join(folder, "answering");
  const app = join(folder, "Example Computer Use.app");
  const driver = driverAt(join(app, "Contents", "MacOS", "cua-driver"), answering);
  // Its app, once open, answers for the grants.
  const mac = machine("darwin", folder, () => writeFileSync(answering, ""));
  const switches = new Switches(folder, true);
  await new Setup(switches, { program: driver }, undefined, mac.stands).set("screen", true);
  assert.equal(switches.on("screen"), true);
  assert.deepEqual(mac.ran, [
    [
      "/usr/bin/open",
      [
        "-g",
        "-a",
        app,
        "--env",
        "DO_NOT_TRACK=1",
        "--env",
        "CUA_DRIVER_RS_UPDATE_CHECK=false",
        "--args",
        "serve",
      ],
    ],
    [driver, ["permissions", "grant"]],
  ]);
  // On again, while its app answers: only the grant.
  mac.ran.length = 0;
  await new Setup(switches, { program: driver }, undefined, mac.stands).set("screen", true);
  assert.deepEqual(mac.ran, [[driver, ["permissions", "grant"]]]);
});

test("turning the browser on opens Chrome at its switch, and turning off asks nothing", async (t) => {
  const home = folderOf(t);
  const chrome = join(home, "Applications", "Google Chrome.app");
  mkdirSync(chrome, { recursive: true });
  const mac = machine("darwin", home);
  const switches = new Switches(home, true);
  const setup = new Setup(switches, undefined, undefined, mac.stands);
  await setup.set("browser", true);
  assert.deepEqual(mac.ran, [
    ["/usr/bin/open", ["-a", chrome, "chrome://inspect/#remote-debugging"]],
  ]);
  mac.ran.length = 0;
  await setup.set("browser", false);
  assert.deepEqual(mac.ran, []);
  assert.equal(switches.on("browser"), false);
});

test("each grant is asked for by itself, and its own pane opens", async (t) => {
  const folder = folderOf(t);
  const answering = join(folder, "answering");
  writeFileSync(answering, "");
  const driver = driverAt(join(folder, "bin", "cua-driver"), answering);
  const pane = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
  const mac = machine("darwin", folder);
  const setup = new Setup(new Switches(folder, true), { program: driver }, undefined, mac.stands);
  await setup.ask("screen", "screen-recording");
  assert.deepEqual(mac.ran, [
    [driver, ["permissions", "grant"]],
    ["/usr/bin/open", [pane]],
  ]);
  // Granted, only its pane opens.
  const granted = driverAt(join(folder, "granted", "cua-driver"), answering, true);
  const done = machine("darwin", folder);
  await new Setup(new Switches(folder, true), { program: granted }, undefined, done.stands).ask(
    "screen",
    "accessibility",
  );
  assert.deepEqual(done.ran, [
    [
      "/usr/bin/open",
      ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"],
    ],
  ]);
  await assert.rejects(setup.ask("files", "accessibility"), {
    status: 409,
    message: 'There\'s no "accessibility" for files here.',
  });
  const none = new Setup(
    new Switches(folder, true),
    { program: join(folder, "none") },
    undefined,
    mac.stands,
  );
  await assert.rejects(none.ask("screen", "install"), {
    status: 409,
    message: "Cua Driver isn't installed on this machine.",
  });
});

test("a driver an app runs embedded is read, and asked for, through that app", async (t) => {
  const folder = folderOf(t);
  const app = join(folder, "Example.app");
  const driver = driverAt(join(app, "Contents", "Resources", "cua-driver"), join(folder, "never"));
  const mac = machine("darwin", folder);
  const setup = new Setup(
    new Switches(folder, true),
    { program: driver, socket: "/tmp/host.sock" },
    undefined,
    mac.stands,
  );
  // Read through the host's socket, under the host's name, though the driver's own app never runs.
  assert.deepEqual(await needsOf(setup, "screen"), [
    { need: "screen-recording", holder: "Example", state: "not-granted" },
    { need: "accessibility", holder: "Example", state: "granted" },
  ]);
  // The host asks, opened through the system: for one grant, or for each that is missing.
  const opened = (...asked: string[]) => [
    "/usr/bin/open",
    ["-n", "-g", "-a", app, "--args", "grant", ...asked],
  ];
  await setup.ask("screen", "screen-recording");
  await setup.ask("screen");
  await setup.ask("screen", "accessibility");
  assert.deepEqual(mac.ran, [
    opened("screen-recording"),
    [
      "/usr/bin/open",
      ["x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"],
    ],
    opened("screen-recording"),
    // Already given, only its pane opens.
    [
      "/usr/bin/open",
      ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"],
    ],
  ]);
  // A driver on that socket that isn't the host's own, embedded, says nothing of its grants.
  const other = driverAt(
    join(folder, "Other.app", "Contents", "MacOS", "cua-driver"),
    "",
    false,
    "caller",
  );
  const notHosted = new Setup(
    new Switches(folder, true),
    { program: other, socket: "/tmp/host.sock" },
    undefined,
    mac.stands,
  );
  assert.deepEqual(await needsOf(notHosted, "screen"), [
    { need: "screen-recording", holder: "Other", state: "unknown" },
    { need: "accessibility", holder: "Other", state: "unknown" },
  ]);
});

test("each browser is asked for by itself, at its own switch", async (t) => {
  const home = folderOf(t);
  const edge = join(home, "Applications", "Microsoft Edge.app");
  mkdirSync(edge, { recursive: true });
  const mac = machine("darwin", home);
  const setup = new Setup(new Switches(home, true), undefined, undefined, mac.stands);
  await setup.ask("browser", "edge");
  assert.deepEqual(mac.ran, [["/usr/bin/open", ["-a", edge, "edge://inspect/#remote-debugging"]]]);
  await assert.rejects(setup.ask("browser", "chrome"), {
    status: 409,
    message: "Chrome isn't installed on this machine.",
  });
});

test("off macOS turning a part on asks nothing", async (t) => {
  const folder = folderOf(t);
  const linux = machine("linux", folder);
  const driver = driverAt(join(folder, "bin", "cua-driver"), join(folder, "answering"));
  await new Setup(new Switches(folder, true), { program: driver }, undefined, linux.stands).set(
    "screen",
    true,
  );
  assert.deepEqual(linux.ran, []);
});

test("a step that can't be started leaves the part on, and says why", async (t) => {
  const home = folderOf(t);
  mkdirSync(join(home, "Applications", "Google Chrome.app"), { recursive: true });
  const switches = new Switches(home, true);
  const failing = machine("darwin", home, undefined, "No application knows how to open it.");
  await assert.rejects(
    new Setup(switches, undefined, undefined, failing.stands).set("browser", true),
    {
      status: 409,
      message:
        "The browser is on, but asking for what it needs didn't start: No application knows how to open it.",
    },
  );
  assert.equal(switches.on("browser"), true);
  // One the service was given only the folder of, the person opens: turning it on opens nothing,
  // and asking for it says so.
  const named = new Setup(switches, undefined, join(home, "named"), failing.stands);
  await named.set("browser", true);
  await assert.rejects(named.ask("browser", "named"), {
    status: 409,
    message:
      "Open the browser yourself, and switch on remote debugging at its inspect page, chrome://inspect/#remote-debugging.",
  });
});

test("a part switched off isn't ready, and its tools refuse, until the person turns it on", async (t) => {
  const home = folderOf(t);
  const data = join(home, "data");
  const workspace = join(home, "workspace");
  mkdirSync(workspace);
  const child: ChildProcess = spawn(
    process.execPath,
    [
      join(root, "dist", "agentcomputer.js"),
      "serve",
      "--lend",
      "--listen",
      "127.0.0.1:0",
      "--data",
      data,
      "--screen-driver",
      join(home, "none"),
      "--own-browser-data",
      join(home, "browser"),
      ...(BROWSER ? ["--browser-name", "chromium", "--browser-path", BROWSER] : []),
    ],
    { env: { PATH: process.env.PATH ?? "", HOME: home }, stdio: ["ignore", "pipe", "inherit"] },
  );
  t.after(async () => {
    const gone = once(child, "exit");
    child.kill("SIGTERM");
    await gone;
  });
  const apiUrl = await new Promise<string>((done) =>
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      const found = /^AgentComputer on (\S+),/.exec(line);
      if (found) done(found[1] as string);
    }),
  );
  const { Computer } = (await import(pathToFileURL(join(root, "dist", "sdk.js")).href)) as Sdk;
  const to = { apiUrl, apiKey: readFileSync(join(data, "control-token"), "utf8").trim() };
  const headers = { Authorization: `Bearer ${to.apiKey}`, "Content-Type": "application/json" };
  const off = (what: string) => `The person turned off ${what} for agents on ${where}.`;

  const setup = (await (await fetch(`${apiUrl}/v1/setup`, { headers })).json()) as {
    capabilities: { capability: string; on: boolean }[];
  };
  assert.deepEqual(
    setup.capabilities.map(({ capability, on }) => [capability, on]),
    [
      ["terminal", false],
      ["files", false],
      ["screen", false],
      ["browser", false],
    ],
  );
  const offered = (await Computer.serviceInfo(to)).thisComputer;
  assert.deepEqual(
    offered.capabilities.find((one) => one.capability === "files"),
    {
      capability: "files",
      ready: false,
      reason: off("the files"),
    },
  );
  assert.deepEqual(
    offered.browsers.find((one) => one.kind === "own"),
    {
      kind: "own",
      ready: false,
      reason: off("their own browser"),
    },
  );
  await assert.rejects(Computer.attach({ ...to, access: "read", workspace, browser: "own" }), {
    code: 409,
    message: off("their own browser"),
  });

  // Attached while its terminal and files are off, the agent's tools that reach them refuse, the
  // browser's too; on, they answer.
  const computer = await Computer.attach({
    ...to,
    access: "terminal",
    workspace,
    browser: Boolean(BROWSER),
  });
  const endpoints = (await computer.getInfo()).endpoints;
  const auth = { Authorization: `Bearer ${computer.getMcpToken()}` };
  const connect = async (url: string) => {
    const client = new Client({ name: "switches", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: auth },
    });
    await client.connect(transport);
    t.after(() => client.close());
    const call = async (name: string, args: Record<string, unknown>) => {
      const answer = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { text?: string }[];
      };
      return answer.isError ? answer.content[0]?.text : "answered";
    };
    return Object.assign(call, { end: () => transport.terminateSession() });
  };
  const call = await connect(endpoints.computer as string);
  const list = () => call("list", { path: "." });
  assert.equal(await list(), off("the files"));
  assert.equal(await call("exec_command", { cmd: "true" }), off("the terminal"));
  // A batch, whose calls couldn't each be refused, is refused whole.
  const post = (body: unknown) =>
    fetch(endpoints.computer as string, {
      method: "POST",
      headers: {
        ...auth,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    });
  const batch = await post([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
  assert.equal(batch.status, 400);
  assert.match(((await batch.json()) as { error: { message: string } }).error.message, /own POST/);
  if (BROWSER) {
    // Any of its calls that names files answers to the files' switch, whichever tool it is.
    const browse = await connect(endpoints.browser as string);
    assert.equal(await browse("browser_run_code_unsafe", { code: "1" }), off("the terminal"));
    assert.equal(await browse("browser_file_upload", { paths: [] }), off("the files"));
    assert.equal(await browse("browser_drop", { paths: [] }), off("the files"));
    assert.equal(await browse("browser_snapshot", { filename: "page.md" }), off("the files"));
    assert.equal(await browse("browser_snapshot", {}), "answered");
  }
  const turned = await fetch(`${apiUrl}/v1/setup/files`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ on: true }),
  });
  assert.equal(turned.status, 200);
  assert.equal(await list(), "answered");
  assert.equal(await call("exec_command", { cmd: "true" }), off("the terminal"));
  if (BROWSER) {
    // A file the browser writes stays in the computer's folder, whatever roots the agent's
    // client gives.
    const elsewhere = folderOf(t);
    const rooted = new Client({ name: "roots", version: "1" }, { capabilities: { roots: {} } });
    rooted.setRequestHandler("roots/list", async () => ({
      roots: [{ uri: pathToFileURL(elsewhere).href }],
    }));
    await rooted.connect(
      new StreamableHTTPClientTransport(new URL(endpoints.browser as string), {
        requestInit: { headers: auth },
      }),
    );
    t.after(() => rooted.close());
    await rooted.callTool({ name: "browser_snapshot", arguments: { filename: "page.md" } });
    assert.deepEqual(readdirSync(elsewhere), []);
  }
  // Ending its session isn't a call, and goes through while the terminal is off.
  await call.end();
});
