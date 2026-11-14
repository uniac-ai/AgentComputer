// This computer's screen, through Cua Driver. Where the driver isn't installed it is not ready and
// is refused, on any machine. The rest runs only inside the screen test image, a Linux desktop of
// its own with the pinned driver: never on the machine running the tests, nor on its screen.
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test, { before, describe } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Screen } from "../src/screen.ts";
import { personCall } from "../src/screen-live.ts";

type Sdk = typeof import("../src/sdk.ts");
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const IMAGE = process.env.AGENTCOMPUTER_TEST_SCREEN_IMAGE;
const run = promisify(execFile);
const MISSING =
  "Cua Driver isn't installed on this machine. Install the signed app from cua.ai/download, then grant it Screen Recording and Accessibility.";

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
    (error: Error & { code: number }) =>
      error.code === 409 && error.message.includes(`no Cua Driver daemon listening on ${socket}`),
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
async function overStandIn(t: test.TestContext, onlyBackground: boolean) {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "ac-")));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const program = join(folder, "cua-driver");
  const standIn = join(root, "test", "fixtures", "driver-stand-in.mjs");
  writeFileSync(program, `#!/bin/sh\nexec "${process.execPath}" "${standIn}" "$@"\n`);
  chmodSync(program, 0o755);
  const none = () => undefined;
  const screen = new Screen(
    { program },
    () => {},
    () => {},
    none,
    none,
    onlyBackground,
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
  const act = (await client.listTools()).tools.find((one) => one.name === "act");
  return { call, act };
}
const window = { pid: 19249, window_id: 12895 };

test("on a lent machine the agent acts only in the background, and is told so in plain words", async (t) => {
  const { call, act } = await overStandIn(t, true);
  assert.equal("delivery_mode" in (act?.inputSchema.properties ?? {}), false);
  assert.match(act?.description ?? "", /always done in the background/);
  assert.doesNotMatch(act?.description ?? "", /foreground/);
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
        "It can't be done in the background in that window, and on this machine the agent acts only in the background: try an element_token from see, or leave it to the person.",
      ],
    ],
  );
  // What the person's screen says is never rewritten, whatever it says.
  assert.equal(
    (await call("see", window)).content[0]?.text,
    'Window "Prefs" (snapshot s1).\n- [3] AXCheckBox "Foreground colour"\n  - [4] AXStaticText "Use the foreground. Then save."',
  );
  assert.match((await call("apps", {})).content[1]?.text ?? "", /"foreground.txt"/);
});

test("an element that can't take a click says to aim at its point, and apps gives each window's fields", async (t) => {
  const { call, act } = await overStandIn(t, false);
  assert.equal("delivery_mode" in (act?.inputSchema.properties ?? {}), true);
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
  // Off a lent machine, the driver's own words reach the agent; its hints still don't.
  const clicked = await call("act", { action: "click", ...window, x: 100, y: 200 });
  assert.match(clicked.content[0]?.text ?? "", /delivery_mode:"foreground"/);
  assert.equal("next_call" in (clicked.structuredContent ?? {}), false);
  const apps = await call("apps", {});
  assert.deepEqual(
    apps.content.map((one) => one.text),
    [
      "✅ Found 1 app(s): 1 running.\n- TextEdit (pid 19249) [com.apple.TextEdit]",
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

type Answer = { isError: boolean; kinds: string[]; text: string; structured?: unknown };
type Ran = Record<string, Answer> & {
  error?: string;
  ran: string;
  screenOffered: unknown;
  attached: { tools: string[]; screen: boolean; surface: unknown };
  liveError?: string;
  watched: { texts: unknown[]; frames: string[]; settled: boolean };
  pointer: { x: number; y: number };
  liveRan: string;
  watchTyped: boolean;
  operated: unknown[];
  aboutAfter: unknown;
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

  test("a point in the frames is scaled to the screen", () => {
    assert.deepEqual([out.pointer.x, out.pointer.y], [150, 150]);
  });

  test("a watch socket's input is dropped", () => {
    assert.equal(out.watchTyped, false);
  });

  test("of every mouse action and keys together, nothing is refused but what is no screen@1 message", () => {
    const refused = { type: "refused", message: "That isn't a screen@1 message." };
    assert.deepEqual(out.operated, [{ type: "size", width: 1280, height: 800 }, refused, refused]);
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
  });
});
