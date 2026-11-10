// The browser host shares the browser on a socket in a fresh folder only its user can enter,
// however long the temporary folder it's given.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(root, "dist", "agentcomputer.js");
const BROWSER = process.env.AGENTCOMPUTER_BROWSER_PATH;
const { chromium } = createRequire(join(root, "package.json"))(
  "playwright-core",
) as typeof import("playwright-core");

for (const [label, long] of [
  ["the temporary folder this machine gives", false],
  ["a temporary folder too long for a socket", true],
] as const)
  test(`with ${label}, the socket is in a folder of its own`, {
    skip: !BROWSER && "needs AGENTCOMPUTER_BROWSER_PATH",
    timeout: 60_000,
  }, async (t) => {
    const work = realpathSync(mkdtempSync(join(tmpdir(), "agentcomputer-host-")));
    t.after(() => rmSync(work, { recursive: true, force: true }));
    const temporary = long
      ? join(work, "a-temporary-folder-whose-path-is-long-enough-to-matter")
      : undefined;
    if (temporary) mkdirSync(temporary);
    const host = spawn(
      process.execPath,
      [CLI, "browser-host", "--profile", join(work, "profile"), "--executable", BROWSER as string],
      {
        env: { ...process.env, ...(temporary ? { TMPDIR: temporary } : {}) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let errors = "";
    host.stderr.on("data", (chunk) => {
      errors += String(chunk);
    });
    const endpoint = await new Promise<string>((done, failed) => {
      host.once("exit", (code) => failed(new Error(`The host exited ${code}: ${errors}`)));
      createInterface({ input: host.stdout }).on("line", (line) => {
        try {
          done((JSON.parse(line) as { endpoint: string }).endpoint);
        } catch {
          // Not its answer.
        }
      });
    });
    host.removeAllListeners("exit");

    const own = dirname(dirname(dirname(endpoint)));
    assert.match(own, /^\/tmp\/agentcomputer-[^/]+$/);
    assert.equal(statSync(own).mode & 0o777, 0o700);
    assert.equal(statSync(own).uid, process.getuid?.());
    assert.ok(Buffer.byteLength(endpoint) <= 104);

    const client = await chromium.connect(endpoint);
    assert.match(client.version(), /^\d+\./);
    await client.close();

    const gone = once(host, "exit");
    host.kill("SIGTERM");
    await gone;
    assert.equal(existsSync(own), false, "its folder goes with it");
  });
