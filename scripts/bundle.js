// Two single files: the program, holding the service and AgentExec, and the SDK, which goes into its
// own package, packages/sdk, and is the same file in the program's package. Both are bundled from
// this repository's packages' sources (the `agentcomputer-source` condition), except AgentExec,
// which is taken built. playwright-core
// stays a dependency, installed beside the program: the browser host and the browser's MCP server
// are built from it. @playwright/mcp is not run and not installed with the package: it is a
// development dependency, the release whose playwright-core this is pinned to. The licences of
// what is bundled go beside them, each with its NOTICE: what came from npm, and what this
// repository's own packages, AgentExec in packages/exec, bundled into what is taken from them.
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
    conditions: ["agentcomputer-source"],
    // node-pty is a native module installed beside the bundle when it can be, and playwright-core
    // is installed beside it at the version @playwright/mcp brings; the other two are optional
    // speed-ups of the WebSocket library.
    external: ["node-pty", "playwright-core", "bufferutil", "utf-8-validate"],
  });
// The WebSocket library is CommonJS, so the program gets a `require` of its own.
const program = await bundle(
  "src/main.ts",
  "dist/agentcomputer.js",
  '#!/usr/bin/env node\nimport { createRequire as agentcomputerRequire } from "node:module";\nconst require = agentcomputerRequire(import.meta.url);',
);
const sdk = await bundle("packages/sdk/src/sdk.ts", "packages/sdk/dist/sdk.js");
cpSync("packages/sdk/dist/sdk.js", "dist/sdk.js");
// The SDK's types, from its own build's declarations. Their one import of the contract's schema becomes
// the schema put beside them, since the contract isn't published.
const SCHEMA = '"@agentorg/computer-contract/schema"';
const types = readFileSync("packages/sdk/out/sdk.d.ts", "utf8");
if (types.split(SCHEMA).length !== 2)
  throw new Error(`The SDK's types should import ${SCHEMA} once.`);
for (const into of ["packages/sdk/dist/types", "dist/types"]) {
  mkdirSync(join(into, "generated"), { recursive: true });
  writeFileSync(join(into, "sdk.d.ts"), types.replace(SCHEMA, '"./generated/schema.js"'));
  cpSync("packages/contract/src/generated/schema.d.ts", join(into, "generated", "schema.d.ts"));
}

const SEPARATOR = `\n${"=".repeat(72)}\n\n`;
/** A package's section: its licence's text, and its `NOTICE` after it when it has one. */
function section(folder, name, version, license) {
  const entries = readdirSync(folder);
  const licence = entries.find((entry) => /^(licen[cs]e|copying)/i.test(entry));
  const notice = entries.find((entry) => /^notice(\.|$)/i.test(entry));
  const texts = [
    licence
      ? readFileSync(join(folder, licence), "utf8").trim()
      : `See https://www.npmjs.com/package/${name}`,
    ...(notice ? [readFileSync(join(folder, notice), "utf8").trim()] : []),
  ];
  return `${name} ${version} (${license})\n\n${texts.join("\n\n")}\n`;
}
/** The licences of what the bundles hold, one section each, into `file`. */
function licences(results, file) {
  const folders = new Set();
  const own = new Set();
  for (const input of results.flatMap(({ metafile }) => Object.keys(metafile.inputs))) {
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (match) folders.add(match[1]);
    // One of this repository's own packages, taken built: its own bundle's licences come with it.
    const ours = /^(packages\/[^/]+)\/dist\//.exec(input);
    if (ours) own.add(ours[1]);
  }
  // Each section by its first line, "name version (licence)", so one bundled twice is listed once.
  const sections = new Map();
  for (const folder of folders) {
    const { name, version, license } = JSON.parse(
      readFileSync(join(folder, "package.json"), "utf8"),
    );
    sections.set(`${name} ${version} (${license})`, section(folder, name, version, license));
  }
  for (const folder of own)
    for (const section of readFileSync(join(folder, "dist/THIRD_PARTY_LICENSES.txt"), "utf8").split(
      SEPARATOR,
    ))
      if (section.trim()) sections.set(section.split("\n")[0], section);
  const sorted = [...sections].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, section]) => section);
  writeFileSync(file, sorted.join(SEPARATOR));
  return sections.size;
}
// The program's package holds both bundles; the SDK's, its own.
console.log(`Bundled ${licences([program, sdk], "dist/THIRD_PARTY_LICENSES.txt")} packages.`);
console.log(`The SDK bundled ${licences([sdk], "packages/sdk/dist/THIRD_PARTY_LICENSES.txt")}.`);
