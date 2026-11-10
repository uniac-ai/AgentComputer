// The browser host and the agent's browser tools speak one protocol only at one version.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

test("the parts of Playwright MCP that the browser's server is built from are there", () => {
  const { tools } = require("playwright-core/lib/coreBundle") as { tools: Record<string, unknown> };
  for (const part of [
    "setupExitWatchdog",
    "resolveCLIConfigForMCP",
    "filteredTools",
    "BrowserBackend",
    "start",
  ])
    assert.equal(typeof tools[part], "function", part);
});
