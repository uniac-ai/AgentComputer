// Two single files: the program, holding the service and AgentExec, and the SDK. playwright-core
// stays a dependency, installed beside the program: the browser host and the browser's MCP server
// are built from it. @playwright/mcp is no longer run; it stays as the release whose
// playwright-core this is pinned to. The licences of what is bundled go beside them.
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const bundle = (entry, outfile, banner = "") =>
  build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    metafile: true,
    banner: { js: banner },
    legalComments: "none",
    // node-pty is a native module installed beside the bundle when it can be, and playwright-core
    // is installed beside it at the version @playwright/mcp brings; the other two are optional
    // speed-ups of the WebSocket library.
    external: ["node-pty", "playwright-core", "bufferutil", "utf-8-validate"],
  });
const results = [
  // The WebSocket library is CommonJS, so the program gets a `require` of its own.
  await bundle(
    "src/main.ts",
    "dist/agentcomputer.js",
    '#!/usr/bin/env node\nimport { createRequire as agentcomputerRequire } from "node:module";\nconst require = agentcomputerRequire(import.meta.url);',
  ),
  await bundle("src/sdk.ts", "dist/sdk.js"),
];
cpSync("out/src/sdk.d.ts", "dist/types/sdk.d.ts");
cpSync("src/generated/schema.d.ts", "dist/types/generated/schema.d.ts");

const folders = new Set();
for (const input of results.flatMap(({ metafile }) => Object.keys(metafile.inputs))) {
  const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (match) folders.add(match[1]);
}
const sections = [...folders].sort().map((folder) => {
  const { name, version, license } = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
  const file = readdirSync(folder).find((entry) => /^(licen[cs]e|copying)/i.test(entry));
  const text = file
    ? readFileSync(join(folder, file), "utf8").trim()
    : `See https://www.npmjs.com/package/${name}`;
  return `${name} ${version} (${license})\n\n${text}\n`;
});
writeFileSync("dist/THIRD_PARTY_LICENSES.txt", sections.join(`\n${"=".repeat(72)}\n\n`));
console.log(`Bundled ${folders.size} packages.`);
