// The person's switches for this machine, what each part still needs, and the steps that ask for
// it. The machine is a stand-in where a step would open something on this one: it records what
// would be run. Cua Driver is a stand-in script, and a browser a folder whose DevToolsActivePort
// names a port this test listens on.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
      ran.push([program, args]);
    },
  };
  return { stands, ran };
};

/**
 * A stand-in Cua Driver at `path`: with Accessibility and without Screen Recording, or, with
 * `allGranted`, with both. It answers for its grants only once `answering` exists, as the driver
 * can't read them while its app isn't running.
 */
const driverAt = (path: string, answering: string, allGranted = false) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `#!/bin/sh
case "$1 $2" in
  "permissions status") [ -f "${answering}" ] && echo '{"accessibility":true,"screen_recording":${allGranted}}' || echo '{"status":"unknown"}' ;;
  *) echo "cua-driver 0.49.7" ;;
esac
`,
  );
  chmodSync(path, 0o755);
  return path;
};

/** A port that answers, written into a browser folder's DevToolsActivePort. */
async function switchOn(t: test.TestContext, folder: string) {
  const listening = createServer();
  await new Promise<void>((done) => listening.listen(0, "127.0.0.1", done));
  t.after(() => listening.close());
  mkdirSync(folder, { recursive: true });
  const { port } = listening.address() as AddressInfo;
  writeFileSync(join(folder, "DevToolsActivePort"), `${port}\n/devtools/browser/one\n`);
}

const needsOf = async (setup: Setup, capability: string) =>
  (await setup.capabilities()).capabilities.find((one) => one.capability === capability)?.needs;

test("every switch is off where the service only lends, on elsewhere, and kept", (t) => {
  const folder = folderOf(t);
  const lent = new Switches(folder, true);
  assert.deepEqual(
    ["terminal", "files", "screen", "browser"].map((one) => lent.on(one as never)),
    [false, false, false, false],
  );
  assert.equal(lent.refused("screen"), `The person turned off the screen for agents on ${where}.`);
  lent.set("screen", true);
  assert.equal(new Switches(folder, true).on("screen"), true);
  assert.equal(new Switches(folder, true).refused("screen"), undefined);
  assert.equal(new Switches(folderOf(t), false).on("terminal"), true);
});

test("the terminal and files need nothing, and the screen needs the driver and its two grants", async (t) => {
  const folder = folderOf(t);
  const switches = new Switches(folder, false);
  const answering = join(folder, "answering");
  writeFileSync(answering, "");
  const app = join(folder, "AgentOrg Computer Use.app");
  const driver = driverAt(join(app, "Contents", "MacOS", "cua-driver"), answering);
  const mac = new Setup(switches, driver, undefined, machine("darwin", folder).stands);
  assert.deepEqual(await needsOf(mac, "terminal"), []);
  assert.deepEqual(await needsOf(mac, "files"), []);
  // Under the app's name, as System Settings lists it.
  assert.deepEqual(await needsOf(mac, "screen"), [
    { need: "screen-recording", holder: "AgentOrg Computer Use", state: "not-granted" },
    { need: "accessibility", holder: "AgentOrg Computer Use", state: "granted" },
  ]);
  const granted = driverAt(join(folder, "granted", "cua-driver"), answering, true);
  assert.deepEqual(
    await needsOf(
      new Setup(switches, granted, undefined, machine("darwin", folder).stands),
      "screen",
    ),
    [],
  );
  assert.deepEqual(
    await needsOf(
      new Setup(switches, driver, undefined, machine("linux", folder).stands),
      "screen",
    ),
    [],
  );
  assert.deepEqual(
    await needsOf(
      new Setup(switches, join(folder, "none"), undefined, machine("darwin", folder).stands),
      "screen",
    ),
    [{ need: "install", state: "missing" }],
  );
});

test("the browser needs one with its switch on, and while none is, lists each off", async (t) => {
  const home = folderOf(t);
  const switches = new Switches(home, false);
  mkdirSync(join(home, "Applications", "Google Chrome.app"), { recursive: true });
  mkdirSync(join(home, "Applications", "Microsoft Edge.app"), { recursive: true });
  const setup = new Setup(switches, undefined, undefined, machine("darwin", home).stands);
  assert.deepEqual(await needsOf(setup, "browser"), [
    { need: "chrome", name: "Chrome", state: "off" },
    { need: "edge", name: "Edge", state: "off" },
  ]);
  await switchOn(t, join(home, "Library", "Application Support", "Microsoft Edge"));
  assert.deepEqual(await needsOf(setup, "browser"), []);
  // The one that is on is the one used: Edge, until Chrome is on too.
  const darwin = { platform: "darwin" as const, home, applications: [join(home, "Applications")] };
  const edge = await ownBrowser(undefined, darwin);
  assert.equal(edge.ready && edge.name, "Edge");
  await switchOn(t, join(home, "Library", "Application Support", "Google", "Chrome"));
  const both = await ownBrowser(undefined, darwin);
  assert.equal(both.ready && both.name, "Chrome");
  assert.deepEqual(
    await needsOf(
      new Setup(switches, undefined, undefined, machine("darwin", folderOf(t)).stands),
      "browser",
    ),
    [{ need: "install", state: "missing" }],
  );
});

test("turning the screen on starts the driver's app through the system, then its own grant", async (t) => {
  const folder = folderOf(t);
  const answering = join(folder, "answering");
  const app = join(folder, "AgentOrg Computer Use.app");
  const driver = driverAt(join(app, "Contents", "MacOS", "cua-driver"), answering);
  // Its app, once open, answers for the grants.
  const mac = machine("darwin", folder, () => writeFileSync(answering, ""));
  const switches = new Switches(folder, true);
  await new Setup(switches, driver, undefined, mac.stands).set("screen", true);
  assert.equal(switches.on("screen"), true);
  assert.deepEqual(mac.ran, [
    ["/usr/bin/open", ["-g", "-a", app, "--env", "DO_NOT_TRACK=1", "--args", "serve"]],
    [driver, ["permissions", "grant"]],
  ]);
  // On again, while its app answers: only the grant.
  mac.ran.length = 0;
  await new Setup(switches, driver, undefined, mac.stands).set("screen", true);
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

test("off macOS turning a part on asks nothing", async (t) => {
  const folder = folderOf(t);
  const linux = machine("linux", folder);
  const driver = driverAt(join(folder, "bin", "cua-driver"), join(folder, "answering"));
  await new Setup(new Switches(folder, true), driver, undefined, linux.stands).set("screen", true);
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
        "It is on, but asking for what it needs didn't start: No application knows how to open it.",
    },
  );
  assert.equal(switches.on("browser"), true);
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

  // Attached while its files are off, the agent's file tools refuse; on, they answer.
  const computer = await Computer.attach({ ...to, access: "read", workspace });
  const client = new Client({ name: "switches", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL((await computer.getInfo()).endpoints.computer as string),
      {
        requestInit: { headers: { Authorization: `Bearer ${computer.getMcpToken()}` } },
      },
    ),
  );
  t.after(() => client.close());
  const list = async () =>
    (await client.callTool({ name: "list", arguments: { path: "." } })) as {
      isError?: boolean;
      content: { text?: string }[];
    };
  const refused = await list();
  assert.deepEqual([refused.isError, refused.content[0]?.text], [true, off("the files")]);
  const turned = await fetch(`${apiUrl}/v1/setup/files`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ on: true }),
  });
  assert.equal(turned.status, 200);
  assert.notEqual((await list()).isError, true);
  assert.equal(existsSync(join(data, "switches.json")), true);
});
