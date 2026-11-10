// What is pinned, and what of it the service is built on: the browser host and the agent's browser
// tools speak one protocol only at one version, and the browser's MCP server is put together from
// parts of Playwright MCP that are not a public interface.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

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

test("the browser's server starts from Playwright MCP's parts and lists its tools, with no browser yet", async (t) => {
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
  const origin = await new Promise<string>((done, failed) => {
    child.once("exit", (code) => failed(new Error(`It exited with ${code}.`)));
    for (const stream of [child.stdout, child.stderr])
      createInterface({ input: stream }).on("line", (line) => {
        const listening = /^Listening on (http:\/\/[^/\s]+)/.exec(line);
        if (listening) done(listening[1] as string);
      });
  });
  child.removeAllListeners("exit");
  const client = new Client({ name: "pins", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
  t.after(() => client.close());
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of ["browser_navigate", "browser_snapshot", "browser_tabs", "browser_close"])
    assert.ok(names.includes(name), name);
  assert.equal(
    client.getServerVersion()?.version,
    read(require.resolve("playwright-core/package.json")).version,
  );
});
