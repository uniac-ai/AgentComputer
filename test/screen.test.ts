// This computer's screen, through Cua Driver. Where the driver isn't installed it is not ready and
// is refused, on any machine. The rest runs only inside the screen test image, a Linux desktop of
// its own with the pinned driver: never on the machine running the tests, nor on its screen.
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

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

test("in a desktop of its own, the agent sees the screen, acts on it and brings apps forward", {
  skip: !IMAGE && "needs AGENTCOMPUTER_TEST_SCREEN_IMAGE",
  timeout: 180_000,
}, async () => {
  // The built service and its modules, read-only, inside the image; what it answers comes back.
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
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const out = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
  assert.equal(out.error, undefined, out.error);
  assert.deepEqual(out.screenOffered, { capability: "screen", ready: true });
  assert.deepEqual(out.attached.tools, ["see", "act", "apps"]);
  assert.equal(out.attached.screen, true);
  // Its three tools, and none of the driver's own.
  assert.deepEqual(out.tools, ["act", "apps", "see"]);
  // The whole screen as a picture, with its windows; the apps and their windows.
  assert.deepEqual([out.see.isError, out.see.kinds.includes("image")], [false, true]);
  assert.match(out.see.text, /"screen-test"/);
  assert.match(out.apps.text, /window_id=\d+ pid=\d+ "screen-test"/);
  // Typing in the background is refused where nothing can deliver it without the focus; in the
  // foreground the command is typed into the window and run.
  assert.equal(out.background.isError, true);
  assert.match(out.background.text, /delivery_mode:"foreground"/);
  assert.deepEqual([out.typed.isError, out.pressed.isError], [false, false]);
  assert.equal(out.ran, "screen-ok\n");
  // One window: its elements, each with a reference, and a picture of it.
  assert.deepEqual([out.window.isError, out.window.kinds.includes("image")], [false, true]);
  assert.match(out.window.text, /element_token/);
  // The agent is told it has the screen and that the person's own use of it can't be seen; another
  // computer attached to the machine sees it acting there.
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
