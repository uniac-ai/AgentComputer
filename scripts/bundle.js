// Two single files: the program, holding the service and AgentExec, and the SDK. playwright-core
// stays a dependency, installed beside the program: the browser host and the browser's MCP server
// are built from it. @playwright/mcp is not run and not installed with the package: it is a
// development dependency, the release whose playwright-core this is pinned to. The licences of
// what is bundled go beside them: what came from npm, and what this repository's own packages,
// AgentExec in packages/exec, bundled into what is taken from them.
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

const SEPARATOR = `\n${"=".repeat(72)}\n\n`;
const folders = new Set();
const own = new Set();
for (const input of results.flatMap(({ metafile }) => Object.keys(metafile.inputs))) {
  const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (match) folders.add(match[1]);
  // One of this repository's own packages, taken built: its own bundle's licences come with it.
  const ours = /^(packages\/[^/]+)\/dist\//.exec(input);
  if (ours) own.add(ours[1]);
}
// Each section by its first line, "name version (licence)", so that one bundled twice is listed once.
const sections = new Map();
for (const folder of folders) {
  const { name, version, license } = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
  const file = readdirSync(folder).find((entry) => /^(licen[cs]e|copying)/i.test(entry));
  const text = file
    ? readFileSync(join(folder, file), "utf8").trim()
    : `See https://www.npmjs.com/package/${name}`;
  sections.set(`${name} ${version} (${license})`, `${name} ${version} (${license})\n\n${text}\n`);
}
for (const folder of own)
  for (const section of readFileSync(join(folder, "dist/THIRD_PARTY_LICENSES.txt"), "utf8").split(
    SEPARATOR,
  ))
    if (section.trim()) sections.set(section.split("\n")[0], section);
const sorted = [...sections].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, section]) => section);
writeFileSync("dist/THIRD_PARTY_LICENSES.txt", sorted.join(SEPARATOR));
console.log(`Bundled ${sections.size} packages.`);
