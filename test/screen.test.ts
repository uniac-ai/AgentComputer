// This computer's screen, through Cua Driver. Where the driver isn't installed it is not ready and
// is refused, on any machine. The rest runs only inside the screen test image, a Linux desktop of
// its own with the pinned driver: never on the machine running the tests, nor on its screen.
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
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
import test, { before, describe } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { WebSocket } from "ws";
import { ProcessRuntime } from "../src/runtime.ts";
import {
  AUTOMATION,
  clickedAt,
  foregroundWouldDo,
  onlyGrantsMissing,
  plain,
  putBackAt,
  Screen,
  screenCheck,
  unpathed,
} from "../src/screen.ts";
import { personCall, ScreenLive } from "../src/screen-live.ts";

type Sdk = typeof import("../src/sdk.ts");
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const IMAGE = process.env.AGENTCOMPUTER_TEST_SCREEN_IMAGE;
const run = promisify(execFile);
const MISSING =
  "Cua Driver isn't installed on this machine. Install the signed app from cua.ai/download, then grant it Screen Recording and Accessibility.";

test("info checks the screen again where its reading is old, waiting up to a second for it", async (t) => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "ac-")));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const version = join(folder, "version");
  writeFileSync(version, "cua-driver 0.49.7\n");
  /** A stand-in for the driver, granted, at the version in that file, that takes this long. */
  const driver = (name: string, seconds: number) => {
    const path = join(folder, name);
    writeFileSync(
      path,
      `#!/bin/sh
sleep ${seconds}
case "$1 $2" in
  "permissions status") echo '{"accessibility":true,"screen_recording":true}' ;;
  *) cat "${version}" ;;
esac
`,
    );
    chmodSync(path, 0o755);
    return path;
  };
  // A browser folder of its own, so that the machine's own browsers aren't read.
  const runtime = (program: string) =>
    new ProcessRuntime(
      { path: join(folder, "no-browser"), sandbox: false },
      false,
      { program },
      join(folder, "browser-data"),
    );
  const screen = async (from: ProcessRuntime) =>
    (await from.offer()).capabilities.find((one) => one.capability === "screen");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  // The first read is the driver's answer, not that it is still being looked for.
  const quick = runtime(driver("quick", 0));
  assert.deepEqual(await screen(quick), { capability: "screen", ready: true });
  // Within 10 s the reading stands, whatever the driver would say now: an older one installed in
  // its place, which its version is read again for.
  writeFileSync(version, "cua-driver 0.49.6\n");
  driver("quick", 0);
  assert.deepEqual(await screen(quick), { capability: "screen", ready: true });
  // Older than that, it is checked again before info answers.
  t.mock.timers.tick(11_000);
  assert.match((await screen(quick))?.reason ?? "", /is older than 0\.49\.7/);
  // A check that takes longer is answered with the reading before it, a second later.
  const asked = performance.now();
  assert.deepEqual(await screen(runtime(driver("slow", 2))), {
    capability: "screen",
    ready: false,
    reason: "Cua Driver is being looked for.",
  });
  const took = performance.now() - asked;
  assert.ok(took < 1_900, `answered after ${took} ms`);
});

test("where Cua Driver isn't installed, the screen isn't ready and attaching with it is refused", async (t) => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "ac-")));
  const child: ChildProcess = spawn(
    process.execPath,
    [
      join(root, "dist", "agentcomputer.js"),
      "serve",
      "--listen",
      "127.0.0.1:0",
      "--data",
      join(folder, "data"),
      "--screen-driver",
      join(folder, "no-such-driver"),
    ],
    { env: { PATH: process.env.PATH ?? "", HOME: folder }, stdio: ["ignore", "pipe", "inherit"] },
  );
  t.after(async () => {
    const gone = once(child, "exit");
    child.kill("SIGTERM");
    await gone;
    rmSync(folder, { recursive: true, force: true });
  });
  const url = await new Promise<string>((done) =>
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      const found = /^AgentComputer on (\S+),/.exec(line);
      if (found) done(found[1] as string);
    }),
  );
  const { Computer } = (await import(pathToFileURL(join(root, "dist", "sdk.js")).href)) as Sdk;
  const to = {
    apiUrl: url,
    apiKey: readFileSync(join(folder, "data", "control-token"), "utf8").trim(),
  };
  const screen = (await Computer.serviceInfo(to)).thisComputer.capabilities.find(
    (one) => one.capability === "screen",
  );
  assert.deepEqual(screen, { capability: "screen", ready: false, reason: MISSING });
  await assert.rejects(
    Computer.attach({ ...to, access: "read", workspace: folder, screen: true }),
    (error: Error & { code: number }) => error.code === 409 && error.message === MISSING,
  );
  // Without the screen it is attached as before, with no screen to reach.
  const plain = await Computer.attach({ ...to, access: "read", workspace: folder });
  const info = await plain.getInfo();
  assert.deepEqual([info.screen, info.endpoints.screen, info.tools.screen], [false, null, []]);
  await plain.kill();
});

test("a missing grant sends the person to the app that hosts the driver, by its name, and otherwise to System Settings", async (t) => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "ac-")));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  /** A stand-in for the driver at `program`, granted Screen Recording and not Accessibility. */
  const driver = (program: string) => {
    mkdirSync(dirname(program), { recursive: true });
    writeFileSync(
      program,
      `#!/bin/sh
case "$1" in
  --version) echo "cua-driver 0.49.7" ;;
  call) echo '{"accessibility":false,"screen_recording":true,"source":{"attribution":"host"}}' ;;
  permissions) echo '{"accessibility":false,"screen_recording":true}' ;;
esac
`,
    );
    chmodSync(program, 0o755);
    return program;
  };
  // Inside an app whose name, as its Info.plist gives it, isn't its folder's: a Mac reads the
  // name there, and elsewhere, with no plutil, the folder's is used.
  const app = join(folder, "Host.app");
  mkdirSync(join(app, "Contents"), { recursive: true });
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleDisplayName</key><string>AgentOrg</string></dict></plist>\n',
  );
  const inApp = driver(join(app, "Contents", "Resources", "cua-driver"));
  const name = process.platform === "darwin" ? "AgentOrg" : "Host";
  const socket = join(folder, "host.sock");
  assert.deepEqual((await screenCheck({ program: inApp, socket }, "darwin")).readiness, {
    ready: false,
    reason: `Screen Recording and Accessibility are needed, and ${name} is missing Accessibility. Set it up in ${name}.`,
  });
  // Told where the app has the person set it up, the way there, to the grant's own button.
  const setupIn = "AgentOrg: its icon in the menu bar, Agent Control…";
  assert.deepEqual((await screenCheck({ program: inApp, socket, setupIn }, "darwin")).readiness, {
    ready: false,
    reason: `Screen Recording and Accessibility are needed, and ${name} is missing Accessibility. Set it up in AgentOrg: its icon in the menu bar, Agent Control…, Screen, Set up.`,
  });
  // The person's own Cua Driver, not hosted, is still sent to System Settings.
  assert.match(
    (await screenCheck({ program: inApp, setupIn }, "darwin")).readiness.reason ?? "",
    /Grant it in System Settings, under Privacy & Security\.$/,
  );
  // Hosted by an app it isn't inside: that app, unnamed.
  const loose = driver(join(folder, "loose", "cua-driver"));
  assert.deepEqual((await screenCheck({ program: loose, socket }, "darwin")).readiness, {
    ready: false,
    reason:
      "Screen Recording and Accessibility are needed, and the app running Cua Driver is missing Accessibility. Set it up in that app.",
  });
  // The person's own Cua Driver: its grants are in System Settings, where it asked for them.
  assert.deepEqual((await screenCheck({ program: inApp }, "darwin")).readiness, {
    ready: false,
    reason:
      "Screen Recording and Accessibility are needed, and Cua Driver is missing Accessibility. Grant it in System Settings, under Privacy & Security.",
  });
});

test("a new computer starts with its screen where all the screen lacks is macOS's grants", () => {
  const driver = { program: "/Applications/AgentOrg.app/Contents/Resources/cua-driver" };
  const notReady = { ready: false, reason: "why" };
  for (const [checked, starts] of [
    // Ready: nothing is missing.
    [
      {
        readiness: { ready: true },
        driver,
        grants: { accessibility: true, screen_recording: true },
      },
      false,
    ],
    // A grant not given, both read: it starts.
    [
      { readiness: notReady, driver, grants: { accessibility: false, screen_recording: true } },
      true,
    ],
    [
      { readiness: notReady, driver, grants: { accessibility: false, screen_recording: false } },
      true,
    ],
    // Grants that couldn't be read, a driver that is older or doesn't run, or none: refused.
    [{ readiness: notReady, driver, grants: { reason: "no Cua Driver daemon listening" } }, false],
    [{ readiness: notReady, driver }, false],
    [{ readiness: notReady }, false],
  ] as const)
    assert.equal(onlyGrantsMissing(checked), starts, JSON.stringify(checked));
});

test("the driver's version is read once while its program is the same file, and again once it isn't", async (t) => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "ac-")));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const log = join(folder, "versions.log");
  const program = join(folder, "cua-driver");
  const write = (version: string) => {
    writeFileSync(
      program,
      `#!/bin/sh\ncase "$1" in\n  --version) echo read >> "${log}"; echo "cua-driver ${version}" ;;\nesac\n`,
    );
    chmodSync(program, 0o755);
  };
  const reads = () => readFileSync(log, "utf8").split("\n").filter(Boolean).length;
  write("0.49.7");
  assert.deepEqual((await screenCheck({ program }, "linux")).readiness, { ready: true });
  assert.deepEqual((await screenCheck({ program }, "linux")).readiness, { ready: true });
  assert.equal(reads(), 1);
  // Installed anew, older: read again.
  write("0.40.0");
  assert.deepEqual((await screenCheck({ program }, "linux")).readiness, {
    ready: false,
    reason:
      "Cua Driver 0.40.0 is older than 0.49.7. Install the signed app from cua.ai/download to update it.",
  });
  assert.equal(reads(), 2);
});

test("where the screen can't tell an app's grants, its reason says the app's socket in words, never its path", async (t) => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "ac-")));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const socket = join(folder, "host.sock");
  /** A stand-in for the driver an app hosts, whose grants are read as `call` answers. */
  const hosted = (call: string) => {
    const program = join(folder, `cua-driver-${Math.random().toString(36).slice(2)}`);
    writeFileSync(
      program,
      `#!/bin/sh\ncase "$1" in\n  --version) echo "cua-driver 0.49.7" ;;\n  call) ${call} ;;\nesac\n`,
    );
    chmodSync(program, 0o755);
    return program;
  };
  const unknown =
    "Can't tell whether the app running Cua Driver is granted Screen Recording and Accessibility";
  // No driver answering on the app's socket.
  const silent = hosted(`echo "no Cua Driver daemon listening on ${socket}" >&2; exit 1`);
  const notListening = await screenCheck({ program: silent, socket }, "darwin");
  assert.deepEqual(notListening.readiness, {
    ready: false,
    reason: `${unknown}: no Cua Driver daemon listening on the app's socket`,
  });
  // A driver there, but not the one inside the app.
  const other = hosted(
    `echo '{"accessibility":true,"screen_recording":true,"source":{"attribution":"self"}}'`,
  );
  assert.deepEqual((await screenCheck({ program: other, socket }, "darwin")).readiness, {
    ready: false,
    reason: `${unknown}: the driver on the app's socket doesn't run inside that app`,
  });
  // Words without the socket are as the driver said them.
  assert.equal(unpathed("no grants could be read", socket), "no grants could be read");
  assert.equal(unpathed(`listening on ${socket}`, undefined), `listening on ${socket}`);
});

test("a driver an app hosts is reached, and its grants read, only through that app's socket", async (t) => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "ac-")));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const cli = join(root, "dist", "agentcomputer.js");
  // Named alone, the socket is refused: the driver is the one inside the app that runs it.
  await assert.rejects(
    run(process.execPath, [
      cli,
      "serve",
      "--data",
      join(folder, "refused"),
      "--screen-socket",
      "/tmp/s",
    ]),
    (error: { code: number; stderr: string }) =>
      error.code === 2 && /--screen-socket needs --screen-driver/.test(error.stderr),
  );
  // A stand-in for the driver inside the app, which writes down how it was run, and whose own
  // runtime its host hasn't started.
  const record = join(folder, "ran");
  const socket = join(folder, "host.sock");
  const driver = join(folder, "cua-driver");
  writeFileSync(
    driver,
    `#!/bin/sh
echo "$*" >> "${record}"
case "$1" in
  --version) echo "cua-driver 0.49.7" ;;
  call) echo '{"accessibility":true,"screen_recording":true,"source":{"attribution":"host"}}' ;;
  mcp) echo "no Cua Driver daemon listening on $4" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(driver, 0o755);
  const child: ChildProcess = spawn(
    process.execPath,
    [cli, "serve", "--listen", "127.0.0.1:0", "--data", join(folder, "data")].concat([
      "--screen-driver",
      driver,
      "--screen-socket",
      socket,
    ]),
    { env: { PATH: process.env.PATH ?? "", HOME: folder }, stdio: ["ignore", "pipe", "inherit"] },
  );
  t.after(async () => {
    const gone = once(child, "exit");
    child.kill("SIGTERM");
    await gone;
  });
  const url = await new Promise<string>((done) =>
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      const found = /^AgentComputer on (\S+),/.exec(line);
      if (found) done(found[1] as string);
    }),
  );
  const { Computer } = (await import(pathToFileURL(join(root, "dist", "sdk.js")).href)) as Sdk;
  const to = {
    apiUrl: url,
    apiKey: readFileSync(join(folder, "data", "control-token"), "utf8").trim(),
  };
  // Once the service has first looked for the driver.
  const screen = async () =>
    (await Computer.serviceInfo(to)).thisComputer.capabilities.find(
      (one) => one.capability === "screen",
    );
  for (let i = 0; i < 50 && (await screen())?.reason?.includes("being looked for"); i++)
    await new Promise((done) => setTimeout(done, 100));
  assert.deepEqual(await screen(), { capability: "screen", ready: true });
  await assert.rejects(
    Computer.attach({ ...to, access: "read", workspace: folder, screen: true }),
    // The driver's words, with the app's socket said in words, not as its path.
    (error: Error & { code: number }) =>
      error.code === 409 &&
      error.message.includes("no Cua Driver daemon listening on the app's socket") &&
      !error.message.includes(socket),
  );
  const ran = readFileSync(record, "utf8");
  assert.match(ran, new RegExp(`^mcp --embedded --socket ${socket}$`, "m"));
  // Only macOS reads grants, and there from the host's driver, never the driver's own app.
  if (process.platform === "darwin")
    assert.match(
      ran,
      new RegExp(`^call check_permissions {"prompt":false} --socket ${socket}$`, "m"),
    );
  assert.doesNotMatch(ran, /permissions status|^mcp$/m);
});

/** The agent's screen tools over a stand-in for the driver, on a lent machine or not. */
/**
 * The stand-in driver as a program, with `env` set for it, writing each call it is asked to
 * `record`, a file in a folder of the test's own unless given: and the calls since the last time.
 */
function standInProgram(t: test.TestContext, env: Record<string, string> = {}, record?: string) {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "ac-")));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const program = join(folder, "cua-driver");
  const standIn = join(root, "test", "fixtures", "driver-stand-in.mjs");
  const written = record ?? join(folder, "calls");
  const vars = Object.entries({ STANDIN_CALLS: written, ...env })
    .map(([name, value]) => `${name}="${value}"`)
    .join(" ");
  writeFileSync(program, `#!/bin/sh\n${vars} exec "${process.execPath}" "${standIn}" "$@"\n`);
  chmodSync(program, 0o755);
  /** The calls the driver was asked since the last time, each its tool and arguments. */
  let read = 0;
  const calls = () => {
    const lines = existsSync(written) ? readFileSync(written, "utf8").trim().split("\n") : [];
    const since = lines.slice(read).filter(Boolean);
    read = lines.length;
    return since.map(
      (line) => JSON.parse(line) as { name: string; args: Record<string, unknown>; who?: string },
    );
  };
  return { program, record: written, calls };
}

async function overStandIn(t: test.TestContext, onlyBackground: boolean, record?: string) {
  const { program, calls } = standInProgram(t, {}, record);
  const logged: string[] = [];
  const screen = new Screen(
    () => ({ program }),
    (line) => logged.push(line),
    () => undefined,
    async () => undefined,
    onlyBackground,
    "darwin",
  );
  t.after(() => screen.stop());
  await screen.ready();
  const server = createServer((request, response) => void screen.handle(request, response));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const client = new Client({ name: "screen", version: "1" });
  const { port } = server.address() as AddressInfo;
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/`)));
  t.after(() => client.close());
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text?: string }[];
      structuredContent?: Record<string, unknown>;
    };
  const { tools } = await client.listTools();
  const [act, apps, see] = ["act", "apps", "see"].map((name) =>
    tools.find((one) => one.name === name),
  );
  return { call, act, apps, see, calls, logged };
}
const window = { pid: 19249, window_id: 12895 };

test("on a lent machine the agent acts only in the background, and is told so in plain words", async (t) => {
  const { call, act, apps, see } = await overStandIn(t, true);
  assert.equal("delivery_mode" in (act?.inputSchema.properties ?? {}), false);
  assert.match(
    act?.description ?? "",
    /It is done in the background, with the person's pointer left where it is; a click that can't be is made in the foreground, which brings the window forward, and the person's pointer is put back\. A point of the whole screen's picture is refused here: find the window in apps, see it, and aim in its picture\./,
  );
  assert.doesNotMatch(act?.description ?? "", /the whole screen's, with neither/);
  assert.match(
    see?.description ?? "",
    /On this machine the whole screen's picture is for finding a window: act aims in a window's picture\./,
  );
  // The driver's advice to retry in the foreground, and its hints naming its own tools, don't reach it.
  const clicked = await call("act", { action: "click", ...window, x: 100, y: 200 });
  assert.deepEqual(
    clicked.content.map((one) => one.text),
    [
      "It was sent in the background, with the person's pointer left where it is: see the window to check that it took effect.",
    ],
  );
  assert.deepEqual(clicked.structuredContent, {
    delivery: { mode: "background" },
    effect: "unverifiable",
    route: "synthetic_events",
  });
  const asked = await call("act", {
    action: "click",
    ...window,
    x: 1,
    y: 1,
    delivery_mode: "foreground",
  });
  assert.equal(asked.isError, true);
  const typed = await call("act", { action: "type", ...window, text: "hi" });
  assert.deepEqual(
    [typed.isError, typed.content.map((one) => one.text)],
    [
      true,
      [
        "It can't be done in the background in that window, and on this machine it isn't done in the foreground either: try an element_token from see, or leave it to the person.",
      ],
    ],
  );
  // What the person's screen says is never rewritten, whatever it says.
  assert.equal(
    (await call("see", window)).content[0]?.text,
    'Window "Prefs" (snapshot s1).\n- [3] AXCheckBox "Foreground colour"\n  - [4] AXStaticText "Use the foreground. Then save."',
  );
  assert.match((await call("apps", {})).content[1]?.text ?? "", /"foreground.txt"/);
  // apps takes no window to bring forward: it would take the person's front app, and their typing.
  assert.equal("pid" in (apps?.inputSchema.properties ?? {}), false);
  assert.match(apps?.description ?? "", /brings no window forward/);
  assert.equal((await call("apps", window)).isError, true);
});

test("a click is made in the foreground only on a refusal that sent nothing and says the foreground would do it", () => {
  const refusal = (structured: Record<string, unknown>) => ({
    content: [],
    isError: true,
    structuredContent: {
      code: "background_unavailable",
      escalation: { recommended: "foreground" },
      ...structured,
    },
  });
  assert.equal(foregroundWouldDo(refusal({ effect: "refused" })), true);
  // A toolkit that reads the real pointer is refused before anything is sent, with no effect.
  assert.equal(foregroundWouldDo(refusal({ reason: "pointer_reading_toolkit" })), true);
  // Anything that may have been sent, or that the foreground can't help, is not.
  assert.equal(foregroundWouldDo(refusal({ effect: "no_drop" })), false);
  assert.equal(foregroundWouldDo(refusal({})), false);
  assert.equal(foregroundWouldDo({ content: [], isError: true }), false);
  assert.equal(
    foregroundWouldDo(refusal({ effect: "refused", escalation: { recommended: "accessibility" } })),
    false,
  );
  assert.equal(
    foregroundWouldDo(refusal({ effect: "refused", code: "minimized_or_hidden_window" })),
    false,
  );
  assert.equal(foregroundWouldDo({ ...refusal({ effect: "refused" }), isError: false }), false);
});

test("the person's pointer goes back where it was, as far as they moved it since the click", () => {
  // Where the driver says it clicked, on a Mac and on X11.
  assert.deepEqual(clickedAt("✅ Posted click at screen-point (500,400) for pid 1 (…)."), {
    x: 500,
    y: 400,
  });
  assert.deepEqual(
    clickedAt("Clicked at (20.0, 20.0) × 1 [window_point=(20, 20) screen_point=(61, 80)]"),
    {
      x: 61,
      y: 80,
    },
  );
  assert.equal(clickedAt("Clicked."), undefined);
  // At 100,100 before; the click at 500,400; the person moved it 3 right and 4 down meanwhile.
  assert.deepEqual(putBackAt({ x: 100, y: 100 }, { x: 503, y: 404 }, { x: 500, y: 400 }), {
    x: 103,
    y: 104,
  });
  // Where the click's point isn't known, back where it was.
  assert.deepEqual(putBackAt({ x: 100, y: 100 }, { x: 503, y: 404 }, undefined), {
    x: 100,
    y: 100,
  });
  // The point said rounded and the pointer read cut down: a point's difference is no motion.
  assert.deepEqual(putBackAt({ x: 100, y: 100 }, { x: 499, y: 401 }, { x: 500, y: 400 }), {
    x: 100,
    y: 100,
  });
  assert.deepEqual(putBackAt({ x: 100, y: 100 }, { x: 498, y: 400 }, { x: 500, y: 400 }), {
    x: 98,
    y: 100,
  });
});

test("on a lent machine a click the background can't make is made once in the foreground, with the person's pointer put back", async (t) => {
  const { call, calls, logged } = await overStandIn(t, true);
  calls();
  const done = await call("act", { action: "click", ...window, x: 777, y: 5 });
  assert.deepEqual(
    [done.isError ?? false, done.content.map((one) => one.text), done.structuredContent],
    [
      false,
      [
        "It couldn't be done in the background in that window, so it was clicked in the foreground, which brings the window forward; the person's pointer was put back where it was. See the window to check that it took effect.",
      ],
      { delivery: "foreground", pointer_back: true },
    ],
  );
  // Read, clicked once in the background and once in the foreground, then moved back once, in the
  // whole screen's pixels at full size: twice its points on this Retina screen.
  const target = { kind: "window", ...window };
  assert.deepEqual(calls(), [
    { name: "click", args: { target, delivery_mode: "background", x: 777, y: 5 } },
    { name: "get_cursor_position", args: {} },
    { name: "click", args: { target, delivery_mode: "foreground", x: 777, y: 5 } },
    { name: "get_cursor_position", args: {} },
    { name: "get_screen_size", args: {} },
    {
      name: "move_cursor",
      args: { scope: "desktop", x: 206, y: 208, delivery_mode: "foreground" },
    },
    { name: "get_cursor_position", args: {} },
  ]);
  assert.match(logged.at(-1) ?? "", /made in the foreground; the person's pointer was put back/);
  // A toolkit that reads the real pointer, refused with no effect, goes the same way.
  assert.equal(
    (await call("act", { action: "double_click", ...window, x: 779, y: 5 })).isError,
    undefined,
  );
  assert.deepEqual(
    calls()
      .filter((one) => one.name === "click")
      .map((one) => [one.args.delivery_mode, one.args.count]),
    [
      ["background", 2],
      ["foreground", 2],
    ],
  );
});

test("on a lent machine a click is never sent twice, and what the foreground can't do is said in words", async (t) => {
  const { call, calls } = await overStandIn(t, true);
  calls();
  const clicks = () =>
    calls()
      .filter((one) => one.name === "click")
      .map((one) => one.args.delivery_mode);
  // Failed after it may have been sent: refused, and not sent again. A refusal keeps all its words.
  const failedAfter = await call("act", { action: "click", ...window, x: 778, y: 5 });
  assert.deepEqual(
    [failedAfter.isError, failedAfter.content[0]?.text],
    [
      true,
      "click failed: the posting task stopped after the press (delivery_mode=background; not driver-verified).",
    ],
  );
  assert.deepEqual(clicks(), ["background"]);
  // Refused where the foreground can't help either: in words, and not sent again.
  const hidden = await call("act", { action: "right_click", ...window, x: 782, y: 5 });
  assert.equal(hidden.isError, true);
  assert.deepEqual(clicks(), ["background"]);
  // An error in the foreground that doesn't say nothing was sent: whether it was clicked isn't
  // known, and the pointer, which it didn't move, is where it was.
  const unsure = await call("act", { action: "click", ...window, x: 781, y: 5 });
  assert.deepEqual(
    [unsure.isError, unsure.content.map((one) => one.text)],
    [
      true,
      [
        "It couldn't be done in the background in that window, and Cua Driver's answer to clicking it in the foreground was an error, so whether it was clicked isn't known: see the window before trying again; the person's pointer is where it was.",
      ],
    ],
  );
  calls();
  // Refused in the foreground as nothing sent: said so, and the pointer, which only the person
  // can have moved meanwhile, is left as it is, not even read again.
  const twice = await call("act", { action: "click", ...window, x: 788, y: 5 });
  assert.deepEqual(
    [twice.isError, twice.content.map((one) => one.text)],
    [
      true,
      [
        "It couldn't be done in the background in that window, and Cua Driver refused to click it in the foreground too, so the person's pointer was left as it is.",
      ],
    ],
  );
  assert.deepEqual(
    calls().map((one) => [one.name, one.args.delivery_mode]),
    [
      ["click", "background"],
      ["get_cursor_position", undefined],
      ["click", "foreground"],
    ],
  );
  // Not put back: said plainly, and the move is tried once.
  const stuck = await call("act", { action: "click", ...window, x: 780, y: 5 });
  assert.deepEqual(
    [stuck.content.map((one) => one.text), stuck.structuredContent],
    [
      [
        "It couldn't be done in the background in that window, so it was clicked in the foreground, which brings the window forward; the person's pointer couldn't be put back where it was, and is where the click left it. See the window to check that it took effect.",
      ],
      { delivery: "foreground", pointer_back: false },
    ],
  );
  assert.equal(calls().filter((one) => one.name === "move_cursor").length, 1);
});

test("on a lent machine the put-back reads the screen as the driver does, and says what it can't tell", async (t) => {
  const { call, calls } = await overStandIn(t, true);
  // The agent has seen the whole screen in a picture smaller than it: the driver reads a later
  // point in the whole screen against that picture, so the put-back's is divided by as much.
  await call("see", {});
  calls();
  const done = await call("act", { action: "click", ...window, x: 777, y: 5 });
  assert.match(done.content[0]?.text ?? "", /; the person's pointer was put back where it was\. /);
  const [move] = calls().filter((one) => one.name === "move_cursor");
  assert.deepEqual(move?.args, {
    scope: "desktop",
    x: (103 * 2) / (3024 / 1366),
    y: (104 * 2) / (1964 / 887),
    delivery_mode: "foreground",
  });
  // Answered with an error that says nothing more, after it moved the pointer: whether it was
  // clicked isn't known, and the pointer goes back where it was, the person's motion unknown.
  const unknown = await call("act", { action: "click", ...window, x: 784, y: 5 });
  assert.deepEqual(
    [unknown.isError, unknown.content.map((one) => one.text)],
    [
      true,
      [
        "It couldn't be done in the background in that window, and Cua Driver's answer to clicking it in the foreground was an error, so whether it was clicked isn't known: see the window before trying again; the person's pointer was put back where it was.",
      ],
    ],
  );
  // The pointer unread after the click: moved back where it was, once.
  const unread = await call("act", { action: "click", ...window, x: 786, y: 5 });
  assert.match(
    unread.content[0]?.text ?? "",
    /; the person's pointer was put back where it was\. /,
  );
  calls();
  // On a Mac, with the screen's scale unread, it isn't moved at all, and that is said.
  const sizeless = await call("act", { action: "click", ...window, x: 785, y: 5 });
  assert.deepEqual(
    [sizeless.content.map((one) => one.text), sizeless.structuredContent],
    [
      [
        "It couldn't be done in the background in that window, so it was clicked in the foreground, which brings the window forward; the person's pointer couldn't be put back where it was, and is where the click left it. See the window to check that it took effect.",
      ],
      { delivery: "foreground", pointer_back: false },
    ],
  );
  assert.equal(calls().filter((one) => one.name === "move_cursor").length, 0);
});

test("on a lent machine the put-back keeps the driver's picture of the whole screen, and moves nothing it can't read", async (t) => {
  const { call, calls } = await overStandIn(t, true);
  // A picture of the whole screen the driver couldn't take leaves it reading points against the
  // last it took, and so does the put-back.
  await call("see", {});
  await call("act", { action: "click", ...window, x: 787, y: 5 });
  assert.equal((await call("see", {})).isError, true);
  calls();
  const done = await call("act", { action: "click", ...window, x: 777, y: 5 });
  assert.match(done.content[0]?.text ?? "", /; the person's pointer was put back where it was\. /);
  // The pointer readable only where the driver last put it: not read, so not clicked.
  const synthetic = await call("act", { action: "click", ...window, x: 789, y: 5 });
  assert.deepEqual(
    [synthetic.isError, synthetic.content.map((one) => one.text)],
    [
      true,
      [
        "It can't be done in the background in that window, and where the person's pointer is couldn't be read, so it wasn't clicked in the foreground either, which would have left the pointer where the click put it: try an element_token from see, or leave it to the person.",
      ],
    ],
  );
  assert.deepEqual(
    calls()
      .filter((one) => one.name === "click")
      .map((one) => [one.args.delivery_mode, one.args.x]),
    [
      ["background", 777],
      ["foreground", 777],
      ["background", 789],
    ],
  );
});

test("on a lent machine a point of the whole screen is refused before anything is sent, and aimed in a window instead", async (t) => {
  const { call, calls } = await overStandIn(t, true);
  calls();
  const point = { x: 777, y: 5 };
  const pointed = [
    { action: "click", ...point },
    { action: "double_click", ...point },
    { action: "right_click", ...point },
    { action: "drag", ...point, to_x: 790, to_y: 9 },
    { action: "scroll", ...point, direction: "down" },
  ];
  for (const input of pointed) {
    const refused = await call("act", input);
    assert.deepEqual(
      [refused.isError, refused.content.map((one) => one.text)],
      [
        true,
        [
          "On this machine the agent acts in a window, not at a point of the whole screen, which would move the person's pointer there and leave it: find the window that holds it in apps, see that window, and find it again in that window's picture to aim at.",
        ],
      ],
      input.action,
    );
  }
  assert.deepEqual(calls(), []);
  // The whole screen is still seen, to find the window; an element, and a window's point, are acted on.
  assert.equal((await call("see", {})).isError, undefined);
  assert.equal((await call("act", { action: "click", element_token: "s1:5" })).isError, true);
  assert.equal(
    (await call("act", { action: "scroll", ...window, ...point, direction: "up" })).isError,
    undefined,
  );
  assert.deepEqual(
    calls().map((one) => [one.name, (one.args.target as { kind?: string } | undefined)?.kind]),
    [
      ["get_desktop_state", undefined],
      ["click", undefined],
      ["scroll", "window"],
    ],
  );
});

test("off a lent machine a point of the whole screen goes to the driver as before", async (t) => {
  const { call, calls, act, see } = await overStandIn(t, false);
  assert.match(act?.description ?? "", /or the whole screen's, with neither/);
  assert.doesNotMatch(see?.description ?? "", /On this machine/);
  calls();
  await call("act", { action: "click", x: 10, y: 20 });
  assert.deepEqual(
    calls().map((one) => [one.name, one.args.target]),
    [["click", { kind: "desktop", display_id: "primary" }]],
  );
});

test("on a lent machine the put-back says when the person moved the pointer again, and two clicks never interleave", async (t) => {
  const { call, calls } = await overStandIn(t, true);
  calls();
  const both = await Promise.all(
    [777, 777].map((x) => call("act", { action: "click", ...window, x, y: 5 })),
  );
  assert.deepEqual(
    both.map((one) => one.structuredContent),
    [
      { delivery: "foreground", pointer_back: true },
      { delivery: "foreground", pointer_back: true },
    ],
  );
  // Each foreground click is read around and put back before the next is made.
  const steps = calls()
    .filter((one) => !(one.name === "click" && one.args.delivery_mode === "background"))
    .map((one) => one.name);
  const each = ["get_cursor_position", "click", "get_cursor_position", "get_screen_size"];
  assert.deepEqual(steps, [
    ...each,
    "move_cursor",
    "get_cursor_position",
    ...each,
    "move_cursor",
    "get_cursor_position",
  ]);
  // Put back, and moved again by the person by the time it is read.
  const drifted = await call("act", { action: "click", ...window, x: 783, y: 5 });
  assert.deepEqual(
    [drifted.content.map((one) => one.text), drifted.structuredContent],
    [
      [
        "It couldn't be done in the background in that window, so it was clicked in the foreground, which brings the window forward; the person's pointer was put back where it was, and has moved since. See the window to check that it took effect.",
      ],
      { delivery: "foreground", pointer_back: true },
    ],
  );
});

test("the driver's words reach the agent without its pictographs, and an action's without its own notes", () => {
  // As the pinned driver answered on a Mac and on Linux.
  for (const [said, action, read] of [
    ["✅ Found 92 app(s): 16 running.", false, "Found 92 app(s): 16 running."],
    [
      '✅ Inserted 33 char(s) into AXTextArea "" A net-zero key edit (space, backspace) was sent so the document registers the change and saves it; an accessibility write alone does not.',
      true,
      "Inserted 33 char(s) into AXTextArea.",
    ],
    ["Pressed cmd+end on pid 85987.", true, "Pressed cmd+end on pid 85987."],
    [
      '✅ Posted click to pid 19249 (background CGEvent routed to the pid; the hardware pointer was not moved, so apps that read the pointer position may not receive it at the target; not driver-verified — confirm via screenshot and retry with delivery_mode:"foreground" if nothing changed).',
      true,
      "Posted click to pid 19249.",
    ],
    [
      "Clicked at (182.0, 100.0) × 1 (delivery_mode=background, path=x11_xsendevent); not verified — confirm with a screenshot. [window_point=(182, 100) screen_point=(383, 320)]",
      true,
      "Clicked at (182.0, 100.0) × 1.",
    ],
    // Anything else stays as it is: words in brackets or asides, titles with their own signs, lines
    // of a list, a reminder with no full stop on its line, and what was typed.
    [
      "Foreground input refused (reason=screen_locked; nothing sent): the screen is locked.",
      true,
      "Foreground input refused (reason=screen_locked; nothing sent): the screen is locked.",
    ],
    ["Window [window_id: 5] not found.", true, "Window [window_id: 5] not found."],
    ['Typed "a[0]" into the field.', true, 'Typed "a[0]" into the field.'],
    [
      "The element was not verified as clickable\nTry element_token s0:1",
      true,
      "The element was not verified as clickable\nTry element_token s0:1",
    ],
    [
      "✅ Found 2 app(s): 2 running.\n- Chat 🔥 (pid 2)\n- Acme™ Notes (pid 3) [com.acme.notes]",
      false,
      "Found 2 app(s): 2 running.\n- Chat 🔥 (pid 2)\n- Acme™ Notes (pid 3) [com.acme.notes]",
    ],
  ] as const)
    assert.equal(plain(said, action), read, said);
});

test("off a lent machine the agent's own choice stands: a refused click isn't made in the foreground for it", async (t) => {
  const { call, calls } = await overStandIn(t, false);
  calls();
  const refused = await call("act", { action: "click", ...window, x: 777, y: 5 });
  assert.equal(refused.isError, true);
  assert.deepEqual(
    calls().map((one) => [one.name, one.args.delivery_mode]),
    [["click", "background"]],
  );
});

test("an element that can't take a click says to aim at its point, and apps gives each window's fields", async (t) => {
  const { call, act, apps: appsTool } = await overStandIn(t, false);
  assert.equal("delivery_mode" in (act?.inputSchema.properties ?? {}), true);
  assert.equal("pid" in (appsTool?.inputSchema.properties ?? {}), true);
  const refused = await call("act", { action: "click", element_token: "s1:7" });
  assert.equal(refused.isError, true);
  assert.deepEqual(
    refused.content.map((one) => one.text),
    [
      "That element can't be clicked by its reference. Aim at its point in the window's picture instead: x and y, with the window's pid and window_id. What the driver said:",
      "AX action failed: AXUIElementPerformAction(AXPress) returned -25206",
    ],
  );
  // A stale reference is not told to aim at its point: seeing again is what it needs.
  const stale = await call("act", { action: "click", element_token: "s0:1" });
  assert.deepEqual(
    stale.content.map((one) => one.text),
    ["The element_token s0:1 is from an earlier snapshot; see the window again."],
  );
  // Off a lent machine, the driver's own words reach the agent, without its pictographs and its own
  // notes; its hints still don't.
  const clicked = await call("act", { action: "click", ...window, x: 100, y: 200 });
  assert.equal(clicked.content[0]?.text, "Posted click to pid 19249.");
  assert.equal("next_call" in (clicked.structuredContent ?? {}), false);
  const apps = await call("apps", {});
  assert.deepEqual(
    apps.content.map((one) => one.text),
    [
      "Found 1 app(s): 1 running.\n- TextEdit (pid 19249) [com.apple.TextEdit]",
      'Found 2 window(s).\n- TextEdit (pid 19249) "Untitled" [window_id: 12895]\n- TextEdit (pid 19249) "foreground.txt" [window_id: 12896]',
    ],
  );
  assert.deepEqual(apps.structuredContent, {
    windows: [
      {
        app_name: "TextEdit",
        title: "Untitled",
        pid: 19249,
        window_id: 12895,
        bounds: { x: 120, y: 80, width: 586, height: 488 },
        z_index: 3,
      },
    ],
  });
});

test("the person's input in the live view is the driver's call, at the whole screen", () => {
  const desktop = { kind: "desktop", display_id: "primary" };
  const mouse = { type: "mouse", x: 10, y: 20 };
  const fore = { target: desktop, delivery_mode: "foreground", x: 10, y: 20 };
  assert.deepEqual(personCall({ ...mouse, action: "click" }), ["click", fore]);
  assert.deepEqual(personCall({ ...mouse, action: "double_click" }), [
    "click",
    { ...fore, count: 2 },
  ]);
  assert.deepEqual(personCall({ ...mouse, action: "right_click" }), [
    "click",
    { ...fore, button: "right" },
  ]);
  assert.deepEqual(personCall({ ...mouse, action: "drag", to_x: 30, to_y: 40 }), [
    "drag",
    { target: desktop, delivery_mode: "foreground", from_x: 10, from_y: 20, to_x: 30, to_y: 40 },
  ]);
  assert.deepEqual(personCall({ ...mouse, action: "scroll", direction: "up", amount: 2 }), [
    "scroll",
    { ...fore, direction: "up", amount: 2 },
  ]);
  // Keys and text go where the person's focus is.
  assert.deepEqual(personCall({ type: "key", keys: ["enter"] }), [
    "press_key",
    { target: desktop, key: "enter" },
  ]);
  assert.deepEqual(personCall({ type: "key", keys: ["cmd", "c"] }), [
    "hotkey",
    { target: desktop, keys: ["cmd", "c"] },
  ]);
  assert.deepEqual(personCall({ type: "text", text: "hi" }), [
    "type_text",
    { target: desktop, text: "hi" },
  ]);
  const malformed = "That isn't a screen@1 message.";
  for (const [wrong, message] of [
    [null, malformed],
    [{ type: "mouse", action: "click" }, malformed],
    [{ type: "key", keys: [] }, malformed],
    [{ type: "text", text: "" }, malformed],
    [{ type: "tab" }, malformed],
    [{ ...mouse, action: "drag" }, "drag needs x and y, where it starts, and to_x and to_y."],
    [{ ...mouse, action: "scroll" }, "scroll needs a direction."],
  ] as const)
    assert.throws(() => personCall(wrong), { message }, JSON.stringify(wrong));
});

/** Until `check` holds, for at most 10 s; `what` names it. */
async function waitFor(check: () => boolean, what: string) {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; ) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.fail(`Waited too long for ${what}.`);
}

/**
 * The person's live view over the stand-in driver, on a Retina Mac: one socket at operate, what it
 * is sent, what the live view's log is told, how often the person acted, and the driver's calls.
 */
async function liveOverStandIn(
  t: test.TestContext,
  env: Record<string, string> = {},
  record?: string,
) {
  const { program, calls } = standInProgram(t, env, record);
  const logged: string[] = [];
  let acted = 0;
  const live = new ScreenLive(
    () => ({ program }),
    (line) => logged.push(line),
    () => {
      acted += 1;
    },
    "darwin",
  );
  t.after(() => live.close());
  const sent: { type: string; message?: string }[] = [];
  const ws = Object.assign(new EventEmitter(), {
    bufferedAmount: 0,
    send: (data: unknown) => {
      if (typeof data === "string") sent.push(JSON.parse(data));
    },
    close() {
      ws.emit("close");
    },
  });
  live.open(ws as unknown as WebSocket, "operate");
  const send = (message: unknown) =>
    ws.emit("message", Buffer.from(JSON.stringify(message)), false);
  // Its frames are taken twice a second, on the same connection, and left out.
  const inputs = () => calls().filter((one) => one.name !== "get_desktop_state");
  return { send, sent, logged, acted: () => acted, calls: inputs, close: () => ws.close() };
}

/** The stand-in's screen: its picture of the whole of it is this much smaller, and its points half its pixels. */
const STANDIN_DESKTOP = { x: 3024 / 1366, y: 1964 / 887 };
/** A point of the screen, in pixels of the stand-in's whole screen's picture, as the put-back moves to it. */
const inPicture = ({ x, y }: { x: number; y: number }) =>
  rounded({ x: (x * 2) / STANDIN_DESKTOP.x, y: (y * 2) / STANDIN_DESKTOP.y });
/** A point, to a millionth of a pixel. */
const rounded = ({ x, y }: { x: number; y: number }) => ({
  x: Math.round(x * 1e6) / 1e6,
  y: Math.round(y * 1e6) / 1e6,
});
const DESKTOP_TARGET = { kind: "desktop", display_id: "primary" };

test("the person's click, double and right click, drag and scroll in the live view are each made once at their point, and the pointer put back", async (t) => {
  const { send, sent, logged, acted, calls } = await liveOverStandIn(t);
  const at = { type: "mouse", x: 200, y: 100 };
  const fore = { target: DESKTOP_TARGET, delivery_mode: "foreground", x: 200, y: 100 };
  const inputs: [unknown, [string, Record<string, unknown>]][] = [
    [{ ...at, action: "click" }, ["click", fore]],
    [{ ...at, action: "double_click" }, ["click", { ...fore, count: 2 }]],
    [{ ...at, action: "right_click" }, ["click", { ...fore, button: "right" }]],
    [
      { ...at, action: "drag", to_x: 300, to_y: 150 },
      [
        "drag",
        {
          target: DESKTOP_TARGET,
          delivery_mode: "foreground",
          from_x: 200,
          from_y: 100,
          to_x: 300,
          to_y: 150,
        },
      ],
    ],
    [{ ...at, action: "scroll", direction: "down" }, ["scroll", { ...fore, direction: "down" }]],
  ];
  for (const [message] of inputs) send(message);
  await waitFor(() => acted() === inputs.length, "every input made");
  // Each: the pointer read, the input made once, then read again and moved back once, to where it
  // was as far as the person moved it meanwhile, a further (3, 4) each time.
  const made = calls().map(({ name, args }) =>
    name === "move_cursor"
      ? { name, args: { ...args, ...rounded(args as never) } }
      : { name, args },
  );
  assert.deepEqual(
    made,
    inputs.flatMap(([, [name, args]], i) => [
      // The screen's scale, then the drawn pointer glided alone to where the input starts.
      { name: "get_screen_size", args: {} },
      {
        name: "move_cursor",
        args: rounded({ x: (200 * STANDIN_DESKTOP.x) / 2, y: (100 * STANDIN_DESKTOP.y) / 2 }),
      },
      { name: "get_cursor_position", args: {} },
      { name, args },
      { name: "get_cursor_position", args: {} },
      {
        name: "move_cursor",
        args: {
          scope: "desktop",
          ...inPicture({ x: 100 + 3 * (i + 1), y: 100 + 4 * (i + 1) }),
          delivery_mode: "foreground",
        },
      },
      { name: "get_cursor_position", args: {} },
    ]),
  );
  // Put back each time, so the person is told nothing, and the log nothing.
  assert.deepEqual([sent, logged], [[], []]);
});

test("where the pointer can't be read first, the person's click is made all the same, and the log says it wasn't put back", async (t) => {
  const { send, sent, logged, acted, calls } = await liveOverStandIn(t, {
    STANDIN_POINTER: "unread",
  });
  send({ type: "mouse", action: "click", x: 200, y: 100 });
  await waitFor(() => logged.length > 0, "what the log is told");
  const words = "where the pointer was before it couldn't be read, so it wasn't put back";
  assert.deepEqual(logged, [`The person's click was made; ${words}.`]);
  assert.deepEqual(sent, []);
  assert.equal(acted(), 1);
  assert.deepEqual(
    calls().map((one) => one.name),
    ["get_screen_size", "move_cursor", "get_cursor_position", "click"],
  );
});

test("the person's input is never sent twice, and where the pointer isn't put back the log says so", async (t) => {
  const { send, sent, logged, acted, calls } = await liveOverStandIn(t);
  const clicks = () => calls().filter((one) => ["click", "drag"].includes(one.name)).length;
  // Refused before anything was sent: nothing moved, and the driver's words.
  send({ type: "mouse", action: "click", x: 602, y: 100 });
  await waitFor(() => sent.length === 1, "the first refusal");
  assert.deepEqual(sent.at(-1), {
    type: "refused",
    message: "Foreground input refused (screen_locked): the screen is locked.",
  });
  assert.deepEqual(
    calls().map((one) => one.name),
    ["get_screen_size", "move_cursor", "get_cursor_position", "click"],
  );
  // Failed after it moved the pointer: put back where it was, and not sent again.
  send({ type: "mouse", action: "click", x: 603, y: 100 });
  await waitFor(() => sent.length === 2, "the second refusal");
  assert.deepEqual(sent.at(-1), { type: "refused", message: "Task error: the connection closed" });
  const failed = calls();
  assert.equal(failed.filter((one) => one.name === "click").length, 1);
  const back = failed.find((one) => one.name === "move_cursor" && one.args.scope)?.args;
  assert.deepEqual(
    { ...back, ...rounded(back as never) },
    {
      scope: "desktop",
      ...inPicture({ x: 100, y: 100 }),
      delivery_mode: "foreground",
    },
  );
  assert.equal(acted(), 0);
  // Moved back somewhere else, as the driver says, and then not moved back at all.
  send({ type: "mouse", action: "drag", x: 604, y: 100, to_x: 650, to_y: 120 });
  send({ type: "mouse", action: "click", x: 601, y: 100 });
  await waitFor(() => logged.length === 2, "both logged");
  assert.equal(sent.length, 2);
  assert.deepEqual(logged, [
    "The person's drag was made; the pointer was moved back, but not to where it was.",
    "The person's click was made; the pointer couldn't be put back where it was.",
  ]);
  assert.equal(acted(), 2);
  assert.equal(clicks(), 2);
  // Failed after it moved the pointer, which then can't be moved back: refused, saying both.
  send({ type: "mouse", action: "click", x: 606, y: 100 });
  await waitFor(() => sent.length === 3, "the third refusal");
  assert.deepEqual(sent.at(-1), {
    type: "refused",
    message: "Task error: the connection closed. The pointer couldn't be put back where it was.",
  });
  assert.equal(
    logged.at(-1),
    "The person's click failed; the pointer couldn't be put back where it was.",
  );
  assert.equal(clicks(), 1);
});

for (const lent of [true, false])
  test(`the person's input in the live view and an agent's input that moves the pointer are made one after the other, ${lent ? "on a lent machine" : "off one"}`, async (t) => {
    const { record } = standInProgram(t);
    const agent = await overStandIn(t, lent, record);
    const live = await liveOverStandIn(t, { STANDIN_WHO: "live" }, record);
    const written = () =>
      (existsSync(record) ? readFileSync(record, "utf8") : "")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { name: string; who?: string });
    const fromLive = (name: string) => () =>
      written().some((one) => one.who === "live" && one.name === name);
    await waitFor(fromLive("get_desktop_state"), "the live view's first frame");
    agent.calls();
    // The person's click, on its way for 400 ms, and meanwhile the agent's click: in the foreground
    // on a lent machine once the background refuses it, or as the agent asks off one.
    live.send({ type: "mouse", action: "click", x: 605, y: 100 });
    await waitFor(fromLive("click"), "the person's click on its way");
    const answer = await agent.call("act", {
      action: "click",
      ...window,
      x: 777,
      y: 5,
      ...(lent ? {} : { delivery_mode: "foreground" }),
    });
    assert.equal(answer.isError, undefined);
    await waitFor(() => live.acted() === 1, "the person's click made");
    // The person's is read around and put back before the agent's is sent.
    const whose = agent
      .calls()
      .filter(
        (one) =>
          one.name !== "get_desktop_state" &&
          !(one.name === "click" && one.args.delivery_mode === "background"),
      )
      .map((one) => `${one.who ?? "agent"} ${one.name}`);
    assert.deepEqual(whose, [
      "live get_screen_size",
      "live move_cursor",
      "live get_cursor_position",
      "live click",
      "live get_cursor_position",
      "live move_cursor",
      "live get_cursor_position",
      ...(lent
        ? [
            "agent get_cursor_position",
            "agent click",
            "agent get_cursor_position",
            "agent get_screen_size",
            "agent move_cursor",
            "agent get_cursor_position",
          ]
        : ["agent click"]),
    ]);
  });

test("an input on its way when the person closes the live view is still put back before its connection ends", async (t) => {
  const { send, close, acted, calls } = await liveOverStandIn(t);
  send({ type: "mouse", action: "click", x: 605, y: 100 });
  const seen: string[] = [];
  await waitFor(() => {
    seen.push(...calls().map((one) => one.name));
    return seen.includes("click");
  }, "the click on its way");
  close();
  await waitFor(() => acted() === 1, "the click made");
  seen.push(...calls().map((one) => one.name));
  assert.deepEqual(seen, [
    "get_screen_size",
    "move_cursor",
    "get_cursor_position",
    "click",
    "get_cursor_position",
    "move_cursor",
    "get_cursor_position",
  ]);
});

test("the live view glides the drawn pointer to an input's point first, so a hand moving meanwhile is kept", async (t) => {
  const { send, acted, calls } = await liveOverStandIn(t, { STANDIN_HAND: "moving" });
  send({ type: "mouse", action: "click", x: 200, y: 100 });
  await waitFor(() => acted() === 1, "the click made");
  const made = calls();
  // Glided alone, with no scope, before the real pointer is read.
  const glided = made.findIndex((one) => one.name === "move_cursor" && !one.args.scope);
  const read = made.findIndex((one) => one.name === "get_cursor_position");
  assert.ok(glided >= 0 && glided < read, JSON.stringify(made));
  // The hand took the pointer a further (50, 30) during the glide, from (100, 100): it is put back
  // there, as far as the hand moved it since, a further (3, 4).
  const back = made.find((one) => one.name === "move_cursor" && one.args.scope)?.args;
  assert.deepEqual(rounded(back as never), inPicture({ x: 153, y: 134 }));
});

type Answer = { isError: boolean; kinds: string[]; text: string; structured?: unknown };
type Ran = Record<string, Answer> & {
  error?: string;
  ran: string;
  screenOffered: unknown;
  attached: { tools: string[]; screen: boolean; surface: unknown };
  liveError?: string;
  watched: { texts: unknown[]; frames: string[]; settled: boolean };
  pointer: Record<"before" | "clicked" | "afterAll", { x: number; y: number }>;
  frontRan: string;
  besideRan: boolean;
  liveRan: string;
  watchTyped: boolean;
  operated: unknown[];
  aboutAfter: unknown;
  logs: string[];
  tools: string[];
  about: unknown;
  other: unknown;
  otherAbout: unknown;
};
/** The driver did it, and what it said. */
const done = (answer: Answer | undefined) => {
  assert.equal(answer?.isError, false, answer?.text);
  return answer.text;
};
/** Refused, and why. */
const refused = (answer: Answer | undefined) => {
  assert.equal(answer?.isError, true, answer?.text);
  return answer.text;
};

/** One run of the built service and its modules, read-only, inside the image: what it answered. */
async function ranInImage(...args: string[]): Promise<Ran> {
  const { stdout } = await run(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${root}:/repo:ro`,
      IMAGE as string,
      "node",
      "/repo/test/fixtures/screen-run.mjs",
      ...args,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const out: Ran = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
  assert.equal(out.error, undefined, out.error);
  return out;
}

describe("in a desktop of its own, with the pinned driver", {
  skip: !IMAGE && "needs AGENTCOMPUTER_TEST_SCREEN_IMAGE",
}, () => {
  let out: Ran;
  // What it was answered comes back for each test below.
  before(
    async () => {
      out = await ranInImage();
    },
    { timeout: 180_000 },
  );

  test("the screen is ready and attached with three tools, none of the driver's own", () => {
    assert.deepEqual(out.screenOffered, { capability: "screen", ready: true });
    assert.deepEqual([out.attached.screen, out.attached.tools], [true, ["see", "act", "apps"]]);
    assert.deepEqual(out.tools, ["act", "apps", "see"]);
    assert.deepEqual(out.attached.surface, {
      surface: "screen",
      protocol: "screen@1",
      operate: true,
    });
  });

  test("the agent sees the whole screen, one window's elements, and the apps", () => {
    assert.match(done(out.see), /"screen-test"/);
    assert.ok(out.see?.kinds.includes("image"));
    assert.match(done(out.window), /element_token/);
    assert.ok(out.window?.kinds.includes("image"));
    assert.match(done(out.apps), /window_id=\d+ pid=\d+ "screen-test"/);
    // Each window's fields, to aim with: the terminal's among them.
    const listed = out.apps?.structured as { windows?: Record<string, unknown>[] } | undefined;
    const terminal = listed?.windows?.find((one) => one.title === "screen-test");
    assert.deepEqual(Object.keys(terminal ?? {}).sort(), [
      "app_name",
      "bounds",
      "pid",
      "title",
      "window_id",
      "z_index",
    ]);
  });

  test("switched off by the person, the agent's calls are refused; on again, they are answered", () => {
    assert.equal(
      refused(out.switchedOff),
      "The person turned off the screen for agents on this machine.",
    );
    assert.match(done(out.switchedOn), /"screen-test"/);
  });

  test("typing is refused in the background where only the focus can take it, and runs in the foreground", () => {
    assert.match(refused(out.background), /delivery_mode:"foreground"/);
    done(out.typed);
    done(out.pressed);
    assert.equal(out.ran, "screen-ok\n");
  });

  test("act refuses what it can't aim before the driver is asked", () => {
    assert.match(refused(out.unknownKey), /Unrecognized key: "element"/);
    assert.equal(
      refused(out.noTarget),
      "type needs a window, by pid and window_id, or an element_token.",
    );
    assert.equal(
      refused(out.halfWindow),
      "A window is its pid and its window_id, from apps: give both.",
    );
  });

  test("the agent clicks, double and right clicks, scrolls, drags, presses keys together and brings a window forward", () => {
    assert.match(done(out.click), /× 1/);
    assert.match(done(out.double), /× 2/);
    done(out.right);
    done(out.scroll);
    done(out.drag);
    done(out.hotkey);
    assert.match(done(out.front), /"screen-test"/);
  });

  test("about says the agent has the screen and can't tell whether the person is using it; another computer here sees it acting", () => {
    assert.deepEqual(out.about, [
      { label: "Reaches", value: "Read-only files, Screen" },
      {
        label: "Acting now",
        value: "Nobody else; can't tell whether the person is using the screen",
      },
    ]);
    assert.deepEqual(out.other, { screen: false, endpoint: null });
    assert.deepEqual(out.otherAbout, [
      { label: "Reaches", value: "Read-only files" },
      { label: "Acting now", value: "Scout: the screen" },
    ]);
  });

  test("the person watching is sent the size, then a PNG frame scaled from the screen, and nothing more while it is still", () => {
    assert.equal(out.liveError, undefined, out.liveError);
    assert.deepEqual(out.watched.texts, [{ type: "size", width: 1280, height: 800 }]);
    assert.deepEqual(out.watched.frames, ["PNG"]);
    assert.equal(out.watched.settled, true);
  });

  test("at operate the person types into the window in front", () => {
    assert.equal(out.liveRan, "live-ok\n");
  });

  test("the person's click brings the window under its point forward, a point in the frames scaled to the screen, and the real pointer ends where it was", () => {
    // Typed before the click, it went to the small window in front, not the terminal.
    assert.equal(out.besideRan, false);
    assert.equal(out.frontRan, "front-ok\n");
    assert.deepEqual(
      [out.pointer.clicked, out.pointer.afterAll],
      [out.pointer.before, out.pointer.before],
    );
  });

  test("a watch socket's input is dropped", () => {
    assert.equal(out.watchTyped, false);
  });

  test("of every mouse action and keys together, nothing is refused but what is no screen@1 message", () => {
    const refused = { type: "refused", message: "That isn't a screen@1 message." };
    assert.deepEqual(out.operated, [{ type: "size", width: 1280, height: 800 }, refused, refused]);
  });

  // It can fail only where the driver reaches its releases, which is where it would tell.
  test("no update notice of the driver's reaches the computer's log", () => {
    assert.ok(out.logs.length > 0);
    assert.ok(!out.logs.some((line) => /is available \(you have/.test(line)), out.logs.join("\n"));
  });

  test("the agent is told the person used the screen, in its next answer there and in about", () => {
    assert.match(done(out.personLine), /\nThe person used the screen \d+ s ago\.$/);
    assert.deepEqual(out.aboutAfter, [
      { label: "Reaches", value: "Read-only files, Screen" },
      {
        label: "Acting now",
        value: "The person: the screen",
      },
    ]);
  });
});

describe("on a lent machine, with the pinned driver behind a proxy that refuses a click in the background", {
  skip: !IMAGE && "needs AGENTCOMPUTER_TEST_SCREEN_IMAGE",
}, () => {
  type PutBack = {
    error?: string;
    before: { x: number; y: number };
    after: { x: number; y: number };
    afterFailed: { x: number; y: number };
    desktop: unknown;
    refused: { isError: boolean; text: string; structured?: unknown };
    failedAfter: { isError: boolean; text: string };
    calls: { name: string; args?: Record<string, unknown>; text?: string }[];
    logs: string[];
  };
  let out: PutBack;
  before(
    async () => {
      const { stdout } = await run(
        "docker",
        [
          "run",
          "--rm",
          "-v",
          `${root}:/repo:ro`,
          IMAGE as string,
          "node",
          "/repo/test/fixtures/screen-put-back.mjs",
        ],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      out = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
      assert.equal(out.error, undefined, out.error);
    },
    { timeout: 180_000 },
  );

  test("a click refused before anything was sent is made once in the foreground, and the real pointer ends where it was", () => {
    assert.deepEqual(
      [out.refused.isError, out.refused.text, out.refused.structured],
      [
        false,
        "It couldn't be done in the background in that window, so it was clicked in the foreground, which brings the window forward; the person's pointer was put back where it was. See the window to check that it took effect.",
        { delivery: "foreground", pointer_back: true },
      ],
    );
    const clicks = out.calls.filter((one) => one.name === "click");
    assert.deepEqual(
      clicks.map((one) => [one.args?.delivery_mode, one.args?.x]),
      [
        ["background", 77],
        ["foreground", 77],
        ["background", 78],
      ],
    );
    // The foreground click moved the real pointer to the point, through X11's own input …
    const [answered] = out.calls.filter((one) => one.name === "answered");
    assert.match(
      answered?.text ?? "",
      /delivery_mode=foreground, path=x11_xtest_fg.*screen_point=\(\d+, \d+\)/,
    );
    // … and one move put it back where it was, in the whole screen's last picture, half the screen.
    assert.deepEqual(out.desktop, {
      ...(out.desktop as object),
      screenshot_width: 960,
      screenshot_original_width: 1920,
    });
    assert.deepEqual(
      out.calls.filter((one) => one.name === "move_cursor").map((one) => one.args),
      [{ scope: "desktop", x: out.before.x / 2, y: out.before.y / 2 }],
    );
    assert.deepEqual(out.after, out.before);
    assert.ok(
      out.logs.some((line) =>
        /made in the foreground; the person's pointer was put back/.test(line),
      ),
      out.logs.join("\n"),
    );
  });

  test("a click that failed after it may have been sent is refused, and never sent again", () => {
    assert.deepEqual(
      [out.failedAfter.isError, out.failedAfter.text],
      [true, "click failed: the posting task stopped after the press"],
    );
    assert.deepEqual(out.afterFailed, out.before);
    assert.equal(out.calls.filter((one) => one.name === "click" && one.args?.x === 78).length, 1);
  });
});

describe("with the pinned driver run embedded, as an app hosting it runs it", {
  skip: !IMAGE && "needs AGENTCOMPUTER_TEST_SCREEN_IMAGE",
}, () => {
  let out: Ran;
  before(
    async () => {
      out = await ranInImage("--embedded");
    },
    { timeout: 180_000 },
  );

  test("the service reaches it through the host's socket: the agent sees and acts, and the person watches", () => {
    assert.deepEqual(out.screenOffered, { capability: "screen", ready: true });
    assert.deepEqual(out.attached.tools, ["see", "act", "apps"]);
    assert.match(done(out.see), /"screen-test"/);
    assert.match(done(out.apps), /"screen-test"/);
    assert.equal(out.ran, "screen-ok\n");
    assert.deepEqual(out.watched.frames, ["PNG"]);
    assert.equal(out.liveRan, "live-ok\n");
    assert.equal(out.besideRan, false);
    assert.equal(out.frontRan, "front-ok\n");
    assert.deepEqual(
      [out.pointer.clicked, out.pointer.afterAll],
      [out.pointer.before, out.pointer.before],
    );
    assert.ok(!out.logs.some((line) => /is available \(you have/.test(line)), out.logs.join("\n"));
  });
});

test("an app macOS hasn't let be controlled through scripting is said in plain words before the driver's", async (t) => {
  for (const lent of [false, true]) {
    const { call } = await overStandIn(t, lent);
    const refused = await call("act", { action: "hotkey", keys: ["cmd", "s"], ...window });
    assert.equal(refused.isError, true);
    assert.deepEqual(
      refused.content.map((one) => one.text),
      [
        AUTOMATION,
        "hotkey refused (automation_consent_required): Save needs TextEdit's scripting interface, and macOS hasn't given consent to control TextEdit. Nothing was sent.",
      ],
    );
    // Any other combination is as the driver answers it.
    const pressed = await call("act", { action: "hotkey", keys: ["cmd", "c"], ...window });
    assert.equal(pressed.isError, undefined);
  }
});
