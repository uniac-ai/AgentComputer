// What is pinned, and what of it the service is built on: the browser host and the agent's browser
// tools speak one protocol only at one version, and the browser's MCP server is put together from
// parts of Playwright MCP that are not a public interface.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { socketFetch } from "../src/browser.ts";
import { channelProgram } from "../src/playwright.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(root, "package.json"));
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));

test("playwright-core is the version @playwright/mcp brings, as named and as installed", () => {
  const ours = read(join(root, "package.json")).dependencies["playwright-core"];
  const theirs = read(require.resolve("@playwright/mcp/package.json")).dependencies[
    "playwright-core"
  ];
  assert.equal(ours, theirs);
  assert.equal(read(require.resolve("playwright-core/package.json")).version, theirs);
});

test("Playwright's registry names where a browser channel's program is, for the description", () => {
  assert.equal(typeof channelProgram("chromium"), "string");
  assert.equal(channelProgram("no-such-channel"), undefined);
});

test("the browser's server starts from Playwright MCP's parts on a socket of its own, with no port", async (t) => {
  const { tools } = require("playwright-core/lib/coreBundle") as { tools: Record<string, unknown> };
  for (const part of [
    "setupExitWatchdog",
    "resolveCLIConfigForMCP",
    "filteredTools",
    "BrowserBackend",
    "start",
  ])
    assert.equal(typeof tools[part], "function", part);

  // A browser is connected to only when a tool is first called, so none is needed to list them.
  const folder = mkdtempSync(join(tmpdir(), "agentcomputer-mcp-"));
  const child = spawn(
    process.execPath,
    [
      join(root, "dist", "agentcomputer.js"),
      "browser-mcp",
      "--endpoint",
      join(folder, "no-browser"),
      "--output",
      join(folder, "output"),
    ],
    { cwd: folder, stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(async () => {
    if (child.exitCode === null) {
      const gone = once(child, "exit");
      child.kill("SIGTERM");
      await gone;
    }
    rmSync(folder, { recursive: true, force: true });
  });
  // The line the service reads to find it.
  const socket = await new Promise<string>((done, failed) => {
    child.once("exit", (code) => failed(new Error(`It exited with ${code}.`)));
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.startsWith("{")) done((JSON.parse(line) as { socket: string }).socket);
    });
  });
  child.removeAllListeners("exit");
  // In a folder only its user can enter, and on no port of the machine's.
  const own = statSync(dirname(socket));
  assert.deepEqual([own.mode & 0o777, own.uid], [0o700, process.getuid?.()]);
  const listening = await new Promise<{ code: unknown; out: string }>((done) =>
    execFile(
      "lsof",
      ["-nP", "-a", "-p", String(child.pid), "-iTCP", "-sTCP:LISTEN"],
      (error, out) => done({ code: error ? (error as NodeJS.ErrnoException).code : 0, out }),
    ),
  );
  assert.notEqual(listening.code, "ENOENT", "This test needs lsof.");
  assert.deepEqual(listening, { code: 1, out: "" });
  const client = new Client({ name: "pins", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: socketFetch(socket),
    }),
  );
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of ["browser_navigate", "browser_snapshot", "browser_tabs", "browser_close"])
    assert.ok(names.includes(name), name);
  assert.equal(
    client.getServerVersion()?.version,
    read(require.resolve("playwright-core/package.json")).version,
  );

  // Stopped, it takes its folder with it.
  await client.close();
  const gone = once(child, "exit");
  child.kill("SIGTERM");
  await gone;
  assert.equal(existsSync(dirname(socket)), false);
});
